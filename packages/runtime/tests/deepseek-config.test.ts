import { afterEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { CredentialStore } from '../src/credentials/vault'
import { AppConfigurations } from '../src/harnesses/app-configurations'
import type { AvailableModel } from '../src/contracts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

const route: AvailableModel = {
  id: 'source-id/gpt-model',
  name: 'GPT Model',
  sourceId: 'source-id',
  sourceLabel: 'Copilot',
  protocol: 'responses',
  protocols: ['responses', 'chat-completions'],
  contextWindow: 120_000,
  maxOutputTokens: 8192,
  inputModalities: ['text', 'image'],
}
const incompatible: AvailableModel = {
  ...route,
  id: 'source-id/messages-only',
  protocol: 'messages',
  protocols: ['messages'],
}
const options = {
  modelId: route.id,
  models: [route, incompatible],
  origin: 'http://127.0.0.1:4321',
  key: 'synthetic-modelbridge-key',
}
const webRef = 'MODELBRIDGE_DSH_WEB_API_KEY'
const desktopRef = 'MODELBRIDGE_DSH_DESKTOP_API_KEY'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-dsh-'))
  directories.push(home)
  const env = { DSH_HOME: path.join(home, 'DeepSeek profile') }
  const vault = CredentialStore.open(path.join(home, 'credentials.json'))
  const open = () => new AppConfigurations(vault, env, home)
  const configurations = open()
  return {
    home,
    vault,
    open,
    configurations,
    settings: configurations.configPath('deepseek'),
    secrets: path.join(env.DSH_HOME, '.credentials.yaml'),
  }
}

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const read = (file: string) => fs.readFileSync(file, 'utf8')
const yaml = (file: string): unknown =>
  parse(read(file), { logLevel: 'silent' })

test('DeepSeek Web config uses exact routes and preserves native settings and credentials', async () => {
  const { settings, secrets, configurations, open } = fixture()
  const original = `# Existing provider
- id: llm-pi-ai
  config:
    providers:
      native:
        api: openai-completions
        apiKeyEnv: NATIVE_API_KEY
        headers:
          arbitrary-auth-header: synthetic-header-secret
- id: agent-default-model
  config:
    provider: native
    model: native-model
    reasoningEffort: high
- id: unrelated
  disabled: !!js "ctx.someFlag"
`
  const savedCredentials = `version: 1
# Unrelated key
refs:
  NATIVE_API_KEY: synthetic-native-key
  ${webRef}: previous-web-key
`
  write(settings, original)
  write(secrets, savedCredentials)

  const preview = configurations.preview('deepseek', options)
  expect(preview.after).toContain('apiKeyEnv: MODELBRIDGE_DSH_WEB_API_KEY')
  const reviewed = JSON.stringify(preview)
  for (const secret of [
    options.key,
    'synthetic-native-key',
    'previous-web-key',
    'synthetic-header-secret',
  ])
    expect(reviewed).not.toContain(secret)
  expect(read(settings)).toBe(original)
  expect(read(secrets)).toBe(savedCredentials)
  await configurations.apply(preview.id)
  expect(read(settings)).toContain('# Existing provider')
  expect(read(settings)).toContain('!!js "ctx.someFlag"')
  expect(read(settings)).not.toContain(options.key)
  expect(yaml(settings)).toMatchObject([
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          native: {
            api: 'openai-completions',
            apiKeyEnv: 'NATIVE_API_KEY',
            headers: { 'arbitrary-auth-header': 'synthetic-header-secret' },
          },
          modelbridge: {
            baseURL: `${options.origin}/v1`,
            api: 'openai-completions',
            apiKeyEnv: webRef,
            headers: { 'x-modelbridge-app': 'deepseek' },
            compat: {
              supportsDeveloperRole: false,
              maxTokensField: 'max_tokens',
            },
            models: [
              {
                id: route.id,
                name: 'GPT Model (Copilot)',
                contextWindow: 120_000,
                maxTokens: 8192,
                input: ['text', 'image'],
              },
            ],
          },
        },
      },
    },
    {
      id: 'agent-default-model',
      config: { provider: 'modelbridge', model: route.id },
    },
    { id: 'unrelated' },
  ])
  expect(read(settings)).not.toMatch(/messages-only|reasoningEffort/u)
  expect(read(secrets)).toContain('# Unrelated key')
  expect(yaml(secrets)).toEqual({
    version: 1,
    refs: { NATIVE_API_KEY: 'synthetic-native-key', [webRef]: options.key },
  })

  const restarted = open()
  expect(restarted.status('deepseek', [route])).toMatchObject({
    configured: true,
    model: route.id,
    missingModel: false,
  })
  expect(restarted.status('deepseek', [incompatible]).missingModel).toBe(true)
  expect(() =>
    restarted.preview('deepseek', { ...options, modelId: incompatible.id }),
  ).toThrow('Choose an available model')
  fs.appendFileSync(settings, '- id: later-edit\n  disabled: true\n')
  await restarted.apply(restarted.restore('deepseek').id)
  expect(yaml(settings)).toEqual(
    parse(`${original}- id: later-edit\n  disabled: true\n`, {
      logLevel: 'silent',
    }),
  )
  expect(yaml(secrets)).toEqual(parse(savedCredentials))
})

test('Web and Desktop setups use independent references in the same store', async () => {
  const { home, vault, settings, secrets, configurations } = fixture()
  expect(new AppConfigurations(vault, {}, home).configPath('deepseek')).toBe(
    path.join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  )
  expect(
    new AppConfigurations(vault, { DSH_HOME: '~/custom' }, home).configPath(
      'deepseek',
    ),
  ).toBe(path.join(home, 'custom', 'profiles', 'web', 'cordis.patch.yml'))
  const desktop = configurations.configPath('deepseek-desktop')
  expect(desktop).toBe(
    path.join(
      path.dirname(path.dirname(settings)),
      'desktop',
      'cordis.patch.yml',
    ),
  )
  await configurations.apply(configurations.preview('deepseek', options).id)
  await configurations.apply(
    configurations.preview('deepseek-desktop', options).id,
  )
  expect(yaml(secrets)).toMatchObject({
    refs: { [webRef]: options.key, [desktopRef]: options.key },
  })
  expect(read(desktop)).toContain(desktopRef)
  await configurations.apply(configurations.restore('deepseek-desktop').id)
  expect(fs.existsSync(desktop)).toBe(false)
  expect(configurations.status('deepseek').configured).toBe(true)
  expect(yaml(secrets)).toEqual({ version: 1, refs: { [webRef]: options.key } })
  await configurations.apply(configurations.restore('deepseek').id)
  expect(fs.existsSync(settings)).toBe(false)
  expect(fs.existsSync(secrets)).toBe(false)
})

for (const original of [null, 'version: 1\n', 'version: 1\nrefs: {}\n']) {
  test(`DeepSeek can restore Web first and recover the original credential store (${JSON.stringify(original)})`, async () => {
    const { secrets, configurations, open } = fixture()
    if (original !== null) write(secrets, original)
    await configurations.apply(configurations.preview('deepseek', options).id)
    await configurations.apply(
      configurations.preview('deepseek-desktop', options).id,
    )
    const restarted = open()
    await restarted.apply(restarted.restore('deepseek').id)
    expect(yaml(secrets)).toEqual({
      version: 1,
      refs: { [desktopRef]: options.key },
    })
    expect(restarted.status('deepseek-desktop').configured).toBe(true)
    await restarted.apply(restarted.restore('deepseek-desktop').id)
    if (original === null) expect(fs.existsSync(secrets)).toBe(false)
    else expect(yaml(secrets)).toEqual(parse(original))
  })
}

test('DeepSeek previews reject changes to either file and detect changed credentials', async () => {
  const { settings, secrets, configurations } = fixture()
  const first = configurations.preview('deepseek', options)
  write(secrets, 'version: 1\nrefs:\n  UNRELATED: keep\n')
  await expect(configurations.apply(first.id)).rejects.toThrow('changed after')
  expect(fs.existsSync(settings)).toBe(false)
  expect(configurations.status('deepseek').canRestore).toBe(false)
  const second = configurations.preview('deepseek', options)
  write(settings, '- id: unrelated\n')
  await expect(configurations.apply(second.id)).rejects.toThrow('changed after')
  expect(read(secrets)).not.toContain(webRef)
  await configurations.apply(configurations.preview('deepseek', options).id)
  const restore = configurations.restore('deepseek')
  write(secrets, read(secrets).replace(options.key, 'outside-edit'))
  expect(configurations.status('deepseek').externalEdit).toBe(true)
  await expect(configurations.apply(restore.id)).rejects.toThrow(
    'changed after',
  )
  expect(read(settings)).toContain('modelbridge')
})

test('DeepSeek setup rolls back the credential write when the profile write fails', async () => {
  const { settings, secrets, configurations } = fixture()
  const preview = configurations.preview('deepseek', options)
  const rename = fs.renameSync
  const stub = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === settings) throw new Error('simulated profile write error')
    return rename(from, to)
  })
  try {
    await expect(configurations.apply(preview.id)).rejects.toThrow(
      'simulated profile write error',
    )
  } finally {
    stub.mockRestore()
  }
  expect(fs.existsSync(settings)).toBe(false)
  expect(fs.existsSync(secrets)).toBe(false)
  await configurations.apply(configurations.preview('deepseek', options).id)
  expect(configurations.status('deepseek').configured).toBe(true)
})

test('a failed DeepSeek credential restore rolls the profile back and preserves its backup', async () => {
  const { configurations, settings, secrets } = fixture()
  write(
    secrets,
    'version: 1\nrefs:\n  UNRELATED: synthetic-unrelated-key\nrecords:\n  native/account:\n    kind: grant\n    payload:\n      access: synthetic-native-grant\n',
  )
  await configurations.apply(configurations.preview('deepseek', options).id)
  const configuredSettings = read(settings)
  const configuredSecrets = read(secrets)
  const preview = configurations.restore('deepseek')
  const rename = fs.renameSync
  const stub = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === secrets) throw new Error('simulated credential restore failure')
    return rename(from, to)
  })
  try {
    await expect(configurations.apply(preview.id)).rejects.toThrow(
      'simulated credential restore failure',
    )
  } finally {
    stub.mockRestore()
  }
  expect(read(settings)).toBe(configuredSettings)
  expect(read(secrets)).toBe(configuredSecrets)
  expect(configurations.canRestore('deepseek')).toBe(true)
  await configurations.apply(configurations.restore('deepseek').id)
  expect(fs.existsSync(settings)).toBe(false)
  expect(yaml(secrets)).toEqual({
    version: 1,
    refs: { UNRELATED: 'synthetic-unrelated-key' },
    records: {
      'native/account': {
        kind: 'grant',
        payload: { access: 'synthetic-native-grant' },
      },
    },
  })
})

test('DeepSeek refuses ambiguous or malformed YAML without reporting credential contents', () => {
  const { settings, secrets, configurations } = fixture()
  write(settings, 'not: a-sequence\n')
  expect(configurations.status('deepseek').error).toContain('list of patches')
  write(settings, '- id: llm-pi-ai\n- id: llm-pi-ai\n')
  expect(configurations.status('deepseek').error).toContain('More than one')
  write(settings, '- id: agent-default-model\n  config: !!js "ctx.selection"\n')
  expect(configurations.status('deepseek').error).toContain('YAML tag or alias')
  write(settings, '- id: unrelated\n')
  write(secrets, 'version: 1\nrefs: [synthetic-secret\n')
  expect(configurations.status('deepseek').error).toContain('version 1 YAML')
  expect(configurations.status('deepseek').error).not.toContain(
    'synthetic-secret',
  )
  expect(() => configurations.preview('deepseek', options)).toThrow(
    'version 1 YAML',
  )
})
