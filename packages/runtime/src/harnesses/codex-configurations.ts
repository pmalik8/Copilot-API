import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AvailableModel, Credentials } from '../contracts'
import { atomicWrite, readOptional } from '../credentials/vault'
import { createCodexCatalog, codexDefaultReasoning } from './codex-catalog'
import {
  configureCodex,
  configValue,
  hasManagedProvider,
  hash,
  managedFingerprint,
  redactConfig,
  restoreCodex,
} from './codex-config'

const revisionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  model: z.string(),
  createdAt: z.string(),
  catalog: z.string(),
  content: z.string(),
  action: z.enum(['configure', 'restore']),
})
const savedSchema = z.object({
  original: z.string().nullable(),
  active: z.string().nullable(),
  fingerprint: z.string(),
  revisions: z.array(revisionSchema),
  pending: z
    .object({
      before: z.string().nullable(),
      after: z.string().nullable(),
      revisionId: z.string(),
    })
    .nullable(),
})
export interface CodexPreview {
  id: string
  label: string
  configPath: string
  catalogPath: string
  before: string
  after: string
  changes: string[]
}
export interface CodexConfigurationStatus {
  configPath: string
  effective: { provider: string; model: string }
  active: string | null
  externalManagedEdit: boolean
  // The active configuration's model list no longer matches the sources.
  catalogStale: boolean
  // The active configuration runs another ModelBridge executable or data
  // folder, for example after either was moved.
  pathsStale: boolean
  // The active configuration's default model is no longer available.
  missingModel: boolean
  revisions: Array<{
    id: string
    label: string
    model: string
    createdAt: string
    action: 'configure' | 'restore'
  }>
}

export class CodexConfigurations {
  private saved: z.infer<typeof savedSchema> | null = null
  private readonly previews = new Map<
    string,
    {
      preview: CodexPreview
      before: string | null
      content: string | null
      revision: z.infer<typeof revisionSchema>
    }
  >()
  private readonly vaultId: string
  private writing = false

  private constructor(
    readonly configPath: string,
    private readonly directory: string,
    private readonly credentials: Credentials,
    private readonly helper: { command: string; args: string[] },
  ) {
    this.vaultId = `codex-configurations-${hash(configPath)}`
  }

  static async open(
    configPath: string,
    directory: string,
    credentials: Credentials,
    helper: { command: string; args: string[] },
  ): Promise<CodexConfigurations> {
    const configurations = new CodexConfigurations(
      configPath,
      directory,
      credentials,
      helper,
    )
    await configurations.recover()
    return configurations
  }

  private async recover(): Promise<void> {
    const marker = path.join(this.directory, `${hash(this.configPath)}.managed`)
    if (!fs.existsSync(marker)) return
    const saved = savedSchema.parse(
      JSON.parse(this.credentials.get(this.vaultId)),
    )
    this.saved = saved
    if (!saved.pending) return
    const pending = saved.pending
    const current = readOptional(this.configPath)
    if (current === pending.after) {
      const revision = saved.revisions.find(
        (item) => item.id === pending.revisionId,
      )
      if (!revision)
        throw new Error('Codex configuration recovery is missing its revision.')
      saved.active = revision.action === 'restore' ? null : revision.id
      saved.fingerprint = managedFingerprint(pending.after ?? '')
    } else if (current !== pending.before)
      throw new Error(
        'An interrupted Codex configuration change conflicts with an external edit. Preserve both profiles for recovery.',
      )
    saved.pending = null
    await this.persist(saved)
  }

  private async persist(next: z.infer<typeof savedSchema>) {
    await this.credentials.set(
      this.vaultId,
      JSON.stringify(savedSchema.parse(next)),
    )
    atomicWrite(
      path.join(this.directory, `${hash(this.configPath)}.managed`),
      'ModelBridge manages revisions for this Codex configuration.',
    )
    this.saved = next
  }

  status(models?: AvailableModel[]): CodexConfigurationStatus {
    const current = readOptional(this.configPath) ?? ''
    const value = configValue(current)
    const active = this.saved?.revisions.find(
      (revision) =>
        revision.id === this.saved?.active && revision.action === 'configure',
    )
    return {
      configPath: this.configPath,
      effective: {
        provider:
          typeof value.model_provider === 'string' ?
            value.model_provider
          : 'openai (default)',
        model: typeof value.model === 'string' ? value.model : 'Codex default',
      },
      active: this.saved?.active ?? null,
      externalManagedEdit:
        !!this.saved && managedFingerprint(current) !== this.saved.fingerprint,
      catalogStale:
        !!active
        && !!models
        && active.catalog !== JSON.stringify(createCodexCatalog(models)),
      pathsStale:
        !!active
        && [this.helper.command, this.directory].some(
          (value) =>
            !active.content.includes(JSON.stringify(value).slice(1, -1)),
        ),
      missingModel:
        !!active
        && !!models
        && !models.some(
          (model) =>
            model.id === active.model && model.protocol === 'responses',
        ),
      revisions: (this.saved?.revisions ?? []).map(
        ({ id, label, model, createdAt, action }) => ({
          id,
          label,
          model,
          createdAt,
          action,
        }),
      ),
    }
  }

  canRestore(): boolean {
    return this.saved !== null
  }

  private prepare(
    label: string,
    before: string | null,
    content: string | null,
    catalog: string,
    model: string,
    action: 'configure' | 'restore',
  ): CodexPreview {
    if (this.saved?.pending)
      throw new Error(
        'A previous Codex change needs recovery. Restart ModelBridge before editing.',
      )
    const external =
      this.saved !== null
      && managedFingerprint(before ?? '') !== this.saved.fingerprint
    if (action === 'configure' && external)
      throw new Error(
        'Codex provider/model settings were changed outside ModelBridge. Review the current settings before explicitly reconciling them.',
      )
    if (!this.saved && hasManagedProvider(before ?? ''))
      throw new Error(
        'The modelbridge provider already exists but is not owned by this installation. Choose another Codex profile or remove that provider yourself after review.',
      )
    const id = randomUUID()
    const catalogPath = path.join(this.directory, `${id}.models.json`)
    const revision = revisionSchema.parse({
      id,
      label,
      model,
      createdAt: new Date().toISOString(),
      catalog,
      content: content ?? '',
      action,
    })
    const preview = {
      id,
      label,
      configPath: this.configPath,
      catalogPath,
      before: redactConfig(before ?? ''),
      after: redactConfig(content ?? ''),
      changes:
        action === 'restore' ?
          [
            'Restore the original provider/model/catalog/reasoning settings.',
            'Preserve current unrelated settings and native auth.json/keychain.',
            ...(content === null ?
              [
                'Remove the configuration file ModelBridge created; no unrelated settings remain.',
              ]
            : []),
            ...(external ?
              [
                'Restoring replaces provider/model settings changed outside ModelBridge. Review those changes below before confirming.',
              ]
            : []),
          ]
        : [
            'model_provider selects the independent modelbridge provider, not the ChatGPT backend.',
            'model selects the exact source-qualified gateway model; no subscription or billing fallback.',
            'model_catalog_json supplies Codex-native picker metadata, not OpenAI /models JSON.',
            'base_url points to the local ModelBridge gateway, which routes to the remote host URL/key.',
            'auth.command asks this same installed app for its local key. No secret is written to TOML.',
            'requires_openai_auth=false keeps custom-provider requests independent of native ChatGPT sign-in.',
            'Unrelated settings and native auth.json/keychain remain unchanged. Restart Codex and open a new local chat.',
          ],
    }
    this.previews.clear()
    this.previews.set(id, { preview, before, content, revision })
    return preview
  }

  preview(
    label: string,
    modelId: string,
    models: AvailableModel[],
    url: string,
  ): CodexPreview {
    const validLabel = z.string().trim().min(1).max(100).parse(label)
    const model = models.find((item) => item.id === modelId)
    if (!model || model.protocol !== 'responses')
      throw new Error(
        'Choose an available Responses-compatible model for Codex.',
      )
    const catalog = JSON.stringify(createCodexCatalog(models))
    if (Buffer.byteLength(catalog) > 1024 * 1024)
      throw new Error('Codex catalog exceeds its 1 MiB client limit.')
    const id = randomUUID()
    const before = readOptional(this.configPath)
    const content = configureCodex(before ?? '', {
      model: model.id,
      url,
      catalogPath: path.join(this.directory, `${id}.models.json`),
      helperCommand: this.helper.command,
      helperArgs: this.helper.args,
      reasoningEffort: codexDefaultReasoning(model),
    })
    const preview = this.prepare(
      validLabel,
      before,
      content,
      catalog,
      model.id,
      'configure',
    )
    const prepared = this.previews.get(preview.id)
    if (!prepared) throw new Error('Codex preview could not be created.')
    prepared.preview.catalogPath = path.join(
      this.directory,
      `${id}.models.json`,
    )
    return prepared.preview
  }

  restore(): CodexPreview {
    if (!this.saved)
      throw new Error(
        'No original Codex configuration has been saved by this installation.',
      )
    const before = readOptional(this.configPath)
    const restored = restoreCodex(before ?? '', this.saved.original ?? '')
    return this.prepare(
      'Restore native Codex',
      before,
      this.saved.original === null && !restored.trim() ? null : restored,
      '',
      '',
      'restore',
    )
  }

  previewRevision(
    id: string,
    models: AvailableModel[],
    url: string,
  ): CodexPreview {
    const revision = this.saved?.revisions.find((item) => item.id === id)
    if (!revision)
      throw new Error('The selected Codex revision does not exist.')
    return revision.action === 'restore' ?
        this.restore()
      : this.preview(revision.label, revision.model, models, url)
  }

  async reconcile(): Promise<CodexConfigurationStatus> {
    return this.exclusive(async () => {
      if (!this.saved || this.saved.pending)
        throw new Error(
          'No committed Codex configuration is available to reconcile.',
        )
      const current = readOptional(this.configPath) ?? ''
      await this.persist({
        ...this.saved,
        fingerprint: managedFingerprint(current),
        active: null,
      })
      return this.status()
    })
  }

  async apply(
    id: string,
    verifyCredential?: () => Promise<void>,
  ): Promise<CodexConfigurationStatus> {
    return this.exclusive(async () => {
      if (this.previews.get(id)?.revision.action === 'configure')
        await verifyCredential?.()
      return this.write(id)
    })
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writing)
      throw new Error(
        'Another Codex configuration change is in progress. Wait for it to finish.',
      )
    this.writing = true
    try {
      return await operation()
    } finally {
      this.writing = false
    }
  }

  private async write(id: string): Promise<CodexConfigurationStatus> {
    const operation = this.previews.get(id)
    if (!operation)
      throw new Error(
        'The Codex preview is stale. Generate a new preview before applying.',
      )
    if (hash(readOptional(this.configPath)) !== hash(operation.before))
      throw new Error(
        'Codex configuration changed after the preview. Nothing was overwritten; generate a fresh preview.',
      )
    const { revision, content } = operation
    if (revision.action === 'configure')
      atomicWrite(operation.preview.catalogPath, revision.catalog)
    const next = {
      original: this.saved ? this.saved.original : operation.before,
      active: this.saved?.active ?? null,
      fingerprint:
        this.saved?.fingerprint ?? managedFingerprint(operation.before ?? ''),
      revisions: [...(this.saved?.revisions ?? []), revision],
      pending: {
        before: operation.before,
        after: content,
        revisionId: revision.id,
      },
    }
    await this.persist(next)
    // Saving the journal yields to other editors, so check the file again.
    if (hash(readOptional(this.configPath)) !== hash(operation.before)) {
      await this.persist({
        ...next,
        revisions: next.revisions.slice(0, -1),
        pending: null,
      })
      throw new Error(
        'Codex configuration changed after the preview. Nothing was overwritten; generate a fresh preview.',
      )
    }
    if (content === null) fs.rmSync(this.configPath, { force: true })
    else atomicWrite(this.configPath, content)
    await this.persist({
      ...next,
      active: revision.action === 'restore' ? null : revision.id,
      fingerprint: managedFingerprint(content ?? ''),
      pending: null,
    })
    this.previews.clear()
    return this.status()
  }
}
