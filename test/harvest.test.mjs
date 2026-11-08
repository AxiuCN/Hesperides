// 抓取流程回归：注入假 fetch，验证增量/跳过/缺席/单文件/静态/文本与 manifest 续跑
import fs from 'node:fs'
import path from 'node:path'
import { mod, checker, freshDir } from './_helper.mjs'

const { harvestChannel, harvestChannels } = await import(mod('src/sources/alioth/harvest.mjs'))
const { ALIOTH_BY_ID } = await import(mod('src/sources/alioth/channels.mjs'))
const { CHANNEL_STATUS } = await import(mod('src/schema/index.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))

const { check, finish } = checker()
const dataDir = freshDir('harvest')

/** 造一个按 URL 响应的假 fetch */
function makeFetch (routes) {
  return async (url) => {
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) return handler(url)
    }
    return { ok: false, status: 404, text: '' }
  }
}

const ABYSS_INDEX = JSON.stringify({
  Phases: [
    { _id: 59, Ver: '7.2', Time: '2026/11/16 - 2026/12/16' },
    { _id: 60, Ver: '7.3', Time: '2026/12/16 - 2027/01/16' }
  ]
})

console.log('\n=== phased：首轮全抓 ===')
let abyssCalls = []
const abyssFetch = makeFetch([
  ['/abyss.json', () => ({ ok: true, status: 200, text: ABYSS_INDEX, lastModified: 'Mon, 02 Nov 2026 04:00:00 GMT' })],
  ['/abyss/59.json', () => { abyssCalls.push(59); return { ok: true, status: 200, text: '{"_id":59,"Floors":[]}' } }],
  ['/abyss/60.json', () => { abyssCalls.push(60); return { ok: true, status: 200, text: '{"_id":60,"Floors":[]}' } }]
])
const first = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:abyss'), {
  dataDir, previous: null, fetchImpl: abyssFetch, delay: false
})
check('首轮抓全部期', first.status === CHANNEL_STATUS.OK && first.fetched === 2, `${first.status} fetched=${first.fetched}`)
check('记录落盘', fs.existsSync(path.join(dataDir, 'records/gi/abyss/59.json')))
check('期数正确', first.periods === 2)
check('期字段带版本与起止', first.phases[1].version === '7.3' && first.phases[1].begin === '2026-12-16')

console.log('\n=== phased：增量只补变动的期 ===')
abyssCalls = []
const second = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:abyss'), {
  dataDir,
  previous: { indexHash: first.indexHash, lastModified: first.lastModified, phaseVersions: first.phaseVersions, records: 2 },
  fetchImpl: abyssFetch,
  delay: false
})
check('索引未变时 304/同 hash 整频道跳过', second.status === CHANNEL_STATUS.SKIPPED && abyssCalls.length === 0, `${second.status} calls=${abyssCalls.length}`)

console.log('\n=== phased：版本变化只抓变化期 ===')
abyssCalls = []
const changedIndex = JSON.stringify({
  Phases: [
    { _id: 59, Ver: '7.2', Time: '2026/11/16 - 2026/12/16' },
    { _id: 60, Ver: '7.4', Time: '2026/12/16 - 2027/01/16' }
  ]
})
const changedFetch = makeFetch([
  ['/abyss.json', () => ({ ok: true, status: 200, text: changedIndex })],
  ['/abyss/59.json', () => { abyssCalls.push(59); return { ok: true, status: 200, text: '{"_id":59}' } }],
  ['/abyss/60.json', () => { abyssCalls.push(60); return { ok: true, status: 200, text: '{"_id":60}' } }]
])
const third = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:abyss'), {
  dataDir,
  previous: { indexHash: first.indexHash, phaseVersions: first.phaseVersions, records: 2 },
  fetchImpl: changedFetch,
  delay: false
})
check('只抓版本变化的期', abyssCalls.join(',') === '60' && third.fetched === 1, `calls=${abyssCalls.join(',')}`)
check('跳过数正确', third.skipped === 1)

console.log('\n=== 404 视为缺席 ===')
const absent = await harvestChannel(ALIOTH_BY_ID.get('alioth:hsr:hsrboss'), {
  dataDir, previous: null, fetchImpl: makeFetch([]), delay: false
})
check('上游没有该文件 → absent 而非 failed', absent.status === CHANNEL_STATUS.ABSENT, absent.status)

console.log('\n=== ids：索引取 ID 后批量抓 ===')
const monsterIndex = JSON.stringify({ Templates: { 101: {}, 102: {} } })
const monsterFetch = makeFetch([
  ['/monster.json', () => ({ ok: true, status: 200, text: monsterIndex })],
  ['/monster/101.json', () => ({ ok: true, status: 200, text: '{"_id":101}' })],
  ['/monster/102.json', () => ({ ok: true, status: 404, text: '' })]
])
const monster = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:monster'), {
  dataDir, previous: null, fetchImpl: monsterFetch, delay: false
})
check('部分条目失败不算频道失败', monster.status === CHANNEL_STATUS.OK && monster.failed === 1, `${monster.status} failed=${monster.failed}`)
check('成功条目已落盘', fs.existsSync(path.join(dataDir, 'records/gi/monster/101.json')))

console.log('\n=== single：索引即数据 ===')
const singleFetch = makeFetch([['/load.json', () => ({ ok: true, status: 200, text: '[{"N":"x"}]' })]])
const single = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:load'), {
  dataDir, previous: null, fetchImpl: singleFetch, delay: false
})
check('单文件频道落 __index.json', single.status === CHANNEL_STATUS.OK &&
  fs.existsSync(path.join(dataDir, 'records/gi/load/__index.json')))

console.log('\n=== static / text：按文件抓并记 hash ===')
const tpsFetch = makeFetch([
  ['/tps/mercenaries.json', () => ({ ok: true, status: 200, text: '{"a":1}' })],
  ['/tps/weapons.json', () => ({ ok: true, status: 200, text: '{"b":2}' })]
])
const tps = await harvestChannel(ALIOTH_BY_ID.get('alioth:gi:tps'), {
  dataDir, previous: null, fetchImpl: tpsFetch, delay: false
})
check('静态频道的文件都落盘', tps.records === 2 && fs.existsSync(path.join(dataDir, 'records/gi/tps/tps__weapons.json')))
check('记录文件 hash', !!tps.fileHashes['tps/weapons.json'])

console.log('\n=== manifest 续跑 + 导出 ===')
const runFetch = makeFetch([
  ['/abyss.json', () => ({ ok: true, status: 200, text: ABYSS_INDEX })],
  ['/abyss/59.json', () => ({ ok: true, status: 200, text: '{"_id":59}' })],
  ['/abyss/60.json', () => ({ ok: true, status: 200, text: '{"_id":60}' })]
])
const dir2 = freshDir('manifest')
await harvestChannels([ALIOTH_BY_ID.get('alioth:gi:abyss')], {
  dataDir: dir2, fetchImpl: runFetch, delay: false, concurrency: 2
})
const manifest = JSON.parse(fs.readFileSync(path.join(dir2, 'manifest.json'), 'utf8'))
check('每频道结束即落 manifest', !!manifest.channels['alioth:gi:abyss']?.indexHash)
const { index, periods } = await exportAll(dir2)
check('导出 index 含 games/channels/pages', !!index.games.gi.channels['alioth:gi:abyss'] && !!index.games.gi.pages.abyss)
check('导出 periods 含期条目', periods.games.gi.abyss.length === 2 && periods.games.gi.abyss[0].no === 1)
check('导出文件可读', fs.existsSync(path.join(dir2, 'index.json')) && fs.existsSync(path.join(dir2, 'periods.json')))

finish()
