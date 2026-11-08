/**
 * 套件运行器：`node test/run.mjs [--filter=关键字] [--list]`
 *
 * 每个 `*.test.mjs` 独立子进程运行，任意 cwd 可跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(testDir, '..')

const args = process.argv.slice(2)
const filter = (args.find((arg) => arg.startsWith('--filter=')) || '').slice('--filter='.length)
const listOnly = args.includes('--list')

const files = fs.readdirSync(testDir)
  .filter((file) => file.endsWith('.test.mjs'))
  .filter((file) => !filter || file.includes(filter))
  .sort()

if (listOnly) {
  console.log(files.join('\n') || '(无套件)')
  process.exit(0)
}
if (!files.length) {
  console.log('没有匹配的套件')
  process.exit(1)
}

const runOne = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(testDir, file)], {
    cwd: rootDir,
    stdio: 'inherit'
  })
  child.on('close', (code) => resolve({ file, code: code ?? 1 }))
})

const results = []
for (const file of files) {
  console.log(`\n================ ${file} ================`)
  results.push(await runOne(file))
}

const failed = results.filter((result) => result.code !== 0)
console.log('\n================ 汇总 ================')
for (const result of results) {
  console.log(`${result.code === 0 ? '通过' : '失败'}   ${result.file}`)
}
console.log(`\n共 ${results.length} 个套件：通过 ${results.length - failed.length}｜失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
