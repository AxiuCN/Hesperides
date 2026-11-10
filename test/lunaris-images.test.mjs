import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mod, ensureTmp, checker } from './_helper.mjs'

const { SOURCE_IMAGE_RULES, buildImageCandidates, collectRecordImageRefs } = await import(mod('src/images/refs.mjs'))
const { localPathForUrl, urlResourceKey, harvestImages } = await import(mod('src/images/store.mjs'))
const { writePageImages, readPageImages, reuseTable } = await import(mod('src/images/index.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { check, finish } = checker()
const tmp = path.join(ensureTmp(), 'lunaris-images')
fs.mkdirSync(tmp, { recursive: true })
const base = 'https://api.lunaris.moe/data/assets'
const fresh = () => fs.mkdtempSync(path.join(tmp, 'case-'))
const candidates = (page, value, field = 'icon') => buildImageCandidates('gi', 'lunaris', page, value, '10000002', field)
const lunarisOnly = urls => urls.filter(url => url.startsWith(base + '/'))
async function run(name, test) {
  try { await test(); check(name, true) }
  catch (error) { check(name, false, error.message) }
}

await run('图片规则声明原神固定游戏且资源根不带游戏段', () => {
  assert.equal(SOURCE_IMAGE_RULES.lunaris.fixedGame, 'gi')
  assert.equal(SOURCE_IMAGE_RULES.lunaris.assetBase, base)
  assert.equal(SOURCE_IMAGE_RULES.lunaris.gamePath('hsr'), null)
})

const routes = [
  ['character', 'UI_Gacha_AvatarIcon_Ayaka', 'CardImg', 'avataricon/UI_AvatarIcon_Ayaka.webp'],
  ['character', 'UI_Gacha_AvatarImg_Ayaka', 'GachaImg', 'gachaimg/UI_Gacha_AvatarImg_Ayaka.png'],
  ['weapon', 'UI_EquipIcon_Sword_Blunt', 'weaponIcon', 'weaponicon/UI_EquipIcon_Sword_Blunt.webp'],
  ['artifact', 'UI_RelicIcon_10001_4', 'setIcon', 'artifacts/UI_RelicIcon_10001_4.webp'],
  ['material', 'UI_ItemIcon_100001', 'icon', 'items/UI_ItemIcon_100001.webp'],
  ['monster', 'UI_MonsterIcon_Slime_Grass_02', 'icon', 'monstericon/UI_MonsterIcon_Slime_Grass_02.png'],
  ['character', 'Skill_A_01', 'detail.skills.normalattack.icon', 'skills/Skill_A_01.webp'],
  ['character', 'UI_Talent_S_Ayaka_01', 'detail.constellations.const1.icon', 'skills/UI_Talent_S_Ayaka_01.webp'],
  ['character', 'UI_CoopImg_Ayaka', 'detail.icons.coop_img', 'coopimg/UI_CoopImg_Ayaka.webp'],
  ['tutorial', 'UI_MessageIcon_Combat', 'tipIcon', 'tutorial/UI_MessageIcon_Combat.png'],
  ['achievement', 'UI_AchievementIcon_O001', 'icon', 'achievementicon/UI_AchievementIcon_O001.webp'],
  ['event', 'UI_BtnIcon_OnmyoMaze_Bg', 'icon', 'events/UI_BtnIcon_OnmyoMaze_Bg.webp'],
  ['tower', 'UI_TowerBlessing_1', 'icon', 'tower/UI_TowerBlessing_1.png'],
  ['chapter', 'UI_ChapterIcon_Ayaka', 'chapterIcon', 'chaptericon/UI_ChapterIcon_Ayaka.png'],
]
for (const [page, value, field, expected] of routes) await run(`官方字段映射 ${field} ${expected.split('/')[0]}`, () => {
  assert.deepEqual(lunarisOnly(candidates(page, value, field)), [base + '/' + expected])
})

await run('原字段与详情图标被收集且描述视频保持普通内容', () => {
  const refs = collectRecordImageRefs({ gameId: 'gi', source: 'lunaris', pageKey: 'character', recordId: '10000002', record: {
    CardImg: 'UI_Gacha_AvatarIcon_Ayaka', GachaImg: 'UI_Gacha_AvatarImg_Ayaka',
    chsDescription: '神里绫华的头像资源为UI_AvatarIcon_Ayaka',
    detail: { icons: { forward: 'UI_AvatarIcon_Ayaka', coop_img: 'UI_CoopImg_Ayaka' }, skills: { normalattack: { icon: 'Skill_A_01', description: '普通攻击' } }, videoUrl: base + '/trace/Ayaka.mp4' },
  } })
  assert.deepEqual(refs.map(ref => ref.fieldPath), ['CardImg', 'GachaImg', 'detail.icons.forward', 'detail.icons.coop_img', 'detail.skills.normalattack.icon'])
  assert.ok(refs.every(ref => lunarisOnly(ref.candidates).length === 1))
})

const materialRoutes = [
  ['MATERIAL_PROFILE_PICTURE', 'UI_ItemIcon_320002', 'avataricon/UI_ItemIcon_320002.webp'],
  ['MATERIAL_PROFILE_PICTURE', 'UI_ItemIcon_320003', 'avataricon/UI_ItemIcon_320003.webp'],
  ['MATERIAL_AVATAR', 'UI_ItemIcon_1002', 'avatarcard/UI_ItemIcon_1002.webp'],
  ['MATERIAL_COSTUME', 'UI_AvatarIcon_AyakaCostumeFruhling_Card', 'avatarcard/UI_AvatarIcon_AyakaCostumeFruhling_Card.webp'],
  ['MATERIAL_NAMECARD', 'UI_NameCardPic_Xinyan', 'namecardicon/UI_NameCardPic_Xinyan.webp'],
  ['MATERIAL_COMMON', 'UI_GcgIcon_CardCurrency', 'items/UI_GcgIcon_CardCurrency.webp'],
  ['MATERIAL_COMMON', 'UI_RogueDiary_Icon_JuNeiDaiBi', 'items/UI_RogueDiary_Icon_JuNeiDaiBi.webp'],
  ['MATERIAL_GCG_CARD', 'UI_Gcg_CardFace_Char_Avatar_Ayaka', 'gcg/UI_Gcg_CardFace_Char_Avatar_Ayaka.webp'],
  ['MATERIAL_AVATAR_TRACE', 'UI_TraceEffectIcon_Ayaka', 'trace/UI_TraceEffectIcon_Ayaka.png'],
]
for (const [type, icon, expected] of materialRoutes) await run(`素材分类参与目录映射 ${type} ${icon}`, () => {
  const refs = collectRecordImageRefs({ gameId: 'gi', source: 'lunaris', pageKey: 'material', recordId: '1', record: { type, icon } })
  assert.deepEqual(lunarisOnly(refs[0].candidates), [base + '/' + expected])
})

await run('其它游戏没有Lunaris备用候选且绝对图片URL保持原值', () => {
  for (const game of ['hsr', 'zzz']) assert.deepEqual(lunarisOnly(buildImageCandidates(game, 'nanoka', 'character', 'UI_AvatarIcon_Ayaka', '1', 'icon')), [])
  const url = base + '/avataricon/UI_AvatarIcon_Ayaka.webp'
  assert.deepEqual(candidates('character', url), [url])
})

await run('落盘补齐原神段并以游戏目录隔离资源键', () => {
  const url = base + '/avataricon/UI_AvatarIcon_Ayaka.webp'
  assert.equal(localPathForUrl(url, 'image/webp'), 'images/gi/avataricon/UI_AvatarIcon_Ayaka.webp')
  assert.equal(urlResourceKey(url), urlResourceKey('https://static.nanoka.cc/assets/gi/avataricon/UI_AvatarIcon_Ayaka.webp'))
  assert.notEqual(urlResourceKey(url), urlResourceKey('https://static.nanoka.cc/assets/hsr/avataricon/UI_AvatarIcon_Ayaka.webp'))
  assert.notEqual(urlResourceKey(url), urlResourceKey(base + '/avatarcard/UI_AvatarIcon_Ayaka.webp'))
})

await run('原两源保持相对顺序且首命中停止后续请求', async () => {
  const urls = candidates('material', 'UI_ItemIcon_100001')
  const oldUrls = urls.filter(url => !url.startsWith(base + '/'))
  assert.deepEqual(oldUrls, ['https://static.nanoka.cc/assets/gi/UI_ItemIcon_100001.webp', 'https://img.alioth.wiki/gi/MonsterIcon/UI_ItemIcon_100001.png', 'https://img.alioth.wiki/gi/UI_ItemIcon_100001.png'])
  const calls = []
  const out = await harvestImages([{ recordId: '1', fieldPath: 'icon', candidates: urls }], { dataDir: fresh(), fetchImpl: async url => { calls.push(url); return { ok: true, buffer: Buffer.from('首候选图片'), contentType: 'image/webp' } } })
  assert.deepEqual(calls, [urls[0]])
  assert.equal(out.refs[0].placeholder, false)
})

await run('首源不可用时命中Lunaris并停止PNG探测', async () => {
  const urls = candidates('material', 'UI_ItemIcon_100001')
  const calls = []
  const out = await harvestImages([{ recordId: '1', fieldPath: 'icon', candidates: urls }], { dataDir: fresh(), fetchImpl: async url => {
    calls.push(url)
    return url.startsWith(base + '/') ? { ok: true, buffer: Buffer.from('Lunaris图片'), contentType: 'image/webp' } : { ok: false, status: 503, error: '合成503' }
  } })
  assert.deepEqual(calls, [urls[0], base + '/items/UI_ItemIcon_100001.webp'])
  assert.equal(out.refs[0].localPath, 'images/gi/items/UI_ItemIcon_100001.webp')
})

await run('Lunaris失败后可回落原PNG源', async () => {
  const urls = candidates('material', 'UI_ItemIcon_100001')
  const calls = []
  const out = await harvestImages([{ recordId: '1', fieldPath: 'icon', candidates: urls }], { dataDir: fresh(), fetchImpl: async url => {
    calls.push(url)
    return url.startsWith('https://img.alioth.wiki/') ? { ok: true, buffer: Buffer.from('PNG备用图'), contentType: 'image/png' } : { ok: false, status: 503, error: '合成503' }
  } })
  assert.deepEqual(calls, urls.slice(0, 3))
  assert.equal(out.refs[0].placeholder, false)
  assert.equal(out.refs[0].remoteUrl, urls[2])
})

await run('角色目录与详情图落盘导出后主图仍选头像且下轮零HTTP复用', async () => {
  const dir = fresh()
  const key = { gameId: 'gi', source: 'lunaris', page: 'character' }
  const refs = collectRecordImageRefs({ ...key, pageKey: 'character', recordId: '10000002', record: { CardImg: 'UI_Gacha_AvatarIcon_Ayaka', GachaImg: 'UI_Gacha_AvatarImg_Ayaka', detail: { icons: { forward: 'UI_AvatarIcon_Ayaka' }, skills: { normalattack: { icon: 'Skill_A_01' } } } } })
  const out = await harvestImages(refs, { dataDir: dir, fetchImpl: async url => url.startsWith(base + '/') ? { ok: true, buffer: Buffer.from('合成落盘图'), contentType: url.endsWith('.png') ? 'image/png' : 'image/webp' } : { ok: false, status: 503, error: '合成503' } })
  await writePageImages(dir, key, { 10000002: out.refs })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ channels: { 'lunaris:gi:character': { game: 'gi', source: 'lunaris', page: 'character', kind: 'page', status: 'ok', ids: ['10000002'], records: 1, labels: { 10000002: { name: '神里绫华', rarity: 5 } } } } }))
  await exportAll(dir)
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  const icon = index.games.gi.sources.lunaris.pages.character.entries['10000002'].icon
  assert.equal(icon, 'images/gi/avataricon/UI_AvatarIcon_Ayaka.webp')
  assert.ok(fs.existsSync(path.join(dir, icon)))
  const saved = await readPageImages(dir, key)
  const again = await harvestImages(refs, { dataDir: dir, previous: reuseTable(saved), previousFailures: out.failures, fetchImpl: async () => { throw new Error('下一轮不应请求网络') } })
  assert.equal(again.stats.downloaded, 0)
  assert.equal(again.stats.placeholder, 0)
})
finish()
