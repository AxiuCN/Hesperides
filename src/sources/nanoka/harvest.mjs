/**
 * nanoka.cc 抓取器
 *
 * 与玉璃的差异：
 *   - 页面地址带版本段：`/{game}/{version}/{page}.json`，版本来自根 `manifest.json` 的 `latest`
 *   - 页面内容是 **dict：记录 id → 记录对象**（少数页为数组）
 *   - 详情需要额外请求（`detail` 模板），是否抓由调用方通过 `withDetails` 决定
 *   - 终局页面（zzz boss/shiyu、gi tower/rolecombat/leyline 等）的记录带 `live_begin`/`live_end`，
 *     可直接产出期索引（这是旧后端没导出的信息）
 */
import path from 'node:path'
import { fetchText, writeFileAtomic, writeJsonAtomic, readJson, parseJson, contentHash, runPool, sleep, log } from '../../core/io.mjs'
import { normalizePhases } from '../../core/normalize.mjs'
import { CHANNEL_STATUS } from '../../schema/index.mjs'
import { NANOKA_BASE, NANOKA_LANG } from './channels.mjs'
import { pickRecordName, pickRecordRarity } from '../../core/labels.mjs'

/** 进程内 manifest 缓存 */
let manifestCache = null

/**
 * 取 nanoka 的版本清单（带缓存）
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<object|null>}
 */
export async function fetchManifest (options = {}) {
  if (manifestCache) return manifestCache
  const doFetch = options.fetchImpl || fetchText
  const res = await doFetch(`${NANOKA_BASE}/manifest.json`)
  if (!res.ok) return null
  manifestCache = parseJson(res.text || '')
  return manifestCache
}

/** 清缓存（测试用） */
export function resetManifestCache () {
  manifestCache = null
}

/**
 * 解析页面内容里的记录条目
 * @param {object|Array} content
 * @returns {[string, object][]}
 */
export function recordEntries (content) {
  if (Array.isArray(content)) {
    return content
      .map((record) => [String(record?.id ?? record?._id ?? ''), record])
      .filter(([id]) => id)
  }
  if (content && typeof content === 'object') {
    return Object.entries(content).filter(([, record]) => record && typeof record === 'object')
  }
  return []
}

/**
 * 从页面记录里提取期（终局页才有）
 *
 * zzz `boss` / `shiyu` 的记录带 `live_begin` / `live_end`；gi 终局页用 `begin` / `end`。
 * @param {[string, object][]} entries
 * @returns {object[]} 已规范化（排序 + 年份纠错）
 */
export function extractNanokaPhases (entries) {
  const phases = []
  for (const [id, record] of entries) {
    const begin = String(record?.live_begin || record?.begin || '').slice(0, 10)
    const end = String(record?.live_end || record?.end || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(begin) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue
    phases.push({
      id,
      name: String(record?.[NANOKA_LANG] || record?.name || ''),
      version: String(record?.version || record?.ver || ''),
      begin,
      end
    })
  }
  return phases.length ? normalizePhases(phases) : []
}

/**
 * 抓单个 nanoka 频道
 * @param {object} channel
 * @param {object} options
 * @param {string} options.dataDir
 * @param {'incremental'|'full'} [options.mode]
 * @param {boolean} [options.withDetails] - 是否抓条目详情（默认否，由调用方决定）
 * @param {number} [options.concurrency]
 * @param {object} [options.previous]
 * @param {Function} [options.fetchImpl]
 * @param {boolean} [options.delay]
 * @returns {Promise<object>}
 */
export async function harvestNanokaChannel (channel, options) {
  const { mode = 'incremental', concurrency = 4, dataDir, previous = null, withDetails = false } = options
  const doFetch = options.fetchImpl || fetchText
  const doSleep = options.delay === false ? () => Promise.resolve() : sleep
  const startedAt = Date.now()
  const result = {
    id: channel.id,
    status: CHANNEL_STATUS.OK,
    records: 0,
    fetched: 0,
    skipped: 0,
    failed: 0,
    periods: 0,
    ms: 0,
    error: ''
  }

  const manifest = await fetchManifest({ fetchImpl: doFetch })
  const version = channel.version || manifest?.[channel.game]?.latest
  if (!version) {
    result.status = CHANNEL_STATUS.FAILED
    result.error = 'manifest 里没有该游戏的版本'
    result.ms = Date.now() - startedAt
    return result
  }

  const pagePath = channel.endpoint.replace('{locale}', NANOKA_LANG)
  const pageUrl = `${NANOKA_BASE}/${channel.game}/${encodeURIComponent(version)}/${pagePath}.json`
  const headers = {}
  if (previous?.lastModified && mode !== 'full') headers['if-modified-since'] = previous.lastModified

  const pageRes = await doFetch(pageUrl, { headers })
  if (pageRes.status === 404) {
    result.status = CHANNEL_STATUS.ABSENT
    result.error = `HTTP 404 @ ${version}`
    result.ms = Date.now() - startedAt
    return result
  }
  // 304：内容没变，整频道跳过（旧记录留在盘上，manifest 保持原样）
  if (pageRes.status === 304) {
    result.status = CHANNEL_STATUS.SKIPPED
    result.skipped = previous?.records || 0
    result.indexHash = previous?.indexHash || ''
    result.version = version
    result.lastModified = previous?.lastModified || pageRes.lastModified || ''
    result.ms = Date.now() - startedAt
    return result
  }
  if (!pageRes.ok) {
    result.status = CHANNEL_STATUS.FAILED
    result.error = `页面失败 HTTP ${pageRes.status || pageRes.error}`
    result.ms = Date.now() - startedAt
    return result
  }

  const pageHash = contentHash(pageRes.text || '')
  result.indexHash = pageHash
  result.lastModified = pageRes.lastModified
  result.version = version
  if (mode !== 'full' && previous?.indexHash === pageHash && previous?.version === version) {
    result.status = CHANNEL_STATUS.SKIPPED
    result.skipped = previous?.records || 0
    result.ms = Date.now() - startedAt
    return result
  }

  const content = parseJson(pageRes.text || '')
  const entries = recordEntries(content)
  if (!entries.length) {
    result.status = CHANNEL_STATUS.FAILED
    result.error = '页面没有可用记录'
    result.ms = Date.now() - startedAt
    return result
  }

  // 详情（可选）：抓完合并进记录
  const detailMap = new Map()
  if (withDetails && channel.detail) {
    const targets = entries.map(([id]) => id)
    const outcomes = await runPool(targets, concurrency, async (id) => {
      const url = `${NANOKA_BASE}/${channel.game}/${encodeURIComponent(version)}/${channel.detail
        .replace('{locale}', NANOKA_LANG)
        .replace('{id}', encodeURIComponent(id))}`
      const res = await doFetch(url)
      await doSleep(100 + Math.random() * 120)
      if (!res.ok) return { id, ok: false }
      return { id, ok: true, detail: parseJson(res.text || '') }
    })
    for (const outcome of outcomes) {
      if (outcome.ok) detailMap.set(outcome.id, outcome.detail)
      else result.failed++
    }
  }

  const dir = path.join(dataDir, 'records', channel.game, channel.page)
  for (const [id, record] of entries) {
    const payload = detailMap.has(id) ? { ...record, detail: detailMap.get(id) } : record
    await writeFileAtomic(path.join(dir, `${id}.json`), `${JSON.stringify(payload)}\n`)
  }

  result.records = entries.length
  result.fetched = entries.length
  result.ids = entries.map(([id]) => id)
  result.labels = Object.fromEntries(entries.map(([id, record]) => [id, {
    name: pickRecordName(record),
    rarity: pickRecordRarity(record)
  }]))

  const phases = extractNanokaPhases(entries)
  if (phases.length) {
    result.phases = phases
    result.periods = phases.length
    result.phaseVersions = Object.fromEntries(phases.map((phase) => [phase.id, phase.version || phase.begin]))
  }

  result.status = result.failed && result.failed === entries.length
    ? CHANNEL_STATUS.FAILED
    : CHANNEL_STATUS.OK
  result.ms = Date.now() - startedAt
  return result
}

/**
 * 批量抓 nanoka 频道（与玉璃同一套 manifest 续跑语义）
 * @param {object[]} channels
 * @param {object} options
 * @returns {Promise<object[]>}
 */
export async function harvestNanokaChannels (channels, options) {
  const manifestPath = path.join(options.dataDir, 'manifest.json')
  const manifest = (await readJson(manifestPath, { channels: {} })) || { channels: {} }
  manifest.channels = manifest.channels || {}

  const results = []
  for (const channel of channels) {
    const previous = manifest.channels[channel.id] || null
    let result
    try {
      result = await harvestNanokaChannel(channel, { ...options, previous })
    } catch (err) {
      log.error(`频道 ${channel.id} 异常：${err?.message || err}`)
      result = {
        id: channel.id,
        status: CHANNEL_STATUS.FAILED,
        records: 0, fetched: 0, skipped: 0, failed: 1, periods: 0, ms: 0,
        error: String(err?.message || err)
      }
    }

    const base = previous || {}
    manifest.channels[channel.id] = {
      ...base,
      source: 'nanoka',
      game: channel.game,
      page: channel.page,
      kind: 'page',
      status: result.status,
      records: result.status === CHANNEL_STATUS.FAILED || result.status === CHANNEL_STATUS.ABSENT
        ? (base.records || 0)
        : result.records,
      indexHash: result.indexHash || base.indexHash || '',
      lastModified: result.lastModified || base.lastModified || '',
      version: result.version || base.version || '',
      ids: result.ids || base.ids,
      labels: result.labels || base.labels,
      phases: result.phases || base.phases,
      phaseVersions: result.phaseVersions || base.phaseVersions,
      fetchedAt: new Date().toISOString(),
      error: result.error || ''
    }
    await writeJsonAtomic(manifestPath, manifest)
    results.push(result)
    if (typeof options.onChannel === 'function') options.onChannel(result)
  }
  return results
}
