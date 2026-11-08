// nanoka 源回归：页面 key/目录名、记录抽取、期提取、页面抓取与详情合并
import fs from 'node:fs'
import path from 'node:path'
import { mod, checker, freshDir } from './_helper.mjs'

const { pageKeyOf, pageDir, NANOKA_CHANNELS, NANOKA_BY_ID } = await import(mod('src/sources/nanoka/channels.mjs'))
const { recordEntries, extractNanokaPhases, harvestNanokaChannel, resetManifestCache } =
  await import(mod('src/sources/nanoka/harvest.mjs'))
const { CHANNEL_STATUS } = await import(mod('src/schema/index.mjs'))

const { check, finish } = checker()
const dataDir = freshDir('nanoka')

console.log('\n=== 页面 key 与目录 ===')
check('locale 前缀被剥离', pageKeyOf('{locale}/currency/role') === 'currency/role')
check('无 locale 的端点原样', pageKeyOf('maze_boss') === 'maze_boss')
check('目录名把斜杠换成 -', pageDir('currency/role') === 'currency-role')
check('频道 id 形如 nanoka:game:page', NANOKA_CHANNELS.every((channel) => channel.id.startsWith('nanoka:') && channel.id.split(':').length === 3))
check('绝区零频道齐全（含终局 boss/shiyu）',
  ['nanoka:zzz:boss', 'nanoka:zzz:shiyu', 'nanoka:zzz:character', 'nanoka:zzz:hollow-tpp'].every((id) => NANOKA_BY_ID.has(id)))
check('终局页配了详情模板', NANOKA_BY_ID.get('nanoka:zzz:boss').detail.includes('{id}'))
check('非详情页 detail 为 null', NANOKA_BY_ID.get('nanoka:zzz:item').detail === null)

console.log('\n=== 记录抽取 ===')
const dictEntries = recordEntries({ 69001: { zh: '试炼' }, 69002: { zh: '试炼' } })
check('dict 记录按 key 取 id', dictEntries.length === 2 && dictEntries[0][0] === '69001')
const arrayEntries = recordEntries([{ id: 1, zh: 'a' }, { _id: 2, zh: 'b' }])
check('数组记录取 id/_id', arrayEntries.map(([id]) => id).join(',') === '1,2')
check('空内容返回空数组', recordEntries(null).length === 0)

console.log('\n=== 期提取（zzz 终局页） ===')
const phases = extractNanokaPhases([
  ['69001', { live_begin: '2024-12-20 04:00:00', live_end: '2025-01-10 03:59:59', zh: '试炼' }],
  ['69002', { live_begin: '2025-01-10 04:00:00', live_end: '2025-01-31 03:59:59', zh: '试炼' }],
  ['69003', { zh: '没有时间' }]
])
check('只提取带时间的期', phases.length === 2)
check('期排序与期号', phases[0].begin === '2024-12-20' && phases[1].begin === '2025-01-10')
check('期名称取 zh', phases[0].name === '试炼')
check('无时间的记录被跳过', !phases.some((phase) => phase.id === '69003'))

console.log('\n=== 页面抓取（含详情合并） ===')
resetManifestCache()
const fetchImpl = async (url) => {
  if (url.endsWith('/manifest.json')) {
    return { ok: true, status: 200, text: JSON.stringify({ zzz: { latest: '3.4.3+test', live: '3.3' } }) }
  }
  if (url.includes('/boss.json')) {
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({
        69001: { zh: '试炼', live_begin: '2024-12-20 04:00:00', live_end: '2025-01-10 03:59:59' },
        69002: { zh: '试炼', live_begin: '2025-01-10 04:00:00', live_end: '2025-01-31 03:59:59' }
      })
    }
  }
  if (url.includes('/boss/69001.json')) return { ok: true, status: 200, text: JSON.stringify({ modes: [1, 2] }) }
  if (url.includes('/boss/69002.json')) return { ok: true, status: 200, text: JSON.stringify({ modes: [3] }) }
  return { ok: false, status: 404, text: '' }
}

const boss = await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:zzz:boss'), {
  dataDir, previous: null, fetchImpl, delay: false, withDetails: true
})
check('抓取状态与记录数', boss.status === CHANNEL_STATUS.OK && boss.records === 2, `${boss.status} records=${boss.records}`)
check('版本写进结果', boss.version === '3.4.3+test')
check('期数正确', boss.periods === 2)
const detailProbe = await import('node:fs')
const record = JSON.parse(detailProbe.readFileSync(`${dataDir}/records/zzz/nanoka/boss/69001.json`, 'utf8'))
check('记录里带 detail 字段', Array.isArray(record.detail?.modes) && record.detail.modes.length === 2)

console.log('\n=== 不抓详情时不发详情请求 ===')
resetManifestCache()
let detailCalls = 0
const noDetailFetch = async (url) => {
  if (url.includes('/boss/')) detailCalls++
  if (url.endsWith('/manifest.json')) return { ok: true, status: 200, text: JSON.stringify({ zzz: { latest: '3.4.3+test' } }) }
  if (url.includes('/boss.json')) return { ok: true, status: 200, text: JSON.stringify({ 69001: { zh: 'x', live_begin: '2024-12-20 04:00:00', live_end: '2025-01-10 03:59:59' } }) }
  return { ok: false, status: 404, text: '' }
}
await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:zzz:boss'), { dataDir: freshDir('nanoka2'), previous: null, fetchImpl: noDetailFetch, delay: false })
check('withDetails 默认关', detailCalls === 0, `detailCalls=${detailCalls}`)

console.log('\n=== 版本未变则跳过 ===')
resetManifestCache()
const skipped = await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:zzz:boss'), {
  dataDir,
  previous: { indexHash: boss.indexHash, version: boss.version, records: 2 },
  fetchImpl,
  delay: false
})
check('同 hash 同版本 → skipped', skipped.status === CHANNEL_STATUS.SKIPPED, skipped.status)

console.log('\n=== 上游回 304 时按「未变」跳过（不能算失败）===')
resetManifestCache()
let conditional = ''
const notModifiedFetch = async (url, opts = {}) => {
  if (url.endsWith('/manifest.json')) {
    return { ok: true, status: 200, text: JSON.stringify({ zzz: { latest: '3.4.3+test' } }) }
  }
  conditional = opts.headers?.['if-modified-since'] || ''
  return { ok: false, status: 304, text: '' }
}
const notModified = await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:zzz:boss'), {
  dataDir,
  mode: 'incremental',
  previous: { indexHash: boss.indexHash, version: boss.version, records: 2, lastModified: 'Mon, 02 Nov 2026 04:12:35 GMT' },
  fetchImpl: notModifiedFetch,
  delay: false
})
check('304 → skipped 而不是 failed', notModified.status === CHANNEL_STATUS.SKIPPED, notModified.status)
check('304 判定依赖条件请求头', conditional === 'Mon, 02 Nov 2026 04:12:35 GMT', conditional || '(空)')
check('304 时沿用上一轮记录数', notModified.skipped === 2)

console.log('\n=== 单文件频道（diff）整份落盘 ===')
resetManifestCache()
{
  const dir = freshDir('nanoka-diff')
  const diffFetch = async (url) => {
    if (url.endsWith('/manifest.json')) return { ok: true, status: 200, text: JSON.stringify({ gi: { latest: '7.2.50' } }) }
    if (url.includes('/diff/zh.json')) {
      return { ok: true, status: 200, text: JSON.stringify({ fromVersion: '7.2', toVersion: '7.2.50', counts: { total: 2 }, items: [] }) }
    }
    return { ok: false, status: 404, text: '' }
  }
  const diffChannel = NANOKA_BY_ID.get('nanoka:gi:diff')
  const single = await harvestNanokaChannel(diffChannel, { dataDir: dir, previous: null, fetchImpl: diffFetch, delay: false })
  check('diff 频道是 single', diffChannel.kind === 'single')
  check('single 频道记录数记 1', single.records === 1 && single.ids.length === 0)
  const file = path.join(dir, 'records', 'gi', 'nanoka', 'diff', '__index.json')
  check('整份 diff 落 __index.json', fs.existsSync(file))
  check('落盘内容与上游一致', (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw.fromVersion === '7.2' && raw.toVersion === '7.2.50'
    } catch {
      return false
    }
  })())
}

console.log('\n=== 根 manifest 快照落盘（#版本新增内容的数据源）===')
resetManifestCache()
{
  const dir = freshDir('nanoka-manifest')
  const snapFetch = async (url) => {
    if (url.endsWith('/manifest.json')) {
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          gi: { latest: '7.2.50', live: '7.2', new: { character: [10000147], weapon: [12438] } },
          hsr: { latest: '4.6.54', live: '4.6', new: { character: [1511] } }
        })
      }
    }
    if (url.includes('/character.json')) {
      return { ok: true, status: 200, text: JSON.stringify({ 10000147: { zh: '新角色' } }) }
    }
    return { ok: true, status: 200, text: JSON.stringify({}) }
  }
  await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:gi:character'), { dataDir: dir, previous: null, fetchImpl: snapFetch, delay: false })
  // 快照走 upstream/ 命名空间（输入素材，与产物分开）
  const snapPath = path.join(dir, 'upstream', 'nanoka.json')
  check('快照落在 upstream/nanoka.json', fs.existsSync(snapPath))
  check('旧的扁平路径不再生成', !fs.existsSync(path.join(dir, 'nanoka-manifest.json')))
  const snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  check('快照带 schemaVersion', snapshot.schemaVersion === 2)
  check('快照保留 latest/live/new', snapshot.games?.gi?.latest === '7.2.50' && snapshot.games?.gi?.live === '7.2'
    && snapshot.games?.gi?.new?.character?.[0] === 10000147)
  check('快照覆盖多游戏', snapshot.games?.hsr?.new?.character?.[0] === 1511)

  // 内容没变时不应重写（mtime 保持）
  const before = fs.statSync(snapPath).mtimeMs
  resetManifestCache()
  await harvestNanokaChannel(NANOKA_BY_ID.get('nanoka:gi:character'), { dataDir: dir, previous: null, fetchImpl: snapFetch, delay: false })
  check('内容未变不重写快照', fs.statSync(snapPath).mtimeMs === before)
}

finish()
