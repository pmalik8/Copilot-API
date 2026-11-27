import path from 'node:path'
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
} from 'yaml'
import type { AvailableModel } from '../contracts'

export type DeepSeekProfile = 'web' | 'desktop'

const providerPath = ['llm-pi-ai', 'config', 'providers', 'modelbridge']
const defaultPath = ['agent-default-model', 'config']
export const deepseekPaths = [
  providerPath,
  [...defaultPath, 'provider'],
  [...defaultPath, 'model'],
  [...defaultPath, 'reasoningEffort'],
]

const managedIds = new Set(deepseekPaths.map(([id]) => id))
const lineEnding = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')
function dshHome(env: NodeJS.ProcessEnv, home: string) {
  const override = env.DSH_HOME
  if (!override?.trim()) return path.resolve(home, '.dsh')
  if (override === '~') return path.resolve(home)
  if (/^~[/\\]/u.test(override)) return path.resolve(home, override.slice(2))
  return path.resolve(override)
}

export const deepseekReference = (profile: DeepSeekProfile) =>
  `MODELBRIDGE_DSH_${profile.toUpperCase()}_API_KEY`

export function deepseekFiles(
  env: NodeJS.ProcessEnv,
  home: string,
  profile: DeepSeekProfile,
) {
  const directory = dshHome(env, home)
  return {
    settings: path.join(directory, 'profiles', profile, 'cordis.patch.yml'),
    credentials: {
      file: path.join(directory, '.credentials.yaml'),
      reference: deepseekReference(profile),
    },
  }
}

export function deepseekEntries(
  selected: AvailableModel,
  models: AvailableModel[],
  origin: string,
  reference: string,
) {
  return [
    {
      path: providerPath,
      value: {
        displayName: 'ModelBridge',
        api: 'openai-completions',
        baseURL: `${origin}/v1`,
        apiKeyEnv: reference,
        headers: { 'x-modelbridge-app': 'deepseek' },
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        models: models
          .filter((model) => model.protocols.includes('chat-completions'))
          .map((model) => ({
            id: model.id,
            name: `${model.name} (${model.sourceLabel})`,
            ...(model.contextWindow && { contextWindow: model.contextWindow }),
            ...(model.maxOutputTokens && { maxTokens: model.maxOutputTokens }),
            ...(model.inputModalities && { input: model.inputModalities }),
          })),
      },
    },
    { path: [...defaultPath, 'provider'], value: 'modelbridge' },
    { path: [...defaultPath, 'model'], value: selected.id },
    // Reasoning choices saved for the native provider do not apply to this one.
    { path: [...defaultPath, 'reasoningEffort'], value: undefined },
  ]
}

function patch(text: string) {
  const document: Document = parseDocument(text)
  if (document.errors.length)
    throw new Error('DeepSeek Harness settings are not valid YAML.')
  if (document.contents === null) document.contents = document.createNode([])
  if (!isSeq(document.contents))
    throw new Error('DeepSeek Harness settings must contain a list of patches.')
  const indexes = new Map<string, number>()
  for (const [index, row] of document.contents.items.entries()) {
    const id = isMap(row) && row.get('id')
    if (typeof id !== 'string' || !managedIds.has(id)) continue
    if (indexes.has(id))
      throw new Error(`More than one DeepSeek Harness patch targets ${id}.`)
    indexes.set(id, index)
  }
  // The generic settings backup restores values, not executable YAML nodes.
  for (const [id, ...keys] of deepseekPaths) {
    const index = indexes.get(id)
    if (index === undefined) continue
    const rejectDynamic = (_key: unknown, node: unknown) => {
      if (
        isAlias(node)
        || (node && typeof node === 'object' && 'tag' in node && node.tag)
      )
        throw new Error(
          `A managed DeepSeek Harness setting in ${id} uses a YAML tag or alias.`,
        )
    }
    for (let depth = 1; depth <= keys.length; depth++) {
      const node = document.getIn([index, ...keys.slice(0, depth)], true)
      rejectDynamic(null, node)
      if (depth === keys.length && (isMap(node) || isSeq(node)))
        visit(node, rejectDynamic)
    }
  }
  return { document, indexes, rows: document.contents }
}

// Cordis patches are sequences, but managed rows are addressed by ID so an
// unrelated insertion or reorder cannot change which settings we own.
export const deepseekPatchFormat = {
  read(text: string) {
    const { document, indexes, rows } = patch(text)
    const values = document.toJS() as unknown[]
    return {
      ...Object.fromEntries(
        [...indexes].map(([id, index]) => {
          const row = values[index] as Record<string, unknown>
          const { id: _id, ...fields } = row
          return [id, fields]
        }),
      ),
      ...(rows.items.length !== indexes.size && { otherPatches: true }),
    }
  },
  set(text: string, [id, ...keys]: string[], value: unknown) {
    const { document, indexes, rows } = patch(text)
    const index = indexes.get(id)
    if (index === undefined) rows.add(document.createNode({ id }))
    const target = [index ?? rows.items.length - 1, ...keys]
    if (value === undefined) document.deleteIn(target)
    else document.setIn(target, document.createNode(value))
    return document
      .toString({ lineWidth: 0 })
      .replace(/\r?\n/gu, lineEnding(text))
  },
  preview(text: string) {
    if (!text.trim()) return text
    const { document } = patch(text)
    visit(document, {
      Pair(_key, pair) {
        if (
          isScalar(pair.key)
          && typeof pair.key.value === 'string'
          && /(?:api[_-]?key|auth[_-]?token|secret|password|authorization|^headers)$/iu.test(
            pair.key.value,
          )
        )
          pair.value = document.createNode('<hidden>')
      },
    })
    return document.toString({ lineWidth: 0 })
  },
  lossy: () => false,
}

function credentialDocument(text: string | null) {
  const document = parseDocument(text ?? 'version: 1\n')
  if (
    document.errors.length
    || !isMap(document.contents)
    || document.get('version') !== 1
    || (document.has('refs') && !isMap(document.get('refs', true)))
  )
    throw new Error(
      'DeepSeek Harness credentials require a valid version 1 YAML file. Open DeepSeek Harness to check or upgrade its credential store.',
    )
  return document
}

export function deepseekCredential(text: string | null, reference: string) {
  const document = credentialDocument(text)
  const value = document.getIn(['refs', reference])
  if (value !== undefined && (typeof value !== 'string' || !value))
    throw new Error(
      'The saved ModelBridge reference in DeepSeek Harness is invalid.',
    )
  return { value: value ?? null, hasRefs: document.has('refs') }
}

export function writeDeepseekCredential(
  text: string | null,
  reference: string,
  value: string | null,
  restore?: { created: boolean; refsCreated?: boolean },
) {
  if (text === null && value === null) return null
  const document = credentialDocument(text)
  if (value !== null) document.setIn(['refs', reference], value)
  else {
    document.deleteIn(['refs', reference])
    const refs = document.get('refs', true)
    if (
      restore?.refsCreated !== false
      && isMap(refs)
      && refs.items.length === 0
    )
      document.delete('refs')
    if (
      restore?.created
      && isMap(document.contents)
      && document.contents.items.length === 1
    )
      return null
  }
  return document
    .toString({ lineWidth: 0 })
    .replace(/\r?\n/gu, lineEnding(text ?? ''))
}
