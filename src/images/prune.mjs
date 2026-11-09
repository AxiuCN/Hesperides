/**
 * 孤儿图片清理：同一资源名落了多个扩展名时，只保留优先级最高的那份
 *
 * 背景：图片按 **URL** 去重，而同一个资源在两个源的格式不同（nanoka `.webp` / 玉璃 `.png`）。
 * 早期「记录所属源优先」的候选顺序会让两个源各落一份（实测某次全量多存 1,319 个 / 150 MB）。
 * 候选顺序改为「nanoka 优先」后新抓的不会再有重复，但**已经抓下来的旧文件需要清一次**。
 *
 * 成本：扫描本身在抓图阶段已经做过（`scanImages()` 同时算好重复组），这里直接复用，
 * 所以每次抓取顺带清理的额外开销只有「无重复时 0 ms」。
 *
 * 保留规则（同 `<目录>/<文件基名>`）：
 *   `.webp` > `.png` > `.jpg` > `.jpeg` > `.avif` > 其它
 * 删除前会确认保住的那份确实存在且非空；**默认只报告，加 `--yes` 才真删**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../core/io.mjs'
import { scanImages } from './store.mjs'
import { exportAll } from '../export/index.mjs'

/**
 * 找出可清理的多余文件
 *
 * 优先用传入的扫描结果（抓图阶段已经付过扫描成本），没给才自己扫一次。
 * @param {string} dataDir
 * @param {{duplicates: object[]}} [scanned] - `scanImages()` 的产物
 * @returns {Promise<object[]>}
 */
export async function findRedundantImages (dataDir, scanned = null) {
  const scan = scanned || await scanImages(dataDir)
  return scan.duplicates || []
}

/**
 * 执行（或预览）清理
 * @param {object} options
 * @param {string} options.dataDir
 * @param {boolean} [options.apply] - true 才真删
 * @param {boolean} [options.json]
 * @returns {Promise<{groups: number, files: number, savedBytes: number, applied: boolean}>}
 */
export async function pruneOrphanImages ({ dataDir, apply = false, json = false, scanned = null } = {}) {
  const imagesDir = path.join(dataDir, 'images')
  if (!fs.existsSync(imagesDir)) {
    if (json) console.log(JSON.stringify({ groups: 0, files: 0, savedBytes: 0, applied: false, error: 'images 目录不存在' }))
    else log.warn('images 目录不存在，无需清理')
    return { groups: 0, files: 0, savedBytes: 0, applied: false }
  }

  const plans = await findRedundantImages(dataDir, scanned)
  const files = plans.reduce((sum, plan) => sum + plan.drop.length, 0)
  const savedBytes = plans.reduce((sum, plan) => sum + (plan.savedBytes || 0), 0)

  // 没有重复 → 短路：不读 imagerefs、不写任何文件（首次清理之后的常态）
  if (!plans.length) {
    if (json) console.log(JSON.stringify({ groups: 0, files: 0, savedMB: 0, applied: false, fixedRefs: 0 }))
    else log.info('图片无同资源多格式重复，无需清理')
    return { groups: 0, files: 0, savedBytes: 0, applied: false, fixedRefs: 0 }
  }

  if (!apply) {
    if (json) {
      console.log(JSON.stringify({
        groups: plans.length,
        files,
        savedMB: Number((savedBytes / 1024 / 1024).toFixed(1)),
        applied: false,
        samples: plans.slice(0, 5).map((plan) => ({ keep: plan.keep, drop: plan.drop }))
      }, null, 2))
      return { groups: plans.length, files, savedBytes, applied: false }
    }
    log.info(`发现 ${plans.length} 组重复 / ${files} 个多余文件，可释放 ${(savedBytes / 1024 / 1024).toFixed(1)} MB`)
    for (const plan of plans.slice(0, 5)) {
      log.info(`  保留 ${plan.keep}  ← 删 ${plan.drop.join(', ')}`)
    }
    if (plans.length > 5) log.info(`  … 共 ${plans.length} 组`)
    log.info('这是预览。确认无误后加 --yes 真删')
    return { groups: plans.length, files, savedBytes, applied: false }
  }

  // 顺序很重要：先持久化引用、再刷新索引投影、**最后**才删旧图。
  // 任一步失败时旧图仍在，引用不会指向不存在的文件；index.json 的 entries.icon
  // 也要跟着刷新，否则图标仍指向被删的 png（插件读出来是空串）。
  const rewrites = new Map()
  for (const plan of plans) {
    const keepAbs = path.join(dataDir, ...plan.keepLocalPath.split('/'))
    const next = { localPath: plan.keepLocalPath, bytes: fs.statSync(keepAbs).size }
    for (const dropPath of plan.dropLocalPaths) rewrites.set(dropPath, next)
  }
  const fixedRefs = fixImageRefs(path.join(dataDir, 'imagerefs'), rewrites)
  await exportAll(dataDir)

  let removed = 0
  for (const plan of plans) {
    for (const rel of plan.drop) {
      try {
        fs.rmSync(path.join(imagesDir, ...rel.split('/')), { force: true })
        removed++
      } catch (err) {
        log.warn(`删除失败 ${rel}：${err.message}`)
      }
    }
  }
  if (json) {
    console.log(JSON.stringify({ groups: plans.length, files: removed, savedMB: Number((savedBytes / 1024 / 1024).toFixed(1)), applied: true }))
  } else {
    log.info(`已删除 ${removed} 个多余图片，释放 ${(savedBytes / 1024 / 1024).toFixed(1)} MB（保留 ${plans.length} 组里的首选格式）`)
    log.info(`已修正 ${fixedRefs} 条图片引用的 localPath`)
  }
  return { groups: plans.length, files: removed, savedBytes, applied: true, fixedRefs }
}

/**
 * 修正 imagerefs 里的路径与文件元数据
 *
 * 除了 `localPath`，还要同步 `bytes` 并清空 `etag`——文件换了，旧的体积/ETag 判据失效。
 * @param {string} refsDir - `<dataDir>/imagerefs`
 * @param {Map<string, {localPath: string, bytes: number}>} rewrites - 旧路径 → 保留文件的信息
 * @returns {number} 被改写的引用条数
 */
function fixImageRefs (refsDir, rewrites) {
  if (!rewrites.size) return 0
  let changed = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.json')) continue
      let data
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch {
        continue
      }
      let touched = false
      for (const refs of Object.values(data.records || {})) {
        const list = Array.isArray(refs) ? refs : (refs.refs || [])
        for (const ref of list) {
          const next = rewrites.get(ref.localPath)
          if (!next) continue
          ref.localPath = next.localPath
          ref.bytes = next.bytes
          ref.etag = ''
          touched = true
          changed++
        }
      }
      if (!touched) continue
      const tmp = `${full}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, full)
    }
  }
  walk(refsDir)
  return changed
}
