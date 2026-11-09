/**
 * 孤儿图片清理回归
 *
 * 覆盖：同资源多格式只留首选、单格式不动、占位图不参与、非空校验、
 * `--yes` 前后行为（预览不删）、imagerefs 的 localPath 跟着改写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRedundantImages, pruneOrphanImages } from '../src/images/prune.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = path.join(here, '.test-tmp', 'prune')
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}
const fresh = (name) => {
  const dir = path.join(tmpRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'images', 'hsr', 'monsterfigure'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'imagerefs', 'hsr', 'nanoka'), { recursive: true })
  return dir
}
const write = (file, bytes) => fs.writeFileSync(file, Buffer.alloc(bytes, 1))

console.log('=== ① 扫描：同资源多格式 ===')
{
  const dir = fresh('scan')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_1.webp'), 100)
  write(path.join(img, 'Monster_1.png'), 300)
  write(path.join(img, 'Monster_2.png'), 200)          // 只有 png（玉璃独有）→ 不动
  write(path.join(img, 'Monster_3.jpg'), 50)
  write(path.join(img, 'Monster_3.webp'), 60)
  fs.mkdirSync(path.join(dir, 'images', '_placeholder'), { recursive: true })
  write(path.join(dir, 'images', '_placeholder', 'unknown.svg'), 10)

  const plans = await findRedundantImages(dir)
  check('找出 2 组重复', plans.length === 2, String(plans.length))
  check('优先保留 webp（png 被删）',
    plans.some((p) => p.keep === 'hsr/monsterfigure/Monster_1.webp' && p.drop.includes('hsr/monsterfigure/Monster_1.png')))
  check('jpg/webp 组保留 webp',
    plans.some((p) => p.keep === 'hsr/monsterfigure/Monster_3.webp' && p.drop.includes('hsr/monsterfigure/Monster_3.jpg')))
  check('只有单一格式的（玉璃独有 png）不进计划', !plans.some((p) => p.keep.includes('Monster_2')))
  check('占位图目录不参与', !plans.some((p) => p.keep.includes('_placeholder')))
  check('计划带上 posix 的 localPath',
    plans.every((p) => p.keepLocalPath.startsWith('images/') && !p.keepLocalPath.includes('\\')))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== ② 预览不删 ===')
{
  const dir = fresh('preview')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_1.webp'), 100)
  write(path.join(img, 'Monster_1.png'), 300)

  const result = await pruneOrphanImages({ dataDir: dir, apply: false, json: true })
  check('预览报告 1 组', result.groups === 1)
  check('预览 applied=false', result.applied === false)
  check('预览不删文件', fs.existsSync(path.join(img, 'Monster_1.png')))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== ③ 执行：删多余 + 修引用 ===')
{
  const dir = fresh('apply')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_1.webp'), 100)
  write(path.join(img, 'Monster_1.png'), 300)
  write(path.join(img, 'Monster_2.png'), 200)

  const refsFile = path.join(dir, 'imagerefs', 'hsr', 'nanoka', 'chaos.json')
  fs.writeFileSync(refsFile, JSON.stringify({
    records: {
      1001: [
        { fieldPath: 'Monsters.1.Figure', localPath: 'images/hsr/monsterfigure/Monster_1.png', status: 'downloaded', placeholder: false },
        { fieldPath: 'Monsters.2.Figure', localPath: 'images/hsr/monsterfigure/Monster_2.png', status: 'downloaded', placeholder: false }
      ]
    }
  }))

  const result = await pruneOrphanImages({ dataDir: dir, apply: true, json: true })
  check('删了 1 个文件', result.files === 1, String(result.files))
  check('webp 保留', fs.existsSync(path.join(img, 'Monster_1.webp')))
  check('png 已删', !fs.existsSync(path.join(img, 'Monster_1.png')))
  check('玉璃独有的 png 未被动', fs.existsSync(path.join(img, 'Monster_2.png')))

  const after = JSON.parse(fs.readFileSync(refsFile, 'utf8'))
  check('被删文件的引用改指 webp',
    after.records['1001'][0].localPath === 'images/hsr/monsterfigure/Monster_1.webp',
    after.records['1001'][0].localPath)
  check('未涉及的引用不动',
    after.records['1001'][1].localPath === 'images/hsr/monsterfigure/Monster_2.png')
  check('报告修正条数', result.fixedRefs === 1, String(result.fixedRefs))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== ④ 边界 ===')
{
  // 没有重复时必须短路：不删文件、不改引用（首次清理后的常态，每次抓取都会走到这里）
  const dir = fresh('no-dup')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_5.png'), 200)   // 只有一份，不算重复
  const refsFile = path.join(dir, 'imagerefs', 'hsr', 'nanoka', 'chaos.json')
  fs.writeFileSync(refsFile, JSON.stringify({
    records: { 1: [{ fieldPath: 'x', localPath: 'images/hsr/monsterfigure/Monster_5.png', status: 'downloaded' }] }
  }))
  const before = fs.readFileSync(refsFile, 'utf8')
  const beforeMtime = fs.statSync(refsFile).mtimeMs

  const result = await pruneOrphanImages({ dataDir: dir, apply: true, json: true })
  check('无重复 → 0 组 0 文件', result.groups === 0 && result.files === 0)
  check('无重复 → 不删文件', fs.existsSync(path.join(img, 'Monster_5.png')))
  check('无重复 → fixedRefs 为 0', result.fixedRefs === 0, String(result.fixedRefs))
  check('无重复 → imagerefs 未被改写', fs.readFileSync(refsFile, 'utf8') === before && fs.statSync(refsFile).mtimeMs === beforeMtime)
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  // 复用外部扫描结果时不再扫盘（传一个带 duplicates 的假扫描结果即可验证）
  const dir = fresh('reuse-scan')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_6.webp'), 100)
  write(path.join(img, 'Monster_6.png'), 200)

  const { scanImages } = await import('../src/images/store.mjs')
  const scanned = await scanImages(dir)
  check('scanImages 同时给出索引与重复组',
    scanned.index instanceof Map && scanned.duplicates.length === 1)
  check('scanImages 的重复组带 posix 路径与可省体积',
    scanned.duplicates[0].keep === 'hsr/monsterfigure/Monster_6.webp'
    && scanned.duplicates[0].drop.includes('hsr/monsterfigure/Monster_6.png')
    && scanned.duplicates[0].savedBytes === 200)

  const result = await pruneOrphanImages({ dataDir: dir, apply: true, json: true, scanned })
  check('用外部扫描结果也能清理', result.files === 1 && !fs.existsSync(path.join(img, 'Monster_6.png')))
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  const dir = path.join(tmpRoot, 'no-images')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const result = await pruneOrphanImages({ dataDir: dir, apply: true, json: true })
  check('images 不存在时安全返回', result.groups === 0 && result.files === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  // 空文件不算有效保留（不能因为有个 0 字节 webp 就把好 png 删了）
  const dir = fresh('empty')
  const img = path.join(dir, 'images', 'hsr', 'monsterfigure')
  write(path.join(img, 'Monster_9.webp'), 0)
  write(path.join(img, 'Monster_9.png'), 300)
  const plans = await findRedundantImages(dir)
  check('首选文件为空时不动这一组', plans.length === 0, JSON.stringify(plans))
  fs.rmSync(dir, { recursive: true, force: true })
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)