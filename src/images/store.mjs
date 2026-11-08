/**
 * 图片落盘与增量
 *
 * 契约：
 *   - 一个远程 URL 只落一个文件，路径镜像 CDN：`<dataDir>/images/<game>/<目录>/<文件>.<ext>`
 *   - 增量判据 = URL 相同 + 本地文件仍在 + 体积一致（可选 `verify` 时再比 ETag）
 *   - 候选全部失败 → 落占位图 `images/_placeholder/unknown.svg`，**不删旧图**（沿用上一轮结果）
 *   - 所有写盘走原子写；下载并发受 `concurrency` 限制
 *
 * 本模块不决定「抓哪些记录」：引用由 `images/refs.mjs` 从记录里算出来，调用方传进来。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fetchBuffer, runPool, writeFileAtomic, log } from '../core/io.mjs'
import { IMAGE_ASSET_BASE } from './refs.mjs'

/** 占位图（上游所有候选都 404 时用；与旧后端同一份图形，纯 SVG 不占体积） */
export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Missing image"><rect width="256" height="256" rx="36" fill="#141827"/><path d="M62 176 98 132l29 35 22-27 45 56H62Z" fill="#2b3248"/><circle cx="183" cy="76" r="18" fill="#39435e"/><path d="M128 58c-24 0-42 14-45 36h30c2-8 8-13 16-13 9 0 15 5 15 13 0 7-4 12-15 20-17 12-24 23-23 41h28c0-10 4-16 17-25 16-11 25-23 25-39 0-20-19-33-48-33Z" fill="#b8c0d9"/><circle cx="120" cy="188" r="15" fill="#b8c0d9"/></svg>\n`

/** 占位图相对路径（相对 dataDir） */
export const PLACEHOLDER_PATH = 'images/_placeholder/unknown.svg'

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
 * 只认 `IMAGE_ASSET_BASE` 下的路径；其它域名按 URL 的 pathname 兜底。
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
    if (url.startsWith(IMAGE_ASSET_BASE)) pathname = pathname.replace(/^\/assets\//, '/')
  } catch {
    pathname = url
  }
  const segments = String(pathname).split('/').filter((seg) => seg && seg !== '.' && seg !== '..')
  const fileName = segments.pop() || 'unknown'
  const ext = EXT_BY_TYPE[String(contentType).split(';')[0].trim().toLowerCase()] || '.webp'
  const dirs = segments.map((seg) => seg.replace(/[<>:"|?*\\]/g, '_'))
  // 产物里的路径一律 posix 风格（数据可能在别的平台消费，不能写 Windows 反斜杠）
  return ['images', ...dirs, fileName.replace(/\.(png|webp|jpg|jpeg|avif)$/i, '') + ext].join('/')
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
    onProgress
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
