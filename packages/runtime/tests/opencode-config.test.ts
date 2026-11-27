import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'jsonc-parser'
import { CredentialStore } from '../src/credentials/vault'
import { AppConfigurations } from '../src/harnesses/app-configurations'
import type { AvailableModel } from '../src/contracts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

const models: AvailableModel[] = [
  {
    id: 'source/gpt-test',
    name: 'GPT Test',
    sourceId: 'source',
    sourceLabel: 'Synthetic Copilot',
    protocol: 'responses',
    protocols: ['responses', 'chat-completions'],
    supportsTools: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    reasoningEfforts: ['none', 'low', 'high'],
    inputModalities: ['text', 'image'],
  },
  {
    id: 'source/text-test',
    name: 'Text Test',
    sourceId: 'source',
    sourceLabel: 'Synthetic Copilot',
    protocol: 'chat-completions',
    protocols: ['chat-completions'],
    supportsTools: false,
    reasoningEfforts: [],
  },
  {
    id: 'source/messages-only',
    name: 'Messages only',
    sourceId: 'source',
    sourceLabel: 'Synthetic Copilot',
    protocol: 'messages',
    protocols: ['messages'],
  },
]
const options = {
  models,
  modelId: models[0].id,
  origin: 'http://127.0.0.1:4321',
  key: 'synthetic-local-opencode-key',
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-opencode-config-'))
  directories.push(home)
  const vault = CredentialStore.open(path.join(home, 'credentials.json'))
  const configurations = new AppConfigurations(vault, {}, home)
  return {
    home,
    vault,
    configurations,
    file: configurations.configPath('opencode'),
  }
}

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const read = (file: string) => fs.readFileSync(file, 'utf8')
const value = (file: string): unknown => parse(read(file))

test('OpenCode JSONC setup retains comments, native providers and restores the exact managed values', async () => {
  const { home, vault, configurations, file } = fixture()
  const original = `{
  // My native provider
  "model": { "providerID": "native", "model": "original-model" },
  "providers": {
    "native": { "settings": { "apiKey": "synthetic-native-token" } },
    "modelbridge": { "name": "Previous custom settings" },
  },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
}
`
  write(file, original)
  const auth = path.join(home, 'native-auth.json')
  write(auth, 'synthetic-native-sign-in-do-not-change')
  const preview = configurations.preview('opencode', options)
  expect(read(file)).toBe(original)
  for (const text of [preview.before, preview.after])
    expect(text).not.toContain('synthetic-native-token')
  expect(preview.after).not.toContain(options.key)
  expect(preview.after).toContain('<modelbridge-local-key>')
  await configurations.apply(preview.id)
  expect(read(file)).toContain('// My native provider')
  expect(value(file)).toMatchObject({
    model: 'modelbridge/source/gpt-test',
    providers: {
      native: { settings: { apiKey: 'synthetic-native-token' } },
      modelbridge: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: {
          baseURL: `${options.origin}/v1`,
          apiKey: options.key,
          transport: 'http',
          encoding: 'none',
          timeout: false,
        },
        headers: { 'x-modelbridge-app': 'opencode' },
        models: {
          'source/gpt-test': {
            modelID: 'source/gpt-test',
            capabilities: {
              tools: true,
              input: ['text', 'image'],
              reasoning: {
                supported: true,
                toggle: true,
                effort: ['low', 'high'],
              },
            },
            limit: { context: 128_000, output: 16_384 },
          },
          'source/text-test': {
            capabilities: { tools: false, reasoning: { supported: false } },
            limit: { context: 32_000, output: 8192 },
          },
        },
      },
    },
  })
  expect(read(file)).not.toContain('messages-only')
  const restarted = new AppConfigurations(vault, {}, home)
  expect(restarted.status('opencode', models)).toMatchObject({
    configured: true,
    model: 'modelbridge/source/gpt-test',
    missingModel: false,
  })
  expect(restarted.status('opencode', []).missingModel).toBe(true)
  await restarted.apply(restarted.restore('opencode').id)
  expect(value(file)).toEqual(parse(original))
  expect(read(file)).toContain('// My native provider')
  expect(read(auth)).toBe('synthetic-native-sign-in-do-not-change')
})

test('OpenCode resolves the shared global config with custom directory and XDG overrides', () => {
  const { home, vault, configurations, file } = fixture()
  expect(file).toBe(path.join(home, '.config', 'opencode', 'opencode.jsonc'))
  const json = path.join(path.dirname(file), 'opencode.json')
  write(json, '{"model":"native/original"}')
  expect(configurations.configPath('opencode')).toBe(json)
  write(file, '{/* takes precedence */}')
  expect(configurations.configPath('opencode')).toBe(file)
  expect(
    new AppConfigurations(
      vault,
      {
        XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
      },
      home,
    ).configPath('opencode'),
  ).toBe(path.join(home, 'xdg-config', 'opencode', 'opencode.jsonc'))
  expect(
    new AppConfigurations(
      vault,
      {
        XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
        OPENCODE_CONFIG_DIR: path.join(home, 'custom-config'),
      },
      home,
    ).configPath('opencode'),
  ).toBe(path.join(home, 'custom-config', 'opencode.jsonc'))
})

test('OpenCode restore detects external edits and refuses previews stale after either setup or restore', async () => {
  const { configurations, file } = fixture()
  const preview = configurations.preview('opencode', options)
  write(file, '{"model":"native/changed"}')
  await expect(configurations.apply(preview.id)).rejects.toThrow(
    'changed after',
  )
  expect(configurations.canRestore('opencode')).toBe(false)
  await configurations.apply(configurations.preview('opencode', options).id)
  write(
    file,
    read(file).replace('modelbridge/source/gpt-test', 'native/outside-edit'),
  )
  expect(configurations.status('opencode').externalEdit).toBe(true)
  const restore = configurations.restore('opencode')
  expect(restore.warnings.join(' ')).toContain('changed outside')
  fs.appendFileSync(file, '\n// Later user edit\n')
  await expect(configurations.apply(restore.id)).rejects.toThrow(
    'changed after',
  )
  expect(read(file)).toContain('native/outside-edit')
  await configurations.apply(configurations.restore('opencode').id)
  expect(value(file)).toEqual({ model: 'native/changed' })
  expect(read(file)).toContain('// Later user edit')
})

test('OpenCode restores the file it managed when a different global file appears', async () => {
  const { home, vault, configurations, file } = fixture()
  const json = path.join(path.dirname(file), 'opencode.json')
  const original = '{"model":"native/original"}'
  write(json, original)
  await configurations.apply(configurations.preview('opencode', options).id)
  const other = '{ /* New config */ "model": "native/other" }'
  write(file, other)

  const restarted = new AppConfigurations(vault, {}, home)
  expect(restarted.canRestore('opencode')).toBe(true)
  expect(restarted.status('opencode')).toMatchObject({
    configured: false,
    externalEdit: true,
  })
  expect(() => restarted.preview('opencode', options)).toThrow(
    'Restore the previously managed file',
  )
  const restore = restarted.restore('opencode')
  expect(restore.configPath).toBe(json)
  await restarted.apply(restore.id)
  expect(value(json)).toEqual(parse(original))
  expect(read(file)).toBe(other)
  expect(restarted.configPath('opencode')).toBe(file)
})

test('OpenCode setup rejects a preview if the selected config file changes', async () => {
  const { configurations, file } = fixture()
  const json = path.join(path.dirname(file), 'opencode.json')
  const original = '{"model":"native/original"}'
  write(json, original)
  const preview = configurations.preview('opencode', options)
  const other = '{ /* New config */ }'
  write(file, other)
  await expect(configurations.apply(preview.id)).rejects.toThrow(
    'target changed',
  )
  expect(read(json)).toBe(original)
  expect(read(file)).toBe(other)
  expect(configurations.canRestore('opencode')).toBe(false)
})

test('OpenCode rejects malformed settings and incompatible routes without changing files', () => {
  const { configurations, file } = fixture()
  write(file, '{ "apiKey": "synthetic-secret", "broken": [ }')
  expect(configurations.status('opencode').error).not.toContain(
    'synthetic-secret',
  )
  expect(() => configurations.preview('opencode', options)).toThrow(
    'could not be read',
  )
  expect(read(file)).toContain('synthetic-secret')
  write(file, '{}')
  expect(() =>
    configurations.preview('opencode', {
      ...options,
      modelId: models[2].id,
    }),
  ).toThrow('Choose an available model')
  expect(read(file)).toBe('{}')
})
