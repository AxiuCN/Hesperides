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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_CHANNELS, CHANNEL_BY_ID, harvestSelected } from './sources/registry.mjs'

import { exportAll } from './export/index.mjs'
import { pruneOrphanImages } from './images/prune.mjs'
import { scanImages } from './images/store.mjs'
import { harvestImagesForChannels } from './images/harvest.mjs'
import { readJson, log } from './core/io.mjs'
import { recordDir } from './core/paths.mjs'
import { validateIndex, CHANNEL_STATUS, SCHEMA_VERSION } from './schema/index.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析命令行参数
 * @param {string[]} argv
 */
export function parseArgs (argv) {
  const args = {
    dataDir: path.join(rootDir, 'data'),
    mode: 'incremental',
    concurrency: 4,
    channels: [],
    json: false,
    list: false,
    all: false,
    withDetails: false,
    images: false,
    retryFailed: false,
    noTextmap: false,
    verify: false,
    pruneImages: false,
    yes: false,
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
      case '--images': args.images = true; break
      case '--no-images': args.images = false; break
      case '--retry-failed': args.retryFailed = true; break
      case '--no-textmap': args.noTextmap = true; break
      case '--export': args.exportOnly = true; break
      case '--verify': args.verify = true; break
      case '--prune-images': args.pruneImages = true; break
      case '--yes': args.yes = true; break
      case '--json': args.json = true; break
      case '--help':
      case '-h': args.help = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    }
  }
  return args
}

/**
 * 期索引压平成 `<game>/<source>/<page>` 列表（v2 起期表按源分组）
 * @param {object} periods
 * @returns {Record<string, string[]>}
 */
function flattenPeriodPages (periods) {
  const out = {}
  for (const [game, sources] of Object.entries(periods?.games || {})) {
    const list = out[game] = out[game] || []
    for (const [source, pages] of Object.entries(sources || {})) {
      for (const page of Object.keys(pages || {})) list.push(`${source}/${page}`)
    }
  }
  return out
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
  --data-dir <path>            产物目录（默认 data/）
  --with-details               为支持详情的频道补抓条目详情（请求量大幅增加）
  --images                     记录抓完接着抓图片（体积大：全量约 580 MB）
  --retry-failed               重新探测上一轮失败的图片候选（默认跳过）
  --no-textmap                 排除 TextMap 大文件频道（--all 时常用）
  --export                     只从已有记录重建 index.json / periods.json
  --verify                     只读校验产物：索引契约、期表结构、记录文件、图片引用
  --prune-images               清理同一资源的多格式重复（保留 webp/最优格式；默认只预览）
  --yes                        与 --prune-images 连用，确认执行删除
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

/**
 * 列出 `images/` 下全部文件的相对路径（`images/<game>/<目录>/<文件>`）
 *
 * 只做目录遍历，不 `stat`、不分组——`--verify` 只需要「在不在」。
 * 早先复用 `scanImages()`：那是给抓图判活与清理用的，会对 1.8 万个文件逐个取体积。
 * @param {string} dataDir
 * @returns {Set<string>}
 */
function listImageFiles (dataDir) {
  const imagesRoot = path.join(dataDir, 'images')
  const found = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const rel = path.relative(dataDir, full).split(path.sep).join('/')
      found.add(rel)
    }
  }
  walk(imagesRoot)
  return found
}

/**
 * 产物完整性校验（只读）
 *
 * 分两级结论：`problems` 是硬失败（exit 1，产物读不了或指向不存在的东西），
 * `notes` 只报告（数量对不上、上一轮失败频道、占位图等，不影响退出码）——
 * 这个命令只回答「现在这份数据能不能用」，不负责修，也不因个别瑕疵把整份判死。
 *
 * 低配机器友好：记录目录只做一次 readdir 取文件名；图片存在性只遍历目录收集文件名
 * （不 stat、不分组、不解码）；图片引用逐页读取、读完即丢。
 * @param {string} dataDir
 * @param {boolean} json
 * @returns {Promise<boolean>} 是否通过（problems 为空）
 */
async function verify (dataDir, json) {
  const startedAt = Date.now()
  const problems = []
  const notes = []
  const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  // 坏了上千个频道时不必刷屏，够定位就行
  const MAX_LISTED = 20
  const addProblem = (msg) => {
    if (problems.length < MAX_LISTED && !problems.includes(msg)) problems.push(msg)
  }

  // ① 索引契约
  const index = await readJson(path.join(dataDir, 'index.json'))
  const result = validateIndex(index)
  if (!result.ok) addProblem(result.reason)

  // ② 期表结构：games.<game>.<source>.<page> = 期条目数组
  const periodsFile = path.join(dataDir, 'periods.json')
  const periods = await readJson(periodsFile, null)
  if (fs.existsSync(periodsFile) && !isJsonObject(periods)) addProblem('periods.json 无法读取或不是合法对象')
  if (periods?.schemaVersion !== undefined && periods.schemaVersion !== SCHEMA_VERSION) {
    addProblem(`periods.json schemaVersion=${periods.schemaVersion}，当前只支持 ${SCHEMA_VERSION}`)
  }
  let periodCount = 0
  const periodsByGame = {}
  for (const [game, sources] of Object.entries(periods?.games || {})) {
    for (const [source, pages] of Object.entries(sources || {})) {
      for (const [page, list] of Object.entries(pages || {})) {
        if (!Array.isArray(list)) {
          addProblem(`期表 ${game}/${source}/${page} 不是数组`)
          continue
        }
        for (const entry of list) {
          if (!entry || typeof entry !== 'object' || !entry.id) {
            addProblem(`期表 ${game}/${source}/${page} 有缺少 id 的期`)
          }
        }
        periodCount += list.length
        periodsByGame[game] = (periodsByGame[game] || 0) + list.length
      }
    }
  }

  // ③ 记录文件：台账里「有数据」的频道必须真有记录目录与文件
  // ok = 本轮抓成功；skipped = 上游没变、沿用上一轮记录。两者都算有数据。
  const manifestFile = path.join(dataDir, 'manifest.json')
  const manifestExists = fs.existsSync(manifestFile)
  const manifest = await readJson(manifestFile, null)
  if (manifestExists && !isJsonObject(manifest)) addProblem('manifest.json 无法读取或不是合法对象')
  const channels = { total: 0, ok: 0, skipped: 0, failed: 0, absent: 0, unverified: 0 }
  if (manifest?.channels) {
    for (const [id, channel] of Object.entries(manifest.channels)) {
      channels.total += 1
      const status = channel?.status
      if (status === CHANNEL_STATUS.OK) channels.ok += 1
      else if (status === CHANNEL_STATUS.SKIPPED) channels.skipped += 1
      else if (status === CHANNEL_STATUS.FAILED) channels.failed += 1
      else if (status === CHANNEL_STATUS.ABSENT) channels.absent += 1
      else channels.unverified += 1
      if (status !== CHANNEL_STATUS.OK && status !== CHANNEL_STATUS.SKIPPED) continue
      // 空页（records 0）本来就不会建目录，不算问题
      if (!(Number(channel?.records) > 0)) continue
      const dir = recordDir(dataDir, channel)
      let files = []
      try {
        const extension = CHANNEL_BY_ID.get(id)?.ext || 'json'
        files = fs.readdirSync(dir).filter((name) => name.endsWith(`.${extension}`))
      } catch {
        addProblem(`频道 ${id} 记录目录缺失：${path.relative(dataDir, dir)}`)
        continue
      }
      if (!files.length) {
        addProblem(`频道 ${id} 记录目录为空：${path.relative(dataDir, dir)}`)
      } else if (typeof channel.records === 'number' && channel.records !== files.length) {
        // 期页/特殊分目录的频道可能天然对不上，只报告不判死
        notes.push(`频道 ${id} 记录数不符（台账 ${channel.records} / 文件 ${files.length}）`)
      }
    }
    if (channels.failed) notes.push(`台账里有 ${channels.failed} 个频道上一轮失败（数据沿用旧值，可重跑该频道）`)
  } else if (!manifestExists) {
    notes.push('没有 manifest.json（尚未抓取，或只用 --export 重建过索引）')
  }

  // ④ 图片引用：非占位的必须指向真实文件
  const images = { files: 0, refs: 0, placeholder: 0, missing: 0 }
  const refsRoot = path.join(dataDir, 'imagerefs')
  if (fs.existsSync(refsRoot)) {
    // 只列文件名、不 stat：校验只要「在不在」，`scanImages()` 那种逐文件取体积是为清理服务的
    const existing = listImageFiles(dataDir)
    images.files = existing.size
    for (const gameEntry of fs.readdirSync(refsRoot, { withFileTypes: true })) {
      if (!gameEntry.isDirectory()) continue
      const gameDir = path.join(refsRoot, gameEntry.name)
      for (const sourceEntry of fs.readdirSync(gameDir, { withFileTypes: true })) {
        if (!sourceEntry.isDirectory()) continue
        const sourceDir = path.join(gameDir, sourceEntry.name)
        for (const file of fs.readdirSync(sourceDir)) {
          if (!file.endsWith('.json')) continue
          const page = await readJson(path.join(sourceDir, file), null)
          if (!isJsonObject(page)) {
            addProblem(`图片引用页无法读取或不是合法对象：${gameEntry.name}/${sourceEntry.name}/${file}`)
            continue
          }
          for (const list of Object.values(page?.records || {})) {
            for (const ref of list || []) {
              images.refs += 1
              if (ref?.placeholder) { images.placeholder += 1; continue }
              if (!ref?.localPath) {
                addProblem(`图片引用缺 localPath：${gameEntry.name}/${sourceEntry.name}/${file}`)
                continue
              }
              if (!existing.has(ref.localPath)) {
                // 大小写不敏感的文件系统上，上游两个只差大小写的资源会落到同一个文件，
                // 逐字符比对会误报；真缺文件时才 stat 兜一次（漏检很少，代价可忽略）
                const full = path.join(dataDir, ref.localPath)
                if (!fs.existsSync(full)) {
                  images.missing += 1
                  addProblem(`图片引用指向不存在的文件：${ref.localPath}`)
                }
              }
            }
          }
        }
      }
    }
    if (images.placeholder) notes.push(`有 ${images.placeholder} 条图片引用是占位图（无候选或候选全失败）`)
  } else {
    notes.push('没有 imagerefs/（尚未抓过图片）')
  }

  const ok = problems.length === 0
  const summary = {
    indexOk: result.ok,
    problems,
    notes,
    games: Object.keys(index?.games || {}),
    periodPages: flattenPeriodPages(periods),
    periods: periodCount,
    channels,
    images,
    elapsedMs: Date.now() - startedAt
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2))
    return ok
  }

  console.log(ok ? '✅ 产物校验通过' : `❌ 产物校验失败：${problems[0]}`)
  if (problems.length > 1) {
    for (const problem of problems.slice(1)) console.log(`   · ${problem}`)
    if (problems.length >= MAX_LISTED) console.log('   · …（更多问题已省略）')
  }
  console.log(`   游戏：${summary.games.join(', ') || '(无)'}`)
  for (const [game, pages] of Object.entries(summary.periodPages)) {
    console.log(`   ${game} 期索引：${pages.join(', ') || '(无)'}（共 ${periodsByGame[game] || 0} 期）`)
  }
  console.log(`   频道：台账 ${channels.total}（成功 ${channels.ok} / 跳过 ${channels.skipped} / 失败 ${channels.failed} / 缺席 ${channels.absent}${channels.unverified ? ` / 未验证 ${channels.unverified}` : ''}）`)
  console.log(`   图片：文件 ${images.files}，引用 ${images.refs}（占位 ${images.placeholder} / 缺失 ${images.missing}）`)
  for (const note of notes) console.log(`   ⚠ ${note}`)
  console.log(`   用时 ${summary.elapsedMs}ms`)
  return ok
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

  // --json 时把 info 日志切到 stderr：stdout 只留机器可读的 JSON，整段可直接 parse。
  // 非 JSON 模式的日志位置不变；进程一次性，改了不必还原。
  if (args.json) log.info = log.error

  if (args.help) return printHelp()
  if (args.list) return listChannels(args.json)
  if (args.exportOnly) {
    const { index, periods } = await exportAll(args.dataDir)
    if (args.json) {
      console.log(JSON.stringify({
        games: Object.keys(index.games),
        periodPages: flattenPeriodPages(periods)
      }, null, 2))
    }
    return
  }
  if (args.verify) {
    const ok = await verify(args.dataDir, args.json)
    process.exitCode = ok ? 0 : 1
    return
  }
  // 只有清理、没有要抓的频道 → 独立清理模式；否则抓完在末尾顺带清理
  if (args.pruneImages && !args.all && !args.channels.length) {
    await pruneOrphanImages({ dataDir: args.dataDir, apply: args.yes, json: args.json })
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

  if (args.noTextmap) {
    const before = selected.length
    selected = selected.filter((channel) => channel.kind !== 'text')
    log.info(`已排除 TextMap 频道：${before} → ${selected.length}`)
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

  // 图片抓取与记录抓取解耦：记录落盘后单独一遍，可只补某几个频道
  let imageResults = []
  // 图片扫描只做一次：抓图判活与随后的清理共用（无图片阶段时为 null）
  let imageScan = null
  if (args.images) {
    log.info('开始抓取图片...')
    imageScan = await scanImages(args.dataDir)
    imageResults = await harvestImagesForChannels(selected, {
      dataDir: args.dataDir,
      concurrency: args.concurrency,
      retryFailed: args.retryFailed,
      existingScan: imageScan
    })
  }

  const { index, periods } = await exportAll(args.dataDir)

  // 抓完顺带清理：复用本轮抓图的扫描结果，不重复扫盘；无重复时内部直接短路
  let pruneSummary = null
  if (args.pruneImages) {
    pruneSummary = await pruneOrphanImages({
      dataDir: args.dataDir,
      apply: args.yes,
      json: false,
      scanned: imageScan
    })
  }

  const summary = {
    elapsedMs: Date.now() - startedAt,
    channels: results.length,
    ok: results.filter((r) => r.status === CHANNEL_STATUS.OK).length,
    skipped: results.filter((r) => r.status === CHANNEL_STATUS.SKIPPED).length,
    absent: results.filter((r) => r.status === CHANNEL_STATUS.ABSENT).length,
    unverified: results.filter((r) => r.status === CHANNEL_STATUS.UNVERIFIED).length,
    failed: results.filter((r) => r.status === CHANNEL_STATUS.FAILED).length,
    images: imageResults.length
      ? {
          channels: imageResults.length,
          refs: imageResults.reduce((sum, item) => sum + (item.stats?.refs || 0), 0),
          downloaded: imageResults.reduce((sum, item) => sum + (item.stats?.downloaded || 0), 0),
          reused: imageResults.reduce((sum, item) => sum + (item.stats?.reused || 0), 0),
          placeholder: imageResults.reduce((sum, item) => sum + (item.stats?.placeholder || 0), 0),
          // 占位再分两类：规则没覆盖（改规则才会变） vs 候选全失败（下一轮还会试）
          unmapped: imageResults.reduce((sum, item) => sum + (item.stats?.unmapped || 0), 0),
          unresolved: imageResults.reduce((sum, item) => sum + (item.stats?.unresolved || 0), 0)
        }
      : null,
    pruned: pruneSummary
      ? { groups: pruneSummary.groups, files: pruneSummary.files, savedMB: Number((pruneSummary.savedBytes / 1024 / 1024).toFixed(1)), fixedRefs: pruneSummary.fixedRefs || 0 }
      : null,
    periodPages: flattenPeriodPages(periods),
    games: Object.keys(index.games)
  }
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  else {
    log.info(`完成：${summary.channels} 频道，成功 ${summary.ok} / 跳过 ${summary.skipped} / 缺席 ${summary.absent} / 未验证 ${summary.unverified} / 失败 ${summary.failed}，耗时 ${(summary.elapsedMs / 1000).toFixed(1)}s`)
  }
  // 频道级失败，或任何频道内有条目失败，都算失败：调用方（插件）靠退出码决定要不要重试。
  // 只看 summary.failed 会漏掉「频道状态 ok 但部分条目 503」的情况——日志记了错，退出码却是 0。
  process.exitCode = summary.failed || results.some((result) => result.failed > 0) ? 1 : 0
}

main().catch((err) => {
  log.error(err?.stack || err)
  process.exitCode = 1
})
