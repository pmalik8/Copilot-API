import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppConfigurations, configurableApps } from '@modelbridge/runtime/apps'
import { CodexConfigurations } from '@modelbridge/runtime/codex'
import type { AvailableModel } from '@modelbridge/runtime/contracts'
import { AppState } from '../electron/state'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'the desktop restores app settings with no sources and confirms before writing',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const main = path.resolve('out', 'main', 'index.js')
    if (!fs.existsSync(main))
      throw new Error('Build ModelBridge before native tests.')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-restore-ui-'))
    const profile = path.join(directory, 'profile')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODELBRIDGE_PORT: '0',
      MODELBRIDGE_UPDATE_CHECK: '0',
      CODEX_HOME: path.join(directory, 'codex-home'),
      CLAUDE_CONFIG_DIR: path.join(directory, 'claude-home'),
      DSH_HOME: path.join(directory, 'dsh-home'),
      HERMES_HOME: path.join(directory, 'hermes-home'),
      OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json'),
      OPENCODE_CONFIG_DIR: path.join(directory, 'opencode-home'),
    }
    delete env.ELECTRON_RUN_AS_NODE
    const model: AvailableModel = {
      id: 'synthetic-source/test-model',
      name: 'Test model',
      sourceId: 'synthetic-source',
      sourceLabel: 'Fixture',
      protocol: 'responses',
      protocols: ['responses', 'chat-completions', 'messages'],
    }
    try {
      const state = AppState.open(profile)
      const configs = new AppConfigurations(state.vault, env, directory)
      const origin = 'http://127.0.0.1:4321'
      for (const app of configurableApps)
        await configs.apply(
          configs.preview(app, {
            modelId: model.id,
            models: [model],
            origin,
            key: state.vault.get('local-access'),
          }).id,
        )
      const codexFile = path.join(directory, 'codex-home', 'config.toml')
      const codex = await CodexConfigurations.open(
        codexFile,
        path.join(profile, 'codex'),
        state.vault,
        { command: 'synthetic-helper', args: [] },
      )
      await codex.apply(
        codex.preview('Fixture', model.id, [model], `${origin}/v1`).id,
      )
      const codexApplied = fs.readFileSync(codexFile, 'utf8')
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: 'modelbridge-restore-test',
          main: 'fixture.cjs',
        }),
      )
      fs.writeFileSync(
        path.join(directory, 'fixture.cjs'),
        `
        const { app, dialog } = require('electron')
        const fs = require('node:fs')
        const { EventEmitter } = require('node:events')
        const cp = require('node:child_process')
        const [main, appPath, profile, codexFile, codexApplied, webFile, desktopFile, remaining] = ${JSON.stringify(
          [
            main,
            process.cwd(),
            profile,
            codexFile,
            codexApplied,
            configs.configPath('deepseek'),
            configs.configPath('deepseek-desktop'),
            [
              ['claude-code', 'Claude Code', configs.configPath('claude-code')],
              ['hermes', 'Hermes Agent', configs.configPath('hermes')],
              ['openclaw', 'OpenClaw', configs.configPath('openclaw')],
              ['opencode', 'OpenCode', configs.configPath('opencode')],
              [
                'deepseek-desktop',
                'DeepSeek Harness (Desktop)',
                configs.configPath('deepseek-desktop'),
              ],
            ],
          ],
        )}
        cp.execFile = (_file, _args, _options, callback) => {
          setImmediate(() => callback(new Error('External commands disabled in this fixture.')))
          return new EventEmitter()
        }
        dialog.showErrorBox = (_title, message) => { throw new Error(message) }
        app.disableHardwareAcceleration()
        app.setAppPath(appPath)
        app.commandLine.appendSwitch('user-data-dir', profile)
        const loaded = new Promise(resolve => app.on('browser-window-created', (_event, window) => {
          window.hide()
          window.webContents.once('did-finish-load', () => resolve(window))
        }))
        require(main)
        loaded.then(async window => {
          const read = expression => window.webContents.executeJavaScript(expression)
          const section = 'document.querySelector("section[aria-labelledby=restore-app-settings-title]")'
          const wait = async expression => {
            const deadline = Date.now() + 15000
            while (!await read(expression)) {
              if (Date.now() > deadline) throw new Error('Restore UI did not reach: ' + expression)
              await new Promise(resolve => setTimeout(resolve, 50))
            }
          }
          const click = (label, root = section) => read(\`(() => {
            const button = [...\${root}.querySelectorAll('button')].find(item => item.textContent.trim() === \${JSON.stringify(label)})
            if (!button || button.disabled) throw new Error('Button unavailable: ' + \${JSON.stringify(label)})
            button.click()
          })()\`)
          await wait(section + '?.querySelectorAll("option").length === ' + (remaining.length + 2))
          if (await read('!!document.querySelector("#tab-settings")'))
            throw new Error('Expected onboarding without a source or role.')
          await click('Set up as client', 'document')
          await wait('!!document.querySelector("#tab-settings")')
          await read('document.querySelector("#tab-settings").click()')
          await wait(section + '?.querySelectorAll("option").length === ' + (remaining.length + 2))

          await click('Preview restore')
          await wait(section + '?.querySelector(".preview h3")?.textContent === "Restore Codex"')
          await click('Cancel')
          if (fs.readFileSync(codexFile, 'utf8') !== codexApplied) throw new Error('Cancel modified Codex.')
          await click('Preview restore')
          await wait(section + '?.querySelector(".preview h3")?.textContent === "Restore Codex"')
          fs.appendFileSync(codexFile, '\\n# Post-preview change\\n')
          await click('Restore original settings')
          await wait(section + '?.querySelector("[role=alert]")?.textContent.includes("changed after")')
          await click('Preview restore')
          await wait(section + '?.querySelector(".preview h3")?.textContent === "Restore Codex"')
          await click('Restore original settings')
          await wait(section + '?.querySelector("[role=status]")?.textContent.includes("Restored Codex")')
          const codexText = fs.readFileSync(codexFile, 'utf8')
          if (!codexText.includes('# Post-preview change') || codexText.includes('modelbridge'))
            throw new Error('Codex restore did not preserve the later unrelated edit.')

          await read(\`(() => { const select = \${section}.querySelector('select'); select.value = 'deepseek'; select.dispatchEvent(new Event('change', { bubbles: true })); })()\`)
          await click('Preview restore')
          await wait(section + '?.querySelector(".preview h3")?.textContent === "Restore DeepSeek Harness (Web)"')
          if (!fs.existsSync(webFile)) throw new Error('DeepSeek preview changed files.')
          if (process.env.MODELBRIDGE_TEST_RESTORE_SCREENSHOTS) {
            const output = process.env.MODELBRIDGE_TEST_RESTORE_SCREENSHOTS
            const path = require('node:path')
            fs.mkdirSync(output, { recursive: true })
            for (const width of [1120, 760]) {
              window.setContentSize(width, 920)
              await wait('innerWidth === ' + width)
              await read(section + '.scrollIntoView({block:"start"})')
              await new Promise(resolve => setTimeout(resolve, 100))
              const overflow = await read('document.documentElement.scrollWidth > innerWidth + 1')
              if (overflow) throw new Error('Restore preview overflows at width ' + width)
              const image = await window.webContents.capturePage()
              fs.writeFileSync(path.join(output, 'restore-' + width + '.png'), image.toPNG())
            }
          }
          await click('Restore original settings')
          await wait(section + '?.querySelector("[role=status]")?.textContent.includes("Restored DeepSeek Harness (Web)")')
          if (fs.existsSync(webFile) || !fs.existsSync(desktopFile))
            throw new Error('Restore touched the wrong DeepSeek profile.')
          await wait(section + '?.querySelectorAll("option").length === ' + (remaining.length + 1))
          let count = remaining.length + 1
          for (const [id, name, file] of remaining) {
            await read(\`(() => { const select = \${section}.querySelector('select'); select.value = \${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()\`)
            await click('Preview restore')
            await wait(section + '?.querySelector(".preview h3")?.textContent === ' + JSON.stringify('Restore ' + name))
            if (!fs.existsSync(file)) throw new Error('Preview changed ' + name)
            await click('Restore original settings')
            await wait(section + '?.querySelector("[role=status]")?.textContent.includes(' + JSON.stringify('Restored ' + name) + ')')
            if (fs.existsSync(file)) throw new Error('Restore failed for ' + name)
            await wait(section + '?.querySelectorAll("option").length === ' + (--count))
          }
          const backups = await read('window.modelbridge.appRestoreTargets()')
          if (!backups.ok || backups.value.some(target => target.app !== 'codex'))
            throw new Error('Restored harnesses still reported as pending backups.')
          process.stdout.write('RESTORE_UI_OK\\n', () => app.quit())
        }).catch(error => { console.error(error.message); app.exit(1) })
      `,
      )
      const child = Bun.spawn({
        cmd: [electron, directory, `--user-data-dir=${profile}`],
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => child.kill(), 50_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      expect(code, stderr).toBe(0)
      expect(stdout).toContain('RESTORE_UI_OK')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
