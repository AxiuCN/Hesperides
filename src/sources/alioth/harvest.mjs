/**
 * 玉璃抓取器
 *
 * 抓取模型（v1）：
 *   ① 先取频道索引（带 If-Modified-Since）——索引没变就整频道跳过，这是最省的增量
 *   ② 索引变了：
 *      - phased 频道：只抓「版本号变化或缺记录」的期
 *      - ids / single 频道：整频道重抓（版本更新时条目普遍变化）
 *   ③ 每条记录原子落盘，失败只记该条，不阻断其它条
 *   ④ 404 视为 `absent`（契约里有、线上没有），不算失败、不删旧数据
 *
 * 抓哪些频道由调用方决定；本模块不读配置、不判断"该不该抓"。
 */
import path from 'node:path'
import {
  fetchText, writeFileAtomic, writeJsonAtomic, readJson, parseJson, contentHash, runPool, sleep, log
} from '../../core/io.mjs'
import { ALIOTH_DATA_BASE, ALIOTH_LANG, ALIOTH_TEXTMAP_BASE } from './channels.mjs'
import { normalizePhases } from '../../core/normalize.mjs'
import { pickRecordName, pickRecordRarity } from '../../core/labels.mjs'
import { CHANNEL_STATUS } from '../../schema/index.mjs'
import { recordDir } from '../../core/paths.mjs'

/**
 * 拼频道索引 URL
 * @param {object} channel
 * @returns {string}
 */
export function channelIndexUrl (channel) {
  if (channel.kind === 'text') {
    return `${ALIOTH_TEXTMAP_BASE}/${channel.files[0]}`
  }
  const prefix = channel.scope === 'root'
    ? `${ALIOTH_DATA_BASE}/${channel.game}`
    : `${ALIOTH_DATA_BASE}/${channel.game}/${ALIOTH_LANG}`
  return `${prefix}/${channel.index}`
}

/**
 * 拼分片 URL（records 用相对路径，这里给出下载地址）
 * @param {object} channel
 * @param {string} [relativePath]
 * @returns {string}
 */
export function channelItemUrl (channel, relativePath) {
  const prefix = channel.scope === 'root'
    ? `${ALIOTH_DATA_BASE}/${channel.game}`
    : `${ALIOTH_DATA_BASE}/${channel.game}/${ALIOTH_LANG}`
  return `${prefix}/${relativePath}`
}

/**
 * 把 `2026/12/16 - 2027/01/16` / `2026/12` 解析成起止日期
 *
 * 玉璃的剧诗时间只到月，按月首/月末补齐（并标记精度），避免"整月期"被算成一天。
 * @param {string} text
 * @param {'day'|'month'} [precision]
 * @returns {{begin: string, end: string}}
 */
export function parsePeriodRange (text, precision = 'day') {
  const raw = String(text || '').trim()
  const parts = raw.split(/\s*-\s*/).filter(Boolean)
  const toDate = (value, isEnd) => {
    const matched = value.match(/^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/)
    if (!matched) return ''
    const [, year, month, day] = matched
    if (day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (precision === 'month') {
      if (!isEnd) return `${year}-${String(month).padStart(2, '0')}-01`
      const lastDay = new Date(Number(year), Number(month), 0).getDate()
      return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    }
    return `${year}-${String(month).padStart(2, '0')}-01`
  }
  return {
    begin: toDate(parts[0] || '', false),
    // 只给了一个月（剧诗）→ 结束日补到该月最后一天
    end: parts[1] ? toDate(parts[1], true) : toDate(parts[0] || '', true)
  }
}

/**
 * 从 phased 频道索引里取期列表（按 begin 升序）
 * @param {object} channel
 * @param {object} indexJson
 * @returns {{id: string, name: string, version: string, begin: string, end: string}[]}
 */
export function extractPhases (channel, indexJson) {
  const map = channel.period || {}
  const list = indexJson?.[map.sourcePhases || 'Phases']
  if (!Array.isArray(list)) return []
  const precision = map.timePrecision === 'month' ? 'month' : 'day'
  return normalizePhases(list.map((phase) => {
    const id = phase?.[map.id || '_id']
    if (id === undefined || id === null) return null
    const { begin, end } = parsePeriodRange(phase?.[map.time || 'Time'], precision)
    return {
      id: String(id),
      name: String(phase?.[map.name || 'Name'] || ''),
      version: String(phase?.[map.version || 'Ver'] || ''),
      begin,
      end
    }
  }).filter(Boolean))
}

/**
 * 按选择器从索引 JSON 里解析分片 id
 * @param {object} channel
 * @param {object} indexJson
 * @returns {string[]|null} null 表示该频道未验证 ID 来源
 */
export function resolveIds (channel, indexJson) {
  const spec = channel.ids
  if (!spec) return null
  const collect = (list, field) => list
    .map((item) => item?.[field])
    .filter((id) => id !== undefined && id !== null)
    .map(String)

  switch (spec.type) {
    case 'keysAt': {
      const object = indexJson?.[spec.path]
      if (!object || typeof object !== 'object') return []
      return Object.keys(object)
    }
    case 'arrayAt': {
      const list = indexJson?.[spec.path]
      return Array.isArray(list) ? collect(list, spec.id) : []
    }
    case 'arrayOfArrays': {
      const groups = indexJson?.[spec.path]
      if (!groups || typeof groups !== 'object') return []
      return Object.values(groups)
        .filter(Array.isArray)
        .flatMap((list) => collect(list, spec.id))
    }
    case 'arrayFields': {
      const ids = []
      for (const [fieldPath, idField] of spec.fields) {
        const list = indexJson?.[fieldPath]
        if (Array.isArray(list)) ids.push(...collect(list, idField))
      }
      return [...new Set(ids)]
    }
    default:
      return null
  }
}

/**
 * 抓单个频道（返回该频道本轮结果，不抛错）
 * @param {object} channel
 * @param {object} options
 * @param {'incremental'|'full'} [options.mode]
 * @param {number} [options.concurrency]
 * @param {string} options.dataDir - 产物根目录（data/hesperides）
 * @param {object} [options.previous] - 上一轮该频道的 manifest 片段
 * @returns {Promise<object>}
 */
export async function harvestChannel (channel, options) {
  const { mode = 'incremental', concurrency = 4, dataDir, previous = null } = options
  // 可注入 fetch / 关闭延时，供离线回归套件使用
  const doFetch = options.fetchImpl || fetchText
  const doSleep = options.delay === false ? () => Promise.resolve() : sleep
  // 上一轮没跑完（失败/带 error）时不做条件请求、不做同 hash 短路，
  // 否则上游恢复后索引没变 → 直接 skipped，缺记录永远补不回来
  const previousIncomplete = previous?.status === CHANNEL_STATUS.FAILED || Boolean(previous?.error)
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

  // text 类频道只有文件、没有索引
  if (channel.kind === 'text' || channel.kind === 'static') {
    const files = channel.files || []
    const hashes = {}
    for (const file of files) {
      const url = `${channel.kind === 'text' ? `${ALIOTH_TEXTMAP_BASE}/` : channelItemUrl(channel, '')}${file}`
      const res = await doFetch(url)
      if (!res.ok) {
        result.failed++
        result.error = `HTTP ${res.status || res.error} @ ${file}`
        continue
      }
      const hash = contentHash(res.text || '')
      const target = path.join(recordDir(dataDir, channel), file.replace(/[\\/]/g, '__'))
      if (mode !== 'full' && previous?.fileHashes?.[file] === hash) {
        result.skipped++
      } else {
        await writeFileAtomic(target, res.text || '')
        result.fetched++
      }
      hashes[file] = hash
      result.records++
      await doSleep(80 + Math.random() * 120)
    }
    result.fileHashes = hashes
    result.status = result.failed ? CHANNEL_STATUS.FAILED : CHANNEL_STATUS.OK
    result.ms = Date.now() - startedAt
    return result
  }

  // 其它类型：先取索引
  const indexPath = channel.kind === 'single'
    ? path.join(recordDir(dataDir, channel), '__index.json')
    : null
  const headers = {}
  if (previous?.lastModified && mode !== 'full' && !previousIncomplete) headers['if-modified-since'] = previous.lastModified

  const indexRes = await doFetch(channelIndexUrl(channel), { headers })
  if (indexRes.status === 304) {
    result.status = CHANNEL_STATUS.SKIPPED
    result.skipped = previous?.records || 0
    result.indexHash = previous?.indexHash || ''
    result.lastModified = previous?.lastModified
    result.ms = Date.now() - startedAt
    return result
  }
  if (indexRes.status === 404) {
    result.status = CHANNEL_STATUS.ABSENT
    result.error = 'HTTP 404（上游没有该文件）'
    result.ms = Date.now() - startedAt
    return result
  }
  if (!indexRes.ok) {
    result.status = CHANNEL_STATUS.FAILED
    result.error = `索引失败 HTTP ${indexRes.status || indexRes.error}`
    result.ms = Date.now() - startedAt
    return result
  }

  const indexHash = contentHash(indexRes.text || '')
  result.indexHash = indexHash
  result.lastModified = indexRes.lastModified
  if (mode !== 'full' && !previousIncomplete && previous?.indexHash === indexHash) {
    // 内容指纹一致（上游没给 304 时兜底）
    result.status = CHANNEL_STATUS.SKIPPED
    result.skipped = previous?.records || 0
    result.ms = Date.now() - startedAt
    return result
  }

  const indexJson = parseJson(indexRes.text || '')
  if (!indexJson) {
    result.status = CHANNEL_STATUS.FAILED
    result.error = '索引不是合法 JSON'
    result.ms = Date.now() - startedAt
    return result
  }

  // single：索引本身就是数据
  if (channel.kind === 'single') {
    await writeFileAtomic(indexPath, indexRes.text || '')
    result.records = 1
    result.fetched = 1
    if (previous?.sha) result.previousSha = previous.sha
    result.ms = Date.now() - startedAt
    return result
  }

  // phased：按期抓，只抓新增/版本变化的期
  if (channel.kind === 'phased') {
    const phases = extractPhases(channel, indexJson)
    const known = previous?.phaseVersions || {}
    const targets = phases.filter((phase) => mode === 'full' || known[phase.id] !== phase.version)
    result.periods = phases.length
    // 只继承已知 + 逐个补「成功落盘」的期；失败期不前进版本，下一轮才会重试
    result.phaseVersions = { ...known }
    result.phases = phases

    const outcomes = await runPool(targets, concurrency, async (phase) => {
      const relative = channel.item.replace('{id}', phase.id)
      const res = await doFetch(channelItemUrl(channel, relative))
      if (!res.ok) {
        await doSleep(100 + Math.random() * 120)
        return { ok: false, id: phase.id, status: res.status }
      }
      const target = path.join(recordDir(dataDir, channel), `${phase.id}.json`)
      await writeFileAtomic(target, res.text || '')
      await doSleep(100 + Math.random() * 120)
      return { ok: true, id: phase.id, version: phase.version }
    })

    for (const outcome of outcomes) {
      if (outcome.ok) {
        result.fetched++
        result.phaseVersions[outcome.id] = outcome.version
      } else {
        result.failed++
        result.error = result.error || `期 ${outcome.id} 失败 HTTP ${outcome.status}`
      }
    }
    result.skipped = phases.length - targets.length
    result.records = phases.length
    // 期名作为记录级元数据（期页不参与常规搜索，但保持 entries 完整）
    result.labels = Object.fromEntries(phases.map((phase) => [phase.id, { name: phase.name || '', rarity: '' }]))
    result.status = result.failed ? CHANNEL_STATUS.FAILED : CHANNEL_STATUS.OK
    result.ms = Date.now() - startedAt
    return result
  }

  // ids：解析 id 列表后整批抓（索引变了通常意味着版本更新，条目普遍变化）
  const ids = resolveIds(channel, indexJson)
  if (ids === null) {
    result.status = CHANNEL_STATUS.UNVERIFIED
    result.error = '未验证 ID 来源'
    result.ms = Date.now() - startedAt
    return result
  }
  result.ids = ids
  const labels = {}
  const outcomes = await runPool(ids, concurrency, async (id) => {
    const relative = channel.item.replace('{id}', id)
    const res = await doFetch(channelItemUrl(channel, relative))
    await doSleep(100 + Math.random() * 120)
    if (!res.ok) return { ok: false, id, status: res.status }
    if (channel.ext === 'txt') {
      await writeFileAtomic(path.join(recordDir(dataDir, channel), `${id}.txt`), res.text || '')
      return { ok: true, id }
    }
    const parsed = parseJson(res.text || '')
    if (!parsed) return { ok: false, id, status: 0, reason: 'invalid json' }
    labels[id] = { name: pickRecordName(parsed), rarity: pickRecordRarity(parsed) }
    await writeFileAtomic(
      path.join(recordDir(dataDir, channel), `${id}.json`),
      `${JSON.stringify(parsed)}\n`
    )
    return { ok: true, id }
  })

  for (const outcome of outcomes) {
    if (outcome.ok) result.fetched++
    else {
      result.failed++
      result.error = result.error || `条目 ${outcome.id} 失败 HTTP ${outcome.status}${outcome.reason ? ' ' + outcome.reason : ''}`
    }
  }
  if (Object.keys(labels).length) result.labels = labels
  result.records = ids.length
  // 全部条目都失败才判频道失败；部分失败让它保持 ok 但记录 failed 数
  result.status = result.failed && result.failed === ids.length
    ? CHANNEL_STATUS.FAILED
    : CHANNEL_STATUS.OK
  result.ms = Date.now() - startedAt
  return result
}

/**
 * 批量抓取（调用方已选好频道）
 * @param {object[]} channels
 * @param {object} options
 * @param {string} options.dataDir
 * @param {'incremental'|'full'} [options.mode]
 * @param {number} [options.concurrency]
 * @param {(result: object) => void} [options.onChannel] - 每频道结束回调（CLI 打印进度）
 * @returns {Promise<object[]>}
 */
export async function harvestChannels (channels, options) {
  const manifestPath = path.join(options.dataDir, 'manifest.json')
  const manifest = (await readJson(manifestPath, { channels: {} })) || { channels: {} }
  manifest.channels = manifest.channels || {}

  const results = []
  for (const channel of channels) {
    const previous = manifest.channels[channel.id] || null
    let result
    try {
      result = await harvestChannel(channel, { ...options, previous })
    } catch (err) {
      log.error(`频道 ${channel.id} 异常：${err?.message || err}`)
      result = {
        id: channel.id,
        status: CHANNEL_STATUS.FAILED,
        records: 0,
        fetched: 0,
        skipped: 0,
        failed: 1,
        periods: 0,
        ms: 0,
        error: String(err?.message || err)
      }
    }

    // 失败/缺席都沿用旧 manifest（保留旧数据可读），成功则覆盖
    const base = previous || {}
    manifest.channels[channel.id] = {
      ...base,
      source: channel.source || 'alioth',
      game: channel.game,
      page: channel.page,
      pageKey: channel.pageKey || channel.page,
      kind: channel.kind,
      status: result.status,
      // 失败 / 缺席 / 未变（skipped）都沿用上一轮记录数：跳过并不代表 0 条
      records: [CHANNEL_STATUS.FAILED, CHANNEL_STATUS.ABSENT, CHANNEL_STATUS.SKIPPED].includes(result.status)
        ? (base.records ?? 0)
        : result.records,
      indexHash: result.indexHash || base.indexHash || '',
      lastModified: result.lastModified || base.lastModified || '',
      phaseVersions: result.phaseVersions || base.phaseVersions,
      phases: result.phases || base.phases,
      labels: result.labels ? { ...(base.labels || {}), ...result.labels } : base.labels,
      fileHashes: result.fileHashes || base.fileHashes,
      ids: result.ids || base.ids,
      fetchedAt: new Date().toISOString(),
      error: result.error || ''
    }

    // 每频道结束都落一次 manifest：中途被杀也能续跑
    await writeJsonAtomic(manifestPath, manifest)
    results.push(result)
    if (typeof options.onChannel === 'function') options.onChannel(result)
  }

  return results
}
