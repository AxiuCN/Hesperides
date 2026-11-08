/**
 * 图片采集：引用收集 → 候选 URL → 落盘与增量 → 产物与 entries 增强
 *
 * 全程离线：`fetchImpl` 注入假响应，临时产物写 `test/.test-tmp/`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildImageCandidates,
  collectRecordImageRefs,
  derivedImageRefs,
  looksLikeImageField,
  ZZZ_ICON_MAP
} from '../src/images/refs.mjs'
import { harvestImages, localPathForUrl, PLACEHOLDER_PATH } from '../src/images/store.mjs'
import {
  pickEntryImage,
  readImageFailures,
  readPageImages,
  reuseTable,
  writeImageFailures,
  writePageImages
} from '../src/images/index.mjs'
import { harvestChannelImages } from '../src/images/harvest.mjs'
import { readJson } from '../src/core/io.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = path.join(here, '.test-tmp')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`)
}

/** 全新临时目录 */
function freshDir (name) {
  const dir = path.join(tmpRoot, `images-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/* ============================================================
 *  ① 字段识别
 * ============================================================ */
console.log('=== ① 字段识别 ===')
check('键名是 icon', looksLikeImageField('icon', 'IconRole01') === true)
check('键名含 icon_', looksLikeImageField('item_icon_path', 'x') === true)
check('值带图片扩展名', looksLikeImageField('whatever', 'a/b.png') === true)
check('模板占位不算图片', looksLikeImageField('icon', '{0}.png') === false)
check('空值不算图片', looksLikeImageField('icon', '  ') === false)
check('type_icon 纯文本不算', looksLikeImageField('type_icon', '物理') === false)
check('type_icon 带路径算', looksLikeImageField('type_icon', 'A/B') === true)

/* ============================================================
 *  ② 候选 URL
 * ============================================================ */
console.log('=== ② 候选 URL ===')
check('已是指向图片的 HTTP 地址直接采用',
  JSON.stringify(buildImageCandidates('gi', 'character', 'https://x/img.png')) === '["https://x/img.png"]')
check('原神头像 → 抽卡立绘',
  buildImageCandidates('gi', 'character', 'UI_AvatarIcon_Ayaka', '10000002', 'icon').includes('https://static.nanoka.cc/assets/gi/UI_Gacha_AvatarImg_Ayaka.webp'))
check('原神名片图标 → 名片图',
  buildImageCandidates('gi', 'character', 'UI_NameCardIcon_Ayaka', '1', 'namecard.icon')
    .some((url) => url.endsWith('/gi/UI_NameCardPic_Ayaka_P.webp')))
check('星铁怪物图走 monsterfigure 目录',
  buildImageCandidates('hsr', 'monster', 'SpriteOutput/MonsterFigure/Monster_1002011.png', '1', 'icon')
    .includes('https://static.nanoka.cc/assets/hsr/monsterfigure/Monster_1002011.webp'))
check('星铁技能图标 id > 10000 时回退减 10000 口径',
  buildImageCandidates('hsr', 'character', 'SpriteOutput/SkillIcons/Avatar/SkillIcon_100201_1.png', '1', 'skill.icon')
    .includes('https://static.nanoka.cc/assets/hsr/skillicons/SkillIcon_90201_1.webp'))
check('绝区零 IconMap 令牌过映射表',
  buildImageCandidates('zzz', 'character', '<IconMap:Icon_SpecialReady>', '1', 'skill.icon')
    .every((url) => url.includes('IconRoleSkillKeySpecialV2')))
check('绝区零 IconMap 多候选', (ZZZ_ICON_MAP.Icon_Switch || []).length === 2)
check('绝区零潜力详情图补 AvatarSpecialAwakenBg_ 前缀',
  buildImageCandidates('zzz', 'character', 'Awaken_1', '1', 'potential_detail.1.image')
    .includes('https://static.nanoka.cc/assets/zzz/AvatarSpecialAwakenBg_Awaken_1.webp'))
check('未知游戏不猜 URL（不支持的源没有资源目录约定）', buildImageCandidates('nte', 'character', 'a/b.png', '1', 'icon').length === 0)

/* ============================================================
 *  ③ 引用收集
 * ============================================================ */
console.log('=== ③ 引用收集 ===')
const giRecord = {
  icon: 'UI_AvatarIcon_Ayaka',
  name: '神里绫华',
  skills: [{ name: '普通攻击', icon: 'Skill_A_01' }],
  empty: { icon: '' }
}
const giRefs = collectRecordImageRefs({ gameId: 'gi', pageKey: 'character', recordId: '10000002', record: giRecord })
check('收集到字段级引用', giRefs.length === 2, `实际 ${giRefs.length}`)
check('空值不产生引用', !giRefs.some((ref) => ref.originalValue === ''))
check('字段路径带数组下标', giRefs.some((ref) => ref.fieldPath === 'skills.0.icon'))
check('记录 id 统一为字符串', giRefs.every((ref) => ref.recordId === '10000002'))

const hsrRefs = collectRecordImageRefs({
  gameId: 'hsr',
  pageKey: 'character',
  recordId: '1308',
  record: { icon: 'SpriteOutput/AvatarIcon/1308.png', damageType: 'Ice', baseType: 'Knight' }
})
check('派生图（头像商店/抽卡/属性/命途）', derivedImageRefs('hsr', 'character', '1308', { damageType: 'Ice', baseType: 'Knight' }).length === 4)
check('派生图并入引用', hsrRefs.filter((ref) => ref.kind === 'derived').length === 4)
check('绝区零影画三层派生', derivedImageRefs('zzz', 'character', '1011', {}).map((ref) => ref.originalValue).join(',') === 'Mindscape_1011_1,Mindscape_1011_2,Mindscape_1011_3')

/* ============================================================
 *  ④ 落盘路径与下载
 * ============================================================ */
console.log('=== ④ 落盘路径与下载 ===')
check('路径镜像 CDN', localPathForUrl('https://static.nanoka.cc/assets/hsr/monsterfigure/Monster_1.png', 'image/webp')
  === 'images/hsr/monsterfigure/Monster_1.webp')
check('扩展名按 content-type', localPathForUrl('https://static.nanoka.cc/assets/gi/UI_A.png', 'image/png').endsWith('.png'))
check('剔除 .. 片段', !localPathForUrl('https://static.nanoka.cc/assets/../../etc/passwd', 'image/webp').includes('..'))

const REF_A = { recordId: '1', fieldPath: 'icon', kind: 'field', originalValue: 'A', candidates: ['https://cdn/a.webp', 'https://cdn/a2.webp'] }
const REF_B = { recordId: '1', fieldPath: 'image', kind: 'field', originalValue: 'B', candidates: ['https://cdn/b.webp'] }

{
  const dir = freshDir('download')
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('a.webp')) return { ok: false, status: 404, error: 'HTTP 404' }
    return { ok: true, status: 200, buffer: Buffer.from(`bytes:${url}`), contentType: 'image/webp', etag: `"${url}"` }
  }
  const { refs, stats, failures } = await harvestImages([REF_A, REF_B], { dataDir: dir, fetchImpl, previous: {} })
  check('候选逐个回退（首个 404 用第二个）', refs[0].remoteUrl === 'https://cdn/a2.webp' && refs[0].status === 'downloaded')
  check('文件真的落盘', fs.existsSync(path.join(dir, refs[0].localPath)))
  check('统计：下载 2 / 复用 0', stats.downloaded === 2 && stats.reused === 0)
  check('失败候选被记下（下一轮不再探测）', Boolean(failures['https://cdn/a.webp']))
  check('占位图已生成', fs.existsSync(path.join(dir, PLACEHOLDER_PATH)))
  check('每个 URL 只请求一次', calls.filter((url) => url === 'https://cdn/a2.webp').length === 1)

  // 第二轮：同引用应全部复用、失败候选不再探测，一个请求都不发
  await writePageImages(dir, { gameId: 'hsr', source: 'nanoka', page: 'character' }, { 1: refs })
  await writeImageFailures(dir, failures)
  const reloaded = await readPageImages(dir, { gameId: 'hsr', source: 'nanoka', page: 'character' })
  const prevFailures = await readImageFailures(dir)
  const prev = reuseTable(reloaded)
  const before = calls.length
  const second = await harvestImages([REF_A, REF_B], {
    dataDir: dir,
    fetchImpl,
    previous: prev,
    previousFailures: prevFailures
  })
  check('第二轮零下载、全部复用', second.stats.downloaded === 0 && second.stats.reused === 2)
  check('第二轮零探测（失败候选与已下载候选都跳过）', second.stats.probed === 0 && calls.length === before)
  check('失败记录跨轮保留', Boolean(second.failures['https://cdn/a.webp']))

  // 删掉本地文件 → 必须重下，不能只信产物
  fs.rmSync(path.join(dir, second.refs[0].localPath), { force: true })
  const third = await harvestImages([REF_A, REF_B], { dataDir: dir, fetchImpl, previous: prev })
  check('本地文件丢失时重新下载', third.stats.downloaded === 1)

  // --retry-failed：失败候选重新探测
  const retried = await harvestImages([REF_A], {
    dataDir: dir,
    fetchImpl,
    previous: prev,
    previousFailures: prevFailures,
    retryFailed: true
  })
  check('retryFailed 时重新探测失败候选', retried.stats.probed > 0)
}

{
  const dir = freshDir('placeholder')
  const fetchImpl = async () => ({ ok: false, status: 404, error: 'HTTP 404' })
  const { refs, stats } = await harvestImages([REF_A], { dataDir: dir, fetchImpl, previous: {} })
  check('候选全失败落占位', refs[0].placeholder === true && refs[0].localPath === PLACEHOLDER_PATH)
  check('占位计数', stats.placeholder === 1)
  check('占位图内容非空', fs.statSync(path.join(dir, PLACEHOLDER_PATH)).size > 100)
}

/* ============================================================
 *  ⑤ 产物与 entries 增强
 * ============================================================ */
console.log('=== ⑤ 页面引用文件与 entries 元数据 ===')
{
  const dir = freshDir('page')
  const key = { gameId: 'hsr', source: 'nanoka', page: 'character' }
  const refs = [
    { fieldPath: 'icon', kind: 'field', originalValue: 'A', remoteUrl: 'https://cdn/a.webp', localPath: 'images/hsr/character/a.webp', status: 'downloaded', placeholder: false },
    { fieldPath: 'derived.mindscape.1', kind: 'derived', originalValue: 'M', remoteUrl: '', localPath: PLACEHOLDER_PATH, status: 'placeholder', placeholder: true }
  ]
  await writePageImages(dir, key, { 1: refs })
  const reloaded = await readPageImages(dir, key)
  check('页面引用文件可读回', reloaded?.['1']?.length === 2)
  check('写入带 schemaVersion', (await readJson(path.join(dir, 'imagerefs/hsr/nanoka/character.json')))?.schemaVersion === 2)
  check('复用表只收成功项', Object.keys(reuseTable(reloaded)).join(',') === 'https://cdn/a.webp')

  const meta = pickEntryImage(reloaded['1'])
  check('imageCount 只数可用图', meta.imageCount === 1)
  check('icon 取非占位主图', meta.icon === 'images/hsr/character/a.webp')
  check('全占位时 imageCount 为 0 且无 icon', (() => {
    const only = pickEntryImage([refs[1]])
    return only.imageCount === 0 && !only.icon
  })())
}

{
  // 频道级：从已落盘记录收集 → 下载 → 写该页引用文件（v2 按源分目录）
  const dir = freshDir('channel')
  const recordDir = path.join(dir, 'records', 'zzz', 'nanoka', 'character')
  fs.mkdirSync(recordDir, { recursive: true })
  fs.writeFileSync(path.join(recordDir, '1011.json'), JSON.stringify({ icon: 'IconRole01', name: '安比' }))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ channels: { 'nanoka:zzz:character': { ids: ['1011'], game: 'zzz', page: 'character', source: 'nanoka' } } }))
  const fetchImpl = async (url) => ({ ok: true, status: 200, buffer: Buffer.from(url), contentType: 'image/webp', etag: `"${url}"` })
  const result = await harvestChannelImages({ id: 'nanoka:zzz:character', game: 'zzz', page: 'character', pageKey: 'character', source: 'nanoka' }, { dataDir: dir, fetchImpl })
  check('频道级：读到记录并抓图', result.refs > 0 && result.stats.downloaded > 0)
  const pages = await readPageImages(dir, { gameId: 'zzz', source: 'nanoka', page: 'character' })
  check('频道级：引用文件按源分目录', (pages?.['1011'] || []).length > 0)
  check('频道级：影画派生图也进了引用',
    (pages['1011'] || []).some((ref) => ref.fieldPath.startsWith('derived.mindscape')))
  check('频道级：失败候选表已生成', fs.existsSync(path.join(dir, 'image-failures.json')))
}

{
  // v2 关键点：两源同名页各写各的引用文件，互不覆盖
  const dir = freshDir('multi-source')
  await writePageImages(dir, { gameId: 'gi', source: 'alioth', page: 'weapon' }, { 1: [{ fieldPath: 'icon', localPath: 'images/gi/a.webp', remoteUrl: 'u1' }] })
  await writePageImages(dir, { gameId: 'gi', source: 'nanoka', page: 'weapon' }, { 1: [{ fieldPath: 'icon', localPath: 'images/gi/b.webp', remoteUrl: 'u2' }] })
  const alioth = await readPageImages(dir, { gameId: 'gi', source: 'alioth', page: 'weapon' })
  const nanoka = await readPageImages(dir, { gameId: 'gi', source: 'nanoka', page: 'weapon' })
  check('同名页按源隔离', alioth['1'][0].remoteUrl === 'u1' && nanoka['1'][0].remoteUrl === 'u2')
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
