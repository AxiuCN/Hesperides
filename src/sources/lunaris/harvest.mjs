import path from 'node:path'
import { fetchText, writeFileAtomic, writeJsonAtomic, readJson, parseJson, contentHash, runPool, sleep, log } from '../../core/io.mjs'
import { recordDir, upstreamManifestFile } from '../../core/paths.mjs'
import { normalizePhases } from '../../core/normalize.mjs'
import { CHANNEL_STATUS, SCHEMA_VERSION } from '../../schema/index.mjs'
import { LUNARIS_BASE, LUNARIS_SITE_BASE, LUNARIS_LANG } from './channels.mjs'

/** 每轮批量抓取只读一次版本；不跨轮缓存，也不回退到其它版本。 */
export async function fetchLunarisVersion (options = {}) {
  const response = await (options.fetchImpl || fetchText)(`${LUNARIS_BASE}/version.json`)
  const versionInfo = response.ok ? parseJson(response.text || '') : null
  if (!versionInfo || typeof versionInfo.version !== 'string' || !versionInfo.version) return null
  if (options.dataDir) {
    const target = upstreamManifestFile(options.dataDir, 'lunaris')
    const previous = await readJson(target)
    const { schemaVersion, generatedAt, ...previousInfo } = previous || {}
    if (JSON.stringify(previousInfo) !== JSON.stringify(versionInfo)) {
      await writeJsonAtomic(target, { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), ...versionInfo })
    }
  }
  return versionInfo
}

/** 目录记录保留原字段，轻量展示名和稀有度仅写入 manifest.labels。 */
export function lunarisLabel (record) {
  const qualities = { WHITE: 1, GREEN: 2, BLUE: 3, PURPLE: 4, ORANGE: 5 }
  const quality = String(record.qualityType || '').replace(/^QUALITY_/, '').replace(/_SP$/, '')
  return {
    name: String(record.chsName || record.chsBuffName || record.chsChallengeName || ''),
    rarity: qualities[quality] || ''
  }
}

/** 保留官网显式时刻，交由既有期规范化和导出流程排序。 */
export function extractLunarisPhases (channel, entries) {
  if (!channel.period) return []
  const phases = entries.map(([id, record]) => ({
    id,
    name: lunarisLabel(record).name,
    version: String(record[channel.period.version || 'version'] || record.ver || ''),
    begin: String(record[channel.period.begin] || ''),
    end: String(record[channel.period.end] || '')
  })).filter(phase => /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(phase.begin)
    && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(phase.end))
  return normalizePhases(phases)
}

/** 抓取一个版本化目录，详情由调用方的 withDetails 决定。 */
export async function harvestLunarisChannel (channel, options) {
  if (channel.scope === 'site') return harvestSiteChannel(channel, options)
  const { dataDir, mode = 'incremental', previous = null, withDetails = false, concurrency = 4 } = options
  const doFetch = options.fetchImpl || fetchText
  const doSleep = options.delay === false ? () => Promise.resolve() : sleep
  const startedAt = Date.now()
  const result = { id: channel.id, status: CHANNEL_STATUS.OK, records: 0, fetched: 0, skipped: 0, failed: 0, periods: 0, ms: 0, error: '' }
  const finish = (status = result.status, error = result.error) => ({ ...result, status, error, ms: Date.now() - startedAt })
  const versionInfo = options.versionInfo === undefined ? await fetchLunarisVersion({ fetchImpl: doFetch, dataDir }) : options.versionInfo
  const version = channel.version || versionInfo?.version
  if (!version) return finish(CHANNEL_STATUS.FAILED, 'version.json 没有可用版本')
  result.version = version
  const needsDetails = withDetails && Boolean(channel.detail)
  const previousIncomplete = previous?.status === CHANNEL_STATUS.FAILED || Boolean(previous?.error)
    || (needsDetails && previous?.detailsComplete !== true)
  const unchangedVersion = previous?.version === version
  const headers = {}
  if (mode !== 'full' && unchangedVersion && !previousIncomplete && previous?.lastModified) headers['if-modified-since'] = previous.lastModified
  const prefix = `${LUNARIS_BASE}/${encodeURIComponent(version)}`
  const response = await doFetch(`${prefix}/${channel.endpoint}`, { headers })
  if (response.status === 404) return finish(CHANNEL_STATUS.ABSENT, `HTTP 404 @ ${version}`)
  if (response.status === 304) {
    result.skipped = previous?.records || 0
    result.indexHash = previous?.indexHash || ''
    result.lastModified = previous?.lastModified || response.lastModified || ''
    return finish(CHANNEL_STATUS.SKIPPED)
  }
  if (!response.ok) return finish(CHANNEL_STATUS.FAILED, `目录失败 HTTP ${response.status || response.error}`)
  result.indexHash = contentHash(response.text || '')
  result.lastModified = response.lastModified || ''
  const unchangedIndex = unchangedVersion && previous?.indexHash === result.indexHash
  if (mode !== 'full' && !previousIncomplete && unchangedIndex) {
    result.skipped = previous.records || 0
    return finish(CHANNEL_STATUS.SKIPPED)
  }
  const content = parseJson(response.text || '')
  if (!content || typeof content !== 'object' || Array.isArray(content)) return finish(CHANNEL_STATUS.FAILED, '目录不是记录字典')
  const entries = Object.entries(content)
  if (entries.some(([, record]) => !record || typeof record !== 'object' || Array.isArray(record))) return finish(CHANNEL_STATUS.FAILED, '目录包含非对象记录')

  const details = new Map()
  if (needsDetails) {
    const outcomes = await runPool(entries, concurrency, async ([id]) => {
      const detailPath = channel.detail.replace('{locale}', LUNARIS_LANG).replace('{id}', encodeURIComponent(id))
      const response = await doFetch(`${prefix}/${detailPath}`)
      await doSleep(100 + Math.random() * 120)
      const parsed = response.ok ? parseJson(response.text || '') : null
      const detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      return { id, detail, status: response.status }
    })
    for (const outcome of outcomes) {
      if (outcome.detail !== null) details.set(outcome.id, outcome.detail)
      else {
        result.failed++
        result.error = result.error || `条目 ${outcome.id} 详情失败 HTTP ${outcome.status}`
      }
    }
  }

  const dir = recordDir(dataDir, channel)
  let hasAllDetails = true
  for (const [id, record] of entries) {
    const previousRecord = details.has(id) ? null : await readJson(path.join(dir, `${id}.json`))
    const payload = details.has(id) ? { ...record, detail: details.get(id) }
      : previousRecord?.detail !== undefined ? { ...record, detail: previousRecord.detail } : record
    hasAllDetails = hasAllDetails && payload.detail !== undefined
    await writeJsonAtomic(path.join(dir, `${id}.json`), payload)
  }
  result.ids = entries.map(([id]) => id)
  result.labels = Object.fromEntries(entries.map(([id, record]) => [id, lunarisLabel(record)]))
  result.records = entries.length
  result.fetched = entries.length
  result.detailsComplete = needsDetails ? result.failed === 0
    : unchangedIndex && previous?.detailsComplete === true && hasAllDetails
  if (channel.period) {
    result.phases = extractLunarisPhases(channel, entries)
    result.periods = result.phases.length
    result.phaseVersions = Object.fromEntries(result.phases.map(phase => [phase.id, phase.version || phase.begin]))
  }
  return finish(result.failed > 0 && result.failed === entries.length ? CHANNEL_STATUS.FAILED : CHANNEL_STATUS.OK)
}

/** 官网独立文件及显式期号目录，无须等待 API 版本端点可用。 */
async function harvestSiteChannel (channel, options) {
  const { dataDir, mode = 'incremental', previous = null, concurrency = 4 } = options
  const doFetch = options.fetchImpl || fetchText
  const doSleep = options.delay === false ? () => Promise.resolve() : sleep
  const startedAt = Date.now()
  const result = { id: channel.id, status: CHANNEL_STATUS.OK, records: 0, fetched: 0, skipped: 0, failed: 0, periods: 0, ms: 0, error: '' }
  const finish = (status = result.status, error = result.error) => ({ ...result, status, error, ms: Date.now() - startedAt })
  const dir = recordDir(dataDir, channel)
  const previousIncomplete = previous?.status === CHANNEL_STATUS.FAILED || Boolean(previous?.error)
  if (channel.kind === 'single') {
    const headers = {}
    if (mode !== 'full' && !previousIncomplete && previous?.lastModified) headers['if-modified-since'] = previous.lastModified
    const response = await doFetch(`${LUNARIS_SITE_BASE}/${channel.endpoint}`, { headers })
    if (response.status === 404) return finish(CHANNEL_STATUS.ABSENT, 'HTTP 404（官网没有该文件）')
    if (response.status === 304) {
      result.skipped = previous?.records || 0
      return finish(CHANNEL_STATUS.SKIPPED)
    }
    if (!response.ok) return finish(CHANNEL_STATUS.FAILED, `文件失败 HTTP ${response.status || response.error}`)
    if (parseJson(response.text || '') === null) return finish(CHANNEL_STATUS.FAILED, '文件不是合法 JSON')
    result.indexHash = contentHash(response.text || '')
    result.lastModified = response.lastModified || ''
    if (mode !== 'full' && !previousIncomplete && result.indexHash === previous?.indexHash) {
      result.skipped = previous.records || 0
      return finish(CHANNEL_STATUS.SKIPPED)
    }
    await writeFileAtomic(path.join(dir, '__index.json'), response.text)
    result.records = 1
    result.fetched = 1
    result.ids = []
    result.labels = {}
    return finish()
  }

  const outcomes = await runPool(channel.ids, concurrency, async id => {
    const file = path.join(dir, `${id}.json`)
    const oldRecord = await readJson(file)
    const headers = {}
    if (mode !== 'full' && !previousIncomplete && previous?.fileLastModified?.[id]) headers['if-modified-since'] = previous.fileLastModified[id]
    const response = await doFetch(`${LUNARIS_SITE_BASE}/${channel.item.replace('{id}', encodeURIComponent(id))}`, { headers })
    await doSleep(100 + Math.random() * 120)
    if (response.status === 304 && oldRecord) return { id, record: oldRecord, skipped: true }
    const record = response.ok ? parseJson(response.text || '') : null
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { id, record: oldRecord, failed: true, status: response.status }
    const hash = contentHash(response.text || '')
    const skipped = mode !== 'full' && !previousIncomplete && oldRecord && previous?.fileHashes?.[id] === hash
    if (!skipped) await writeJsonAtomic(file, record)
    return { id, record, hash, lastModified: response.lastModified, skipped: Boolean(skipped) }
  })
  result.fileHashes = { ...(previous?.fileHashes || {}) }
  result.fileLastModified = { ...(previous?.fileLastModified || {}) }
  const entries = []
  for (const outcome of outcomes) {
    if (outcome.failed) {
      result.failed++
      result.error = result.error || `期 ${outcome.id} 失败 HTTP ${outcome.status}`
    } else if (outcome.skipped) result.skipped++
    else result.fetched++
    if (outcome.record) entries.push([outcome.id, outcome.record])
    if (outcome.hash) result.fileHashes[outcome.id] = outcome.hash
    if (outcome.lastModified) result.fileLastModified[outcome.id] = outcome.lastModified
  }
  result.ids = entries.map(([id]) => id)
  result.records = entries.length
  result.labels = Object.fromEntries(entries.map(([id, record]) => [id, lunarisLabel(record)]))
  result.phases = extractLunarisPhases(channel, entries)
  result.periods = result.phases.length
  result.phaseVersions = Object.fromEntries(result.phases.map(phase => [phase.id, phase.version || phase.begin]))
  if (result.failed === channel.ids.length) return finish(CHANNEL_STATUS.FAILED)
  return finish(result.skipped === channel.ids.length ? CHANNEL_STATUS.SKIPPED : CHANNEL_STATUS.OK)
}

/** 每频道结束原子保存 manifest，失败保留上一轮记录与增量判据。 */
export async function harvestLunarisChannels (channels, options) {
  const manifestPath = path.join(options.dataDir, 'manifest.json')
  const manifest = await readJson(manifestPath, { channels: {} }) || { channels: {} }
  manifest.channels = manifest.channels || {}
  const versionInfo = channels.some(channel => channel.scope !== 'site') ? await fetchLunarisVersion(options) : null
  const results = []
  for (const channel of channels) {
    const previous = manifest.channels[channel.id] || null
    let result
    try {
      result = await harvestLunarisChannel(channel, { ...options, previous, versionInfo })
    } catch (error) {
      log.error(`频道 ${channel.id} 异常：${error?.message || error}`)
      result = { id: channel.id, status: CHANNEL_STATUS.FAILED, records: 0, fetched: 0, skipped: 0, failed: 1, periods: 0, ms: 0, error: String(error?.message || error) }
    }
    const base = previous || {}
    manifest.channels[channel.id] = {
      ...base,
      source: 'lunaris', game: channel.game, page: channel.page, pageKey: channel.pageKey || channel.page, kind: channel.kind,
      status: result.status,
      records: [CHANNEL_STATUS.FAILED, CHANNEL_STATUS.ABSENT, CHANNEL_STATUS.SKIPPED].includes(result.status) ? base.records ?? 0 : result.records,
      indexHash: result.indexHash || base.indexHash || '',
      lastModified: result.lastModified || base.lastModified || '',
      version: result.version || base.version || '',
      ids: result.ids || base.ids,
      labels: result.labels || base.labels,
      phases: result.phases || base.phases,
      phaseVersions: result.phaseVersions || base.phaseVersions,
      detailsComplete: result.detailsComplete ?? base.detailsComplete ?? false,
      fileHashes: result.fileHashes || base.fileHashes,
      fileLastModified: result.fileLastModified || base.fileLastModified,
      fetchedAt: new Date().toISOString(), error: result.error || ''
    }
    await writeJsonAtomic(manifestPath, manifest)
    results.push(result)
    if (typeof options.onChannel === 'function') options.onChannel(result)
  }
  return results
}
