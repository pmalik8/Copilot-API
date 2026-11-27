import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AppConfigurations } from '../src/harnesses/app-configurations'
import { CredentialStore } from '../src/credentials/vault'
import { SourceService } from '../src/sources/source-service'
import { createGateway } from '../src/routing/gateway'
import type { UsageEntry } from '../src/usage/usage-ledger'

test.skipIf(!process.env.MODELBRIDGE_TEST_OPENCODE)(
  'OpenCode 2.x loads the generated provider, executes a read tool and streams the exact route',
  async () => {
    const cli = process.env.MODELBRIDGE_TEST_OPENCODE
    if (!cli)
      throw new Error(
        'Set MODELBRIDGE_TEST_OPENCODE to the OpenCode executable.',
      )
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-opencode-cli-'))
    const localKey = 'synthetic-opencode-local-key'
    const providerKey = 'synthetic-opencode-upstream-key'
    const forwarded: Array<{ headers: Headers; body: unknown }> = []
    const usage: UsageEntry[] = []
    const requestSchema = z.object({
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.unknown().optional(),
          tool_call_id: z.string().optional(),
        }),
      ),
      tools: z
        .array(
          z.object({
            function: z.object({ name: z.string() }),
          }),
        )
        .optional(),
    })
    let toolRequested = false
    let toolReturned = false
    const vault = CredentialStore.open(path.join(home, 'credentials.json'))
    const sources = new SourceService(
      [],
      vault,
      () => {},
      async (url, init) => {
        if (url.endsWith('/models'))
          return Response.json({
            data: [
              {
                id: 'coding-model',
                modelbridge: {
                  protocol: 'chat-completions',
                  supportsTools: true,
                  contextWindow: 32_000,
                  maxOutputTokens: 4096,
                },
              },
            ],
          })
        if (typeof init?.body !== 'string')
          throw new Error('Expected a JSON model request.')
        const body: unknown = JSON.parse(init.body)
        const request = requestSchema.parse(body)
        forwarded.push({
          headers: new Headers(init.headers),
          body,
        })
        if (
          request.messages.some(
            (message) =>
              message.role === 'tool'
              && message.tool_call_id === 'call_modelbridge_read'
              && JSON.stringify(message.content).includes(
                'MODELBRIDGE_FILE_OK',
              ),
          )
        )
          toolReturned = true
        const read = request.tools?.find(
          (tool) => tool.function.name === 'read',
        )
        const frame = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-opencode-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'coding-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        const output =
          read && !toolRequested ?
            (() => {
              toolRequested = true
              return (
                frame(
                  {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_modelbridge_read',
                        type: 'function',
                        function: {
                          name: read.function.name,
                          arguments: JSON.stringify({
                            path: 'opencode-probe.txt',
                            offset: 1,
                            limit: 10,
                          }),
                        },
                      },
                    ],
                  },
                  null,
                ) + frame({}, 'tool_calls')
              )
            })()
          : frame(
              { role: 'assistant', content: 'MODELBRIDGE_OPENCODE_OK' },
              null,
            ) + frame({}, 'stop')
        return new Response(output + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    )
    const gateway = createGateway(sources, localKey, false, {
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
        label: 'Synthetic source',
        baseUrl: 'http://127.0.0.1:12345/v1',
        protocol: 'chat-completions',
        apiKey: providerKey,
        shared: false,
      })
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ProgramData: path.join(home, 'system-config'),
        TEMP: home,
        TMP: home,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        APPDATA: home,
        OPENCODE_TEST_HOME: home,
        OPENCODE_CONFIG_DIR: path.join(home, 'config', 'opencode'),
        XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_STATE_HOME: path.join(home, 'state'),
        NO_PROXY: 'localhost,127.0.0.1',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      }
      const configurations = new AppConfigurations(vault, env, home)
      fs.writeFileSync(
        path.join(home, 'opencode-probe.txt'),
        'MODELBRIDGE_FILE_OK\n',
      )
      const file = configurations.configPath('opencode')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(
        file,
        '{"update":"disable","snapshots":false,"warming":false}',
      )
      const preview = configurations.preview('opencode', {
        models: sources.models(),
        modelId: sources.models()[0].id,
        origin: server.url.origin,
        key: localKey,
      })
      await configurations.apply(preview.id)
      const child = Bun.spawn({
        cmd: [
          cli,
          'run',
          '--standalone',
          '--format',
          'json',
          'Read opencode-probe.txt, then reply with exactly MODELBRIDGE_OPENCODE_OK.',
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
      expect(code, stderr).toBe(0)
      expect(stdout).toContain('MODELBRIDGE_OPENCODE_OK')
      expect(toolRequested).toBe(true)
      expect(toolReturned).toBe(true)
      expect(forwarded.length).toBeGreaterThan(0)
      for (const request of forwarded) {
        expect(request.headers.get('authorization')).toBe(
          `Bearer ${providerKey}`,
        )
        expect(request.body).toMatchObject({
          model: 'coding-model',
          stream: true,
        })
      }
      expect(
        usage.some(
          (entry) => entry.app === 'opencode' && entry.outcome === 'completed',
        ),
      ).toBe(true)
      await configurations.apply(configurations.restore('opencode').id)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown).toEqual({
        update: 'disable',
        snapshots: false,
        warming: false,
      })
    } finally {
      await server.stop(true)
      fs.rmSync(home, { recursive: true, force: true })
    }
  },
  65_000,
)
