import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  configurableApps,
  configurableAppSchema,
} from '@modelbridge/runtime/apps'
import { roleSchema } from '@modelbridge/runtime/contracts'
import { usageRanges } from '@modelbridge/runtime/usage'
import type { Channel, EmitChunk } from '../electron/channels'

export interface CliContext {
  call(channel: Channel, value?: unknown, emit?: EmitChunk): Promise<unknown>
  readJson(file: string): Promise<unknown>
  env: NodeJS.ProcessEnv
}
type Flags = Record<string, string | boolean | undefined>
interface Input {
  args: string[]
  flags: Flags
}
interface Command {
  name: string
  usage: string
  description: string
  arguments: number
  flags?: string[]
  confirm?: boolean
  run(context: CliContext, input: Input): Promise<unknown>
}
const required = (flags: Flags, name: string) => {
  const value = flags[name]
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`--${name} is required.`)
  return value
}
const object = z.record(z.string(), z.unknown())
const appId = (value: string) =>
  value === 'codex' ? value : configurableAppSchema.parse(value)
const statusFields = (value: unknown, field: string) =>
  object.parse(value)[field]

function action(
  name: string,
  usage: string,
  description: string,
  channel: Channel,
  value: (input: Input) => unknown = () => undefined,
  options: Pick<Command, 'arguments' | 'flags' | 'confirm'> = { arguments: 0 },
): Command {
  return {
    name,
    usage,
    description,
    ...options,
    run: (context, input) => context.call(channel, value(input)),
  }
}

async function harnessPreview(
  context: CliContext,
  input: Input,
  restore: boolean,
) {
  const app = appId(input.args[0])
  let preview: unknown
  if (app === 'codex') {
    if (!restore) await context.call('modelbridge:codex-discover')
    preview = await context.call(
      restore ? 'modelbridge:codex-restore' : 'modelbridge:codex-preview',
      restore ? undefined : (
        {
          label: input.flags.label ?? 'ModelBridge CLI',
          modelId: required(input.flags, 'model'),
        }
      ),
    )
  } else
    preview = await context.call(
      restore ?
        'modelbridge:app-config-restore'
      : 'modelbridge:app-config-preview',
      restore ? app : { app, modelId: required(input.flags, 'model') },
    )
  if (!input.flags.apply) return preview
  // --apply --yes explicitly approves exactly the freshly generated preview.
  const id = z.object({ id: z.string().uuid() }).parse(preview).id
  const result = await context.call(
    app === 'codex' ?
      'modelbridge:codex-apply'
    : 'modelbridge:app-config-apply',
    app === 'codex' ? id : { id, app },
  )
  return { preview, result }
}

export const commands: Command[] = [
  action(
    'status',
    'status',
    'Runtime, profile, sources and sharing status.',
    'modelbridge:status',
  ),
  {
    name: 'models',
    usage: 'models',
    description: 'List exact source-qualified models.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:status'), 'models'),
  },
  {
    name: 'sources list',
    usage: 'sources list',
    description: 'List providers and connected hosts.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:status'), 'sources'),
  },
  {
    name: 'sources add',
    usage: 'sources add --file <source.json> [--key-env <NAME>]',
    description: 'Add a provider or remote host; verifies discovery first.',
    arguments: 0,
    flags: ['file', 'key-env'],
    run: async (context, { flags }) => {
      const input = object.parse(
        await context.readJson(required(flags, 'file')),
      )
      const keyName = flags['key-env']
      if (typeof keyName === 'string') {
        const key = context.env[keyName]
        if (!key)
          throw new Error(`The ${keyName} environment variable is empty.`)
        input.apiKey = key
      }
      return context.call('modelbridge:add-source', input)
    },
  },
  {
    name: 'sources edit',
    usage: 'sources edit --file <changes.json>',
    description: 'Verify changes and keep the source identity.',
    arguments: 0,
    flags: ['file'],
    run: async (context, { flags }) =>
      context.call(
        'modelbridge:update-source',
        await context.readJson(required(flags, 'file')),
      ),
  },
  action(
    'sources remove',
    'sources remove <source-id> --yes',
    'Remove a source and its saved credential.',
    'modelbridge:remove-source',
    ({ args }) => args[0],
    { arguments: 1, confirm: true },
  ),
  action(
    'sources refresh',
    'sources refresh <source-id>',
    'Check the source and refresh its models.',
    'modelbridge:refresh-source',
    ({ args }) => args[0],
    { arguments: 1 },
  ),
  {
    name: 'sources share',
    usage: 'sources share --file <selection.json> --yes',
    description: 'Select sources and models allowed on the sharing listener.',
    arguments: 0,
    flags: ['file'],
    confirm: true,
    run: async (context, { flags }) =>
      context.call(
        'modelbridge:share-source',
        await context.readJson(required(flags, 'file')),
      ),
  },
  action(
    'sources web-search',
    'sources web-search <source-id> <model-id|auto>',
    'Select the Copilot web-search helper.',
    'modelbridge:web-search-model',
    ({ args }) => ({
      sourceId: args[0],
      modelId: args[1] === 'auto' ? null : args[1],
    }),
    { arguments: 2 },
  ),
  action(
    'role',
    'role <host|client>',
    'Change the layout role without deleting connections.',
    'modelbridge:set-role',
    ({ args }) => roleSchema.parse(args[0]),
    { arguments: 1 },
  ),
  action(
    'client-name',
    'client-name <name|auto>',
    'Set the name reported to hosts.',
    'modelbridge:set-client-name',
    ({ args }) => (args[0] === 'auto' ? null : args[0]),
    { arguments: 1 },
  ),
  action(
    'copilot login',
    'copilot login [--label <name>] [--share]',
    'Begin direct GitHub device sign-in; status shows its URL/code.',
    'modelbridge:copilot-login',
    ({ flags }) => ({
      label: flags.label ?? 'GitHub Copilot',
      shared: flags.share === true,
    }),
    { arguments: 0, flags: ['label', 'share'] },
  ),
  action(
    'copilot cancel',
    'copilot cancel',
    'Cancel pending device sign-in.',
    'modelbridge:copilot-cancel',
  ),
  {
    name: 'copilot status',
    usage: 'copilot status',
    description: 'Show pending sign-in and errors.',
    arguments: 0,
    run: async (context) => {
      const status = object.parse(await context.call('modelbridge:status'))
      return {
        login: status.copilotLogin,
        error: status.copilotError,
        sources: status.sources,
      }
    },
  },
  action(
    'copilot quota',
    'copilot quota [--refresh]',
    'Read account-wide Copilot quota.',
    'modelbridge:copilot-quota',
    ({ flags }) => flags.refresh === true,
    { arguments: 0, flags: ['refresh'] },
  ),
  action(
    'tunnel login',
    'tunnel login <github|microsoft>',
    'Begin Dev Tunnels device sign-in.',
    'modelbridge:tunnel-login',
    ({ args }) => z.enum(['github', 'microsoft']).parse(args[0]),
    { arguments: 1 },
  ),
  action(
    'tunnel check-login',
    'tunnel check-login',
    'Verify the Dev Tunnels account.',
    'modelbridge:tunnel-check-login',
  ),
  {
    name: 'tunnel status',
    usage: 'tunnel status',
    description: 'Show tunnel sign-in, URL and relay health.',
    arguments: 0,
    run: async (context) => {
      const status = object.parse(await context.call('modelbridge:status'))
      return {
        sharing: status.sharing,
        url: status.remoteUrl,
        health: status.tunnelHealth,
        user: status.tunnelUser,
        login: status.login,
        error: status.transportError,
      }
    },
  },
  action(
    'tunnel start',
    'tunnel start --yes',
    'Enable remote access to explicitly shared models.',
    'modelbridge:sharing-start',
    undefined,
    { arguments: 0, confirm: true },
  ),
  action(
    'tunnel stop',
    'tunnel stop',
    'Stop remote access.',
    'modelbridge:sharing-stop',
  ),
  action(
    'tunnel check',
    'tunnel check',
    'Check relay reachability and reconnect if necessary.',
    'modelbridge:tunnel-check',
  ),
  {
    name: 'tunnel settings',
    usage: 'tunnel settings --file <health.json>',
    description: 'Set automatic reconnect and optional periodic checks.',
    arguments: 0,
    flags: ['file'],
    run: async (context, { flags }) =>
      context.call(
        'modelbridge:tunnel-settings',
        await context.readJson(required(flags, 'file')),
      ),
  },
  {
    name: 'apps list',
    usage: 'apps list',
    description: 'List supported harnesses.',
    arguments: 0,
    run: () => Promise.resolve(['codex', ...configurableApps]),
  },
  {
    name: 'apps status',
    usage: 'apps status <app>',
    description: 'Inspect current harness settings.',
    arguments: 1,
    run: (context, { args }) => {
      const app = appId(args[0])
      return context.call(
        app === 'codex' ?
          'modelbridge:codex-status'
        : 'modelbridge:app-config-status',
        app === 'codex' ? undefined : app,
      )
    },
  },
  {
    name: 'apps setup',
    usage:
      'apps setup <app> --model <exact-id> [--label <name>] [--apply --yes]',
    description:
      'Preview or apply the same revision-checked harness setup as the GUI.',
    arguments: 1,
    flags: ['model', 'label', 'apply'],
    run: (context, input) => harnessPreview(context, input, false),
  },
  {
    name: 'apps restore',
    usage: 'apps restore <app> [--apply --yes]',
    description:
      'Preview or restore the original owned settings without requiring a model.',
    arguments: 1,
    flags: ['apply'],
    run: (context, input) => harnessPreview(context, input, true),
  },
  {
    name: 'apps apply',
    usage: 'apps apply <app> <preview-id> --yes',
    description:
      'Apply a preview from this running runtime; stale previews fail.',
    arguments: 2,
    confirm: true,
    run: (context, { args }) =>
      context.call(
        appId(args[0]) === 'codex' ?
          'modelbridge:codex-apply'
        : 'modelbridge:app-config-apply',
        appId(args[0]) === 'codex' ?
          z.string().uuid().parse(args[1])
        : { id: z.string().uuid().parse(args[1]), app: appId(args[0]) },
      ),
  },
  action(
    'apps backups',
    'apps backups',
    'List saved originals available for rollback.',
    'modelbridge:app-restore-targets',
  ),
  action(
    'codex discover',
    'codex discover',
    'Discover installed Codex console executables.',
    'modelbridge:codex-discover',
  ),
  action(
    'codex select',
    'codex select <executable>',
    'Verify a Codex executable without a file picker.',
    'modelbridge:codex-select-path',
    ({ args }) => args[0],
    { arguments: 1 },
  ),
  {
    name: 'codex revisions',
    usage: 'codex revisions',
    description: 'List saved Codex revisions.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:codex-status'), 'revisions'),
  },
  action(
    'codex revision',
    'codex revision <revision-id>',
    'Preview a saved Codex configuration.',
    'modelbridge:codex-revision',
    ({ args }) => args[0],
    { arguments: 1 },
  ),
  action(
    'codex acknowledge',
    'codex acknowledge --yes',
    'Acknowledge external managed edits before reconfiguration.',
    'modelbridge:codex-reconcile',
    undefined,
    { arguments: 0, confirm: true },
  ),
  action(
    'usage',
    'usage [--range today|7d|30d|90d]',
    'Recorded tokens, charges, clients and app usage.',
    'modelbridge:usage',
    ({ flags }) => z.enum(usageRanges).parse(flags.range ?? 'today'),
    { arguments: 0, flags: ['range'] },
  ),
  action(
    'usage clear',
    'usage clear --yes',
    'Delete recorded usage metadata.',
    'modelbridge:usage-clear',
    undefined,
    { arguments: 0, confirm: true },
  ),
  {
    name: 'limits show',
    usage: 'limits show',
    description: 'Show warn-only client/model budgets.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:usage', 'today'), 'limits'),
  },
  {
    name: 'limits set',
    usage: 'limits set --file <limits.json>',
    description: 'Save warn-only client/model budgets.',
    arguments: 0,
    flags: ['file'],
    run: async (context, { flags }) =>
      context.call(
        'modelbridge:premium-limits',
        await context.readJson(required(flags, 'file')),
      ),
  },
  {
    name: 'keys show',
    usage: 'keys show <local|remote> --yes',
    description: 'Explicitly print a gateway key; never the CLI admin key.',
    arguments: 1,
    confirm: true,
    run: (context, { args }) =>
      context.call(
        z.enum(['local', 'remote']).parse(args[0]) === 'local' ?
          'modelbridge:local-key'
        : 'modelbridge:remote-key',
      ),
  },
  action(
    'keys copy',
    'keys copy <local|remote>',
    'Copy a gateway key to the clipboard.',
    'modelbridge:copy-key',
    ({ args }) => z.enum(['local', 'remote']).parse(args[0]) === 'remote',
    { arguments: 1 },
  ),
  action(
    'updates check',
    'updates check',
    'Check for installable product releases.',
    'modelbridge:update-check',
  ),
  {
    name: 'updates status',
    usage: 'updates status',
    description: 'Read current update/download status.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:status'), 'update'),
  },
  action(
    'updates install',
    'updates install --yes',
    'Verify the checksum, install, and restart the packaged app.',
    'modelbridge:update-install',
    undefined,
    { arguments: 0, confirm: true },
  ),
  {
    name: 'data show',
    usage: 'data show',
    description: 'Show the active data location.',
    arguments: 0,
    run: async (context) =>
      statusFields(await context.call('modelbridge:status'), 'data'),
  },
  action(
    'data move',
    'data move <empty-folder> --yes',
    'Move packaged-app data using the existing copy/restart workflow.',
    'modelbridge:data-move',
    ({ args }) => args[0],
    { arguments: 1, confirm: true },
  ),
  action(
    'data open',
    'data open',
    'Open the data folder.',
    'modelbridge:data-open',
  ),
  action(
    'open',
    'open',
    'Open the GUI for this same runtime/profile.',
    'modelbridge:open-window',
  ),
  action(
    'stop',
    'stop --yes',
    'Gracefully stop the gateway and sharing runtime.',
    'modelbridge:stop',
    () => true,
    { arguments: 0, confirm: true },
  ),
]

export interface ParsedCommand {
  name: string
  json: boolean
  directory?: string
  execute(context: CliContext, emit: EmitChunk): Promise<unknown>
}

const options = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  yes: { type: 'boolean' },
  apply: { type: 'boolean' },
  share: { type: 'boolean' },
  refresh: { type: 'boolean' },
  file: { type: 'string' },
  model: { type: 'string' },
  label: { type: 'string' },
  range: { type: 'string' },
  path: { type: 'string' },
  'key-env': { type: 'string' },
  'user-data-dir': { type: 'string' },
} as const

export const cliHelp = [
  'ModelBridge CLI',
  'Usage: modelbridge [--user-data-dir <folder>] <command> [--json]',
  '',
  'start                         Start the shared runtime headlessly in the background.',
  'serve                         Run the shared runtime in the foreground (Ctrl+C to stop).',
  ...commands.map((command) => `${command.usage}\n  ${command.description}`),
  'request --path <API-path> [--file <request.json>] [--json]',
  '  Stream a full API request through the same gateway as the Playground.',
  '',
  'JSON inputs may use --file - for stdin. Secrets can use --key-env instead of command arguments.',
  'Sign-in is asynchronous: login prints the device code; status checks its progress.',
  'Previews survive CLI exit but not runtime restart. --apply always requires --yes.',
].join('\n')

export function parseCommand(argv: string[]): ParsedCommand {
  const parsed = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
  })
  const flags: Flags = parsed.values
  const positionals = parsed.positionals
  const globals = ['json', 'help', 'yes', 'user-data-dir']
  const base = {
    json: parsed.values.json === true,
    directory: parsed.values['user-data-dir'],
  }
  if (
    parsed.values.help
    || positionals.length === 0
    || positionals[0] === 'help'
  )
    return { ...base, name: 'help', execute: () => Promise.resolve(cliHelp) }
  const name = positionals[0]
  if (name === 'start' || name === 'serve') {
    if (
      positionals.length !== 1
      || Object.keys(flags).some((key) => !globals.includes(key))
    )
      throw new Error(`Usage: modelbridge ${name} [--user-data-dir <folder>]`)
    return { ...base, name, execute: () => Promise.resolve() }
  }
  if (name === 'request') {
    if (
      positionals.length !== 1
      || Object.keys(flags).some(
        (key) => ![...globals, 'path', 'file'].includes(key),
      )
    )
      throw new Error(
        'Usage: modelbridge request --path <API-path> [--file <request.json>]',
      )
    const apiPath = z
      .enum([
        '/health',
        '/v1/models',
        '/v1/responses',
        '/v1/chat/completions',
        '/v1/messages',
      ])
      .parse(required(flags, 'path'))
    // Keep the JSON conversation intact; no conversion to a single prompt.
    return {
      ...base,
      name,
      execute: async (context, emit) =>
        context.call(
          'modelbridge:playground-send',
          {
            id: randomUUID(),
            path: apiPath,
            ...(flags.file && {
              body: object.parse(await context.readJson(String(flags.file))),
            }),
          },
          emit,
        ),
    }
  }
  const command = [...commands]
    .sort((a, b) => b.name.length - a.name.length)
    .find((item) => {
      const words = item.name.split(' ')
      return words.every((word, index) => positionals[index] === word)
    })
  if (!command) throw new Error('Unknown ModelBridge command. Use --help.')
  const args = positionals.slice(command.name.split(' ').length)
  if (args.length !== command.arguments)
    throw new Error(`Usage: modelbridge ${command.usage}`)
  const allowed = [...globals, ...(command.flags ?? [])]
  const unexpected = Object.keys(flags).find((key) => !allowed.includes(key))
  if (unexpected)
    throw new Error(`--${unexpected} is not valid for ${command.name}.`)
  if ((command.confirm || flags.apply) && flags.yes !== true)
    throw new Error(
      'This action requires --yes. Review its preview or current settings first.',
    )
  return {
    ...base,
    name: command.name,
    execute: async (context) => command.run(context, { args, flags }),
  }
}

export function printableResult(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) => printableResult(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        (
          /(?:api[_-]?key|auth[_-]?token|secret|password|authorization)$/iu.test(
            key,
          )
        ) ?
          '[redacted]'
        : printableResult(field),
      ]),
    )
  return value
}
