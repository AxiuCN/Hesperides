/**
 * 图片产物（schema v2）：一页一个引用文件
 *
 *   imagerefs/<game>/<source>/<page>.json   `{ [recordId]: [ref, …] }`
 *   image-failures.json                     `{ [url]: { status, at } }`
 *
 * 为什么按页存而不是一份大 JSON：一页最多几千条记录，插件用到哪页读哪页（缓存几页即可），
 * 抓取时也只重写当前页——原来那份 `images.json` 要读进 30 MB+ 并在每个频道后整体重写。
 */
import { readJson, writeJsonAtomic } from '../core/io.mjs'
import { imageFailuresFile, imageRefsFile } from '../core/paths.mjs'
import { SCHEMA_VERSION } from '../schema/index.mjs'

/**
 * 读一页的图片引用
 * @param {string} dataDir
 * @param {{gameId: string, source: string, page: string}} key
 * @returns {Promise<Record<string, object[]>|null>}
 */
export async function readPageImages (dataDir, key) {
  const data = await readJson(imageRefsFile(dataDir, key))
  if (!data || data.schemaVersion !== SCHEMA_VERSION) return null
  return data.records || {}
}

/**
 * 写一页的图片引用
 * @param {string} dataDir
 * @param {{gameId: string, source: string, page: string}} key
 * @param {Record<string, object[]>} records
 */
export async function writePageImages (dataDir, key, records) {
  await writeJsonAtomic(imageRefsFile(dataDir, key), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    game: key.gameId,
    source: key.source,
    page: key.page,
    records
  })
}

/**
 * 读失败候选表
 * @param {string} dataDir
 * @returns {Promise<Record<string, {status: string, at: string}>>}
 */
export async function readImageFailures (dataDir) {
  return (await readJson(imageFailuresFile(dataDir), {})) || {}
}

/**
 * 写失败候选表
 * @param {string} dataDir
 * @param {object} failures
 */
export async function writeImageFailures (dataDir, failures) {
  await writeJsonAtomic(imageFailuresFile(dataDir), failures)
}

/**
 * 一页的引用 → 增量复用表（URL → 已落盘结果）
 * @param {Record<string, object[]>} records
 * @returns {Record<string, object>}
 */
export function reuseTable (records) {
  const byUrl = {}
  for (const list of Object.values(records || {})) {
    for (const ref of list) {
      if (ref.remoteUrl && ref.localPath && !ref.placeholder) byUrl[ref.remoteUrl] = ref
    }
  }
  return byUrl
}

/** 图标字段偏好（越小越优先当列表/详情主图） */
const ICON_RANK = [
  /(^|\.)(icon|CardImg|weaponIcon|setIcon)$/i,
  /mindscape/i,
  /avatar/i,
  /figure/i,
  /(^|\.)image$/i
]

/**
 * 一条记录的引用 → `entries` 上的 `{ imageCount, icon }`
 * @param {object[]} list
 * @returns {{imageCount: number, icon?: string}}
 */
export function pickEntryImage (list) {
  const usable = (list || []).filter((ref) => ref.localPath && !ref.placeholder)
  if (!usable.length) return { imageCount: 0 }
  let icon = ''
  for (const pattern of ICON_RANK) {
    const hit = usable.find((ref) => pattern.test(ref.fieldPath))
    if (hit) {
      icon = hit.localPath
      break
    }
  }
  return { imageCount: usable.length, icon: icon || usable[0].localPath }
}
