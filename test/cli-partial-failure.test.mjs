import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { rootDir, freshDir, checker } from './_helper.mjs'

const { check, finish } = checker()
const dataDir = freshDir('cli-partial-failure')
function run(stage, directory = dataDir, json = true) {
  const args = [...process.execArgv, '--import', pathToFileURL(path.join(rootDir, 'test/fixtures/cli-partial-fetch.mjs')).href,
    path.join(rootDir, 'src/cli.mjs'), '--channel', 'alioth:gi:monster', '--data-dir', directory, ...(json ? ['--json'] : [])]
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: rootDir, env: { ...process.env, HESPERIDES_TEST_STAGE: stage } })
  const summary = json && child.stdout ? JSON.parse(child.stdout) : null
  const row = { stage, directory, exit: child.status, summary, stdout: child.stdout, stderr: child.stderr }
    return row
}

const partial = run('partial')
check('部分条目失败时退出码为1，频道统计保持原口径', partial.exit === 1 && partial.summary?.ok === 1 && partial.summary?.failed === 0, JSON.stringify({ exit: partial.exit, summary: partial.summary }))
const recovered = run('recovered')
check('同索引恢复成功时退出码为0，缺失记录补回', recovered.exit === 0 && recovered.summary?.failed === 0 && fs.existsSync(path.join(dataDir, 'records/gi/alioth/monster/102.json')))
const stable = run('recovered')
check('健康频道未变时仍跳过并返回退出码0', stable.exit === 0 && stable.summary?.skipped === 1)
const allFailed = run('all-failed', freshDir('cli-total-failure'))
check('整频道失败时保留失败计数并返回退出码1', allFailed.exit === 1 && allFailed.summary?.failed === 1)
const plain = run('partial', freshDir('cli-partial-plain'), false)
check('非JSON部分失败时退出码为1，进度日志仍保留', plain.exit === 1 && plain.stdout.includes('[hesperides]'))

finish()
