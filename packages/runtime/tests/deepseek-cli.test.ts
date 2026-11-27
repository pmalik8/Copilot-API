import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialStore } from '../src/credentials/vault'
import { AppConfigurations } from '../src/harnesses/app-configurations'
import { createGateway } from '../src/routing/gateway'
import { SourceService } from '../src/sources/source-service'
import type { UsageEntry } from '../src/usage/usage-ledger'

const installed = process.env.MODELBRIDGE_TEST_DSH_EXE
const entry = process.env.MODELBRIDGE_TEST_DSH
// Use the same entry point as the packaged Windows dsh.cmd launcher.
const command =
  installed ?
    [
      installed,
      '--expose-internals',
      path.join(
        path.dirname(installed),
        'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
      ),
    ]
  : entry ? ['node', entry]
  : null

for (const app of ['deepseek', 'deepseek-desktop'] as const)
  test.skipIf(!command)(
    `DeepSeek Harness headless runner loads the ${app} patch, streams, and restores`,
    async () => {
      if (!command)
        throw new Error('Set MODELBRIDGE_TEST_DSH or MODELBRIDGE_TEST_DSH_EXE.')
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), 'modelbridge-dsh-cli-'),
      )
      const key = 'synthetic-dsh-local-key'
      const upstreamKey = 'synthetic-upstream-key'
      const seen: Array<{ path: string; auth: string | null; body: unknown }> =
        []
      const usage: UsageEntry[] = []
      const model = 'upstream-model'
      const store = CredentialStore.open(path.join(home, 'credentials.json'))
      const sources = new SourceService(
        [],
        store,
        () => {},
        async (url, init) => {
          if (url.endsWith('/models'))
            return Response.json({ data: [{ id: model }] })
          if (typeof init?.body !== 'string')
            throw new Error('Expected a JSON request body.')
          seen.push({
            path: new URL(url).pathname,
            auth: new Headers(init?.headers).get('authorization'),
            body: JSON.parse(init.body) as unknown,
          })
          const envelope = {
            id: 'chatcmpl-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
          }
          const chunk = (choice: Record<string, unknown>) =>
            `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, ...choice }] })}\n\n`
          return new Response(
            chunk({
              delta: { role: 'assistant', content: 'MODELBRIDGE_DSH_OK' },
              finish_reason: null,
            })
              + chunk({ delta: {}, finish_reason: 'stop' })
              + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      )
      const gateway = createGateway(sources, key, false, {
        record: (entry) => usage.push(entry),
      })
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => gateway.fetch(request),
      })
      try {
        await sources.add({
          kind: 'api',
          label: 'Synthetic provider',
          baseUrl: 'http://127.0.0.1:12345/v1',
          protocol: 'chat-completions',
          apiKey: upstreamKey,
          shared: false,
        })
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: home,
          TMP: home,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: home,
          APPDATA: home,
          DSH_HOME: path.join(home, '.dsh'),
          DSH_AGENTS_HOME: path.join(home, '.agents'),
          DSH_TELEMETRY_DISABLED: '1',
          ...(installed && { ELECTRON_RUN_AS_NODE: '1' }),
        }
        const configurations = new AppConfigurations(store, env, home)
        const models = sources.models()
        const preview = configurations.preview(app, {
          models,
          modelId: models[0].id,
          origin: server.url.origin,
          key,
        })
        await configurations.apply(preview.id)

        // Use the selected profile's patch with the noninteractive runner.
        // The headless preset alone disables the saved credential store.
        const credentialOverlay = path.join(home, 'credentials.patch.yml')
        fs.writeFileSync(
          credentialOverlay,
          '- id: credentials\n  disabled: false\n',
        )
        const child = Bun.spawn({
          cmd: [
            ...command,
            '--profile',
            'headless',
            '--patch',
            preview.configPath,
            '--patch',
            credentialOverlay,
            'Reply with a short greeting.',
          ],
          cwd: home,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timer = setTimeout(() => child.kill(), 60_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]).finally(() => clearTimeout(timer))
        expect(
          code,
          `DeepSeek forwarded ${seen.length} requests.\n${stderr}`,
        ).toBe(0)
        expect(stdout.trim()).toBe('MODELBRIDGE_DSH_OK')
        expect(seen.length).toBeGreaterThan(0)
        for (const request of seen)
          expect(request).toMatchObject({
            path: '/v1/chat/completions',
            auth: `Bearer ${upstreamKey}`,
            body: { model },
          })
        const turn = seen.find(({ body }) =>
          JSON.stringify(body).includes('Reply with a short greeting.'),
        )
        expect(turn?.body).toMatchObject({ stream: true })
        expect(
          usage.some(
            (entry) =>
              entry.app === 'deepseek'
              && entry.model === model
              && entry.outcome === 'completed',
          ),
        ).toBe(true)
        const restarted = new AppConfigurations(store, env, home)
        await restarted.apply(restarted.restore(app).id)
        expect(fs.existsSync(preview.configPath)).toBe(false)
        expect(
          fs.existsSync(path.join(home, '.dsh', '.credentials.yaml')),
        ).toBe(false)
      } finally {
        await server.stop(true)
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
    65_000,
  )
