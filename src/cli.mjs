#!/usr/bin/env node
/**
 * Hesperides CLI
 *
 * 用法：
 *   node src/cli.mjs --list-channels
 *   node src/cli.mjs --channel alioth:gi:abyss
 *   node src/cli.mjs --channels alioth:gi:abyss,alioth:hsr:as --mode full
 *   node src/cli.mjs --all
 *   node src/cli.mjs --export
 *   node src/cli.mjs --verify
 *
 * 约定：
 *   - 本 CLI 只是「调用方之一」，与 Atlas-Plugin 调用同一套库；抓哪些频道由参数决定，代码里没有默认开关
 *   - 退出码：0 全部成功 / 1 有失败或校验不过
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_CHANNELS, CHANNEL_BY_ID, harvestSelected } from './sources/registry.mjs'

import { exportAll } from './export/index.mjs'
import { readJson, log } from './core/io.mjs'
import { validateIndex, CHANNEL_STATUS } from './schema/index.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析命令行参数
 * @param {string[]} argv
 */
export function parseArgs (argv) {
  const args = {
    dataDir: path.join(rootDir, 'data', 'hesperides'),
    mode: 'incremental',
    concurrency: 4,
    channels: [],
    json: false,
    list: false,
    all: false,
    withDetails: false,
    verify: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--list-channels': args.list = true; break
      case '--all': args.all = true; break
      case '--channel': args.channels.push(next()); break
      case '--channels': args.channels.push(...String(next() || '').split(',').filter(Boolean)); break
      case '--mode': args.mode = next() === 'full' ? 'full' : 'incremental'; break
      case '--concurrency': args.concurrency = Math.max(1, Number(next()) || 4); break
      case '--data-dir': args.dataDir = path.resolve(String(next())); break
      case '--with-details': args.withDetails = true; break
      case '--export': args.exportOnly = true; break
      case '--verify': args.verify = true; break
      case '--json': args.json = true; break
      case '--help':
      case '-h': args.help = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    }
  }
  return args
}

/** 打印帮助 */
function printHelp () {
  console.log(`Hesperides CLI

  --list-channels              列出全部频道（source:game:page）
  --channel <id>               抓取单个频道（可重复）
  --channels <a,b,c>           抓取多个频道
  --all                        抓取全部频道（含 TextMap 大文件，注意体积）
  --mode incremental|full      增量（默认）或全量
  --concurrency <n>            并发数（默认 4）
  --data-dir <path>            产物目录（默认 data/hesperides）
  --with-details               nanoka 频道同时抓条目详情（请求量大幅增加）
  --export                     只从已有记录重建 index.json / periods.json
  --verify                     校验已有产物（schema 版本、频道状态）
  --json                       以 JSON 输出结果
  -h, --help                   显示本帮助`)
}

/** 列出频道 */
function listChannels (json) {
  if (json) {
    console.log(JSON.stringify(ALL_CHANNELS.map((channel) => ({
      id: channel.id, game: channel.game, page: channel.page, kind: channel.kind
    })), null, 2))
    return
  }
  const rows = ALL_CHANNELS.map((channel) => `${channel.id.padEnd(28)} ${channel.kind.padEnd(7)} ${channel.page}`)
  console.log(`共 ${ALL_CHANNELS.length} 个频道\n`)
  console.log(rows.join('\n'))
}

/** 校验产物 */
async function verify (dataDir, json) {
  const index = await readJson(path.join(dataDir, 'index.json'))
  const result = validateIndex(index)
  const periods = await readJson(path.join(dataDir, 'periods.json'), { games: {} })
  const summary = {
    indexOk: result.ok,
    reason: result.reason || '',
    games: Object.keys(index?.games || {}),
    periodPages: Object.fromEntries(Object.entries(periods?.games || {}).map(([game, pages]) => [game, Object.keys(pages)]))
  }
  if (json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(result.ok ? '✅ 产物校验通过' : `❌ 产物校验失败：${result.reason}`)
    console.log(`   游戏：${summary.games.join(', ') || '(无)'}`)
    for (const [game, pages] of Object.entries(summary.periodPages)) {
      console.log(`   ${game} 期索引：${pages.join(', ') || '(无)'}`)
    }
  }
  return result.ok
}

/**
 * 入口
 */
async function main () {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    log.error(err.message)
    printHelp()
    process.exitCode = 1
    return
  }

  if (args.help) return printHelp()
  if (args.list) return listChannels(args.json)
  if (args.exportOnly) {
    const { index, periods } = await exportAll(args.dataDir)
    if (args.json) {
      console.log(JSON.stringify({
        games: Object.keys(index.games),
        periodPages: Object.fromEntries(Object.entries(periods.games).map(([game, pages]) => [game, Object.keys(pages)]))
      }, null, 2))
    }
    return
  }
  if (args.verify) {
    const ok = await verify(args.dataDir, args.json)
    process.exitCode = ok ? 0 : 1
    return
  }

  // 解析要抓的频道（这里没有"默认集合"，--all 才是全部）
  let selected
  if (args.all) {
    selected = ALL_CHANNELS
  } else if (args.channels.length) {
    const unknown = args.channels.filter((id) => !CHANNEL_BY_ID.has(id))
    if (unknown.length) {
      log.error(`未知频道：${unknown.join(', ')}`)
      log.info('用 --list-channels 查看可用频道')
      process.exitCode = 1
      return
    }
    selected = args.channels.map((id) => CHANNEL_BY_ID.get(id))
  } else {
    printHelp()
    process.exitCode = 1
    return
  }

  log.info(`抓取 ${selected.length} 个频道（mode=${args.mode}, concurrency=${args.concurrency}）`)
  const startedAt = Date.now()
  const results = await harvestSelected(selected, {
    dataDir: args.dataDir,
    mode: args.mode,
    concurrency: args.concurrency,
    withDetails: args.withDetails,
    onChannel: (result) => {
      const status = result.status === CHANNEL_STATUS.OK ? '✅'
        : result.status === CHANNEL_STATUS.SKIPPED ? '⏭'
          : result.status === CHANNEL_STATUS.ABSENT ? '∅'
            : result.status === CHANNEL_STATUS.UNVERIFIED ? '⚠' : '❌'
      log.info(`${status} ${result.id} 记录 ${result.records}（抓 ${result.fetched} / 跳 ${result.skipped} / 失败 ${result.failed}）${result.ms}ms${result.error ? ' — ' + result.error : ''}`)
    }
  })

  const { index, periods } = await exportAll(args.dataDir)
  const summary = {
    elapsedMs: Date.now() - startedAt,
    channels: results.length,
    ok: results.filter((r) => r.status === CHANNEL_STATUS.OK).length,
    skipped: results.filter((r) => r.status === CHANNEL_STATUS.SKIPPED).length,
    absent: results.filter((r) => r.status === CHANNEL_STATUS.ABSENT).length,
    unverified: results.filter((r) => r.status === CHANNEL_STATUS.UNVERIFIED).length,
    failed: results.filter((r) => r.status === CHANNEL_STATUS.FAILED).length,
    periodPages: Object.fromEntries(Object.entries(periods.games).map(([game, pages]) => [game, Object.keys(pages)])),
    games: Object.keys(index.games)
  }
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  else {
    log.info(`完成：${summary.channels} 频道，成功 ${summary.ok} / 跳过 ${summary.skipped} / 缺席 ${summary.absent} / 未验证 ${summary.unverified} / 失败 ${summary.failed}，耗时 ${(summary.elapsedMs / 1000).toFixed(1)}s`)
  }
  process.exitCode = summary.failed ? 1 : 0
}

main().catch((err) => {
  log.error(err?.stack || err)
  process.exitCode = 1
})
