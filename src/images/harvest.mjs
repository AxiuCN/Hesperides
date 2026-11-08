/**
 * 按频道抓图：读已落盘记录 → 收集引用 → 下载 → 写当前页的引用文件
 *
 * 与记录抓取解耦：记录抓完后单独跑一遍，支持只补某几个频道，也支持中断后重跑（复用已有文件）。
 * 一页一份引用文件（`imagerefs/<game>/<source>/<page>.json`），失败候选写全局 `image-failures.json`。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, log } from '../core/io.mjs'
import { imageRefsFile, recordDir, sourceOf } from '../core/paths.mjs'
import { collectRecordImageRefs } from './refs.mjs'
import { harvestImages } from './store.mjs'
import { readImageFailures, readPageImages, reuseTable, writeImageFailures, writePageImages } from './index.mjs'

/**
 * 某频道的记录 id 列表（manifest 优先，缺失则扫目录）
 * @param {string} dataDir
 * @param {object} channel
 * @param {string[]} [ids]
 * @returns {Promise<string[]>}
 */
export async function channelRecordIds (dataDir, channel, ids) {
  if (Array.isArray(ids) && ids.length) return ids.map(String)
  const manifest = await readJson(path.join(dataDir, 'manifest.json'), { channels: {} })
  const entry = manifest.channels?.[channel.id]
  if (Array.isArray(entry?.ids) && entry.ids.length) return entry.ids.map(String)
  try {
    const files = await fs.readdir(recordDir(dataDir, channel))
    return files.filter((file) => file.endsWith('.json') && !file.startsWith('__')).map((file) => file.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

/**
 * 抓一个频道的图片
 * @param {object} channel - 频道定义（含 id/game/page/source）
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string[]} [options.ids]
 * @param {number} [options.concurrency]
 * @param {Function} [options.fetchImpl]
 * @param {boolean} [options.verify]
 * @param {boolean} [options.retryFailed]
 * @returns {Promise<{channel: string, records: number, refs: number, stats: object}>}
 */
export async function harvestChannelImages (channel, options) {
  const { dataDir, concurrency = 6, fetchImpl, verify = false } = options
  const source = sourceOf(channel)
  const key = { gameId: channel.game, source, page: channel.page }
  const ids = await channelRecordIds(dataDir, channel, options.ids)
  if (!ids.length) {
    log.warn(`${channel.id}：没有记录，跳过图片`)
    return { channel: channel.id, records: 0, refs: 0, stats: {} }
  }

  const dir = recordDir(dataDir, channel)
  const flat = []
  for (const id of ids) {
    const record = await readJson(path.join(dir, `${id}.json`))
    if (!record) continue
    const refs = collectRecordImageRefs({
      gameId: channel.game,
      source,
      pageKey: channel.pageKey || channel.page,
      recordId: id,
      record
    })
    for (const ref of refs) flat.push({ ...ref, gameId: channel.game, pageId: channel.page })
  }

  if (!flat.length) {
    log.info(`${channel.id}：记录里没有图片引用`)
    return { channel: channel.id, records: ids.length, refs: 0, stats: {} }
  }

  const previousRecords = (await readPageImages(dataDir, key)) || {}
  const failures = await readImageFailures(dataDir)
  const { byUrl, failures: nextFailures, stats, refs } = await harvestImages(flat, {
    dataDir,
    previous: reuseTable(previousRecords),
    previousFailures: failures,
    retryFailed: options.retryFailed,
    concurrency,
    fetchImpl,
    verify
  })

  // 按记录归组；同一条记录的引用整条替换（重跑不留旧条目）
  const byRecord = {}
  for (const ref of refs) {
    const meta = byUrl[ref.remoteUrl] || {}
    const entry = {
      source,
      fieldPath: ref.fieldPath,
      kind: ref.kind,
      originalValue: ref.originalValue,
      remoteUrl: ref.remoteUrl || '',
      localPath: ref.localPath || '',
      status: ref.status || '',
      placeholder: Boolean(ref.placeholder),
      bytes: Number(meta.bytes) || 0,
      etag: meta.etag || ''
    }
    byRecord[ref.recordId] = byRecord[ref.recordId] || []
    byRecord[ref.recordId].push(entry)
  }

  await writePageImages(dataDir, key, byRecord)
  await writeImageFailures(dataDir, nextFailures)

  return { channel: channel.id, records: ids.length, refs: refs.length, stats, file: imageRefsFile(dataDir, key) }
}

/**
 * 批量抓图（逐频道写盘，中断可续跑）
 * @param {object[]} channels
 * @param {object} options
 * @returns {Promise<object[]>}
 */
export async function harvestImagesForChannels (channels, options) {
  const results = []
  for (const channel of channels) {
    const started = Date.now()
    const result = await harvestChannelImages(channel, options)
    results.push({ ...result, ms: Date.now() - started })
  }
  return results
}
