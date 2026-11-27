import fs from 'node:fs'
import path from 'node:path'
import net, { type Socket } from 'node:net'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { channels, type Channel, type EmitChunk } from './channels'
import type { Result } from '../src/types'

export const controlKeyId = 'cli-access'
export const maxControlFrame = 8 * 1024 * 1024
const requestSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1).max(8192),
    channel: z.enum(channels),
    value: z.unknown().optional(),
  })
  .strict()
const responseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('result'),
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: z.unknown().optional() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal('chunk'),
    chunk: z.object({ id: z.string(), text: z.string() }),
  }),
])

export function controlAddress(directory: string, platform = process.platform) {
  const resolved = path.resolve(directory)
  const identity = platform === 'win32' ? resolved.toLowerCase() : resolved
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return platform === 'win32' ?
      `\\\\.\\pipe\\modelbridge-${id}-control`
    : path.join(resolved, 'control.sock')
}

function readFrames(socket: Socket, receive: (frame: unknown) => void) {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length) {
      const newline = pending.indexOf(10)
      if (newline < 0 && pending.length <= maxControlFrame) return
      if (newline < 0 || newline > maxControlFrame) {
        socket.destroy(
          new Error('The CLI control frame exceeds its size limit.'),
        )
        return
      }
      const frame = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'))
        receive(value)
      } catch {
        socket.destroy(new Error('The CLI control response is invalid.'))
        return
      }
    }
  })
}

async function writeFrame(socket: Socket, value: unknown) {
  const text = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(text) > maxControlFrame)
    throw new Error('The CLI control frame exceeds its size limit.')
  await new Promise<void>((resolve, reject) => {
    socket.write(text, (error) => (error ? reject(error) : resolve()))
  })
}

export type ControlDispatch = (
  channel: Channel,
  value: unknown,
  emit: EmitChunk,
  disconnected: AbortSignal,
) => Promise<Result<unknown>>

export async function startControlServer(
  directory: string,
  key: string,
  dispatch: ControlDispatch,
) {
  if (!key) throw new Error('A separate CLI access key is required.')
  const address = controlAddress(directory)
  const sockets = new Set<Socket>()
  const server = net.createServer((socket) => {
    const disconnected = new AbortController()
    sockets.add(socket)
    socket.setTimeout(15_000, () => socket.destroy())
    socket.on('error', () => undefined)
    socket.once('close', () => {
      sockets.delete(socket)
      disconnected.abort()
    })
    let accepted = false
    readFrames(socket, (frame) => {
      if (accepted) {
        socket.destroy()
        return
      }
      accepted = true
      const request = requestSchema.safeParse(frame)
      const supplied =
        request.success ? Buffer.from(request.data.key) : Buffer.alloc(0)
      const expected = Buffer.from(key)
      if (
        !request.success
        || supplied.length !== expected.length
        || !timingSafeEqual(supplied, expected)
      ) {
        void writeFrame(socket, {
          type: 'result',
          result: { ok: false, error: 'CLI authentication required.' },
        }).then(
          () => socket.end(),
          () => socket.destroy(),
        )
        return
      }
      socket.setTimeout(0)
      const emit: EmitChunk = (chunk) =>
        writeFrame(socket, { type: 'chunk', chunk })
      void dispatch(
        request.data.channel,
        request.data.value,
        emit,
        disconnected.signal,
      )
        .then((result) => writeFrame(socket, { type: 'result', result }))
        .then(() => socket.end())
        .catch(() => socket.destroy())
    })
  })
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600)
  return {
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export class ControlUnavailable extends Error {
  constructor() {
    super(
      'ModelBridge is not running for this data folder. Run "modelbridge start" or open the updated GUI first.',
    )
  }
}

export function callControl(
  directory: string,
  key: string,
  channel: Channel,
  value?: unknown,
  emit: EmitChunk = () => Promise.resolve(),
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlAddress(directory))
    let finished = false
    let delivery = Promise.resolve()
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return
      finished = true
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    socket.setTimeout(330_000, () =>
      finish(
        new Error(
          'The CLI action stopped responding. Check ModelBridge status before retrying a change.',
        ),
      ),
    )
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ?
          new ControlUnavailable()
        : error,
      )
    })
    socket.on('close', () => {
      void delivery.then(() => {
        if (!finished)
          finish(
            new Error(
              'The CLI connection closed before confirming the action. Check current settings before retrying.',
            ),
          )
      })
    })
    socket.on('connect', () => {
      void writeFrame(socket, { version: 1, key, channel, value }).catch(
        (error: unknown) =>
          finish(
            error instanceof Error ? error : (
              new Error('The CLI request could not be sent.')
            ),
          ),
      )
    })
    readFrames(socket, (frame) => {
      const parsed = responseSchema.safeParse(frame)
      if (!parsed.success) {
        finish(new Error('The CLI control response is invalid.'))
        return
      }
      const message = parsed.data
      delivery = delivery
        .then(async () => {
          if (message.type === 'chunk') await emit(message.chunk)
          else {
            const result = message.result
            finish(
              result.ok ? undefined : new Error(result.error),
              result.ok ? result.value : undefined,
            )
          }
        })
        .catch((error: unknown) =>
          finish(
            error instanceof Error ? error : new Error('CLI output failed.'),
          ),
        )
    })
  })
}
