import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {
  callControl,
  controlAddress,
  ControlUnavailable,
  maxControlFrame,
  startControlServer,
} from '../electron/control'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
const profile = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-control-'))
  directories.push(directory)
  return directory
}

test('CLI controls are profile-scoped, authenticated and stream chunks before completion', async () => {
  const directory = profile()
  const events: string[] = []
  const calls: string[] = []
  const server = await startControlServer(
    directory,
    'synthetic-admin-key',
    async (channel, value, emit) => {
      calls.push(channel)
      await emit({ id: 'request-id', text: 'first\n\u03c0' })
      await Bun.sleep(10)
      await emit({ id: 'request-id', text: 'second' })
      return { ok: true, value }
    },
  )
  try {
    await expect(
      callControl(directory, 'wrong-key', 'modelbridge:status'),
    ).rejects.toThrow('authentication')
    expect(calls).toHaveLength(0)
    expect(
      await callControl(
        directory,
        'synthetic-admin-key',
        'modelbridge:status',
        { role: 'host' },
        async (event) => {
          events.push(event.text)
          await Bun.sleep(5)
        },
      ),
    ).toEqual({ role: 'host' })
    expect(events).toEqual(['first\n\u03c0', 'second'])
    expect(calls).toEqual(['modelbridge:status'])
    await expect(
      callControl(profile(), 'synthetic-admin-key', 'modelbridge:status'),
    ).rejects.toBeInstanceOf(ControlUnavailable)
  } finally {
    await server.close()
  }
})

test('CLI control reports failures and never dispatches malformed frames', async () => {
  const directory = profile()
  let dispatched = 0
  const server = await startControlServer(
    directory,
    'synthetic-admin-key',
    () => {
      dispatched++
      return Promise.resolve({
        ok: false,
        error: 'Settings changed after preview.',
      })
    },
  )
  try {
    await expect(
      callControl(directory, 'synthetic-admin-key', 'modelbridge:status'),
    ).rejects.toThrow('changed after')
    const raw = (data: string) =>
      new Promise<string>((resolve) => {
        const socket = net.createConnection(server.address)
        let output = ''
        socket.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        socket.on('error', () => resolve(output))
        socket.on('close', () => resolve(output))
        socket.on('connect', () => socket.write(data))
      })
    expect(
      await raw(
        '{"version":1,"channel":"not-allowed","key":"synthetic-admin-key"}\n',
      ),
    ).toContain('authentication')
    expect(await raw('{broken\n')).toBe('')
    expect(await raw('x'.repeat(maxControlFrame + 1))).toBe('')
    expect(dispatched).toBe(1)
  } finally {
    await server.close()
  }
})

test('CLI refuses missing keys, large outgoing frames and interrupted replies', async () => {
  const directory = profile()
  await expect(
    startControlServer(directory, '', async () => ({
      ok: true,
      value: undefined,
    })),
  ).rejects.toThrow('access key')
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', () => socket.end())
  })
  await new Promise<void>((resolve) =>
    server.listen(controlAddress(directory), resolve),
  )
  try {
    await expect(
      callControl(directory, 'key', 'modelbridge:status'),
    ).rejects.toThrow('closed before confirming')
    await expect(
      callControl(
        directory,
        'key',
        'modelbridge:status',
        'x'.repeat(maxControlFrame),
      ),
    ).rejects.toThrow('size limit')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the Windows control identity is case insensitive and distinct from Unix sockets', () => {
  const directory = profile()
  expect(controlAddress(directory, 'win32')).toBe(
    controlAddress(directory.toUpperCase(), 'win32'),
  )
  expect(controlAddress(directory, 'linux')).toBe(
    path.join(path.resolve(directory), 'control.sock'),
  )
})
