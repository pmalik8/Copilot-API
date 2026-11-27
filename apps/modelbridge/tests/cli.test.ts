import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseCommand,
  commands,
  printableResult,
  cliHelp,
  type CliContext,
} from '../cli/commands'
import { cliDataDirectory, runCli } from '../cli/run'
import { startControlServer } from '../electron/control'
import { CredentialStore } from '@modelbridge/runtime/credentials'

const id = '00000000-0000-4000-8000-000000000001'
const sample = {
  id,
  sources: [],
  models: [{ id: 'source/model' }],
  revisions: [],
  localUrl: 'http://127.0.0.1:4321/v1',
  update: { phase: 'idle' },
  data: { path: 'profile' },
  limits: {},
}
const examples: Record<string, string[]> = {
  status: [],
  models: [],
  'sources list': [],
  'sources add': ['--file', 'source.json', '--key-env', 'TEST_KEY'],
  'sources edit': ['--file', 'changes.json'],
  'sources remove': [id, '--yes'],
  'sources refresh': [id],
  'sources share': ['--file', 'share.json', '--yes'],
  'sources web-search': [id, 'auto'],
  role: ['host'],
  'client-name': ['auto'],
  'copilot login': ['--label', 'Copilot', '--share'],
  'copilot cancel': [],
  'copilot status': [],
  'copilot quota': ['--refresh'],
  'tunnel login': ['github'],
  'tunnel check-login': [],
  'tunnel status': [],
  'tunnel start': ['--yes'],
  'tunnel stop': [],
  'tunnel check': [],
  'tunnel settings': ['--file', 'health.json'],
  'apps list': [],
  'apps status': ['opencode'],
  'apps setup': ['opencode', '--model', 'source/model'],
  'apps restore': ['opencode'],
  'apps apply': ['opencode', id, '--yes'],
  'apps backups': [],
  'codex discover': [],
  'codex select': ['C:\\codex.exe'],
  'codex revisions': [],
  'codex revision': [id],
  'codex acknowledge': ['--yes'],
  usage: ['--range', '7d'],
  'usage clear': ['--yes'],
  'limits show': [],
  'limits set': ['--file', 'limits.json'],
  'keys show': ['local', '--yes'],
  'keys copy': ['remote'],
  'updates check': [],
  'updates status': [],
  'updates install': ['--yes'],
  'data show': [],
  'data move': ['C:\\Data', '--yes'],
  'data open': [],
  open: [],
  stop: ['--yes'],
}

test.each(commands.map((command) => [command.name] as const))(
  'CLI %s delegates to the shared runtime and is described in help',
  async (name) => {
    const calls: unknown[] = []
    const context: CliContext = {
      env: { TEST_KEY: 'synthetic-env-key' },
      readJson: () => Promise.resolve({ label: 'Synthetic source' }),
      call: (channel, value) => {
        calls.push({ channel, value })
        return Promise.resolve(sample)
      },
    }
    const parsed = parseCommand([
      ...name.split(' '),
      ...examples[name],
      '--json',
    ])
    expect(parsed.name).toBe(name)
    expect(parsed.json).toBe(true)
    expect(cliHelp).toContain(name)
    await parsed.execute(context, () => Promise.resolve())
    expect(calls.length > 0 || name === 'apps list').toBe(true)
  },
)

test('CLI validates unknown commands, arguments, confirmations and credentials before changes', async () => {
  for (const args of [
    ['unknown'],
    ['status', 'extra'],
    ['status', '--file', 'x'],
    ['stop'],
    ['apps', 'setup', 'opencode', '--apply'],
    ['request', '--path', '/unknown'],
    ['request', '--path', '/health', 'extra'],
    ['start', '--file', 'x'],
  ])
    expect(() => parseCommand(args)).toThrow()
  const context: CliContext = {
    env: {},
    call: () => Promise.resolve(sample),
    readJson: () => Promise.resolve({}),
  }
  await expect(
    parseCommand([
      'sources',
      'add',
      '--file',
      'x',
      '--key-env',
      'EMPTY',
    ]).execute(context, async () => {}),
  ).rejects.toThrow('empty')
  await expect(
    parseCommand(['sources', 'add']).execute(context, async () => {}),
  ).rejects.toThrow('required')
  await expect(
    parseCommand(['apps', 'status', 'not-an-app']).execute(
      context,
      async () => {},
    ),
  ).rejects.toThrow()
  expect(parseCommand(['--help']).name).toBe('help')
  expect(parseCommand([]).name).toBe('help')
})

test('CLI harness setup and restore keep the exact fresh preview and request conversation', async () => {
  const calls: Array<{ channel: string; value: unknown }> = []
  const context: CliContext = {
    env: {},
    readJson: () =>
      Promise.resolve({
        model: 'exact/model',
        input: [{ role: 'user', content: 'Original history' }],
      }),
    call: (channel, value) => {
      calls.push({ channel, value })
      return Promise.resolve(sample)
    },
  }
  for (const app of ['codex', 'opencode'])
    for (const action of ['setup', 'restore']) {
      const args = ['apps', action, app, '--apply', '--yes']
      if (action === 'setup') args.push('--model', 'exact/model')
      expect(
        await parseCommand(args).execute(context, async () => {}),
      ).toMatchObject({ preview: { id } })
    }
  expect(
    calls
      .filter((item) => item.channel.endsWith('-apply'))
      .map((item) => item.value),
  ).toEqual([id, id, { id, app: 'opencode' }, { id, app: 'opencode' }])
  await parseCommand(['apps', 'status', 'codex']).execute(
    context,
    async () => {},
  )
  await parseCommand(['apps', 'apply', 'codex', id, '--yes']).execute(
    context,
    async () => {},
  )
  await parseCommand([
    'request',
    '--path',
    '/v1/responses',
    '--file',
    '-',
  ]).execute(context, async () => {})
  expect(calls.at(-1)?.value).toMatchObject({
    body: {
      model: 'exact/model',
      input: [{ role: 'user', content: 'Original history' }],
    },
  })
  expect(
    printableResult({
      apiKey: 'secret',
      nested: [{ password: 'secret' }],
      before: 'redacted preview',
    }),
  ).toEqual({
    apiKey: '[redacted]',
    nested: [{ password: '[redacted]' }],
    before: 'redacted preview',
  })
})

test('CLI help works offline, reports unavailable profiles and honors packaged data pointers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cli-unit-'))
  try {
    const output: string[] = []
    const errors: string[] = []
    const io = {
      env: { APPDATA: directory },
      out: (text: string) => {
        output.push(text)
        return Promise.resolve()
      },
      error: (text: string) => {
        errors.push(text)
        return Promise.resolve()
      },
      input: () => Promise.resolve('{}'),
    }
    const launch = {
      executable: path.join(directory, 'ModelBridge.exe'),
      packaged: true,
    }
    expect(await runCli(['--help'], io, launch)).toBe(0)
    expect(output.join('')).toContain('ModelBridge CLI')
    expect(await runCli(['status'], io, launch)).toBe(1)
    expect(errors.join('')).toContain('not running')
    expect(cliDataDirectory(launch, io.env)).toBe(
      path.join(directory, 'ModelBridge'),
    )
    fs.writeFileSync(path.join(directory, 'data-location.txt'), directory)
    expect(cliDataDirectory(launch, io.env)).toBe(directory)
    expect(
      cliDataDirectory(launch, io.env, path.join(directory, 'override')),
    ).toBe(path.join(directory, 'override'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI runner preserves errors, stdin JSON and secret-output intent across real control calls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cli-runner-'))
  const vault = CredentialStore.open(path.join(directory, 'credentials.json'))
  vault.set('cli-access', 'synthetic-admin-key')
  const calls: unknown[] = []
  const server = await startControlServer(
    directory,
    'synthetic-admin-key',
    async (channel, value, emit) => {
      calls.push({ channel, value })
      if (channel === 'modelbridge:local-key')
        return { ok: true, value: 'synthetic-local-key' }
      if (channel === 'modelbridge:playground-send') {
        await emit({ id: 'request', text: 'streamed' })
        return { ok: true, value: { status: 200 } }
      }
      return { ok: true, value: { ...sample, apiKey: 'must-not-display' } }
    },
  )
  const output: string[] = []
  const errors: string[] = []
  let input = '{"model":"exact/model"}'
  const io = {
    env: {},
    out: (text: string) => {
      output.push(text)
      return Promise.resolve()
    },
    error: (text: string) => {
      errors.push(text)
      return Promise.resolve()
    },
    input: () => Promise.resolve(input),
  }
  const launch = { executable: 'unused.exe', packaged: false }
  const run = (args: string[]) =>
    runCli(['--user-data-dir', directory, ...args], io, launch)
  try {
    expect(await run(['start'])).toBe(0)
    expect(await run(['serve'])).toBe(1)
    expect(await run(['status', '--json'])).toBe(0)
    expect(output.join('')).not.toContain('must-not-display')
    expect(
      await run([
        'request',
        '--path',
        '/v1/responses',
        '--file',
        '-',
        '--json',
      ]),
    ).toBe(0)
    expect(output.join('')).toContain('"type":"chunk"')
    expect(await run(['request', '--path', '/health'])).toBe(0)
    expect(await run(['keys', 'show', 'local', '--yes'])).toBe(0)
    expect(output.join('')).toContain('synthetic-local-key')
    input = '{bad'
    expect(await run(['sources', 'add', '--file', '-'])).toBe(1)
    expect(errors.join('')).toContain('valid JSON')
    const file = path.join(directory, 'source.json')
    fs.writeFileSync(file, '{"label":"test"}')
    expect(await run(['sources', 'add', '--file', file])).toBe(0)
    expect(calls.length).toBeGreaterThan(0)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
