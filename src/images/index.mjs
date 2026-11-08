/**
 * 图片产物：`images.json`
 *
 * 记录一条引用解析到了哪个文件，插件据此在**不读全量记录**的前提下拿到 `imageCount` / `icon`，
 * 并在详情页把 `meta.images` 还原成旧后端同形的数组。
 *
 * 结构（`schemaVersion` 与 index/periods 一致）：
 *   { schemaVersion, generatedAt, games: { <game>: { <page>: { <recordId>: [
 *       { fieldPath, kind, originalValue, remoteUrl, localPath, status, placeholder } ] } } } }
 *
 * `localPath` 相对 `<dataDir>/`，如 `images/hsr/monsterfigure/Monster_1002011.webp`。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../core/io.mjs'
import { SCHEMA_VERSION } from '../schema/index.mjs'

/** 图片产物文件名 */
export const IMAGES_FILE = 'images.json'

/** 空产物骨架 */
export function emptyImages (generatedAt = new Date().toISOString()) {
  return { schemaVersion: SCHEMA_VERSION, generatedAt, games: {}, failures: {} }
}

/**
 * 把散装引用按 game/page/record 分组
 * @param {object[]} refs - 已解析的引用（带 gameId/pageId/recordId）
 * @param {object} [base] - 已有产物（合并用）
 * @returns {object}
 */
export function groupImages (refs, base = emptyImages()) {
  const product = {
    schemaVersion: base.schemaVersion ?? SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    games: { ...(base.games || {}) },
    // 失败候选：下一轮默认不再探测，`--retry-failed` 才重试
    failures: { ...(base.failures || {}) }
  }
  for (const ref of refs) {
    const { gameId, pageId, recordId } = ref
    if (!gameId || !pageId || !recordId) continue
    product.games[gameId] = product.games[gameId] || {}
    product.games[gameId][pageId] = product.games[gameId][pageId] || {}
    product.games[gameId][pageId][recordId] = (ref.list || []).map((item) => ({
      fieldPath: item.fieldPath,
      kind: item.kind,
      originalValue: item.originalValue,
      remoteUrl: item.remoteUrl || '',
      localPath: item.localPath || '',
      status: item.status || '',
      placeholder: Boolean(item.placeholder),
      // 增量元数据：复用判据只比体积，`etag` 留给 verify 模式
      bytes: Number(item.bytes) || 0,
      etag: item.etag || ''
    }))
  }
  return product
}

/** 读产物（不存在返回 null） */
export async function readImagesProduct (dataDir) {
  const product = await readJson(path.join(dataDir, IMAGES_FILE))
  if (!product || product.schemaVersion !== SCHEMA_VERSION) return null
  return product
}

/** 写产物 */
export async function writeImagesProduct (dataDir, product) {
  await writeJsonAtomic(path.join(dataDir, IMAGES_FILE), product)
}

/**
 * 产物 → 增量复用表（URL → 已落盘结果）
 * @param {object|null} product
 * @returns {Record<string, object>}
 */
export function reuseTable (product) {
  const byUrl = {}
  for (const pages of Object.values(product?.games || {})) {
    for (const records of Object.values(pages)) {
      for (const list of Object.values(records)) {
        for (const ref of list) {
          if (ref.remoteUrl && ref.localPath) byUrl[ref.remoteUrl] = { ...ref, bytes: ref.bytes }
        }
      }
    }
  }
  return byUrl
}

/** 图标字段偏好（越小越优先当列表/详情主图） */
const ICON_RANK = [
  /(^|\.)icon$/i,
  /mindscape/i,
  /avatar/i,
  /figure/i,
  /(^|\.)image$/i
]

/**
 * 给索引的 `entries` 补 `imageCount` / `icon`
 *
 * 就地修改 `index.games[game].pages[page].entries`；页面在产物里没有图片时不动。
 * @param {object} index - exportAll 正在构建的 index
 * @param {object|null} product - images.json
 * @returns {{records: number, icons: number}}
 */
export function enrichIndexEntries (index, product) {
  let records = 0
  let icons = 0
  for (const [gameId, pages] of Object.entries(product?.games || {})) {
    for (const [pageDir, recordsMap] of Object.entries(pages)) {
      const target = index.games[gameId]?.pages?.[pageDir]?.entries
      if (!target) continue
      for (const [recordId, list] of Object.entries(recordsMap)) {
        const usable = list.filter((ref) => ref.localPath && !ref.placeholder)
        target[recordId] = { ...(target[recordId] || {}), imageCount: usable.length }
        if (usable.length) {
          const icon = pickIcon(usable)
          if (icon) {
            target[recordId].icon = icon.localPath
            icons += 1
          }
        }
        records += 1
      }
    }
  }
  return { records, icons }
}

/** 按偏好挑一张主图 */
function pickIcon (list) {
  for (const pattern of ICON_RANK) {
    const hit = list.find((ref) => pattern.test(ref.fieldPath))
    if (hit) return hit
  }
  return list[0]
}

/**
 * 读一条记录的图片引用（插件侧用；不存在返回空数组）
 * @param {object|null} product
 * @param {string} gameId
 * @param {string} pageDir
 * @param {string|number} recordId
 * @returns {object[]}
 */
export function recordImages (product, gameId, pageDir, recordId) {
  return product?.games?.[gameId]?.[pageDir]?.[String(recordId)] || []
}

/** 图片目录是否存在（判断要不要抓图） */
export async function hasImages (dataDir) {
  try {
    const stat = await fs.stat(path.join(dataDir, 'images'))
    return stat.isDirectory()
  } catch {
    return false
  }
}
