import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CredentialStore } from '@modelbridge/runtime/credentials'
import { readDataLocation } from '../electron/data-location'
import {
  callControl,
  controlKeyId,
  ControlUnavailable,
  maxControlFrame,
} from '../electron/control'
import { parseCommand, printableResult, type CliContext } from './commands'

export interface CliLaunch {
  executable: string
  appPath?: string
  packaged: boolean
}
export interface CliIO {
  out(text: string): Promise<void>
  error(text: string): Promise<void>
  input(): Promise<string>
  env: NodeJS.ProcessEnv
}

export function cliDataDirectory(
  launch: CliLaunch,
  env: NodeJS.ProcessEnv,
  override?: string,
) {
  if (override) return path.resolve(override)
  const defaultDirectory = path.join(
    env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'ModelBridge',
  )
  return launch.packaged ?
      (readDataLocation(path.dirname(launch.executable)) ?? defaultDirectory)
    : defaultDirectory
}

function key(directory: string) {
  try {
    return CredentialStore.open(path.join(directory, 'credentials.json')).get(
      controlKeyId,
    )
  } catch {
    throw new ControlUnavailable()
  }
}

async function startRuntime(
  launch: CliLaunch,
  directory: string,
  env: NodeJS.ProcessEnv,
  foreground: boolean,
  explicitProfile: boolean,
) {
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(
    launch.executable,
    [
      ...(launch.appPath ? [launch.appPath] : []),
      '--modelbridge-headless',
      ...(!launch.packaged || explicitProfile ?
        [`--user-data-dir=${directory}`]
      : []),
    ],
    {
      env: childEnv,
      stdio: foreground ? 'inherit' : 'ignore',
      windowsHide: true,
      detached: !foreground,
    },
  )
  let failure: Error | undefined
  child.on('error', (error) => {
    failure = error
  })
  const completion = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1))
    child.once('error', () => resolve(1))
  })
  if (!foreground) child.unref()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (failure) throw failure
    if (child.exitCode !== null) break
    try {
      const status = await callControl(
        directory,
        key(directory),
        'modelbridge:status',
      )
      return { child, completion, status }
    } catch (error) {
      if (!(error instanceof ControlUnavailable)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
  child.kill()
  throw new Error(
    'ModelBridge did not start. Check its diagnostics log and make sure this CLI and the GUI are the same build.',
  )
}

export async function runCli(
  argv: string[],
  io: CliIO,
  launch: CliLaunch,
): Promise<number> {
  try {
    const command = parseCommand(argv)
    const directory = cliDataDirectory(launch, io.env, command.directory)
    const context: CliContext = {
      env: io.env,
      call: (channel, value, emit) =>
        callControl(directory, key(directory), channel, value, emit),
      readJson: async (file) => {
        const text =
          file === '-' ? await io.input() : fs.readFileSync(file, 'utf8')
        if (Buffer.byteLength(text) > maxControlFrame)
          throw new Error('The CLI JSON input exceeds its size limit.')
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new Error(
            'The CLI input must be valid JSON; no settings were changed.',
          )
        }
      },
    }
    let result: unknown
    if (command.name === 'start' || command.name === 'serve') {
      let running = false
      try {
        result = await context.call('modelbridge:status')
        running = true
      } catch (error) {
        if (!(error instanceof ControlUnavailable)) throw error
      }
      if (running && command.name === 'serve')
        throw new Error(
          'This profile is already running. Use its GUI or CLI commands, or stop it before starting a foreground server.',
        )
      if (!running) {
        const started = await startRuntime(
          launch,
          directory,
          io.env,
          command.name === 'serve',
          command.directory !== undefined,
        )
        result = started.status
        if (command.name === 'serve') {
          await io.out(
            'ModelBridge is running in the foreground. Press Ctrl+C to stop.\n',
          )
          const terminate = () => {
            void context
              .call('modelbridge:stop', true)
              .catch(() => started.child.kill())
          }
          process.once('SIGINT', terminate)
          process.once('SIGTERM', terminate)
          try {
            return await started.completion
          } finally {
            process.removeListener('SIGINT', terminate)
            process.removeListener('SIGTERM', terminate)
          }
        }
      }
    } else {
      result = await command.execute(context, async (chunk) => {
        await io.out(
          command.json ?
            JSON.stringify({ type: 'chunk', ...chunk }) + '\n'
          : chunk.text,
        )
      })
    }
    if (command.name === 'request' && !command.json) await io.out('\n')
    const output =
      command.name === 'keys show' ? result : printableResult(result)
    await io.out(
      typeof output === 'string' && !command.json ?
        output + '\n'
      : JSON.stringify(output ?? { ok: true }, null, command.json ? 0 : 2)
          + '\n',
    )
    return 0
  } catch (error) {
    await io.error(
      `ModelBridge CLI: ${error instanceof Error ? error.message : 'The command failed.'}\n`,
    )
    return 1
  }
}
