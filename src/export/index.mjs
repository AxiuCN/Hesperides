/**
 * 产物导出：把 manifest + 记录文件汇总成插件可读的三份文件
 *
 *   index.json     频道状态 + 每页的记录 id（不含正文，体积可控）
 *   periods.json   期索引（终局类频道），插件据此判断「本期 / 上期 / 某版本」
 *   manifest.json  增量判据（由抓取流程维护，这里只读）
 *
 * 导出是纯本地操作：不联网，可从已有记录重建（`--export`）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic, log } from '../core/io.mjs'
import { emptyIndex, emptyPeriods, toPeriodEntries, SCHEMA_VERSION } from '../schema/index.mjs'

/**
 * 由 manifest 生成三份产物
 * @param {string} dataDir - data/hesperides
 * @returns {Promise<{index: object, periods: object}>}
 */
export async function exportAll (dataDir) {
  const manifest = (await readJson(path.join(dataDir, 'manifest.json'), { channels: {} })) || { channels: {} }
  const index = emptyIndex()
  const periods = emptyPeriods()

  for (const [channelId, entry] of Object.entries(manifest.channels || {})) {
    const game = entry.game
    const page = entry.page
    if (!game || !page) continue

    index.games[game] = index.games[game] || { channels: {}, pages: {} }
    index.games[game].channels[channelId] = {
      source: entry.source || 'alioth',
      page,
      kind: entry.kind,
      status: entry.status,
      records: entry.records || 0,
      fetchedAt: entry.fetchedAt || '',
      error: entry.error || ''
    }
    index.games[game].pages[page] = {
      ids: Array.isArray(entry.ids) ? entry.ids : [],
      records: entry.records || 0,
      // 记录级轻量元数据：消费者不用读全量记录就能建索引
      entries: entry.labels || {}
    }

    if (Array.isArray(entry.phases) && entry.phases.length) {
      periods.games[game] = periods.games[game] || {}
      const sorted = [...entry.phases].sort((a, b) => (a.begin || '').localeCompare(b.begin || ''))
      periods.games[game][page] = toPeriodEntries(sorted, entry.source || 'alioth')
    }
  }

  await writeJsonAtomic(path.join(dataDir, 'index.json'), index)
  await writeJsonAtomic(path.join(dataDir, 'periods.json'), periods)
  log.info(`已导出 index.json / periods.json（schema v${SCHEMA_VERSION}）`)
  return { index, periods }
}

/**
 * 只重建期索引（不重写 index.json）
 * @param {string} dataDir
 */
export async function exportPeriods (dataDir) {
  const manifest = (await readJson(path.join(dataDir, 'manifest.json'), { channels: {} })) || { channels: {} }
  const periods = emptyPeriods()
  for (const entry of Object.values(manifest.channels || {})) {
    if (!Array.isArray(entry.phases) || !entry.phases.length) continue
    const game = entry.game
    periods.games[game] = periods.games[game] || {}
    const sorted = [...entry.phases].sort((a, b) => (a.begin || '').localeCompare(b.begin || ''))
    periods.games[game][entry.page] = toPeriodEntries(sorted, entry.source || 'alioth')
  }
  await writeJsonAtomic(path.join(dataDir, 'periods.json'), periods)
  return periods
}
