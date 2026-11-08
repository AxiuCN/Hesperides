// 纯函数回归：期解析、期索引、ID 选择器、schema 校验
import { mod, checker } from './_helper.mjs'

const { parsePeriodRange, extractPhases, resolveIds, channelIndexUrl } = await import(mod('src/sources/alioth/harvest.mjs'))
const { toPeriodEntries, validateIndex, emptyIndex, emptyPeriods, SCHEMA_VERSION } =
  await import(mod('src/schema/index.mjs'))
const { contentHash } = await import(mod('src/core/io.mjs'))
const { ALIOTH_BY_ID, ALIOTH_CHANNELS, ALIOTH_ENDGAME_CHANNELS } = await import(mod('src/sources/alioth/channels.mjs'))

const { check, finish } = checker()

console.log('\n=== 期时间解析 ===')
const range = parsePeriodRange('2026/12/16 - 2027/01/16')
check('日精度区间', range.begin === '2026-12-16' && range.end === '2027-01-16', `${range.begin} → ${range.end}`)
const month = parsePeriodRange('2026/12', 'month')
check('月精度补齐首末日', month.begin === '2026-12-01' && month.end === '2026-12-31', `${month.begin} → ${month.end}`)
const feb = parsePeriodRange('2028/02', 'month')
check('闰年 2 月补到 29 日', feb.end === '2028-02-29', feb.end)
check('空串不抛错', parsePeriodRange('').begin === '' && parsePeriodRange(undefined).end === '')

console.log('\n=== 期索引提取 ===')
const abyssChannel = ALIOTH_BY_ID.get('alioth:gi:abyss')
const phases = extractPhases(abyssChannel, {
  Phases: [
    { _id: 60, Ver: '7.3', Time: '2026/12/16 - 2027/01/16' },
    { _id: 59, Ver: '7.2', Time: '2026/11/16 - 2026/12/16' }
  ]
})
check('按期升序（与索引内顺序无关）', phases[0].id === '59' && phases[1].id === '60', phases.map(p => p.id).join(','))
check('保留版本号原样（覆盖版本，不换算）', phases[1].version === '7.3')
const theaterPhases = extractPhases(ALIOTH_BY_ID.get('alioth:gi:theater'), { Phases: [{ _id: 30, Ver: '7.2-7.3', Time: '2026/12' }] })
check('剧诗按月补齐', theaterPhases[0].begin === '2026-12-01' && theaterPhases[0].end === '2026-12-31')

const entries = toPeriodEntries(phases, 'alioth')
check('期序号从 1 连续', entries.every((entry, index) => entry.no === index + 1))
check('期条目字段齐全', entries[0].begin === '2026-11-16' && entries[0].source === 'alioth' && entries[0].id === '59')

console.log('\n=== ID 选择器 ===')
// 多字段合并去重（用合成选择器验证）
const mergedIds = resolveIds({ ids: { type: 'arrayFields', fields: [['Avatar', 'ID'], ['Weapon', 'ID'], ['Weapon', 'ID']] } }, {
  Avatar: [{ ID: 10000002 }, { ID: 10000003 }],
  Weapon: [{ ID: 11522 }, { ID: 10000002 }]
})
check('arrayFields 多字段合并去重', mergedIds.length === 3 && mergedIds.includes('11522'), mergedIds.join(','))
// 真实频道：char 只取 Avatar（武器/圣遗物/枪械各自是独立频道）
const charIds = resolveIds(ALIOTH_BY_ID.get('alioth:gi:char'), {
  Avatar: [{ ID: 10000002 }, { ID: 10000003 }],
  Weapon: [{ ID: 11522 }],
  Relic: [{ ID: 15048 }],
  Gun: [{ ID: 10000134 }],
  Flycloak: [{ ID: 140001 }],
  WeaponSkin: [{ ID: 1 }]
})
check('gi:char 只取角色 ID', charIds.length === 2 && !charIds.includes('11522'), charIds.join(','))
const gunIds = resolveIds(ALIOTH_BY_ID.get('alioth:gi:char-gun'), { Gun: [{ ID: 10000134 }] })
check('char-gun 取枪械 ID', gunIds[0] === '10000134')
const weaponIds = resolveIds(ALIOTH_BY_ID.get('alioth:gi:weapon'), { Weapon: [{ ID: 11522 }] })
check('weapon 复用 char.json 的 Weapon 数组', weaponIds[0] === '11522')
const keysAt = resolveIds(ALIOTH_BY_ID.get('alioth:gi:monster'), { Templates: { 101: {}, 102: {} } })
check('keysAt 取字典键', keysAt.join(',') === '101,102')
const arrayAt = resolveIds(ALIOTH_BY_ID.get('alioth:hsr:monster'), { Templates: [{ _id: 8034010 }] })
check('arrayAt 取数组字段', arrayAt[0] === '8034010')
const nested = resolveIds(ALIOTH_BY_ID.get('alioth:hsr:relic'), { Relic: { 1: [{ ID: 134 }, { ID: 135 }], 2: [{ ID: 201 }] } })
check('arrayOfArrays 展开对象里的数组', nested.join(',') === '134,135,201', nested.join(','))
check('无 ids 选择器返回 null', resolveIds({ kind: 'single' }, {}) === null)

console.log('\n=== 频道表完整性 ===')
const ids = ALIOTH_CHANNELS.map((channel) => channel.id)
check('频道 id 唯一', new Set(ids).size === ids.length)
check('频道 id 形如 source:game:page', ALIOTH_CHANNELS.every((channel) => channel.id.split(':').length === 3))
check('终局频道都在表里', ALIOTH_ENDGAME_CHANNELS.every((id) => ALIOTH_BY_ID.has(id)), ALIOTH_ENDGAME_CHANNELS.length + ' 个')
check('phased 频道都配了 period 映射', ALIOTH_CHANNELS.filter(c => c.kind === 'phased').every(c => c.period?.id))
check('ids 频道都配了 item 模板', ALIOTH_CHANNELS.filter(c => c.kind === 'ids').every(c => c.item?.includes('{id}')))
check('索引 URL 按 scope 拼接', channelIndexUrl(ALIOTH_BY_ID.get('alioth:gi:banner')).includes('/data/gi/banner.json') &&
  channelIndexUrl(ALIOTH_BY_ID.get('alioth:gi:abyss')).includes('/data/gi/ch/abyss.json'))

console.log('\n=== schema ===')
const index = emptyIndex()
check('空索引含 schemaVersion', index.schemaVersion === SCHEMA_VERSION)
check('空产物可校验通过', validateIndex(index).ok)
check('版本不符被拒', validateIndex({ ...index, schemaVersion: 999 }).ok === false)
check('缺 games 被拒', validateIndex({ schemaVersion: SCHEMA_VERSION }).ok === false)
check('缺 channels 被拒', validateIndex({ schemaVersion: SCHEMA_VERSION, games: { gi: { pages: {} } } }).ok === false)
check('期索引空骨架合法', !!emptyPeriods().games)

console.log('\n=== 期规范化（版本排序 + 年份纠错） ===')
const { normalizePhases, shiftYear, compareVersion } = await import(mod('src/core/normalize.mjs'))
check('版本比较处理区间（4.6-4.7 < 4.7）', compareVersion('4.6-4.7', '4.7') < 0)
check('年份平移保持月日', shiftYear('2025-04-15', 1) === '2026-04-15')
check('闰日跨平年退到 28 日', shiftYear('2028-02-29', 1) === '2029-02-28')

const stygianLike = normalizePhases([
  { id: '7', version: '6.4', begin: '2026-03-04', end: '2025-04-07' },
  { id: '8', version: '6.5', begin: '2025-04-15', end: '2025-05-19' },
  { id: '9', version: '6.6', begin: '2025-05-27', end: '2025-06-30' },
  { id: '10', version: '6.7', begin: '2025-07-08', end: '2025-08-11' },
  { id: '11', version: '7.0', begin: '2026-08-19', end: '2026-09-22' }
])
check('按期版本排序', stygianLike.map(p => p.id).join(',') === '7,8,9,10,11', stygianLike.map(p => p.id).join(','))
check('错年 begin 被修正', stygianLike[1].begin === '2026-04-15' && stygianLike[2].begin === '2026-05-27' && stygianLike[3].begin === '2026-07-08',
  stygianLike.slice(1, 4).map(p => p.begin).join(','))
check('end 早于 begin 被修正', stygianLike[0].end === '2026-04-07', stygianLike[0].end)
check('修正过的期带标记与原文', stygianLike[1].timeCorrected === true && stygianLike[1].rawTime.begin === '2025-04-15')
check('未改动的期不带标记', !stygianLike[4].timeCorrected)
check('修正后时间单调不减', stygianLike.every((p, i) => i === 0 || p.begin >= stygianLike[i - 1].begin))

console.log('\n=== 内容指纹 ===')
check('相同内容同指纹', contentHash('abc') === contentHash('abc'))
check('不同内容不同指纹', contentHash('abc') !== contentHash('abd'))

finish()
