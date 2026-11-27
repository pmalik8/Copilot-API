import { createRequire } from 'node:module'
import path from 'node:path'
import { runCli } from './run'

const packaged = __dirname.includes('app.asar')
const require = createRequire(path.join(__dirname, 'cli.js'))
const write = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()))
  })
void runCli(
  process.argv.slice(2),
  {
    env: process.env,
    out: (text) => write(process.stdout, text),
    error: (text) => write(process.stderr, text),
    input: async () => {
      let input = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) {
        input += String(chunk)
        if (Buffer.byteLength(input) > 8 * 1024 * 1024)
          throw new Error('The CLI JSON input exceeds its size limit.')
      }
      return input
    },
  },
  {
    executable: packaged ? process.execPath : (require('electron') as string),
    appPath: packaged ? undefined : path.resolve(__dirname, '../..'),
    packaged,
  },
).then((code) => {
  process.exitCode = code
})
