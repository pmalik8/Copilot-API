import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { CredentialStore } from '@modelbridge/runtime/credentials'
import { callControl, controlKeyId } from '../electron/control'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_PACKAGED_EXE,
)(
  'packaged Windows CLI starts and stops outside the workspace without Node or Bun',
  async () => {
    const executable = process.env.MODELBRIDGE_TEST_PACKAGED_EXE
    if (!executable) throw new Error('Set MODELBRIDGE_TEST_PACKAGED_EXE.')
    const launcher = path.join(path.dirname(executable), 'bin/modelbridge.cmd')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-packaged-cli-'))
    const profile = path.join(directory, 'profile with spaces')
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toUpperCase() !== 'PATH',
        ),
      ),
      MODELBRIDGE_PORT: '0',
      MODELBRIDGE_UPDATE_CHECK: '0',
      APPDATA: path.join(directory, 'roaming'),
      LOCALAPPDATA: path.join(directory, 'local'),
      CODEX_HOME: path.join(directory, 'codex'),
      OPENCODE_CONFIG_DIR: path.join(directory, 'opencode'),
      DSH_HOME: path.join(directory, 'deepseek'),
      HERMES_HOME: path.join(directory, 'hermes'),
      CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
      OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json'),
      // The wrapper must use ModelBridge's bundled Node, not developer tools.
      PATH: [
        path.dirname(launcher),
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      ].join(path.delimiter),
    }
    const invoke = async (args: string[], command = 'modelbridge') => {
      const child = Bun.spawn({
        cmd: [
          'cmd.exe',
          '/d',
          '/c',
          command,
          '--user-data-dir',
          profile,
          ...args,
        ],
        cwd: directory,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => child.kill(), 40_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      expect(code, stderr).toBe(0)
      return stdout
    }
    try {
      const where = Bun.spawn(['where.exe', 'node.exe'], {
        cwd: directory,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      expect(await where.exited).toBe(1)
      expect(await invoke(['--help'])).toContain('ModelBridge CLI')
      expect(await invoke(['--help'], launcher)).toContain('ModelBridge CLI')
      const powershell = Bun.spawn(
        [
          path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'modelbridge --help',
        ],
        { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => powershell.kill(), 20_000)
      const [output, errors, code] = await Promise.all([
        new Response(powershell.stdout).text(),
        new Response(powershell.stderr).text(),
        powershell.exited,
      ]).finally(() => clearTimeout(timer))
      expect(code, errors).toBe(0)
      expect(output).toContain('ModelBridge CLI')
      const started: unknown = JSON.parse(await invoke(['start', '--json']))
      expect(started).toMatchObject({ sources: [], models: [], sharing: false })
      const credentials = CredentialStore.open(
        path.join(profile, 'credentials.json'),
      )
      const key = credentials.get(controlKeyId)
      const status = await invoke(['status', '--json'])
      expect(status).not.toContain(key)
      expect(status).not.toContain(credentials.get('local-access'))
      const { localUrl } = z
        .object({ localUrl: z.string() })
        .parse(JSON.parse(status))
      expect((await fetch(localUrl + '/models')).status).toBe(401)
      const models = await fetch(localUrl + '/models', {
        headers: { Authorization: `Bearer ${credentials.get('local-access')}` },
      })
      expect(models.status).toBe(200)
      await invoke(['role', 'client'])
      await invoke(['stop', '--yes'])
      await Bun.sleep(500)
      await invoke(['start'])
      expect(
        JSON.parse(await invoke(['status', '--json'])) as unknown,
      ).toMatchObject({ role: 'client' })
      expect(
        CredentialStore.open(path.join(profile, 'credentials.json')).get(
          controlKeyId,
        ),
      ).toBe(key)
      await invoke(['stop', '--yes'])
      await Bun.sleep(500)
    } finally {
      try {
        const key = CredentialStore.open(
          path.join(profile, 'credentials.json'),
        ).get(controlKeyId)
        await callControl(profile, key, 'modelbridge:stop', true).catch(
          () => undefined,
        )
      } catch {
        /* Startup failed before credentials were created. */
      }
      await Bun.sleep(500)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
