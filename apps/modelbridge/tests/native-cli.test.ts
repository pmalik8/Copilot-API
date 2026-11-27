import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SourceService } from '@modelbridge/runtime'
import { configurableApps } from '@modelbridge/runtime/apps'
import { AppState } from '../electron/state'
import { runCli } from '../cli/run'
import { callControl, controlKeyId } from '../electron/control'
import type { AppStatus } from '../src/types'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'CLI headless startup shares GUI state, streams requests and restores all harnesses after restart',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const main = path.resolve('out/main/index.js')
    const cli = path.resolve('out/main/cli.js')
    if (!fs.existsSync(main) || !fs.existsSync(cli))
      throw new Error('Build ModelBridge before native CLI tests.')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-native-cli-'))
    const profile = path.join(directory, 'profile')
    let requests = 0
    const waiting = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const heldResponse = Promise.withResolvers<Response>()
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (
          request.headers.get('authorization')
          !== 'Bearer synthetic-cli-provider'
        )
          return new Response('unauthorized', { status: 401 })
        if (new URL(request.url).pathname === '/v1/models')
          return Response.json({ data: [{ id: 'cli-model' }] })
        const body: unknown = await request.json()
        expect(body).toMatchObject({ model: 'cli-model', stream: true })
        requests++
        if (JSON.stringify(body).includes('Wait for cancellation')) {
          request.signal.addEventListener(
            'abort',
            () => {
              disconnected.resolve()
              heldResponse.resolve(new Response(null, { status: 499 }))
            },
            { once: true },
          )
          waiting.resolve()
          return heldResponse.promise
        }
        return new Response('data: {"output":"CLI_STREAM_OK"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const state = AppState.open(profile)
    const service = new SourceService([], state.vault, (sources) =>
      state.save({ ...state.value, sources }),
    )
    const source = await service.add({
      label: 'CLI source',
      kind: 'api',
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      protocol: 'responses',
      apiKey: 'synthetic-cli-provider',
      shared: false,
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODELBRIDGE_PORT: '0',
      MODELBRIDGE_UPDATE_CHECK: '0',
      CODEX_HOME: path.join(directory, 'codex-home'),
      CLAUDE_CONFIG_DIR: path.join(directory, 'claude-home'),
      HERMES_HOME: path.join(directory, 'hermes-home'),
      OPENCODE_CONFIG_DIR: path.join(directory, 'opencode-home'),
      OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json'),
      DSH_HOME: path.join(directory, 'dsh-home'),
    }
    delete env.ELECTRON_RUN_AS_NODE
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'modelbridge-cli-test',
        version: '0.1.7',
        main: 'fixture.cjs',
      }),
    )
    fs.writeFileSync(
      path.join(directory, 'fixture.cjs'),
      `
      const { app, dialog } = require('electron')
      const fs = require('node:fs')
      const cp = require('node:child_process')
      const { EventEmitter } = require('node:events')
      const [main, appPath, directory] = ${JSON.stringify([main, process.cwd(), directory])}
      const execFile = cp.execFile
      cp.execFile = (file, args, options, callback) => {
        if (args.includes('--modelbridge-credential')
          || (file === process.env.MODELBRIDGE_TEST_CODEX && args.join(' ') === '--version'))
          return execFile(file, args, options, callback)
        setImmediate(() => callback(new Error('No external services in isolated CLI tests.')))
        return new EventEmitter()
      }
      cp.execFile[require('node:util').promisify.custom] = (file, args, options) =>
        new Promise((resolve, reject) => cp.execFile(file, args, options,
          (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr})))
      app.disableHardwareAcceleration()
      app.setAppPath(appPath)
      fs.writeFileSync(require('node:path').join(directory, 'pid.txt'), String(process.pid))
      app.on('browser-window-created', (_event, window) => {
        window.hide()
        fs.appendFileSync(require('node:path').join(directory, 'windows.txt'), 'created\\n')
      })
      dialog.showErrorBox = (_title, message) => {
        fs.writeFileSync(require('node:path').join(directory, 'error.txt'), message)
        app.exit(1)
      }
      require(main)
    `,
    )
    const output: string[] = []
    const errors: string[] = []
    const io = {
      env,
      out: (text: string) => {
        output.push(text)
        return Promise.resolve()
      },
      error: (text: string) => {
        errors.push(text)
        return Promise.resolve()
      },
      input: () =>
        Promise.resolve(
          JSON.stringify({
            model: `${source.id}/cli-model`,
            stream: true,
            input: [{ role: 'user', content: 'Synthetic input' }],
          }),
        ),
    }
    const launch = { executable: electron, appPath: directory, packaged: false }
    const invoke = async (args: string[], expected = 0) => {
      output.length = 0
      errors.length = 0
      const result = await runCli(
        ['--user-data-dir', profile, ...args],
        io,
        launch,
      )
      expect(result, errors.join('')).toBe(expected)
      return output.join('')
    }
    const key = state.vault.get(controlKeyId)
    try {
      await invoke(['start'])
      expect(fs.existsSync(path.join(directory, 'windows.txt'))).toBe(false)
      const status = (await callControl(
        profile,
        key,
        'modelbridge:status',
      )) as AppStatus
      const terminal = Bun.spawn({
        cmd: ['node', cli, '--user-data-dir', profile, 'status', '--json'],
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [terminalOutput, terminalErrors, terminalCode] = await Promise.all([
        new Response(terminal.stdout).text(),
        new Response(terminal.stderr).text(),
        terminal.exited,
      ])
      expect(terminalCode, terminalErrors).toBe(0)
      expect(terminalOutput).toContain(status.models[0].id)
      expect(terminalOutput).not.toContain(state.vault.get(controlKeyId))
      expect(status.models[0].id).toBe(`${source.id}/cli-model`)
      await invoke(['start']) // Reuses the owner; it does not create a second writer.
      await invoke(['role', 'client'])
      await invoke(['client-name', 'CLI test machine'])
      await invoke(['sources', 'refresh', source.id])
      const changed = (await callControl(
        profile,
        key,
        'modelbridge:status',
      )) as AppStatus
      expect(changed.role).toBe('client')
      expect(changed.clientName).toBe('CLI test machine')
      await expect(
        callControl(
          profile,
          state.vault.get('local-access'),
          'modelbridge:set-role',
          'host',
        ),
      ).rejects.toThrow('authentication')
      for (const app of configurableApps) {
        const preview = await invoke([
          'apps',
          'setup',
          app,
          '--model',
          status.models[0].id,
          '--json',
        ])
        expect(preview).not.toContain(state.vault.get('local-access'))
        const parsed: unknown = JSON.parse(preview)
        if (
          !parsed
          || typeof parsed !== 'object'
          || !('id' in parsed)
          || typeof parsed.id !== 'string'
        )
          throw new Error('CLI setup returned no preview.')
        await invoke(['apps', 'apply', app, parsed.id, '--yes'])
      }
      if (env.MODELBRIDGE_TEST_CODEX) {
        await invoke(['codex', 'select', env.MODELBRIDGE_TEST_CODEX])
        await invoke([
          'apps',
          'setup',
          'codex',
          '--model',
          status.models[0].id,
          '--apply',
          '--yes',
        ])
        expect(await invoke(['apps', 'status', 'codex', '--json'])).toContain(
          '"provider":"modelbridge"',
        )
      }
      expect(
        await invoke(['request', '--path', '/v1/responses', '--file', '-']),
      ).toContain('CLI_STREAM_OK')
      expect(requests).toBe(1)
      expect(await invoke(['usage', '--json'])).toContain('"requests":1')
      const requestFile = path.join(directory, 'waiting-request.json')
      fs.writeFileSync(
        requestFile,
        JSON.stringify({
          model: status.models[0].id,
          stream: true,
          input: [{ role: 'user', content: 'Wait for cancellation' }],
        }),
      )
      const pendingRequest = Bun.spawn({
        cmd: [
          'node',
          cli,
          '--user-data-dir',
          profile,
          'request',
          '--path',
          '/v1/responses',
          '--file',
          requestFile,
        ],
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      const within = async (result: Promise<void>, message: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            result,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(message)), 5_000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        await within(
          waiting.promise,
          'The test request did not reach the provider.',
        )
        pendingRequest.kill()
        await pendingRequest.exited
        await within(
          disconnected.promise,
          'Exiting the CLI did not cancel its pending upstream request.',
        )
      } finally {
        if (pendingRequest.exitCode === null) pendingRequest.kill()
        await pendingRequest.exited
        heldResponse.resolve(new Response(null, { status: 499 }))
      }
      await invoke(['open'])
      expect(
        fs.readFileSync(path.join(directory, 'windows.txt'), 'utf8').trim(),
      ).toBe('created')
      await invoke(['stop', '--yes'])
      await Bun.sleep(500)
      await invoke(['start'])
      expect(
        ((await callControl(profile, key, 'modelbridge:status')) as AppStatus)
          .role,
      ).toBe('client')
      for (const app of configurableApps) {
        expect(await invoke(['apps', 'status', app, '--json'])).toContain(
          '"configured":true',
        )
        await invoke(['apps', 'restore', app, '--apply', '--yes'])
      }
      if (env.MODELBRIDGE_TEST_CODEX)
        await invoke(['apps', 'restore', 'codex', '--apply', '--yes'])
      expect(
        JSON.parse(await invoke(['apps', 'backups', '--json'])) as unknown,
      ).toEqual(
        env.MODELBRIDGE_TEST_CODEX ?
          [
            {
              app: 'codex',
              configPath: path.join(directory, 'codex-home', 'config.toml'),
            },
          ]
        : [],
      )
      await invoke(['stop', '--yes'])
      await Bun.sleep(500)
      const restarted = AppState.open(profile)
      expect(restarted.vault.get(controlKeyId)).toBe(key)
      expect(restarted.vault.get('local-access')).toBe(
        state.vault.get('local-access'),
      )
      const foreground = runCli(
        ['--user-data-dir', profile, 'serve'],
        io,
        launch,
      )
      const deadline = Date.now() + 10_000
      let ready = false
      while (!ready && Date.now() < deadline) {
        try {
          await callControl(profile, key, 'modelbridge:status')
          ready = true
        } catch {
          await Bun.sleep(100)
        }
      }
      expect(ready).toBe(true)
      // Let serve finish its readiness output before asking the runtime to stop.
      await Bun.sleep(200)
      await invoke(['serve'], 1)
      await callControl(profile, key, 'modelbridge:stop', true)
      expect(await foreground).toBe(0)
    } finally {
      await callControl(profile, key, 'modelbridge:stop', true).catch(
        () => undefined,
      )
      await Bun.sleep(500)
      await provider.stop(true)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  90_000,
)
