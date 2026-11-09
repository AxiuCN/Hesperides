// CLI 输出契约：`--json` 时 stdout 只能是机器可读的 JSON
//
// 早先 `--export --json` 会把导出日志先打到 stdout，整段无法 JSON.parse（exit 仍是 0）——
// 调用方（插件/脚本）拿到的既不是纯 JSON、也不报错，只能静默失败。
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rootDir, freshDir, checker } from './_helper.mjs'

const { check, finish } = checker()
const dataDir = freshDir('cli-json')
const missingDir = freshDir('cli-json-missing')

/** 跑一次 CLI，返回 exit / stdout / stderr / 解析出的 JSON */
function run (args) {
  const result = spawnSync(process.execPath, [...process.execArgv, path.join(rootDir, 'src/cli.mjs'), ...args], {
    cwd: rootDir,
    encoding: 'utf8'
  })
  let json = null
  let parseError = ''
  try {
    json = JSON.parse(result.stdout)
  } catch (error) {
    parseError = error.message
  }
  return { args, exit: result.status, stdout: result.stdout, stderr: result.stderr, json, parseError }
}

console.log('=== ① --json：stdout 是单个 JSON 值 ===')
{
  const list = run(['--list-channels', '--json'])
  check('list --json 可解析且非空', list.exit === 0 && Array.isArray(list.json) && list.json.length > 0,
    `exit=${list.exit} ${list.parseError}`)
}

{
  const exported = run(['--export', '--json', '--data-dir', dataDir])
  check('export --json 的 stdout 只有 JSON（修复点）',
    exported.exit === 0 && !exported.parseError && Array.isArray(exported.json?.games),
    exported.parseError || `exit=${exported.exit}`)
  check('export --json 的日志被挪到 stderr',
    exported.stderr.includes('[hesperides]'), `stderr=${exported.stderr.slice(0, 40)}`)
}

{
  const verified = run(['--verify', '--json', '--data-dir', dataDir])
  check('verify --json 保持可解析与 exit 0', verified.exit === 0 && verified.json?.indexOk === true,
    verified.parseError || `indexOk=${verified.json?.indexOk}`)
}

{
  const invalid = run(['--verify', '--json', '--data-dir', missingDir])
  check('失败的 verify 仍是 exit 1 且 JSON 可读',
    invalid.exit === 1 && invalid.json?.indexOk === false, `exit=${invalid.exit}`)
}

console.log('\n=== ② 不带 --json：日志照常在 stdout ===')
{
  const plainExport = run(['--export', '--data-dir', dataDir])
  check('非 JSON export 保留进度文本', plainExport.exit === 0
    && plainExport.stdout.includes('[hesperides]') && plainExport.stdout.includes('导出'))
}
{
  const plainList = run(['--list-channels'])
  check('非 JSON list 保留频道文本', plainList.exit === 0
    && plainList.stdout.includes('alioth:gi:abyss') && plainList.stdout.includes('共 '))
}
{
  const plainVerify = run(['--verify', '--data-dir', dataDir])
  check('非 JSON 成功 verify：exit 0 且有「校验通过」', plainVerify.exit === 0 && plainVerify.stdout.includes('校验通过'))
}
{
  const plainInvalid = run(['--verify', '--data-dir', missingDir])
  check('非 JSON 失败 verify：exit 1 且有「校验失败」', plainInvalid.exit === 1 && plainInvalid.stdout.includes('校验失败'))
}

finish()