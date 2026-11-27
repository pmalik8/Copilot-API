import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const include = fileURLToPath(
  new URL('../installer/cli-path.nsh', import.meta.url),
)
const prerequisites = fileURLToPath(
  new URL('../installer/prerequisites.nsh', import.meta.url),
)

test('installer wires user PATH setup and update-aware uninstall cleanup', () => {
  const source = fs.readFileSync(include, 'utf8')
  const hooks = fs.readFileSync(prerequisites, 'utf8')
  expect(hooks).toMatch(
    /!macro customInstall\s+Call MBApplyDataFolder\s+Call MBInstallCliPath/u,
  )
  expect(hooks.indexOf('cli-path.nsh')).toBeLessThan(
    hooks.indexOf('!ifndef BUILD_UNINSTALLER'),
  )
  expect(source).toMatch(
    /!macro customUnInstall[\s\S]*?\$\{IfNot\} \$\{isUpdated\}[\s\S]*?Call un\.MBUninstallCliPath/u,
  )
  expect(source).not.toMatch(/(?:WriteReg|DeleteReg)\w* .*HKLM/u)
  expect(source).not.toMatch(/\bsetx\b|powershell|nsExec/u)
  expect(source).toContain('StrCpy $MBPathInstallEntry "$INSTDIR\\bin"')
  const packaging = z
    .object({
      build: z.object({
        extraFiles: z.array(z.object({ from: z.string(), to: z.string() })),
      }),
    })
    .parse(
      JSON.parse(
        fs.readFileSync(
          fileURLToPath(new URL('../package.json', import.meta.url)),
          'utf8',
        ),
      ),
    )
  expect(packaging.build.extraFiles).toContainEqual({
    from: 'cli/modelbridge.cmd',
    to: 'bin/modelbridge.cmd',
  })
  const launcher = fs.readFileSync(
    fileURLToPath(new URL('../cli/modelbridge.cmd', import.meta.url)),
    'utf8',
  )
  expect(launcher).toContain('"%~dp0..\\ModelBridge.exe"')
  expect(launcher).toContain(
    '"%~dp0..\\resources\\app.asar\\out\\main\\cli.js"',
  )
})

test.skipIf(process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_NSIS)(
  'compiled CLI install and uninstall preserve user PATH, ownership and long values',
  async () => {
    const compiler = process.env.MODELBRIDGE_TEST_NSIS
    if (!compiler) throw new Error('Set MODELBRIDGE_TEST_NSIS to makensis.exe.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-cli-path-'),
    )
    const registryRoot = `Software\\ModelBridgeCliPathTest-${path.basename(directory)}`
    const envKey = `${registryRoot}\\Environment`
    const ownerKey = `${registryRoot}\\Owner`
    const installDirectory = path.join(directory, 'Install with spaces')
    const movedDirectory = path.join(directory, 'Moved installation')
    const install = path.join(installDirectory, 'bin')
    const moved = path.join(movedDirectory, 'bin')
    const executable = path.join(directory, 'install.exe')
    const builder = path.join(directory, 'uninstall-builder.exe')
    const uninstaller = path.join(directory, 'uninstall.exe')
    const limitFile = path.join(directory, 'limit')
    const raceFile = path.join(directory, 'race')
    const resultSchema = z.object({
      value: z.union([z.string(), z.number()]).nullable(),
      kind: z.string().nullable(),
      entry: z.string().nullable(),
      missing: z.number().nullable(),
      data: z.string().nullable(),
    })
    type Seed = {
      value?: string | number
      kind?: 'String' | 'ExpandString' | 'DWord'
      entry?: string
      missing?: number
    }
    const registry = async (
      action: 'reset' | 'read' | 'edit' | 'delete',
      seed: Seed = {},
    ) => {
      // All registry operations are scoped to one unique fixture branch.
      const command = `
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = '${registryRoot}'
if (!$root.StartsWith('Software\\ModelBridgeCliPathTest-')) { throw 'Unsafe fixture key.' }
$cu = [Microsoft.Win32.Registry]::CurrentUser
if ($inputData.action -eq 'reset' -or $inputData.action -eq 'delete') {
  $cu.DeleteSubKeyTree($root, $false)
}
if ($inputData.action -eq 'reset' -or $inputData.action -eq 'edit') {
  $envKey = $cu.CreateSubKey('${envKey}')
  try {
    if ($null -eq $inputData.seed.value) { $envKey.DeleteValue('Path', $false) }
    else {
      $kind = if ($inputData.seed.kind) { $inputData.seed.kind } else { 'ExpandString' }
      $value = if ($kind -eq 'DWord') { [int]$inputData.seed.value } else { [string]$inputData.seed.value }
      $envKey.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::$kind)
    }
  } finally { $envKey.Close() }
  if ($inputData.action -eq 'reset') {
    $ownerKey = $cu.CreateSubKey('${ownerKey}')
    try {
      $ownerKey.SetValue('DataDir', '${path.join(directory, 'data')}')
      if ($null -ne $inputData.seed.entry) { $ownerKey.SetValue('CliPathEntry', $inputData.seed.entry) }
      if ($null -ne $inputData.seed.missing) { $ownerKey.SetValue('CliPathMissing', [int]$inputData.seed.missing) }
    } finally { $ownerKey.Close() }
  }
}
$result = @{ value = $null; kind = $null; entry = $null; missing = $null; data = $null }
$envKey = $cu.OpenSubKey('${envKey}')
if ($envKey) {
  try {
    if ($envKey.GetValueNames() -contains 'Path') {
      $result.value = $envKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $result.kind = $envKey.GetValueKind('Path').ToString()
    }
  } finally { $envKey.Close() }
}
$ownerKey = $cu.OpenSubKey('${ownerKey}')
if ($ownerKey) {
  try {
    $result.entry = $ownerKey.GetValue('CliPathEntry')
    $result.missing = $ownerKey.GetValue('CliPathMissing')
    $result.data = $ownerKey.GetValue('DataDir')
  } finally { $ownerKey.Close() }
}
$result | ConvertTo-Json -Compress
`
      const child = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          command,
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      )
      await child.stdin.write(JSON.stringify({ action, seed }))
      await child.stdin.end()
      const timer = setTimeout(() => child.kill(), 20_000)
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      expect(code, errors).toBe(0)
      return resultSchema.parse(JSON.parse(output))
    }
    const run = async (file: string, args: string[] = []) => {
      const child = spawn(file, args, {
        env: { ...process.env, MODELBRIDGE_PATH_TEST: install },
        stdio: 'ignore',
        // NSIS /D and _? consume the unquoted remainder, including spaces.
        windowsVerbatimArguments: true,
      })
      const timer = setTimeout(() => child.kill(), 20_000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        expect(code, 'CLI PATH fixture failed or timed out.').toBe(0)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
      }
    }
    const compile = async (name: string, source: string) => {
      const script = path.join(directory, name)
      fs.writeFileSync(script, source)
      const child = Bun.spawn([compiler, '/V2', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${output}\n${errors}`).toBe(0)
    }
    const definitions = `
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!define MB_CLI_ENV_REGISTRY_KEY "${envKey}"
!define MB_CLI_OWNER_REGISTRY_KEY "${ownerKey}"
!define MB_CLI_SKIP_NOTIFY
`
    const apply = async (target = installDirectory) =>
      run(executable, ['/S', `/D=${target}`])
    const restore = async (target = installDirectory) =>
      run(uninstaller, ['/S', `_?=${target}`])
    const expectRestored = async (
      value: string | number | null,
      kind: string | null,
    ) =>
      expect(await registry('read')).toEqual({
        value,
        kind,
        entry: null,
        missing: null,
        data: path.join(directory, 'data'),
      })
    try {
      await compile(
        'install.nsi',
        `${definitions}
Name "ModelBridge CLI PATH install fixture"
OutFile "${executable}"
InstallDir "${installDirectory}"
!include "FileFunc.nsh"
!include "${include}"
Section
  FileOpen $9 "${limitFile}" w
  FileWrite $9 "\${NSIS_MAX_STRLEN}"
  FileClose $9
  \${GetParameters} $0
  ClearErrors
  \${GetOptions} "$0" "/RACE" $1
  \${IfNot} \${Errors}
    Call MBReadCliPath
    StrCpy $MBPathBefore $MBPathValue
    StrCpy $MBPathBeforeExists $MBPathExists
    StrCpy $MBPathBeforeType $MBPathType
    StrCpy $MBPathAfter "$MBPathValue;$INSTDIR"
    WriteRegExpandStr HKCU "${envKey}" "Path" "changed concurrently"
    StrCpy $MBPathMissing 0
    Call MBWriteCliPath
    FileOpen $9 "${raceFile}" w
    FileWrite $9 "$MBPathSafe"
    FileClose $9
  \${Else}
    Call MBInstallCliPath
  \${EndIf}
SectionEnd
`,
      )
      await compile(
        'uninstall-builder.nsi',
        `${definitions}
Name "ModelBridge CLI PATH uninstall fixture"
OutFile "${builder}"
!define BUILD_UNINSTALLER
!include "${include}"
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section "Uninstall"
  Call un.MBUninstallCliPath
SectionEnd
`,
      )
      await run(builder)

      await registry('reset')
      await apply()
      const added = await registry('read')
      expect(added).toMatchObject({
        value: install,
        kind: 'ExpandString',
        entry: install,
        missing: 1,
      })
      await apply()
      expect(await registry('read')).toEqual(added)
      await restore()
      await expectRestored(null, null)
      await restore()
      await expectRestored(null, null)

      for (const kind of ['String', 'ExpandString'] as const) {
        for (const original of [
          '',
          'C:\\Other Tools',
          '%USERPROFILE%\\bin;C:\\Other;',
          ';C:\\Other;;',
          '"C:\\Other Tools";C:\\ModelBridge-Extra',
        ]) {
          await registry('reset', { value: original, kind })
          await apply()
          expect((await registry('read')).value).toBe(
            original ? `${original};${install}` : install,
          )
          await restore()
          await expectRestored(original, kind)
        }
      }

      for (const existing of [
        install,
        `C:\\Other;${install.toUpperCase()}\\`,
        `C:\\Other; "${install}\\" ;C:\\After`,
        `C:\\Other;${install};${install}`,
        'C:\\Other;%MODELBRIDGE_PATH_TEST%',
      ]) {
        await registry('reset', { value: existing })
        await apply()
        expect((await registry('read')).entry).toBeNull()
        await restore()
        await expectRestored(existing, 'ExpandString')
      }

      await registry('reset', { value: 'C:\\Other' })
      await apply()
      await registry('edit', { value: `C:\\Other;${install};C:\\UserAdded` })
      await restore()
      await expectRestored('C:\\Other;C:\\UserAdded', 'ExpandString')

      await registry('reset', { value: 'C:\\Other' })
      await apply()
      await registry('edit', { value: `${install};C:\\Other` })
      await restore()
      await expectRestored('C:\\Other', 'ExpandString')

      await registry('reset', { value: 'C:\\Other' })
      await apply()
      await registry('edit', { value: `C:\\Other;${install};${install}` })
      await restore()
      await expectRestored(`C:\\Other;${install}`, 'ExpandString')

      await registry('reset', { value: 'C:\\Other' })
      await apply()
      const edited = `C:\\Other;"${install.toUpperCase()}\\"`
      await registry('edit', { value: edited })
      await restore()
      await expectRestored(edited, 'ExpandString')

      await registry('reset')
      await apply()
      await apply(movedDirectory)
      expect(await registry('read')).toMatchObject({
        value: moved,
        entry: moved,
        missing: 1,
      })
      await restore(installDirectory)
      expect((await registry('read')).entry).toBe(moved)
      await restore(movedDirectory)
      await expectRestored(null, null)

      await registry('reset', { value: 'C:\\Other' })
      await apply()
      await registry('edit', { value: 'C:\\Other;C:\\NewUserTool' })
      await apply()
      expect((await registry('read')).value).toBe(
        `C:\\Other;C:\\NewUserTool;${install}`,
      )
      await restore()
      await expectRestored('C:\\Other;C:\\NewUserTool', 'ExpandString')

      await registry('reset', { value: `C:\\Other;${moved}` })
      await apply()
      await apply(movedDirectory)
      expect((await registry('read')).entry).toBeNull()
      await restore(movedDirectory)
      await expectRestored(`C:\\Other;${moved}`, 'ExpandString')

      await registry('reset')
      await apply()
      await registry('edit')
      await restore()
      await expectRestored(null, null)

      const limit = Number(fs.readFileSync(limitFile, 'utf8'))
      expect(limit).toBeGreaterThanOrEqual(1024)
      for (const long of ['x'.repeat(limit + 50), 'x'.repeat(limit - 10)]) {
        await registry('reset', { value: long })
        await apply()
        await restore()
        await expectRestored(long, 'ExpandString')
      }
      const long = 'x'.repeat(limit + 50)
      await registry('reset', {
        value: long,
        entry: install,
        missing: 0,
      })
      await restore()
      expect(await registry('read')).toMatchObject({
        value: long,
        entry: install,
      })

      await registry('reset', { value: 42, kind: 'DWord' })
      await apply()
      await restore()
      await expectRestored(42, 'DWord')

      await registry('reset', { value: 'C:\\Other', kind: 'String' })
      await run(executable, ['/S', '/RACE'])
      expect(fs.readFileSync(raceFile, 'utf8')).toBe('0')
      await expectRestored('changed concurrently', 'ExpandString')

      await registry('reset', { value: 'C:\\Other' })
      await apply(path.join(directory, 'Folder;with delimiter'))
      await expectRestored('C:\\Other', 'ExpandString')
    } finally {
      await registry('delete')
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  180_000,
)
