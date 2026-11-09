/**
 * 图片落盘与增量
 *
 * 契约：
 *   - 一个远程 URL 只落一个文件，路径镜像 CDN：`<dataDir>/images/<game>/<目录>/<文件>.<ext>`
 *   - URL 里的游戏路径段先归一成 gameId（玉璃的星铁段是 `sr`，落盘仍是 `hsr`）
 *   - 增量判据 = URL 相同 + 本地文件仍在 + 体积一致（可选 `verify` 时再比 ETag）
 *   - 候选全部失败 → 落占位图 `images/_placeholder/unknown.svg`，**不删旧图**（沿用上一轮结果）
 *   - 所有写盘走原子写；下载并发受 `concurrency` 限制
 *
 * 本模块不决定「抓哪些记录」：引用由 `images/refs.mjs` 从记录里算出来（按源分派 URL 规则），调用方传进来。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fetchBuffer, runPool, writeFileAtomic, log } from '../core/io.mjs'
import { IMAGE_ASSET_BASE, SOURCE_IMAGE_RULES } from './refs.mjs'

/** 占位图（上游所有候选都 404 时用；与旧后端同一份图形，纯 SVG 不占体积） */
export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Missing image"><rect width="256" height="256" rx="36" fill="#141827"/><path d="M62 176 98 132l29 35 22-27 45 56H62Z" fill="#2b3248"/><circle cx="183" cy="76" r="18" fill="#39435e"/><path d="M128 58c-24 0-42 14-45 36h30c2-8 8-13 16-13 9 0 15 5 15 13 0 7-4 12-15 20-17 12-24 23-23 41h28c0-10 4-16 17-25 16-11 25-23 25-39 0-20-19-33-48-33Z" fill="#b8c0d9"/><circle cx="120" cy="188" r="15" fill="#b8c0d9"/></svg>\n`

/** 占位图相对路径（相对 dataDir） */
export const PLACEHOLDER_PATH = 'images/_placeholder/unknown.svg'

/**
 * URL 里的游戏路径段 → gameId
 *
 * 玉璃把星铁放在 `sr/` 下；落盘时统一回 `hsr/`，否则同一游戏的图会被拆成两个目录。
 * 未登记的段按原样保留（交给后续人工判断，不静默改写）。
 */
const GAME_PATH_TO_ID = { gi: 'gi', hsr: 'hsr', sr: 'hsr', zzz: 'zzz' }

/** 各源的 CDN 根（用于把 pathname 归一成「游戏之后的相对路径」） */
const ASSET_BASES = [IMAGE_ASSET_BASE, ...Object.values(SOURCE_IMAGE_RULES).map((rule) => rule.assetBase)]

/** 扩展名映射（上游不总给对扩展名，以 content-type 为准） */
const EXT_BY_TYPE = {
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/gif': '.gif'
}

/**
 * URL → 落盘相对路径（相对 dataDir）
 *
 * 只认各源 `assetBase` 下的路径；其它域名按 URL 的 pathname 兜底。
 * 第一段如果是游戏路径段，先归一成 gameId（`sr` → `hsr`）。
 * 片段里的 `..` 一律剔除，避免把文件写到 dataDir 之外。
 * @param {string} url
 * @param {string} contentType
 * @returns {string} 如 `images/hsr/monsterfigure/Monster_1002011.webp`
 */
export function localPathForUrl (url, contentType = '') {
  let pathname = ''
  try {
    const parsed = new URL(url)
    pathname = decodeURIComponent(parsed.pathname)
    for (const base of ASSET_BASES) {
      if (!url.startsWith(base)) continue
      const marker = new URL(base).pathname.replace(/\/$/, '')
      if (marker && pathname.startsWith(marker)) pathname = pathname.slice(marker.length)
      break
    }
  } catch {
    pathname = url
  }
  const segments = String(pathname).split('/').filter((seg) => seg && seg !== '.' && seg !== '..')
  const fileName = segments.pop() || 'unknown'
  const ext = EXT_BY_TYPE[String(contentType).split(';')[0].trim().toLowerCase()] || '.webp'
  const dirs = segments.map((seg) => seg.replace(/[<>:"|?*\\]/g, '_'))
  // 游戏路径段归一：玉璃星铁是 `sr`，产物里统一写 `hsr`
  if (dirs.length && GAME_PATH_TO_ID[dirs[0].toLowerCase()]) {
    dirs[0] = GAME_PATH_TO_ID[dirs[0].toLowerCase()]
  }
  // 产物里的路径一律 posix 风格（数据可能在别的平台消费，不能写 Windows 反斜杠）
  return ['images', ...dirs, fileName.replace(/\.(png|webp|jpg|jpeg|avif)$/i, '') + ext].join('/')
}

/**
 * URL → 资源键（去掉扩展名、游戏路径段归一）
 *
 * 同一个资源在不同源下的 URL 只有 CDN、游戏段（`sr`/`hsr`）与扩展名不同，
 * 归一后才能判断「这个资源是不是已经抓过（哪怕是另一种格式）」。
 * @param {string} url
 * @returns {string} 如 `hsr/monsterfigure/Monster_1002040`
 */
export function urlResourceKey (url) {
  return localPathForUrl(url, '')
    .replace(/^images\//, '')
    .replace(/\.(webp|png|jpg|jpeg|avif|gif)$/i, '')
}

/** 扩展名保留优先级（与 `--prune-images` 的规则一致） */
const EXT_PRIORITY = ['.webp', '.png', '.jpg', '.jpeg', '.avif', '.gif']

/**
 * 一次扫描 images/，同时产出「资源键索引」与「同资源多格式的重复组」
 *
 * 为什么要合并：`scanExistingImages`（抓图判活）和清理逻辑都需要递归 `stat` 每个文件，
 * 实测 18,560 个文件时分别要 154 ms / 642 ms —— 分两次扫就是白扫一遍。
 * 合并后抓图用的那次扫描顺带把重复组算出来，清理阶段零额外扫盘。
 * @param {string} dataDir
 * @returns {Promise<{index: Map<string, string>, duplicates: object[]}>}
 *   index: 资源键 → 相对 dataDir 的 posix 路径（同资源多份时取优先级最高的）
 *   duplicates: 同资源多格式的分组（至少 2 份），可直接交给清理逻辑
 */
export async function scanImages (dataDir) {
  const imagesDir = path.join(dataDir, 'images')
  /** 资源键 → [{ posix, rank, size }] */
  const groups = new Map()

  const walk = async (dir) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '_placeholder') continue
        await walk(full)
        continue
      }
      const ext = path.extname(entry.name).toLowerCase()
      const rank = EXT_PRIORITY.indexOf(ext)
      if (rank < 0) continue
      let size = 0
      try {
        size = (await fs.stat(full)).size
      } catch {
        continue
      }
      const posix = path.relative(imagesDir, full).split(path.sep).join('/')
      const key = posix.slice(0, -ext.length)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ posix, rank, size })
    }
  }

  await walk(imagesDir)

  const index = new Map()
  const duplicates = []
  for (const [key, group] of groups) {
    group.sort((a, b) => a.rank - b.rank)
    const keep = group[0]
    index.set(key, `images/${keep.posix}`)
    if (group.length < 2) continue
    // 首选文件为空 → 整组不动（宁可留重复也不删掉唯一可能有效的）
    if (!keep.size) continue
    const drop = group.slice(1).filter((item) => item.size > 0)
    if (!drop.length) continue
    duplicates.push({
      key,
      keep: keep.posix,
      keepLocalPath: `images/${keep.posix}`,
      drop: drop.map((item) => item.posix),
      dropLocalPaths: drop.map((item) => `images/${item.posix}`),
      savedBytes: drop.reduce((sum, item) => sum + item.size, 0)
    })
  }

  return { index, duplicates }
}

/**
 * 扫描 images/ 建立「资源键 → 已落盘文件」索引
 *
 * 用途：候选顺序变更后（nanoka webp 优先），旧数据里可能只抓过 png。只按 URL 判活会把这些
 * 资源当「没抓过」重下一遍（实测多下约 150 MB）；按资源键匹配就能直接复用已有文件，
 * 无论它是什么格式。
 *
 * 同一资源键有多份时按扩展名优先级取（webp > png > jpg …），与 `--prune-images` 的保留规则一致。
 * @param {string} dataDir
 * @returns {Promise<Map<string, string>>} 资源键 → 相对 dataDir 的 posix 路径
 */
export async function scanExistingImages (dataDir) {
  return (await scanImages(dataDir)).index
}

/** 列出全部候选 URL（去重） */
export function candidateUrls (refs) {
  const urls = new Set()
  for (const ref of refs) for (const url of ref.candidates || []) urls.add(url)
  return [...urls]
}

/**
 * 抓取一批图片引用
 * @param {object[]} refs - `collectRecordImageRefs()` 的输出（同一条目可传多条）
 * @param {object} options
 * @param {string} options.dataDir
 * @param {object} [options.previous] - 上一轮 `images.json` 的 `byUrl`（URL → 结果）
 * @param {number} [options.concurrency]
 * @param {Function} [options.fetchImpl]
 * @param {boolean} [options.verify] - 复用前再比一次 ETag（默认只比体积）
 * @param {Function} [options.onProgress]
 * @returns {Promise<{byUrl: object, stats: object, refs: object[]}>}
 */
export async function harvestImages (refs, options = {}) {
  const {
    dataDir,
    previous = {},
    previousFailures = {},
    retryFailed = false,
    concurrency = 6,
    fetchImpl,
    verify = false,
    onProgress,
    /** 已落盘资源索引（`scanImages()` 的产物或单纯的 Map）；不传则内部扫一次 */
    existingScan
  } = options

  const allUrls = candidateUrls(refs)
  // 上一轮失败过的候选本轮默认不再探测（一个资源常有 2~6 个候选，输掉的候选每轮都试等于白跑上万请求）
  const urls = retryFailed ? allUrls : allUrls.filter((url) => !previousFailures[url])
  const byUrl = {}
  const failures = {}
  let downloaded = 0
  let reused = 0
  let failed = 0
  let skipped = 0

  // 沿用上一轮的失败记录（本轮没再探测的那些）
  if (!retryFailed) for (const [url, info] of Object.entries(previousFailures)) failures[url] = info

  // 资源键索引：用于「同一资源换了个格式/源」时复用旧文件，避免升级后重下一遍。
  // 接受 scanImages() 的完整结果（顺带拿 duplicates 已算好）或单纯的 Map（兼容旧调用）。
  const resourceIndex = existingScan instanceof Map
    ? existingScan
    : (existingScan?.index instanceof Map ? existingScan.index : (await scanImages(dataDir)).index)

  await runPool(urls, concurrency, async (url) => {
    const prev = previous[url]
    if (prev?.localPath && !prev.placeholder) {
      const abs = path.join(dataDir, prev.localPath)
      try {
        const stat = await fs.stat(abs)
        // bytes 缺失或为 0 都按「未知」处理，只要求文件仍在
        if (!prev.bytes || stat.size === prev.bytes) {
          if (!verify || await etagUnchanged(abs, prev, fetchImpl)) {
            byUrl[url] = prev
            reused += 1
            skipped += 1
            return
          }
        }
      } catch {
        // 文件没了 → 重新下载
      }
    }

    // 按资源键复用：候选顺序变了（nanoka webp 优先）但旧数据只抓过 png 时，
    // URL 匹配不上，却已经有同一资源的文件——直接用它，不再重下
    const existingPath = resourceIndex.get(urlResourceKey(url))
    if (existingPath) {
      try {
        const stat = await fs.stat(path.join(dataDir, existingPath))
        if (stat.size > 0) {
          byUrl[url] = {
            url,
            localPath: existingPath,
            status: 'downloaded',
            contentType: '',
            bytes: stat.size,
            etag: '',
            lastModified: '',
            reuseByResource: true
          }
          reused += 1
          skipped += 1
          return
        }
      } catch {
        // 索引里的文件没了 → 照常下载
      }
    }

    const res = await (fetchImpl ? fetchImpl(url) : fetchBuffer(url))
    if (!res?.ok || !res.buffer?.length) {
      byUrl[url] = { url, status: 'failed', error: res?.error || 'empty response' }
      failures[url] = { status: 'failed', error: res?.error || 'empty response', at: new Date().toISOString() }
      failed += 1
      return
    }

    const localPath = localPathForUrl(url, res.contentType)
    await writeFileAtomic(path.join(dataDir, localPath), res.buffer)
    delete failures[url]
    byUrl[url] = {
      url,
      localPath,
      status: 'downloaded',
      contentType: res.contentType || '',
      bytes: res.buffer.length,
      sha256: createHash('sha256').update(res.buffer).digest('hex'),
      etag: res.etag || '',
      lastModified: res.lastModified || ''
    }
    downloaded += 1
    if (onProgress && (downloaded + failed) % 200 === 0) {
      onProgress({ done: downloaded + failed, total: urls.length, downloaded, reused, failed })
    }
  })

  await ensurePlaceholder(dataDir)

  // 引用 → 命中结果：按候选顺序取第一个成功项，全失败落占位
  const resolved = refs.map((ref) => {
    for (const url of ref.candidates || []) {
      const hit = byUrl[url]
      if (hit?.localPath && hit.status === 'downloaded') {
        return {
          ...ref,
          remoteUrl: url,
          localPath: hit.localPath,
          status: 'downloaded',
          placeholder: false,
          // 体积/ETag 随引用一起回传，产物据此做下一轮复用判据
          bytes: hit.bytes || 0,
          etag: hit.etag || ''
        }
      }
    }
    return { ...ref, remoteUrl: '', localPath: PLACEHOLDER_PATH, status: 'placeholder', placeholder: true }
  })

  const stats = {
    refs: refs.length,
    urls: allUrls.length,
    // 真正发出请求的 URL 数（复用的不算）
    probed: downloaded + failed,
    downloaded,
    reused,
    failed,
    placeholder: resolved.filter((ref) => ref.placeholder).length
  }
  log.info(`图片：${stats.refs} 条引用 / ${stats.urls} 个 URL（本轮请求 ${stats.probed}），下载 ${downloaded}、复用 ${reused}、失败 ${failed}、占位 ${stats.placeholder}`)
  return { byUrl, failures, stats, refs: resolved }
}

/** 写占位图（幂等） */
export async function ensurePlaceholder (dataDir) {
  const file = path.join(dataDir, PLACEHOLDER_PATH)
  try {
    await fs.access(file)
  } catch {
    await writeFileAtomic(file, PLACEHOLDER_SVG)
  }
}

/** 复用前校验 ETag（仅 `verify` 模式；失败即视为需要重下） */
async function etagUnchanged (absPath, prev, fetchImpl) {
  if (!prev.etag || !fetchImpl) return true
  try {
    const res = await fetchImpl(prev.url, { method: 'HEAD' })
    if (!res?.ok) return false
    return res.etag ? res.etag === prev.etag : true
  } catch {
    return true
  }
}
