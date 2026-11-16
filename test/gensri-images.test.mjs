import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mod, checker, freshDir, testDir } from './_helper.mjs'

const { SOURCE_IMAGE_RULES, buildImageCandidates, collectRecordImageRefs } = await import(mod('src/images/refs.mjs'))
const { localPathForUrl, urlResourceKey, harvestImages } = await import(mod('src/images/store.mjs'))
const { harvestChannelImages } = await import(mod('src/images/harvest.mjs'))
const { readPageImages, reuseTable } = await import(mod('src/images/index.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { check, finish } = checker()
const fixtures = path.join(testDir, 'fixtures/gensri')
const fixture = name => JSON.parse(fs.readFileSync(path.join(fixtures, name + '.json'), 'utf8'))
const db = 'https://db.gensri.wiki'
const site = 'https://www.gensri.wiki'
const images = new Map([
  [db + '/png/Characters/db/10000002.webp', 'character-10000002.webp'],
  [db + '/png/Characters/db/10000046.webp', 'character-10000046.webp'],
  [db + '/png/Weapons/db/12438.webp', 'weapon-12438.webp'],
  [db + '/png/Artifacts/15040.png', 'artifact-15040.png'],
  [site + fixture('season-st072').enemies[0].image, 'season-enemy.png']
])
const digest = value => createHash('sha256').update(value).digest('hex')
const candidates = (page, value, id, field) => buildImageCandidates('gi', 'gensri', page, value, id, field)
const provenance = fixture('provenance')
const fetched = []
const replayImages = async url => {
  fetched.push(url)
  const file = images.get(url)
  if (!file) return { ok: false, status: 404, error: '无捕获样本' }
  return { ok: true, status: 200, buffer: fs.readFileSync(path.join(fixtures, file)), contentType: file.endsWith('.png') ? 'image/png' : 'image/webp', etag: '"captured-' + file + '"' }
}
async function run (name, test) {
  try { await test(); check(name, true) }
  catch (error) { check(name, false, error.message) }
}

await run('两官方资源域统一原神游戏段', () => {
  assert.equal(SOURCE_IMAGE_RULES.gensri.fixedGame, 'gi')
  assert.deepEqual(SOURCE_IMAGE_RULES.gensri.assetBases, [site])
  assert.equal(localPathForUrl(db + '/png/Characters/db/10000002.webp', 'image/webp'), 'images/gi/png/Characters/db/10000002.webp')
  assert.equal(localPathForUrl(site + '/png/Enemies/Boss.png', 'image/png'), 'images/gi/png/Enemies/Boss.png')
  assert.notEqual(urlResourceKey(db + '/png/Characters/db/1.webp'), urlResourceKey(db + '/png/Weapons/db/1.webp'))
})

await run('只将角色目录主图覆盖成前端实际头像并保留自定义头像路径', () => {
  assert.deepEqual(candidates('character', 'https://old.hoyolab.com/avatar.png', '10000005_CRYO', 'image'), [db + '/png/Characters/db/10000005.webp'])
  assert.deepEqual(candidates('character', '/png/Characters/custom/10000002.png', '10000002', 'image'), [db + '/png/Characters/custom/10000002.png'])
  const skill = 'https://act-upload.mihoyo.com/skills/normal.png'
  assert.deepEqual(candidates('character', skill, '10000002', 'detail.skills.normal.icon'), [skill])
  assert.ok(candidates('character', 'Skill_A_01', '10000002', 'detail.skills.normal.icon').every(url => !url.includes('/png/Characters/')))
})

await run('武器目录与详情主图以及套装camelCase字段采用官网路径', () => {
  for (const field of ['image', 'detail.weaponIcon']) {
    assert.deepEqual(candidates('weapon', 'UI_EquipIcon_Claymore_X', '12438', field), [db + '/png/Weapons/db/12438.webp'])
  }
  for (const field of ['setIcon', 'detail.info.setIcon']) {
    assert.deepEqual(candidates('artifact', 'UI_RelicIcon_15040_4', '15040', field), [db + '/png/Artifacts/15040.png'])
  }
  const refs = collectRecordImageRefs({ gameId: 'gi', source: 'gensri', pageKey: 'artifact', recordId: '15040', record: { setIcon: 'UI_RelicIcon_15040_4', detail: { info: { setIcon: 'UI_RelicIcon_15040_4' } } } })
  assert.deepEqual(refs.map(ref => ref.fieldPath), ['setIcon', 'detail.info.setIcon'])
})

await run('985显式敌人路径使用www域，数据库图片仍使用db域', () => {
  const image = fixture('season-st072').enemies[0].image
  assert.deepEqual(candidates('stygian', image, 'st072', 'detail.enemies.0.image'), [site + image])
  assert.deepEqual(candidates('character', '/png/Skills/test.png', '10000002', 'detail.skills.0.icon'), [db + '/png/Skills/test.png'])
})

await run('原三源资源候选相对顺序保持', () => {
  assert.deepEqual(buildImageCandidates('gi', 'nanoka', 'material', 'UI_ItemIcon_100001', '1', 'icon'), [
    'https://static.nanoka.cc/assets/gi/UI_ItemIcon_100001.webp',
    'https://api.lunaris.moe/data/assets/items/UI_ItemIcon_100001.webp',
    'https://img.alioth.wiki/gi/MonsterIcon/UI_ItemIcon_100001.png',
    'https://img.alioth.wiki/gi/UI_ItemIcon_100001.png'
  ])
  assert.deepEqual(buildImageCandidates('hsr', 'alioth', 'character', 'https://example.org/avatar.png', '1', 'icon'), ['https://example.org/avatar.png'])
})

await run('五张公开真实图片字节与来源指纹一致', () => {
  for (const [url, name] of images) {
    const source = provenance.files.find(file => file.file === name)
    assert.equal(source?.url, url)
    assert.equal(digest(fs.readFileSync(path.join(fixtures, name))), source.sha256)
  }
})

const dir = freshDir('gensri-images-channel')
const channels = ['character', 'weapon', 'artifact', 'stygian'].map(page => ({ id: 'gensri:gi:' + page, game: 'gi', source: 'gensri', page, pageKey: page, kind: page === 'stygian' ? 'endgame' : 'page' }))
const records = {
  character: { 10000002: fixture('characters').find(row => row.file === '10000002'), 10000046: fixture('characters').find(row => row.file === '10000046') },
  weapon: { 12438: fixture('weapons').find(row => row.id === 12438) },
  artifact: { 15040: fixture('artifacts')['15040'] },
  stygian: { st072: { detail: { enemies: [fixture('season-st072').enemies[0]] } } }
}
const manifest = { channels: {} }
for (const channel of channels) {
  const recordDir = path.join(dir, 'records/gi/gensri', channel.page)
  fs.mkdirSync(recordDir, { recursive: true })
  for (const [id, record] of Object.entries(records[channel.page])) fs.writeFileSync(path.join(recordDir, id + '.json'), JSON.stringify(record))
  const ids = Object.keys(records[channel.page])
  manifest.channels[channel.id] = { ...channel, status: 'ok', ids, records: ids.length, labels: Object.fromEntries(ids.map(id => [id, { name: id, rarity: 5 }])) }
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))

await run('真实频道入口将两站五张真实图片落盘并按source保存引用', async () => {
  for (const channel of channels) {
    const out = await harvestChannelImages(channel, { dataDir: dir, fetchImpl: replayImages })
    assert.ok(out.stats.downloaded > 0)
    const page = await readPageImages(dir, { gameId: 'gi', source: 'gensri', page: channel.page })
    assert.deepEqual(Object.keys(page).sort(), Object.keys(records[channel.page]).sort())
    for (const refs of Object.values(page)) for (const ref of refs.filter(ref => !ref.placeholder)) {
      const name = images.get(ref.remoteUrl)
      assert.ok(name)
      assert.equal(digest(fs.readFileSync(path.join(dir, ref.localPath))), digest(fs.readFileSync(path.join(fixtures, name))))
    }
  }
  assert.ok([...images.keys()].every(url => fetched.includes(url)))
})

await run('导出entries的主图指向可用本地文件并保持四页隔离', async () => {
  const { index } = await exportAll(dir)
  for (const channel of channels) {
    const entries = index.games.gi.sources.gensri.pages[channel.page].entries
    for (const id of Object.keys(records[channel.page])) {
      assert.ok(entries[id].imageCount > 0)
      assert.ok(entries[id].icon.startsWith('images/gi/png/'))
      assert.ok(fs.existsSync(path.join(dir, entries[id].icon)))
    }
  }
})

await run('第二轮频道采图完全复用真实本地文件、零HTTP', async () => {
  const before = fetched.length
  for (const channel of channels) {
    const out = await harvestChannelImages(channel, { dataDir: dir, fetchImpl: replayImages })
    assert.equal(out.stats.downloaded, 0)
    assert.equal(out.stats.probed, 0)
    assert.ok(out.stats.reused > 0)
  }
  assert.equal(fetched.length, before)
})

await run('新图失败保留已下载旧文件并可显式重试恢复', async () => {
  const failureDir = freshDir('gensri-images-recovery')
  const url = db + '/png/Characters/db/10000002.webp'
  const refs = [{ recordId: '10000002', fieldPath: 'image', kind: 'field', originalValue: url, candidates: [url] }]
  const first = await harvestImages(refs, { dataDir: failureDir, fetchImpl: replayImages })
  const before = fs.readFileSync(path.join(failureDir, first.refs[0].localPath))
  const newUrl = db + '/png/Characters/db/new.webp'
  const changed = [{ ...refs[0], candidates: [newUrl] }]
  const unavailable = await harvestImages(changed, { dataDir: failureDir, previous: reuseTable({ 10000002: first.refs }), fetchImpl: async () => ({ ok: false, status: 503, error: '合成503' }) })
  assert.equal(unavailable.refs[0].placeholder, true)
  assert.deepEqual(fs.readFileSync(path.join(failureDir, first.refs[0].localPath)), before)
  const retried = []
  const restored = await harvestImages(changed, { dataDir: failureDir, previousFailures: unavailable.failures, retryFailed: true, fetchImpl: async target => { retried.push(target); return replayImages(url) } })
  assert.deepEqual(retried, [newUrl])
  assert.equal(restored.stats.downloaded, 1)
  assert.equal(restored.refs[0].placeholder, false)
  assert.deepEqual(fs.readFileSync(path.join(failureDir, restored.refs[0].localPath)), before)
})

finish()
