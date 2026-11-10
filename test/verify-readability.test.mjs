import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mod, rootDir, freshDir, checker } from './_helper.mjs'

const { harvestChannels } = await import(mod('src/sources/alioth/harvest.mjs'))
const { ALIOTH_BY_ID } = await import(mod('src/sources/alioth/channels.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { check, finish } = checker()
const rows = []
function snapshot(directory) {
  const files = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push({ name: path.relative(directory, file), hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtime: fs.statSync(file).mtimeMs })
    }
  }
  walk(directory)
  return JSON.stringify(files.sort((a, b) => a.name.localeCompare(b.name)))
}
function verify(name, directory, expectedExit, expectedProblem) {
  const before = snapshot(directory)
  const child = spawnSync(process.execPath, [...process.execArgv, path.join(rootDir, 'src/cli.mjs'), '--verify', '--json', '--data-dir', directory], { cwd: rootDir, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(child.stdout) } catch {}
  const readOnly = before === snapshot(directory)
  const row = { name, exit: child.status, expectedExit, json, readOnly, stderr: child.stderr }
  rows.push(row)
  check(name, child.status === expectedExit && readOnly && Array.isArray(json?.problems) && (!expectedProblem || json.problems.some(problem => problem.includes(expectedProblem))), JSON.stringify(row))
}
for (const format of ['txt', 'json']) {
  const dataDir = freshDir('verify-actual-' + format)
  const channel = ALIOTH_BY_ID.get(format === 'txt' ? 'alioth:gi:char-flycloak' : 'alioth:gi:monster')
  await harvestChannels([channel], { dataDir, delay: false, fetchImpl: async url => ({ ok: true, status: 200, text: url.endsWith('/char.json') ? '{"Flycloak":[{"ID":123}]}' : url.endsWith('/monster.json') ? '{"Templates":{"101":{}}}' : format === 'txt' ? 'fixture readable text' : '{"_id":101}' }) })
  await exportAll(dataDir)
  verify(`实际采集导出的${format}记录体检通过且保持只读`, dataDir, 0)
}
for (const kind of ['healthy', 'periods', 'imagerefs', 'manifest', 'missing-periods']) {
  const dataDir = freshDir('verify-readable-' + kind)
  await exportAll(dataDir)
  if (kind === 'periods') fs.writeFileSync(path.join(dataDir, 'periods.json'), '{"broken":')
  if (kind === 'manifest') fs.writeFileSync(path.join(dataDir, 'manifest.json'), '{"channels":')
  if (kind === 'imagerefs') {
    const file = path.join(dataDir, 'imagerefs/gi/nanoka/item.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"records":')
  }
  if (kind === 'missing-periods') fs.rmSync(path.join(dataDir, 'periods.json'))
  const broken = ['periods', 'imagerefs', 'manifest'].includes(kind)
  const label = kind === 'healthy' ? '健康空产物及缺少可选台账保持通过' : kind === 'missing-periods' ? '缺少可选期表保持原通过口径' : `现存${kind}文件解析失败时体检返回失败`
  verify(label, dataDir, broken ? 1 : 0, kind === 'imagerefs' ? '图片引用页' : broken ? kind + '.json' : '')
}
console.log('VERIFY_READABILITY_RESULTS=' + JSON.stringify(rows))
finish()
