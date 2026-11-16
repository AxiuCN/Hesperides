import path from 'node:path'
import { fetchText, writeJsonAtomic, readJson, parseJson, contentHash, runPool, sleep, log } from '../../core/io.mjs'
import { recordDir, upstreamManifestFile } from '../../core/paths.mjs'
import { normalizePhases } from '../../core/normalize.mjs'
import { CHANNEL_STATUS, SCHEMA_VERSION } from '../../schema/index.mjs'
import { GENSRI_DB_BASE, GENSRI_SITE_BASE } from './channels.mjs'

/** 每轮读取当前版本与官方详情文件映射，保留原始上游清单。 */
export async function fetchGensriVersion (options = {}) {
  const response = await (options.fetchImpl || fetchText)(`${GENSRI_DB_BASE}/data/versions.json`)
  const info = response.ok ? parseJson(response.text || '') : null
  if (!info || Array.isArray(info) || typeof info.currentVersion !== 'string' || !info.currentVersion) return null
  if (options.dataDir) {
    const file = upstreamManifestFile(options.dataDir, 'gensri')
    const previous = await readJson(file)
    const { schemaVersion, generatedAt, ...previousInfo } = previous || {}
    if (JSON.stringify(previousInfo) !== JSON.stringify(info)) {
      await writeJsonAtomic(file, { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), ...info })
    }
  }
  return info
}

/** 目录名称区分旅行者元素，优先于详情里共用的“旅行者”。 */
export function gensriLabel (record) {
  const quality = String(record.qualityType || '').replace(/^QUALITY_/, '')
  return {
    name: String(record.name || record.chsName || ''),
    rarity: record.rarity || ({ WHITE: 1, GREEN: 2, BLUE: 3, PURPLE: 4, ORANGE: 5 }[quality] || '')
  }
}

/** 单频道采集，详情与图片由调用方分别选择。 */
export async function harvestGensriChannel (channel, options) {
  const { dataDir, mode = 'incremental', previous = null, withDetails = false, concurrency = 4 } = options
  const doFetch = options.fetchImpl || fetchText
  const doSleep = options.delay === false ? () => Promise.resolve() : sleep
  const startedAt = Date.now()
  const result = { id: channel.id, status: CHANNEL_STATUS.OK, records: 0, fetched: 0, skipped: 0, failed: 0, periods: 0, ms: 0, error: '' }
  const finish = (status = result.status, error = result.error) => ({ ...result, status, error, ms: Date.now() - startedAt })
  const site = channel.scope === 'site'
  const versionInfo = site ? null : options.versionInfo === undefined ? await fetchGensriVersion(options) : options.versionInfo
  if (!site && !versionInfo) return finish(CHANNEL_STATUS.FAILED, 'versions.json 没有可用当前版本')
  const versionFiles = site ? {} : versionInfo[channel.versionKey] || {}
  result.version = site ? '' : versionInfo.currentVersion
  result.versionHash = site ? '' : contentHash(JSON.stringify(versionFiles))
  const previousIncomplete = previous?.status === CHANNEL_STATUS.FAILED || Boolean(previous?.error)
    || (withDetails && previous?.detailsComplete !== true)
  const sameVersion = site || (previous?.version === result.version && previous?.versionHash === result.versionHash)
  const conditional = mode !== 'full' && sameVersion && !previousIncomplete && Boolean(previous?.lastModified)
  const headers = conditional ? { 'if-modified-since': previous.lastModified } : {}
  const endpoint = site ? `${GENSRI_SITE_BASE}/${channel.endpoint}` : `${GENSRI_DB_BASE}/data/${channel.endpoint}`
  const response = await doFetch(endpoint, { headers })
  if (response.status === 404) return finish(CHANNEL_STATUS.ABSENT, 'HTTP 404（官网没有该文件）')
  if (response.status === 304) {
    if (!conditional) return finish(CHANNEL_STATUS.FAILED, '目录返回 304，但本轮需要完整内容')
    result.skipped = previous.records || 0
    return finish(CHANNEL_STATUS.SKIPPED)
  }
  if (!response.ok) return finish(CHANNEL_STATUS.FAILED, `目录失败 HTTP ${response.status || response.error}`)
  result.indexHash = contentHash(response.text || '')
  result.lastModified = response.lastModified || ''
  if (mode !== 'full' && sameVersion && !previousIncomplete && previous?.indexHash === result.indexHash) {
    result.skipped = previous.records || 0
    return finish(CHANNEL_STATUS.SKIPPED)
  }

  let entries
  try {
    entries = catalogEntries(channel, parseJson(response.text || ''), versionFiles)
  } catch (error) {
    return finish(CHANNEL_STATUS.FAILED, error.message)
  }
  const dir = recordDir(dataDir, channel)
  const details = new Map()
  if (withDetails) {
    const outcomes = await runPool(entries, concurrency, async entry => {
      const url = site ? `${GENSRI_SITE_BASE}/${entry.detailFile}`
        : `${GENSRI_DB_BASE}/data/${channel.detailFolder}/${encodeURIComponent(entry.detailFile)}.json`
      const response = await doFetch(url)
      await doSleep(100 + Math.random() * 120)
      const detail = response.ok ? parseJson(response.text || '') : null
      return { id: entry.id, detail: detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null, status: response.status }
    })
    for (const outcome of outcomes) {
      if (outcome.detail) details.set(outcome.id, outcome.detail)
      else {
        result.failed++
        result.error = result.error || `条目 ${outcome.id} 详情失败 HTTP ${outcome.status}`
      }
    }
  }

  let allDetailsCurrent = true
  for (const entry of entries) {
    const old = details.has(entry.id) ? null : await readJson(path.join(dir, `${entry.id}.json`))
    const sourceMeta = { source: 'gensri', catalogFile: entry.id, requestedDetailFile: entry.detailFile }
    const payload = { ...entry.record, sourceMeta }
    if (details.has(entry.id)) {
      payload.detail = details.get(entry.id)
      sourceMeta.detailFile = entry.detailFile
      sourceMeta.detailVersion = entry.detailVersion
    } else if (old?.detail !== undefined) {
      payload.detail = old.detail
      sourceMeta.detailFile = old.sourceMeta?.detailFile || ''
      sourceMeta.detailVersion = old.sourceMeta?.detailVersion || ''
    }
    allDetailsCurrent = allDetailsCurrent && payload.detail !== undefined && sourceMeta.detailFile === entry.detailFile
    await writeJsonAtomic(path.join(dir, `${entry.id}.json`), payload)
  }
  result.ids = entries.map(entry => entry.id)
  result.labels = Object.fromEntries(entries.map(entry => [entry.id, gensriLabel(entry.record)]))
  result.records = entries.length
  result.fetched = entries.length
  result.detailsComplete = withDetails ? result.failed === 0 : allDetailsCurrent
  if (site) {
    result.phases = normalizePhases(entries.map(entry => entry.phase))
    result.periods = result.phases.length
    result.phaseVersions = Object.fromEntries(result.phases.map(phase => [phase.id, phase.version]))
  }
  return finish(result.failed > 0 && result.failed === entries.length ? CHANNEL_STATUS.FAILED : CHANNEL_STATUS.OK)
}

/** 将三类目录与官方期表转换成稳定记录键，在写入前完成形状校验。 */
function catalogEntries (channel, content, versionFiles) {
  const site = channel.scope === 'site'
  let rows
  if (site) rows = content?.seasons
  else if (channel.page === 'artifact' && content && typeof content === 'object' && !Array.isArray(content)) rows = Object.values(content)
  else rows = content
  if (!Array.isArray(rows)) throw new Error('目录形状与频道定义不符')
  const ids = new Set()
  return rows.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('目录包含非对象记录')
    const id = String(site ? record.id || '' : record.file || record.setId || record.id || '')
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`目录记录键缺失或重复：${id}`)
    ids.add(id)
    if (site) {
      if (!/^[A-Za-z0-9_-]+\/$/.test(record.page || '')) throw new Error(`期 ${id} 缺少官网相对页面路径`)
      const begin = siteTime(record.startAt)
      const end = siteTime(record.endAt)
      if (!begin || !end || Date.parse(end) <= Date.parse(begin)) throw new Error(`期 ${id} 起止时刻不可用`)
      return { id, record, detailFile: `${record.page}config.json`, detailVersion: String(record.version || ''), phase: { id, name: String(record.name || ''), version: String(record.version || ''), begin, end } }
    }
    const latest = Array.isArray(versionFiles[id]) ? versionFiles[id][0] : null
    const detailFile = String(latest?.file || id)
    if (!/^[A-Za-z0-9_@.-]+$/.test(detailFile)) throw new Error(`条目 ${id} 的详情文件名不可用`)
    return { id, record, detailFile, detailVersion: String(latest?.version || '') }
  })
}

/** 官网明确以东八区展示分钟粒度时间，产物补齐秒与时区。 */
function siteTime (value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value || '')) return ''
  const result = value.replace(' ', 'T') + (value.length === 16 ? ':00' : '') + '+08:00'
  return Number.isFinite(Date.parse(result)) ? result : ''
}

/** 每频道结束保存清单，失败继续保留旧索引、记录和详情来源。 */
export async function harvestGensriChannels (channels, options) {
  const manifestPath = path.join(options.dataDir, 'manifest.json')
  const manifest = await readJson(manifestPath, { channels: {} }) || { channels: {} }
  manifest.channels = manifest.channels || {}
  const versionInfo = channels.some(channel => channel.scope !== 'site') ? await fetchGensriVersion(options) : null
  const results = []
  for (const channel of channels) {
    const previous = manifest.channels[channel.id] || null
    let result
    try {
      result = await harvestGensriChannel(channel, { ...options, previous, versionInfo })
    } catch (error) {
      log.error(`频道 ${channel.id} 异常：${error?.message || error}`)
      result = { id: channel.id, status: CHANNEL_STATUS.FAILED, records: 0, fetched: 0, skipped: 0, failed: 1, periods: 0, error: String(error?.message || error) }
    }
    const base = previous || {}
    const retained = [CHANNEL_STATUS.FAILED, CHANNEL_STATUS.ABSENT, CHANNEL_STATUS.SKIPPED].includes(result.status)
    manifest.channels[channel.id] = {
      ...base,
      source: 'gensri', game: channel.game, page: channel.page, pageKey: channel.pageKey, kind: channel.kind,
      status: result.status,
      records: retained ? base.records ?? 0 : result.records,
      indexHash: result.indexHash || base.indexHash || '',
      lastModified: result.lastModified || base.lastModified || '',
      version: result.version || base.version || '',
      versionHash: result.versionHash || base.versionHash || '',
      ids: result.ids || base.ids,
      labels: result.labels || base.labels,
      phases: result.phases || base.phases,
      phaseVersions: result.phaseVersions || base.phaseVersions,
      detailsComplete: result.detailsComplete ?? base.detailsComplete ?? false,
      fetchedAt: new Date().toISOString(), error: result.error || ''
    }
    await writeJsonAtomic(manifestPath, manifest)
    results.push(result)
    if (typeof options.onChannel === 'function') options.onChannel(result)
  }
  return results
}
