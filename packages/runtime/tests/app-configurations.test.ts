import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSON5 from 'json5'
import { parse as parseYaml } from 'yaml'
import {
  AppConfigurations,
  configurableApps,
  redactSecrets,
} from '../src/harnesses/app-configurations'
import { CredentialStore } from '../src/credentials/vault'
import type { AvailableModel } from '../src/contracts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

const model = (id: string, extra: Partial<AvailableModel> = {}) => ({
  id: `host/${id}`,
  name: id,
  sourceId: 'host',
  sourceLabel: 'Remote Copilot',
  protocol: 'messages' as const,
  protocols: ['messages' as const, 'chat-completions' as const],
  ...extra,
})
const models: AvailableModel[] = [
  model('claude-sonnet-4.5'),
  model('claude-opus-4.6', { reasoningEfforts: ['low', 'high'] }),
  model('claude-haiku-4.5'),
  model('claude-haiku-5.5', {
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputModalities: ['text', 'image'],
  }),
  model('gpt-responses-only', {
    protocol: 'responses',
    protocols: ['responses'],
  }),
]
const origin = 'http://127.0.0.1:4321'
const key = 'mb_local_secret_value'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-apps-'))
  directories.push(home)
  const vault = CredentialStore.open(path.join(home, 'credentials.json'))
  const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local') }
  return {
    home,
    vault,
    configurations: new AppConfigurations(vault, env, home),
  }
}

test('Claude Code settings are merged, redacted in preview and fully restored', async () => {
  const { configurations } = fixture()
  const file = configurations.configPath('claude-code')
  const original = `{
  // personal settings
  "theme": "dark",
  "env": { "ANTHROPIC_API_KEY": "sk-ant-personal", "OTHER": "keep" },
}
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, original)

  const preview = configurations.preview('claude-code', {
    modelId: 'host/claude-sonnet-4.5',
    models,
    origin,
    key,
  })
  expect(preview.after).not.toContain(key)
  expect(preview.after).not.toContain('sk-ant-personal')
  expect(preview.before).not.toContain('sk-ant-personal')
  expect(preview.after).toContain('<modelbridge-local-key>')
  await configurations.apply(preview.id)

  const written = fs.readFileSync(file, 'utf8')
  expect(written).toContain('// personal settings')
  const settings = JSON5.parse<{ theme: string; env: Record<string, string> }>(
    written,
  )
  expect(settings.theme).toBe('dark')
  expect(settings.env).toEqual({
    OTHER: 'keep',
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: 'host/claude-sonnet-4.5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'host/claude-opus-4.6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'host/claude-sonnet-4.5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'host/claude-haiku-5.5',
    ANTHROPIC_CUSTOM_HEADERS: 'x-modelbridge-app: claude-code',
  })
  expect(configurations.status('claude-code', models)).toMatchObject({
    configured: true,
    externalEdit: false,
    missingModel: false,
    canRestore: true,
    model: 'host/claude-sonnet-4.5',
  })
  expect(
    configurations.status('claude-code', models.slice(1)).missingModel,
  ).toBe(true)

  await configurations.apply(configurations.restore('claude-code').id)
  expect(JSON5.parse(fs.readFileSync(file, 'utf8'))).toEqual(
    JSON5.parse(original),
  )
  expect(configurations.status('claude-code')).toMatchObject({
    configured: false,
    canRestore: false,
  })
})

test('a settings file ModelBridge created is removed on restore', async () => {
  const { configurations } = fixture()
  const file = configurations.configPath('claude-code')
  const preview = configurations.preview('claude-code', {
    modelId: 'host/claude-haiku-4.5',
    models,
    origin,
    key,
  })
  await configurations.apply(preview.id)
  expect(fs.existsSync(file)).toBe(true)
  const restore = configurations.restore('claude-code')
  expect(restore.after).toBe('')
  await configurations.apply(restore.id)
  expect(fs.existsSync(file)).toBe(false)
})

test.each([...configurableApps])(
  '%s can restore after restart without a model and protects unreadable settings',
  async (app) => {
    const { configurations, home } = fixture()
    const file = configurations.configPath(app)
    expect(configurations.canRestore(app)).toBe(false)
    const preview = configurations.preview(app, {
      modelId: models[0].id,
      models,
      origin,
      key,
    })
    expect(configurations.canRestore(app)).toBe(false)
    await configurations.apply(preview.id)

    const reopened = new AppConfigurations(
      CredentialStore.open(path.join(home, 'credentials.json')),
      { LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
      home,
    )
    expect(reopened.status(app, []).missingModel).toBe(true)
    expect(reopened.canRestore(app)).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, '[invalid')
    expect(reopened.canRestore(app)).toBe(true)
    expect(() => reopened.restore(app)).toThrow('could not be read')
    expect(fs.readFileSync(file, 'utf8')).toBe('[invalid')

    fs.writeFileSync(file, written)
    const restore = reopened.restore(app)
    expect(restore.before).not.toContain(key)
    await reopened.apply(restore.id)
    expect(fs.existsSync(file)).toBe(false)
    expect(reopened.canRestore(app)).toBe(false)
  },
)

test('Hermes YAML keeps comments, replaces the model block and restores it', async () => {
  const { configurations, home } = fixture()
  const file = configurations.configPath('hermes')
  expect(file).toBe(
    process.platform === 'win32' ?
      path.join(home, 'AppData', 'Local', 'hermes', 'config.yaml')
    : path.join(home, '.hermes', 'config.yaml'),
  )
  const original =
    '# my hermes\nmodel:\n  default: gpt-4o\n  provider: openrouter\nproviders:\n  work:\n    api: https://work/v1\n    key_env: WORK_KEY\nterminal:\n  backend: local\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, original)

  const preview = configurations.preview('hermes', {
    modelId: 'host/claude-opus-4.6',
    models,
    origin,
    key,
  })
  expect(preview.after).not.toContain(key)
  await configurations.apply(preview.id)
  const written = fs.readFileSync(file, 'utf8')
  expect(written).toContain('# my hermes')
  const config = parseYaml(written) as Record<string, Record<string, unknown>>
  expect(config.model).toEqual({
    default: 'host/claude-opus-4.6',
    provider: 'custom:modelbridge',
  })
  expect(config.providers.work).toEqual({
    api: 'https://work/v1',
    key_env: 'WORK_KEY',
  })
  expect(config.providers.modelbridge).toMatchObject({
    api: `${origin}/v1`,
    api_key: key,
    transport: 'chat_completions',
    discover_models: false,
    extra_headers: { 'x-modelbridge-app': 'hermes' },
  })
  expect(
    (config.providers.modelbridge as { models: string[] }).models,
  ).not.toContain('host/gpt-responses-only')
  expect(() =>
    configurations.preview('hermes', {
      modelId: 'host/gpt-responses-only',
      models,
      origin,
      key,
    }),
  ).toThrow('Choose an available model')

  await configurations.apply(configurations.restore('hermes').id)
  expect(parseYaml(fs.readFileSync(file, 'utf8'))).toEqual(parseYaml(original))
})

test('OpenClaw JSON5 is rewritten with a warning and a string model is restored', async () => {
  const { configurations } = fixture()
  const file = configurations.configPath('openclaw')
  const original = `{
  // JSON5 features
  gateway: { port: 18789 },
  agents: { defaults: { model: 'anthropic/claude' } },
}
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, original)
  const preview = configurations.preview('openclaw', {
    modelId: 'host/claude-haiku-5.5',
    models,
    origin,
    key,
  })
  expect(preview.warnings[0]).toContain('JSON5')
  await configurations.apply(preview.id)
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    gateway: unknown
    agents: { defaults: { model: { primary: string } } }
    models: { providers: { modelbridge: Record<string, unknown> } }
  }
  expect(config.gateway).toEqual({ port: 18789 })
  expect(config.agents.defaults.model.primary).toBe(
    'modelbridge/host/claude-haiku-5.5',
  )
  const provider = config.models.providers.modelbridge
  expect(provider).toMatchObject({
    baseUrl: `${origin}/v1`,
    apiKey: key,
    api: 'openai-completions',
    headers: { 'x-modelbridge-app': 'openclaw' },
  })
  expect(provider.models).toContainEqual({
    id: 'host/claude-haiku-5.5',
    name: 'claude-haiku-5.5 (Remote Copilot)',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  })

  await configurations.apply(configurations.restore('openclaw').id)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(
    JSON5.parse(original),
  )
})

test('restoring an original OpenClaw scalar never discards later fallback settings', async () => {
  const { configurations } = fixture()
  const file = configurations.configPath('openclaw')
  const original = {
    agents: { defaults: { model: 'anthropic/claude' } },
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(original))
  const preview = configurations.preview('openclaw', {
    modelId: 'host/claude-haiku-5.5',
    models,
    origin,
    key,
  })
  await configurations.apply(preview.id)
  const applied = fs.readFileSync(file, 'utf8')
  const withFallback = applied.replace(
    '"primary": "modelbridge/host/claude-haiku-5.5"',
    '"primary": "modelbridge/host/claude-haiku-5.5", "fallbacks": ["native/fallback"]',
  )
  expect(withFallback).not.toBe(applied)
  fs.writeFileSync(file, withFallback)
  expect(() => configurations.restore('openclaw')).toThrow(
    'would overwrite other settings',
  )
  expect(fs.readFileSync(file, 'utf8')).toBe(withFallback)
  expect(configurations.canRestore('openclaw')).toBe(true)
  fs.writeFileSync(file, applied)
  await configurations.apply(configurations.restore('openclaw').id)
  expect(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown).toEqual(original)
})

test('external edits are detected and stale previews never overwrite', async () => {
  const { configurations } = fixture()
  const file = configurations.configPath('claude-code')
  const preview = configurations.preview('claude-code', {
    modelId: 'host/claude-sonnet-4.5',
    models,
    origin,
    key,
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"theme":"light"}')
  await expect(configurations.apply(preview.id)).rejects.toThrow(
    'changed after',
  )

  await configurations.apply(
    configurations.preview('claude-code', {
      modelId: 'host/claude-sonnet-4.5',
      models,
      origin,
      key,
    }).id,
  )
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    env: Record<string, string>
  }
  settings.env.ANTHROPIC_MODEL = 'something-else'
  fs.writeFileSync(file, JSON.stringify(settings))
  expect(configurations.status('claude-code')).toMatchObject({
    configured: false,
    externalEdit: true,
  })

  const restore = configurations.restore('claude-code')
  expect(restore.warnings.join(' ')).toContain('changed outside ModelBridge')
  await configurations.apply(restore.id)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    theme: 'light',
  })
})

test('unreadable settings are reported instead of overwritten', () => {
  const { configurations } = fixture()
  const file = configurations.configPath('hermes')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'model: [unclosed\n')
  expect(configurations.status('hermes').error).toContain('YAML')
  expect(() =>
    configurations.preview('hermes', {
      modelId: 'host/claude-sonnet-4.5',
      models,
      origin,
      key,
    }),
  ).toThrow('could not be read')
})

test('redaction masks secrets in every supported format', () => {
  expect(redactSecrets('api_key: abc123\nname: x')).toBe(
    'api_key: ••••••••\nname: x',
  )
  expect(redactSecrets('"apiKey": "abc"')).toBe('"apiKey": "••••••••"')
  expect(redactSecrets('"ANTHROPIC_AUTH_TOKEN": "zzz"', 'zzz')).toBe(
    '"ANTHROPIC_AUTH_TOKEN": "<modelbridge-local-key>"',
  )
  expect(redactSecrets('max_tokens: 100')).toBe('max_tokens: 100')
})

test('an explicitly targeted apply cannot use another harness preview', async () => {
  const { configurations } = fixture()
  const preview = configurations.preview('opencode', {
    modelId: models[0].id,
    models,
    origin,
    key,
  })
  await expect(configurations.apply(preview.id, 'hermes')).rejects.toThrow(
    'different app',
  )
  expect(configurations.canRestore('opencode')).toBe(false)
  expect(fs.existsSync(configurations.configPath('opencode'))).toBe(false)
  await configurations.apply(preview.id, 'opencode')
  expect(configurations.status('opencode').configured).toBe(true)
})

test('restore previews hide entire bearer tokens and multiline YAML secrets', async () => {
  const { configurations } = fixture()
  const claude = configurations.configPath('claude-code')
  fs.mkdirSync(path.dirname(claude), { recursive: true })
  fs.writeFileSync(
    claude,
    '{"env":{"ANTHROPIC_AUTH_TOKEN":"Bearer synthetic-token with spaces"}}',
  )
  const preview = configurations.preview('claude-code', {
    modelId: models[0].id,
    models,
    origin,
    key,
  })
  expect(preview.before).not.toContain('synthetic-token')
  await configurations.apply(preview.id)
  const restore = configurations.restore('claude-code')
  expect(restore.after).not.toContain('synthetic-token')

  const hermes = configurations.configPath('hermes')
  fs.mkdirSync(path.dirname(hermes), { recursive: true })
  fs.writeFileSync(
    hermes,
    'providers:\n  modelbridge:\n    api_key: |\n      synthetic-multiline-token\n      second-secret-line\n',
  )
  const yamlPreview = configurations.preview('hermes', {
    modelId: models[0].id,
    models,
    origin,
    key,
  })
  expect(yamlPreview.before).not.toContain('synthetic-multiline-token')
  expect(yamlPreview.before).not.toContain('second-secret-line')
})

test.each([...configurableApps])(
  '%s keeps the original backup across repeated setup and restore preserves later edits',
  async (app) => {
    const { home, vault, configurations } = fixture()
    const file = configurations.configPath(app)
    const isYaml = app === 'hermes' || app.startsWith('deepseek')
    const original =
      app === 'hermes' ?
        'model:\n  default: native-model\n  provider: native\nterminal:\n  backend: local\n'
      : app.startsWith('deepseek') ?
        '- id: agent-default-model\n  config:\n    provider: native\n    model: native-model\n    reasoningEffort: high\n'
      : app === 'openclaw' ?
        '{"agents":{"defaults":{"model":{"primary":"native/model"}}},"gateway":{"port":1234}}'
      : app === 'opencode' ?
        '{"model":"native/model","providers":{"native":{"name":"Native provider"}}}'
      : '{"env":{"ANTHROPIC_MODEL":"native-model","ANTHROPIC_API_KEY":"synthetic-native-key"},"theme":"light"}'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, original)
    for (const model of models.slice(0, 2))
      await configurations.apply(
        configurations.preview(app, {
          modelId: model.id,
          models,
          origin,
          key,
        }).id,
      )
    const updated = fs.readFileSync(file, 'utf8')
    const parse = (text: string): unknown =>
      isYaml ? parseYaml(text) : JSON5.parse(text)
    const extra =
      app.startsWith('deepseek') ?
        '- id: later-user-setting\n  disabled: true\n'
      : app === 'hermes' ? 'later_user_setting: keep\n'
      : ''
    const expected =
      isYaml ?
        parse(original + extra)
      : {
          ...(parse(original) as Record<string, unknown>),
          laterUserSetting: 'keep',
        }
    fs.writeFileSync(
      file,
      isYaml ?
        updated + extra
      : JSON.stringify({
          ...(parse(updated) as Record<string, unknown>),
          laterUserSetting: 'keep',
        }),
    )
    const restarted = new AppConfigurations(
      vault,
      { LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
      home,
    )
    await restarted.apply(restarted.restore(app).id)
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual(expected)
    expect(restarted.canRestore(app)).toBe(false)
  },
)
