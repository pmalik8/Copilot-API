import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import workspace from '../package.json'
import desktop from '../apps/modelbridge/package.json'
import runtime from '../packages/runtime/package.json'

const root = fileURLToPath(new URL('..', import.meta.url))

test('one clean-slate product has matching versions and a distinct Windows identity', () => {
  expect(workspace.workspaces).toEqual(['apps/modelbridge', 'packages/runtime'])
  expect(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')).toContain(
    '* text=auto eol=lf',
  )
  expect(desktop.version).toBe(workspace.version)
  expect(runtime.version).toBe(workspace.version)
  expect(desktop.build.appId).toBe('com.rajathnaik.modelbridge')
  expect(desktop.build.productName).toBe('ModelBridge')
  expect(desktop.build.electronLanguages).toEqual(['en-US'])
  expect(desktop.build.nsis.oneClick).toBe(false)
  expect(desktop.build.nsis.installerLanguages).toEqual(['en_US'])
  expect(
    fs.existsSync(
      path.resolve(root, 'apps', 'modelbridge', desktop.build.nsis.include),
    ),
  ).toBe(true)
  expect(desktop.build).not.toHaveProperty('publish')
  expect(workspace.scripts).not.toHaveProperty('build:connector')
  expect(workspace.scripts).not.toHaveProperty('build:gateway')
  expect(
    fs.readdirSync(path.join(root, '.github', 'workflows')).sort(),
  ).toEqual(['ci.yml', 'modelbridge-release.yml'])
  expect(
    fs.existsSync(path.join(root, 'apps', 'connector', 'package.json')),
  ).toBe(false)
  expect(
    fs.existsSync(path.join(root, 'packages', 'harnesses', 'package.json')),
  ).toBe(false)
  for (const entry of Object.values(runtime.exports))
    expect(
      fs.existsSync(path.resolve(root, 'packages', 'runtime', entry)),
    ).toBe(true)
})

test('only published ModelBridge releases can attach validated Windows assets', () => {
  const source = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'modelbridge-release.yml'),
    'utf8',
  )
  const workflow: unknown = Bun.YAML.parse(source)
  expect(workflow).toMatchObject({
    on: { release: { types: ['published'] }, workflow_dispatch: null },
    permissions: { contents: 'read' },
    concurrency: { 'cancel-in-progress': false },
    jobs: {
      build: {
        if: "github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/modelbridge-v')",
        'runs-on': 'windows-latest',
      },
      'attach-assets': {
        if: "github.event_name == 'release'",
        needs: 'build',
        permissions: { contents: 'write' },
      },
    },
  })
  expect(source).toContain('bun install --frozen-lockfile')
  expect(source).toContain('bun run test')
  expect(source).toContain('bun run --cwd apps/modelbridge package:win')
  expect(source).toContain('sha256sum --check "$INSTALLER.sha256"')
  expect(source).not.toContain('--clobber')
})

test('runtime modules do not depend on Electron, legacy shells, globals or compatibility imports', () => {
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.ts'))
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(
          /from\s+['"](?:electron|[^'"]*apps\/|@copilot-api\/)|window\.electronAPI|window\.connectorAPI/u,
        )
    }
  }
  visit(path.join(root, 'packages', 'runtime', 'src'))
})

test('the Electron main process never blocks on synchronous child processes', () => {
  const directory = path.join(root, 'apps', 'modelbridge', 'electron')
  for (const name of fs
    .readdirSync(directory)
    .filter((item) => item.endsWith('.ts')))
    expect(fs.readFileSync(path.join(directory, name), 'utf8')).not.toMatch(
      /\b(?:spawnSync|execFileSync|execSync)\b/u,
    )
})

test('documentation keeps legal attribution and identifies unsigned development downloads', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const release = `https://github.com/rajathnaik/Copilot-API/releases/download/modelbridge-v${workspace.version}`
  const installer = `ModelBridge.Setup.${workspace.version}.exe`
  expect(readme).toContain(`Development pre-release: ${workspace.version}`)
  expect(readme).toContain(`${release}/${installer}`)
  expect(readme).toContain(`${release}/${installer}.sha256`)
  expect(readme).toContain('not code-signed')
  expect(readme).toContain('not a verified production release')
  for (const target of [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)].map(
    (match) => match[1],
  ))
    if (!/^https?:/u.test(target))
      expect(fs.existsSync(path.resolve(root, target))).toBe(true)
  expect(fs.existsSync(path.join(root, 'LICENSE'))).toBe(true)
  expect(fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8')).toContain(
    'Project Lineage',
  )
})
