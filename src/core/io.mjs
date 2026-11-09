/**
 * Hesperides 采集内核：HTTP、限速、原子写、并发池、日志
 *
 * 设计约束（与旧后端 nanoka-atlas-backend 的差异）：
 *   ① 任何写盘都是「临时文件 + rename」，不会出现半截文件
 *   ② 失败不删旧数据，由调用方决定 stale 策略
 *   ③ 抓取什么、什么时候抓由调用方（Atlas-Plugin / CLI）决定，本模块不持有策略
 */
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 进程级日志（保持 stdout 可读，不引入依赖） */
export const log = {
  info: (...args) => console.log('[hesperides]', ...args),
  warn: (...args) => console.warn('[hesperides]', ...args),
  error: (...args) => console.error('[hesperides]', ...args)
}

/**
 * 带超时与重试的 GET（返回文本）
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - 单次请求超时
 * @param {number} [options.retries] - 重试次数（不含首次）
 * @param {number} [options.retryDelayMs] - 重试退避基数（线性增长）
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.userAgent]
 * @returns {Promise<{ok: boolean, status: number, text?: string, lastModified?: string, error?: string}>}
 */
export async function fetchText (url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 400,
    headers = {},
    userAgent = UA
  } = options

  let lastError = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': userAgent, accept: 'application/json, text/plain, */*', ...headers },
        signal: controller.signal
      })
      if (!res.ok) {
        // 与 fetchBuffer 同规则：403/404 不重试（没有就是没有），其余状态码（含 5xx、429）按退避重试
        if (res.status === 403 || res.status === 404) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
        lastError = `HTTP ${res.status}`
      } else {
        return {
          ok: true,
          status: res.status,
          text: await res.text(),
          lastModified: res.headers.get('last-modified') || undefined
        }
      }
    } catch (err) {
      lastError = err?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(err?.message || err)
    } finally {
      clearTimeout(timer)
    }
    if (attempt < retries) await sleep(retryDelayMs * (attempt + 1))
  }
  return { ok: false, status: 0, error: lastError }
}

/**
 * 本包版本号（读 package.json，避免 UA 与实际版本脱节）
 * @returns {string} 读不到时返回 '0'
 */
function packageVersion () {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return String(pkg.version || '0')
  } catch {
    return '0'
  }
}

/** 默认 UA（标明身份，便于上游识别与限流协商；版本号跟随 package.json） */
export const UA = `Hesperides/${packageVersion()} (+https://github.com/AxiuCN/Hesperides)`

/**
 * 带超时与重试的 GET（返回 Buffer，用于图片等二进制资源）
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @param {string} [options.userAgent]
 * @returns {Promise<{ok: boolean, status: number, buffer?: Buffer, contentType?: string, etag?: string, lastModified?: string, error?: string}>}
 */
export async function fetchBuffer (url, options = {}) {
  const {
    timeoutMs = 60000,
    retries = 3,
    retryDelayMs = 400,
    userAgent = UA
  } = options

  let lastError = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': userAgent, accept: 'image/avif,image/webp,image/*,*/*' },
        signal: controller.signal
      })
      if (!res.ok) {
        // 404 不重试：没有就是没有，重试只会拖慢全量
        if (res.status === 404 || res.status === 403) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
        lastError = `HTTP ${res.status}`
      } else {
        const buffer = Buffer.from(await res.arrayBuffer())
        return {
          ok: true,
          status: res.status,
          buffer,
          contentType: res.headers.get('content-type') || '',
          etag: res.headers.get('etag') || '',
          lastModified: res.headers.get('last-modified') || ''
        }
      }
    } catch (err) {
      lastError = err?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(err?.message || err)
    } finally {
      clearTimeout(timer)
    }
    if (attempt < retries) await sleep(retryDelayMs * (attempt + 1))
  }
  return { ok: false, status: 0, error: lastError }
}

/** 简易内容指纹（不依赖外部依赖，FNV-1a 32 位 + 长度，够做增量判据） */
export function contentHash (text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${text.length}`
}

/**
 * 并发池（保序返回）
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function runPool (items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(concurrency, items.length || 1))
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 原子写文件：同目录临时文件 + rename
 * @param {string} filePath
 * @param {string} text
 */
export async function writeFileAtomic (filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${randomUUID()}.tmp`
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, filePath)
}

/** 原子写 JSON（2 空格缩进，便于人工 diff） */
export async function writeJsonAtomic (filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 读 JSON，文件不存在或损坏时返回 fallback
 * @param {string} filePath
 * @param {*} [fallback]
 */
export async function readJson (filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

/** 解析 JSON 文本，失败返回 null */
export function parseJson (text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
