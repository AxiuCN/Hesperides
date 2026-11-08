/**
 * 产物导出：把 manifest + 记录文件汇总成插件可读的产物（schema v2）
 *
 *   index.json     频道状态 + 每源每页的记录 id + 记录级轻量元数据（name / rarity / imageCount / icon）
 *   periods.json   期索引（终局类频道），按 `<game>.<source>.<page>` 分组
 *
 * v2 起「源」是一等维度：`games.<game>.sources.<source>.pages.<page>`，跨源同名页（weapon/monster/item）
 * 各写各的，不再互相覆盖。
 *
 * 导出是纯本地操作：不联网，可从已有记录重建（`--export`）。
 */
import path from 'node:path'
import { readJson, writeJsonAtomic, log } from '../core/io.mjs'
import { emptyIndex, emptyPeriods, toPeriodEntries, SCHEMA_VERSION } from '../schema/index.mjs'
import { readPageImages, pickEntryImage } from '../images/index.mjs'
import { CHANNEL_BY_ID } from '../sources/registry.mjs'

/**
 * 由 manifest 生成产物
 * @param {string} dataDir - data/
 * @returns {Promise<{index: object, periods: object}>}
 */
export async function exportAll (dataDir) {
  const manifest = (await readJson(path.join(dataDir, 'manifest.json'), { channels: {} })) || { channels: {} }
  const index = emptyIndex()
  const periods = emptyPeriods()
  let imageRecords = 0
  let imageIcons = 0

  for (const [channelId, entry] of Object.entries(manifest.channels || {})) {
    const game = entry.game
    const page = entry.page
    const source = entry.source || 'alioth'
    if (!game || !page) continue

    index.games[game] = index.games[game] || { channels: {}, sources: {} }
    index.games[game].channels[channelId] = {
      source,
      page,
      kind: entry.kind,
      status: entry.status,
      // 历史 manifest 可能把跳过频道的 records 写成 0，这里按 ids 条数兜底
      records: entry.records || (Array.isArray(entry.ids) ? entry.ids.length : 0),
      version: entry.version || '',
      fetchedAt: entry.fetchedAt || '',
      error: entry.error || ''
    }

    const group = index.games[game].sources[source] = index.games[game].sources[source] || { pages: {} }
    group.pages[page] = {
      // 插件侧 pageKey（上游端点 key，`/` 未转 `-`），让消费者不必反推
      // pageKey 以频道表为准：manifest 可能是旧条目（没有 pageKey 字段）
      key: CHANNEL_BY_ID.get(channelId)?.pageKey || entry.pageKey || page,
      ids: Array.isArray(entry.ids) ? entry.ids : [],
      // 历史 manifest 可能把跳过频道的 records 写成 0，这里按 ids 条数兜底
      records: entry.records || (Array.isArray(entry.ids) ? entry.ids.length : 0),
      entries: entry.labels || {}
    }

    if (Array.isArray(entry.phases) && entry.phases.length) {
      periods.games[game] = periods.games[game] || {}
      periods.games[game][source] = periods.games[game][source] || {}
      const sorted = [...entry.phases].sort((a, b) => (a.begin || '').localeCompare(b.begin || ''))
      periods.games[game][source][page] = toPeriodEntries(sorted, source)
    }

    // 图片元数据：一页一个文件，只读当前页，不进常驻内存
    const images = await readPageImages(dataDir, { gameId: game, source, page })
    if (images) {
      const enriched = enrichPage(images)
      for (const [recordId, meta] of Object.entries(enriched)) {
        const target = group.pages[page].entries[recordId]
        if (target) {
          if (meta.imageCount) target.imageCount = meta.imageCount
          if (meta.icon) target.icon = meta.icon
        }
        if (meta.imageCount) imageRecords += 1
        if (meta.icon) imageIcons += 1
      }
    }
  }

  await writeJsonAtomic(path.join(dataDir, 'index.json'), index)
  await writeJsonAtomic(path.join(dataDir, 'periods.json'), periods)
  log.info(`已导出 index.json / periods.json（schema v${SCHEMA_VERSION}）${imageRecords ? `，图片元数据 ${imageRecords} 条记录 / ${imageIcons} 个图标` : ''}`)
  return { index, periods }
}

/**
 * 一页的图片引用 → 每条记录的 `{ imageCount, icon }`
 * @param {object} images - `{ [recordId]: ref[] }`
 * @returns {Record<string, {imageCount: number, icon?: string}>}
 */
function enrichPage (images) {
  const result = {}
  for (const [recordId, list] of Object.entries(images)) {
    result[recordId] = pickEntryImage(list)
  }
  return result
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
    const source = entry.source || 'alioth'
    periods.games[game] = periods.games[game] || {}
    periods.games[game][source] = periods.games[game][source] || {}
    const sorted = [...entry.phases].sort((a, b) => (a.begin || '').localeCompare(b.begin || ''))
    periods.games[game][source][entry.page] = toPeriodEntries(sorted, source)
  }
  await writeJsonAtomic(path.join(dataDir, 'periods.json'), periods)
  return periods
}
