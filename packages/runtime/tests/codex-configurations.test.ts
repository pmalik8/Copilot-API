import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexConfigurations } from '../src/harnesses/codex-configurations'
import {
  configValue,
  configureCodex,
  redactConfig,
} from '../src/harnesses/codex-config'
import { CredentialStore } from '../src/credentials/vault'
import type { AvailableModel } from '../src/contracts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
const models: AvailableModel[] = [
  {
    id: 'host/copilot/gpt',
    name: 'GPT',
    sourceId: 'host',
    sourceLabel: 'Remote Copilot',
    protocol: 'responses',
    protocols: ['responses'],
    supportsTools: true,
  },
  {
    id: 'host/copilot/claude',
    name: 'Claude',
    sourceId: 'host',
    sourceLabel: 'Remote Copilot',
    protocol: 'responses',
    protocols: ['responses'],
    upstreamProtocol: 'messages',
    supportsTools: true,
  },
]
const helper = {
  command: 'C:\\Programs\\ModelBridge.exe',
  args: ['--modelbridge-credential', '--user-data-dir=C:\\Profile'],
}
const url = 'http://127.0.0.1:4321/v1'
const original =
  '# Native account stays signed in\nmodel = "native-model"\nmodel_provider = "openai"\n\n[projects."C:\\\\work"]\ntrust_level = "trusted"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n'
async function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modelbridge-codex-config-'),
  )
  directories.push(directory)
  const file = path.join(directory, 'config.toml')
  fs.writeFileSync(file, original)
  fs.writeFileSync(
    path.join(directory, 'auth.json'),
    'native-account-do-not-touch',
  )
  const vault = CredentialStore.open(path.join(directory, 'credentials.json'))
  const revisions = path.join(directory, 'revisions')
  return {
    directory,
    file,
    vault,
    revisions,
    service: await CodexConfigurations.open(file, revisions, vault, helper),
  }
}
test('preview explains exact Codex changes and writes nothing until approval', async () => {
  const { file, service, revisions } = await fixture()
  expect(service.canRestore()).toBe(false)
  const preview = service.preview(
    'My remote Copilot',
    models[0].id,
    models,
    url,
  )
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect(fs.existsSync(revisions)).toBe(false)
  expect(service.canRestore()).toBe(false)
  expect(preview.before).toBe(original)
  const value = configValue(preview.after)
  expect(value).toMatchObject({
    model: models[0].id,
    model_provider: 'modelbridge',
    model_reasoning_effort: 'none',
  })
  expect(preview.after).toContain('requires_openai_auth = false')
  expect(preview.after).toContain('auth]')
  expect(preview.after).not.toContain('experimental_bearer_token')
  expect(preview.changes.join('\n')).toContain('auth.json')
  expect(preview.changes.join('\n')).toContain('ChatGPT backend')
})
test('activation, revision switching, restart and native restoration preserve unrelated edits and auth', async () => {
  const { directory, file, service, revisions, vault } = await fixture()
  const first = service.preview('GPT configuration', models[0].id, models, url)
  expect((await service.apply(first.id)).active).toBe(first.id)
  const catalog: unknown = JSON.parse(
    fs.readFileSync(first.catalogPath, 'utf8'),
  )
  expect(catalog).toMatchObject({
    models: [{ slug: models[0].id }, { slug: models[1].id }],
  })
  fs.appendFileSync(file, '\n[tools]\nweb_search = false\n')
  const second = service.preview(
    'Claude configuration',
    models[1].id,
    models,
    url,
  )
  await service.apply(second.id)
  const restarted = await CodexConfigurations.open(
    file,
    revisions,
    vault,
    helper,
  )
  expect(restarted.status().revisions).toHaveLength(2)
  expect(restarted.status().effective.model).toBe(models[1].id)
  await restarted.apply(restarted.previewRevision(first.id, models, url).id)
  const restore = restarted.restore()
  expect(restore.after).toContain('model_provider = "openai"')
  await restarted.apply(restore.id)
  expect(restarted.status().active).toBeNull()
  expect(fs.readFileSync(file, 'utf8')).toContain('web_search = false')
  expect(fs.readFileSync(file, 'utf8')).toContain('command = "local-mcp"')
  expect(fs.readFileSync(path.join(directory, 'auth.json'), 'utf8')).toBe(
    'native-account-do-not-touch',
  )
  const stored = JSON.parse(
    fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'),
  ) as Record<string, string>
  expect(
    Object.keys(stored).some((key) => key.startsWith('codex-configurations-')),
  ).toBe(true)
})
test('external edits block configuration but can be reviewed and restored without a model', async () => {
  const { file, service } = await fixture()
  const preview = service.preview('Test', models[0].id, models, url)
  fs.appendFileSync(file, '\n# changed after preview\n')
  await expect(service.apply(preview.id)).rejects.toThrow('changed after')
  expect(service.status().revisions).toHaveLength(0)
  await service.apply(service.preview('Test', models[0].id, models, url).id)
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(models[0].id, 'external-model'),
  )
  expect(service.status().externalManagedEdit).toBe(true)
  expect(() => service.preview('Test', models[0].id, models, url)).toThrow(
    'outside ModelBridge',
  )
  expect(service.canRestore()).toBe(true)
  const restore = service.restore()
  expect(restore.changes.join(' ')).toContain('changed outside ModelBridge')
  expect(restore.before).toContain('external-model')
  expect(restore.after).toContain('native-model')
  fs.appendFileSync(file, '\n# changed after restore preview\n')
  await expect(service.apply(restore.id)).rejects.toThrow('changed after')
  expect(fs.readFileSync(file, 'utf8')).toContain('external-model')
  await service.apply(service.restore().id)
  expect(service.status([])).toMatchObject({
    active: null,
    effective: { model: 'native-model', provider: 'openai' },
  })
  expect(fs.readFileSync(file, 'utf8')).toContain(
    'changed after restore preview',
  )

  fs.writeFileSync(file, original.replace('native-model', 'external-model'))
  await service.reconcile()
  expect(service.status().externalManagedEdit).toBe(false)
  await service.apply(
    service.preview('Reviewed external change', models[1].id, models, url).id,
  )
  expect(service.status().effective.model).toBe(models[1].id)
})

test('restoring Codex removes a ModelBridge-created file but keeps later unrelated settings', async () => {
  const { file, service, revisions, vault } = await fixture()
  fs.unlinkSync(file)
  await service.apply(service.preview('Fresh', models[0].id, models, url).id)
  const preview = service.restore()
  expect(preview.changes.join(' ')).toContain('Remove the configuration file')
  expect(preview.after).toBe('')
  await service.apply(preview.id)
  expect(fs.existsSync(file)).toBe(false)
  const reopened = await CodexConfigurations.open(
    file,
    revisions,
    vault,
    helper,
  )
  expect(reopened.status().active).toBeNull()
  await reopened.apply(reopened.preview('Again', models[0].id, models, url).id)
  fs.appendFileSync(file, '\n[tools]\nweb_search = false\n')
  await reopened.apply(reopened.restore().id)
  expect(configValue(fs.readFileSync(file, 'utf8'))).toEqual({
    tools: { web_search: false },
  })
})

test('Codex rollback does not run the credential check required for setup', async () => {
  const { file, service } = await fixture()
  const setup = service.preview('Codex setup', models[0].id, models, url)
  let checks = 0
  const verify = async () => {
    checks++
    throw new Error('Credential helper is unavailable.')
  }
  await expect(service.apply(setup.id, verify)).rejects.toThrow('unavailable')
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  await service.apply(setup.id)
  await service.apply(service.restore().id, verify)
  expect(checks).toBe(1)
  expect(service.status().effective.model).toBe('native-model')
})
test('status reports when the active Codex model list or default model no longer matches the sources', async () => {
  const { service } = await fixture()
  expect(service.status(models)).toMatchObject({
    catalogStale: false,
    missingModel: false,
  })
  await service.apply(service.preview('GPT', models[0].id, models, url).id)
  expect(service.status(models)).toMatchObject({
    catalogStale: false,
    missingModel: false,
  })
  expect(service.status()).toMatchObject({
    catalogStale: false,
    missingModel: false,
  })
  expect(service.status([models[0]])).toMatchObject({
    catalogStale: true,
    missingModel: false,
  })
  expect(service.status([models[1]])).toMatchObject({
    catalogStale: true,
    missingModel: true,
  })
  await service.apply(service.restore().id)
  expect(service.status([models[1]])).toMatchObject({
    catalogStale: false,
    missingModel: false,
  })
})
test('status flags an active Codex configuration that runs a moved executable or data folder', async () => {
  const { file, vault, revisions, service } = await fixture()
  expect(service.status().pathsStale).toBe(false)
  const applied = service.preview('GPT', models[0].id, models, url)
  await service.apply(applied.id)
  expect(service.status().pathsStale).toBe(false)
  const moved = {
    command: 'D:\\Apps\\ModelBridge\\ModelBridge.exe',
    args: ['--modelbridge-credential', '--user-data-dir=D:\\Data'],
  }
  const installMoved = await CodexConfigurations.open(
    file,
    revisions,
    vault,
    moved,
  )
  expect(installMoved.status().pathsStale).toBe(true)
  const movedRevisions = path.join(path.dirname(revisions), 'moved', 'codex')
  fs.cpSync(revisions, movedRevisions, { recursive: true })
  const dataMoved = await CodexConfigurations.open(
    file,
    movedRevisions,
    vault,
    helper,
  )
  expect(dataMoved.status().pathsStale).toBe(true)
  await dataMoved.apply(dataMoved.previewRevision(applied.id, models, url).id)
  expect(dataMoved.status().pathsStale).toBe(false)
  expect(fs.readFileSync(file, 'utf8')).toContain(
    JSON.stringify(movedRevisions).slice(1, -1),
  )
})
test('concurrent Codex writes are rejected instead of interleaving', async () => {
  const { service } = await fixture()
  const first = service.preview('First', models[0].id, models, url)
  const [applied, reconciling, reapplying] = await Promise.allSettled([
    service.apply(first.id),
    service.reconcile(),
    service.apply(first.id),
  ])
  expect(applied.status === 'fulfilled' && applied.value.active).toBe(first.id)
  for (const result of [reconciling, reapplying])
    expect(result.status === 'rejected' && String(result.reason)).toContain(
      'in progress',
    )
  expect((await service.reconcile()).active).toBeNull()
})
test('unsupported models, malformed config and unowned provider collisions fail before writes', async () => {
  const { file, service } = await fixture()
  expect(() => service.preview('Unknown', 'not-a-model', models, url)).toThrow(
    'available',
  )
  fs.writeFileSync(file, 'model = [broken')
  expect(() => service.status()).toThrow('valid TOML')
  fs.writeFileSync(
    file,
    '[model_providers.modelbridge]\nname="Some other owner"\n',
  )
  expect(() => service.preview('Collision', models[0].id, models, url)).toThrow(
    'not owned',
  )
})
test('preview redacts existing secrets and TOML editing preserves comments, quoted keys and CRLF', () => {
  const text =
    original.replaceAll('\n', '\r\n')
    + '\r\n[model_providers.private]\r\nexperimental_bearer_token = "dont-display-this"\r\nhttp_headers = { Authorization = "dont-display-that" }\r\n'
  const redacted = redactConfig(text)
  expect(redacted).not.toContain('dont-display')
  const changed = configureCodex(text, {
    model: models[0].id,
    url,
    catalogPath: 'C:\\models.json',
    helperCommand: helper.command,
    helperArgs: helper.args,
  })
  expect(changed).toContain('# Native account stays signed in')
  expect(changed).toContain('[projects."C:\\\\work"]')
  expect(changed).toContain('experimental_bearer_token = "dont-display-this"')
  expect(configValue(changed)).toHaveProperty('model_providers.private')
})
test('interrupted committed config is recovered from the encrypted journal, not reset', async () => {
  const { file, service, revisions, vault } = await fixture()
  const preview = service.preview('Recovery', models[0].id, models, url)
  await service.apply(preview.id)
  const marker = fs
    .readdirSync(revisions)
    .find((entry) => entry.endsWith('.managed'))
  if (!marker) throw new Error('Missing revision ownership marker.')
  const id = `codex-configurations-${marker.replace('.managed', '')}`
  const saved = JSON.parse(vault.get(id)) as {
    pending: unknown
    active: string | null
    fingerprint: string
  }
  saved.pending = {
    before: original,
    after: fs.readFileSync(file, 'utf8'),
    revisionId: preview.id,
  }
  saved.active = null
  await vault.set(id, JSON.stringify(saved))
  expect(
    (await CodexConfigurations.open(file, revisions, vault, helper)).status()
      .active,
  ).toBe(preview.id)
})

test('Codex restore preserves an external edit made while its journal is being saved', async () => {
  const { file, service, revisions, vault } = await fixture()
  await service.apply(service.preview('Setup', models[0].id, models, url).id)
  let editDuringSave = false
  const restarted = await CodexConfigurations.open(
    file,
    revisions,
    {
      get: (id) => vault.get(id),
      set: (id, value) => {
        vault.set(id, value)
        if (editDuringSave) {
          editDuringSave = false
          fs.appendFileSync(file, '\n# External edit during journal save\n')
        }
        return Promise.resolve()
      },
      remove: (id) => vault.remove(id),
    },
    helper,
  )
  const before = fs.readFileSync(file, 'utf8')
  const restore = restarted.restore()
  editDuringSave = true
  await expect(restarted.apply(restore.id)).rejects.toThrow('changed after')
  expect(fs.readFileSync(file, 'utf8')).toBe(
    before + '\n# External edit during journal save\n',
  )
  const recovered = await CodexConfigurations.open(
    file,
    revisions,
    vault,
    helper,
  )
  await recovered.apply(recovered.restore().id)
  expect(fs.readFileSync(file, 'utf8')).toContain(
    'External edit during journal save',
  )
})
