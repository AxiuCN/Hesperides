#!/usr/bin/env node
/**
 * 源监控：按范围完整重抓一遍，只记录每个频道的条数，并按统一口径给结论。
 *
 * 用法：
 *   node tools/validate-sources.mjs --scope runtime   # 每日：nanoka 全量 + 玉璃终局（= #图鉴更新 同口径）
 *   node tools/validate-sources.mjs --scope all       # 每周：全引擎 records-only（跳过 TextMap 大文件）
 *
 * 判定只有三条：
 *   🔴 退出码非 0 / 有频道 failed / 频道没写进台账 → exit 1
 *   🟡 有频道 0 条 → 仍 exit 0，只在摘要里标出来
 *   🟢 其余正常，条数照表记录（`absent` = 上游 404，属正常状态，单列不判红）
 *
 * 产物一律写临时目录（不落仓库、不进 git）；CI 里额外写 step summary 与 markdown 供建 issue。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(rootDir, 'src/cli.mjs')

/** 解析参数 */
function parseArgs (argv) {
  const args = { scope: 'runtime', dataDir: '', json: false, timeoutMs: 30 * 60 * 1000 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scope') args.scope = argv[++i]
    else if (arg === '--data-dir') args.dataDir = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--timeout-minutes') args.timeoutMs = Number(argv[++i]) * 60 * 1000
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools/validate-sources.mjs [--scope runtime|all] [--data-dir <dir>] [--json] [--timeout-minutes N]')
      process.exit(0)
    }
  }
  if (!['runtime', 'all'].includes(args.scope)) throw new Error(`未知 scope：${args.scope}`)
  return args
}

/**
 * 按范围挑频道
 * runtime = 插件运行期口径（nanoka 全量 + 玉璃终局）；all = 全部频道，跳过 TextMap
 * @param {{scope: string}} args
 * @returns {Promise<object[]>}
 */
async function selectChannels ({ scope }) {
  const registry = await import(new URL('../src/sources/registry.mjs', import.meta.url).href)
  const { ALL_CHANNELS, ENDGAME_CHANNEL_IDS } = registry
  if (scope === 'all') return ALL_CHANNELS.filter((channel) => channel.kind !== 'text')
  return ALL_CHANNELS.filter((channel) => channel.source === 'nanoka'
    || (channel.source === 'alioth' && ENDGAME_CHANNEL_IDS.includes(channel.id)))
}

/** 跑一次 CLI 完整抓取 */
function runScrape ({ channels, dataDir, timeoutMs }) {
  const startedAt = Date.now()
  const child = spawnSync(process.execPath, [
    cli, '--channels', channels.map((channel) => channel.id).join(','), '--mode', 'full', '--data-dir', dataDir
  ], { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
  return {
    exit: child.status ?? 1,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    stdout: child.stdout || '',
    stderr: child.stderr || ''
  }
}

/** 读台账里的频道结果 */
function readManifest (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 汇总行：频道 → 状态与条数 */
function buildRows (channels, manifest) {
  const recorded = manifest?.channels || {}
  return channels.map((channel) => {
    const entry = recorded[channel.id]
    return {
      id: channel.id,
      status: entry ? String(entry.status || '') : 'missing',
      records: entry ? Number(entry.records || 0) : 0
    }
  })
}

/**
 * 结论：三档判定
 *
 * 只有 `failed`（抓取失败）和 `missing`（没写进台账）算红；`absent` 是上游 404 的正常状态
 * （契约里有、线上没有，如 Lunaris 当前未发布的 `quest`），不应让监控变红——单列出来供人看。
 * @param {{exit: number, rows: object[]}} input
 * @returns {{level: 'red'|'yellow'|'green', broken: object[], empty: object[], absent: object[]}}
 */
export function verdictOf ({ exit, rows }) {
  const broken = rows.filter((row) => row.status === 'missing' || row.status === 'failed')
  const absent = rows.filter((row) => row.status === 'absent')
  const empty = rows.filter((row) => !['missing', 'failed', 'absent'].includes(row.status) && row.records === 0)
  if (exit !== 0 || broken.length) return { level: 'red', broken, empty, absent }
  if (empty.length) return { level: 'yellow', broken, empty, absent }
  return { level: 'green', broken, empty, absent }
}

/** markdown 摘要（step summary / issue 正文共用） */
function renderMarkdown ({ scope, args, result, rows, verdict, dataDir }) {
  const icon = { red: '🔴', yellow: '🟡', green: '🟢' }[verdict.level]
  const lines = [
    `${icon} **源监控（${scope}）** — 频道 ${rows.length}，条数合计 ${rows.reduce((sum, row) => sum + row.records, 0).toLocaleString()}，` +
      `CLI exit ${result.exit}，耗时 ${result.seconds}s`,
    '',
    `- 数据目录：\`${dataDir}\``,
    `- 完整重抓（\`--mode full\`，不带详情与图片）`
  ]
  if (verdict.broken.length) lines.push(`- 异常频道：${verdict.broken.map((row) => `\`${row.id}\`(${row.status})`).join('、')}`)
  if (verdict.absent.length) lines.push(`- 上游 404（按 \`absent\` 记录，保留旧数据）：${verdict.absent.map((row) => `\`${row.id}\``).join('、')}`)
  if (verdict.empty.length) lines.push(`- 0 条频道：${verdict.empty.map((row) => `\`${row.id}\``).join('、')}`)
  lines.push('', '| 频道 | 状态 | 条数 |', '| --- | --- | --- |')
  for (const row of rows) lines.push(`| \`${row.id}\` | ${row.status} | ${row.records} |`)
  return lines.join('\n')
}

/** 入口：跑一次完整重抓并输出结论 */
async function main () {
  const args = parseArgs(process.argv.slice(2))
  const channels = await selectChannels(args)
  if (!channels.length) throw new Error('没有选中任何频道')

  const dataDir = args.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hes-monitor-'))
  fs.mkdirSync(dataDir, { recursive: true })

  console.log(`[monitor] scope=${args.scope} 频道 ${channels.length} 个，产物目录 ${dataDir}`)
  let result = runScrape({ channels, dataDir, timeoutMs: args.timeoutMs })
  // 网络抖动兜底：整体失败时等 30 秒重跑一次（只重试一次，避免把上游当靶子）
  if (result.exit !== 0) {
    console.log(`[monitor] 首轮失败（exit ${result.exit}），30 秒后重试一次`)
    await new Promise((resolve) => setTimeout(resolve, 30000))
    result = runScrape({ channels, dataDir, timeoutMs: args.timeoutMs })
  }

  const manifest = readManifest(dataDir)
  const rows = buildRows(channels, manifest)
  const verdict = verdictOf({ exit: result.exit, rows })
  const markdown = renderMarkdown({ scope: args.scope, args, result, rows, verdict, dataDir })
  const summary = {
    scope: args.scope,
    channels: rows.length,
    records: rows.reduce((sum, row) => sum + row.records, 0),
    exit: result.exit,
    seconds: result.seconds,
    level: verdict.level,
    broken: verdict.broken.map((row) => row.id),
    empty: verdict.empty.map((row) => row.id),
    absent: verdict.absent.map((row) => row.id),
    rows
  }

  const outFile = path.join(os.tmpdir(), 'hesperides-monitor.json')
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2))
  const mdFile = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'hesperides-monitor.md')
  fs.writeFileSync(mdFile, markdown + '\n')

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
  }

  console.log(markdown)
  console.log(`\n[monitor] 结论：${verdict.level}，结果 JSON：${outFile}`)
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  process.exit(verdict.level === 'red' ? 1 : 0)
}

// 只在直接执行时跑；被套件 import 时只取纯函数（verdictOf），不触发抓取
const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(`[monitor] 失败：${error?.message || error}`)
    process.exit(1)
  })
}