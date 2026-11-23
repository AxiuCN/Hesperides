/**
 * 图片回退：某个字段的图缺失（占位/404）时，用同一 id 在其它页 / 其它源的同名图补上
 *
 * 典型场景：
 *   - `gi/nanoka/item_all` 的 `icon` 大量缺图，而 `gi/nanoka/item` 同 id 有图；
 *   - `hsr/nanoka/monster` 的怪物图在 nanoka 静态站 404，而玉璃终局记录里已抓到
 *     `Monsters.<id>.Icon` / `.Figure`。
 *
 * 只改写引用（`localPath` / `placeholder`），不复制文件：回退后的引用直接指向 donor 页
 * 已有的本地文件，避免同一张图存两份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { imageRefsFile } from '../core/paths.mjs'
import { readJson } from '../core/io.mjs'

/**
 * 回退表：目标页的哪个字段，能由谁补
 *
 * `resolve({ id, field })` 返回候选 donor 列表（按顺序尝试）：
 * `{ source, page, fieldPath }`
 */
export const IMAGE_FALLBACKS = [
  {
    game: 'gi',
    source: 'nanoka',
    page: 'item_all',
    resolve: ({ field }) => (field === 'icon' ? [{ source: 'nanoka', page: 'item', fieldPath: 'icon', mode: 'record' }] : [])
  },
  {
    game: 'hsr',
    source: 'nanoka',
    page: 'monster',
    resolve: ({ id, field }) => {
      const donorField = { icon: 'Icon', 'detail.image_path': 'Figure', 'derived.monsterFigure': 'Figure' }[field]
      if (!donorField) return []
      return ['chaos', 'as'].map((page) => ({ source: 'alioth', page, fieldPath: `Monsters.${id}.${donorField}`, mode: 'field' }))
    }
  },
  {
    // 同名的图标在别的页已经有了（如玉璃/月亮网的怪物图标），按图标名回退
    game: 'gi',
    source: 'nanoka',
    page: 'leyline',
    resolve: ({ field }) => (/\.icon$/.test(field) ? [{ mode: 'name' }] : [])
  }
]

/**
 * 取某页的引用文件内容
 * @param {string} dataDir
 * @param {{game: string, source: string, page: string}} key
 * @returns {object|null} `{ records: { [id]: ref[] } }`
 */
async function readRefs (dataDir, key) {
  return readJson(imageRefsFile(dataDir, { gameId: key.game, source: key.source, page: key.page }), null)
}

/** donor 页的索引：按「记录 id + 字段」与「字段」两套（只收有本地文件、非占位的引用） */
function donorIndex (refs, dataDir) {
  const byRecord = new Map()
  const byField = new Map()
  for (const [id, list] of Object.entries(refs?.records || {})) {
    for (const ref of list) {
      if (ref.placeholder || !ref.localPath) continue
      if (!fs.existsSync(path.join(dataDir, ref.localPath))) continue
      byRecord.set(`${id}|${ref.fieldPath}`, ref.localPath)
      if (!byField.has(ref.fieldPath)) byField.set(ref.fieldPath, ref.localPath)
    }
  }
  return { byRecord, byField }
}

/** 图标名（去目录、去扩展名、小写）——`UI_MonsterIcon_Xxx` 这类在字段里是裸名 */
function iconNameOf (value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.split(/[\\/]/).pop().replace(/\.(png|webp|jpe?g)$/i, '').toLowerCase()
}

/**
 * 全局图标名索引：扫一遍所有 imagerefs，建立 `图标名 → localPath`
 * 只在需要「按名字回退」时构建一次（几千条引用，开销可接受）
 * @param {string} dataDir
 * @returns {Promise<Map<string, string>>}
 */
async function globalNameIndex (dataDir) {
  const refRoot = path.join(dataDir, 'imagerefs')
  const index = new Map()
  let games = []
  try {
    games = fs.readdirSync(refRoot)
  } catch {
    return index
  }
  for (const game of games) {
    const gameDir = path.join(refRoot, game)
    if (!fs.statSync(gameDir).isDirectory()) continue
    for (const source of fs.readdirSync(gameDir)) {
      const sourceDir = path.join(gameDir, source)
      if (!fs.statSync(sourceDir).isDirectory()) continue
      for (const file of fs.readdirSync(sourceDir).filter((name) => name.endsWith('.json'))) {
        const refs = await readJson(path.join(sourceDir, file), null)
        for (const list of Object.values(refs?.records || {})) {
          for (const ref of list) {
            if (ref.placeholder || !ref.localPath) continue
            if (!fs.existsSync(path.join(dataDir, ref.localPath))) continue
            for (const name of [iconNameOf(ref.originalValue), iconNameOf(ref.localPath)]) {
              if (name && !index.has(name)) index.set(name, ref.localPath)
            }
          }
        }
      }
    }
  }
  return index
}

/**
 * 对一页应用回退（原地改写该页的引用文件）
 * @param {string} dataDir
 * @param {{game: string, source: string, page: string}} target
 * @returns {Promise<{patched: number, checked: number}>}
 */
export async function applyImageFallbacks (dataDir, target) {
  const rule = IMAGE_FALLBACKS.find((item) => item.game === target.game && item.source === target.source && item.page === target.page)
  if (!rule) return { patched: 0, checked: 0 }

  const page = await readRefs(dataDir, target)
  if (!page?.records) return { patched: 0, checked: 0 }

  const indexes = new Map()
  const indexFor = (candidate) => {
    const key = `${candidate.source}/${candidate.page}`
    if (!indexes.has(key)) indexes.set(key, candidate.index || null)
    return indexes.get(key)
  }

  let patched = 0
  let checked = 0
  let nameIndex = null
  for (const [id, list] of Object.entries(page.records)) {
    for (const ref of list) {
      if (!ref.placeholder && ref.localPath && fs.existsSync(path.join(dataDir, ref.localPath))) continue
      checked += 1
      for (const candidate of rule.resolve({ id, field: ref.fieldPath })) {
        let localPath = null
        if (candidate.mode === 'name') {
          if (!nameIndex) nameIndex = await globalNameIndex(dataDir)
          const name = iconNameOf(ref.originalValue)
          localPath = name ? nameIndex.get(name) : null
        } else {
          const key = `${candidate.source}/${candidate.page}`
          if (!indexes.has(key)) {
            const donorRefs = await readRefs(dataDir, { game: target.game, source: candidate.source, page: candidate.page })
            indexes.set(key, donorIndex(donorRefs, dataDir))
          }
          localPath = candidate.mode === 'field'
            ? indexes.get(key).byField.get(candidate.fieldPath)
            : indexes.get(key).byRecord.get(`${id}|${candidate.fieldPath}`)
        }
        if (!localPath) continue
        ref.localPath = localPath
        ref.placeholder = false
        ref.status = 'fallback'
        ref.fallbackFrom = `${candidate.source}/${candidate.page}:${candidate.fieldPath}`
        patched += 1
        break
      }
    }
  }

  if (patched) {
    const fsPromises = await import('node:fs/promises')
    await fsPromises.mkdir(path.dirname(imageRefsFile(dataDir, { gameId: target.game, source: target.source, page: target.page })), { recursive: true })
    await fsPromises.writeFile(imageRefsFile(dataDir, { gameId: target.game, source: target.source, page: target.page }), JSON.stringify(page, null, 2) + '\n')
  }
  return { patched, checked }
}

/**
 * 对全部规则页应用回退
 * @param {string} dataDir
 * @returns {Promise<{pages: number, patched: number}>}
 */
export async function applyAllImageFallbacks (dataDir) {
  let pages = 0
  let patched = 0
  for (const rule of IMAGE_FALLBACKS) {
    const result = await applyImageFallbacks(dataDir, { game: rule.game, source: rule.source, page: rule.page })
    pages += 1
    patched += result.patched
  }
  return { pages, patched }
}