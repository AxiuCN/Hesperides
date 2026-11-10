import fs from 'node:fs'
import path from 'node:path'
import { mod, checker, freshDir, testDir } from './_helper.mjs'

const { LUNARIS_CHANNELS, LUNARIS_BY_ID, LUNARIS_ENDGAME_CHANNEL_IDS } = await import(mod('src/sources/lunaris/channels.mjs'))
const { harvestLunarisChannel, harvestLunarisChannels, lunarisLabel } = await import(mod('src/sources/lunaris/harvest.mjs'))
const { harvestSelected, CHANNEL_BY_ID } = await import(mod('src/sources/registry.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { check, finish } = checker()
const fixture = name => JSON.parse(fs.readFileSync(path.join(testDir, 'fixtures/lunaris', `${name}.json`), 'utf8'))
const catalogs = fixture('catalogs')
const details = fixture('details')
const versionInfo = fixture('version')
const banners = fixture('banners')
const leyline = fixture('leyline')
const json = value => ({ ok: true, status: 200, text: JSON.stringify(value), lastModified: 'Tue, 10 Nov 2026 00:00:00 GMT' })
const unavailable = { ok: false, status: 503, text: '' }
const absent = { ok: false, status: 404, text: '' }
const channel = page => LUNARIS_BY_ID.get(`lunaris:gi:${page}`)
const recordFile = (dir, page, id) => path.join(dir, 'records/gi/lunaris', page, `${id}.json`)
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const manifest = dir => read(path.join(dir, 'manifest.json'))
const characterId = Object.keys(catalogs['charlist.json'])[0]
const character = channel('character')

console.log('=== ① 已公开目录、详情与正常注册入口 ===')
check('14个频道不裁剪重叠页面', LUNARIS_CHANNELS.length === 14)
check('频道ID唯一', LUNARIS_BY_ID.size === 14)
check('所有频道都属于原神Lunaris', LUNARIS_CHANNELS.every(item => item.source === 'lunaris' && item.game === 'gi'))
check('正常注册表能找到全部频道', LUNARIS_CHANNELS.every(item => CHANNEL_BY_ID.get(item.id)?.source === 'lunaris'))
check('12个版本目录齐全', LUNARIS_CHANNELS.filter(item => item.kind === 'page').length === 12)
check('material目录映射item', channel('item').endpoint === 'materiallist.json')
check('chapter目录保持quest且未猜详情路径', channel('quest').endpoint === 'chapterlist.json' && !channel('quest').detail)
check('achievement目录按goals取详情', channel('achievement').detail === '{locale}/goals/{id}.json')
check('banner是官网单文件', channel('banner').kind === 'single' && channel('banner').scope === 'site')
check('leyline只列官网公布的13期', channel('leyline').ids.length === 13 && channel('leyline').ids[0] === '5269001' && channel('leyline').ids.at(-1) === '5269013')
check('终局频道包含三种玩法', LUNARIS_ENDGAME_CHANNEL_IDS.join(',') === 'lunaris:gi:tower,lunaris:gi:rolecombat,lunaris:gi:leyline')
check('橙SP稀有度取5', lunarisLabel(fixture('special-character')).rarity === 5)
check('五种qualityType映射完整', ['WHITE', 'GREEN', 'BLUE', 'PURPLE', 'ORANGE'].every((quality, index) => lunarisLabel({ qualityType: `QUALITY_${quality}` }).rarity === index + 1))

const dataDir = freshDir('lunaris-api')
fs.mkdirSync(path.join(dataDir, 'records/gi/nanoka/character'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'records/gi/nanoka/character/other.json'), '{"name":"其它源"}\n')
fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify({ channels: {
  'nanoka:gi:character': { source: 'nanoka', game: 'gi', page: 'character', kind: 'page', status: 'ok', records: 1, ids: ['other'], labels: { other: { name: '其它源', rarity: 4 } } }
} }))
let calls = []
let callbackCount = 0
const summaryFetch = async (url, options) => {
  calls.push({ url, headers: options?.headers || {} })
  if (url.endsWith('/version.json')) return json(versionInfo)
  const name = url.split('/').pop()
  return catalogs[name] ? json(catalogs[name]) : absent
}
const apiChannels = LUNARIS_CHANNELS.filter(item => item.kind === 'page')
const summaries = await harvestSelected(apiChannels, {
  dataDir, delay: false, fetchImpl: summaryFetch,
  onChannel (result) {
    callbackCount++
    check(`频道结束即保存台账 ${result.id}`, manifest(dataDir).channels[result.id]?.status === result.status)
  }
})
check('正常入口返回12目录结果', summaries.length === 12)
check('可用11目录成功且chapter缺席', summaries.filter(item => item.status === 'ok').length === 11 && summaries.find(item => item.id === 'lunaris:gi:quest').status === 'absent')
check('一轮多频道只取一次版本', calls.filter(item => item.url.endsWith('/version.json')).length === 1)
check('默认不抓详情', calls.length === 13)
check('所有API目录使用官方当前版本', calls.filter(item => !item.url.endsWith('/version.json')).every(item => item.url.startsWith('https://api.lunaris.moe/data/7.2.51/')))
check('每频道结束均回调', callbackCount === 12)
check('角色摘要原字段未修改', JSON.stringify(read(recordFile(dataDir, 'character', characterId))) === JSON.stringify(catalogs['charlist.json'][characterId]))
check('中文名字与星级写入labels', manifest(dataDir).channels[character.id].labels[characterId].name === '神里绫华' && manifest(dataDir).channels[character.id].labels[characterId].rarity === 5)
check('快照保存官方版本及版本列表', read(path.join(dataDir, 'upstream/lunaris.json')).version === '7.2.51' && read(path.join(dataDir, 'upstream/lunaris.json')).versions.includes('7.2.50'))
check('快照使用既有schema', read(path.join(dataDir, 'upstream/lunaris.json')).schemaVersion === 2)

console.log('\n=== ② 同目录补详情、304与内容指纹 ===')
calls = []
const detailFetch = async (url, options) => {
  calls.push({ url, headers: options?.headers || {} })
  if (url.endsWith('/version.json')) return json(versionInfo)
  if (url.endsWith('/charlist.json')) return json(catalogs['charlist.json'])
  if (url.endsWith(`/chs/char/${characterId}.json`)) return json(details.character)
  return absent
}
await harvestSelected([character], { dataDir, delay: false, withDetails: true, fetchImpl: detailFetch })
check('同目录由摘要升级为完整详情', JSON.stringify(read(recordFile(dataDir, 'character', characterId)).detail) === JSON.stringify(details.character))
check('升级详情不发旧目录条件请求', !calls.find(item => item.url.endsWith('/charlist.json')).headers['if-modified-since'])
check('详情默认使用chs', calls.some(item => item.url.endsWith(`/7.2.51/chs/char/${characterId}.json`)))
check('台账记录详情已完成', manifest(dataDir).channels[character.id].detailsComplete === true)
const recordBefore304 = fs.readFileSync(recordFile(dataDir, 'character', characterId), 'utf8')
calls = []
const notModified = await harvestSelected([character], {
  dataDir, delay: false, withDetails: true,
  fetchImpl: async (url, options) => {
    calls.push({ url, headers: options?.headers || {} })
    return url.endsWith('/version.json') ? json(versionInfo) : { ok: false, status: 304 }
  }
})
check('健康目录304正常跳过', notModified[0].status === 'skipped' && notModified[0].skipped === 1)
check('304发送LastModified条件且不再取详情', Boolean(calls[1].headers['if-modified-since']) && calls.length === 2)
check('304保留记录原字节', fs.readFileSync(recordFile(dataDir, 'character', characterId), 'utf8') === recordBefore304)
calls = []
const recordMtime = fs.statSync(recordFile(dataDir, 'character', characterId)).mtimeMs
const snapshotMtime = fs.statSync(path.join(dataDir, 'upstream/lunaris.json')).mtimeMs
const sameHash = await harvestSelected([character], { dataDir, delay: false, withDetails: true, fetchImpl: detailFetch })
check('健康目录同hash同版本跳过', sameHash[0].status === 'skipped' && calls.length === 2)
check('跳过不重写记录', fs.statSync(recordFile(dataDir, 'character', characterId)).mtimeMs === recordMtime)
check('未变版本快照不重写', fs.statSync(path.join(dataDir, 'upstream/lunaris.json')).mtimeMs === snapshotMtime)
calls = []
await harvestSelected([character], { dataDir, mode: 'full', delay: false, withDetails: true, fetchImpl: detailFetch })
check('full模式仍重新抓详情且不带目录条件头', calls.length === 3 && !calls[1].headers['if-modified-since'])

console.log('\n=== ②b 同版本目录新增条目后仍能升级详情 ===')
{
  const growthDir = freshDir('lunaris-catalog-growth')
  const additional = fixture('additional-character')
  let catalog = catalogs['charlist.json']
  let requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options?.headers || {} })
    if (url.endsWith('/version.json')) return json(versionInfo)
    if (url.endsWith('/charlist.json')) return json(catalog)
    return url.endsWith(`/${characterId}.json`) ? json(details.character) : json({ testMarker: '新增条目的详情' })
  }
  await harvestSelected([character], { dataDir: growthDir, withDetails: true, delay: false, fetchImpl })
  catalog = { ...catalog, [additional.id]: additional.record }
  await harvestSelected([character], { dataDir: growthDir, withDetails: false, delay: false, fetchImpl })
  check('摘要更新保留已存在条目的详情', Boolean(read(recordFile(growthDir, 'character', characterId)).detail))
  check('新条目尚无详情时不标记完整', !read(recordFile(growthDir, 'character', additional.id)).detail && manifest(growthDir).channels[character.id].detailsComplete === false)
  requests = []
  const upgraded = await harvestSelected([character], { dataDir: growthDir, withDetails: true, delay: false, fetchImpl })
  check('同版本同hash仍补齐新增条目的详情', upgraded[0].fetched === 2 && read(recordFile(growthDir, 'character', additional.id)).detail?.testMarker === '新增条目的详情')
  check('补齐新条目不发旧目录条件请求', !requests.find(item => item.url.endsWith('/charlist.json')).headers['if-modified-since'])
  check('全部当前条目有详情后标记完整', manifest(growthDir).channels[character.id].detailsComplete === true)
}
{
  const staleDir = freshDir('lunaris-summary-change')
  let catalog = catalogs['charlist.json']
  let generation = 1
  const fetchImpl = async url => {
    if (url.endsWith('/version.json')) return json(versionInfo)
    return url.endsWith('/charlist.json') ? json(catalog) : json({ generation })
  }
  await harvestSelected([character], { dataDir: staleDir, withDetails: true, delay: false, fetchImpl })
  catalog = { [characterId]: { ...catalog[characterId], chsName: '同版本更新摘要' } }
  generation = 2
  await harvestSelected([character], { dataDir: staleDir, withDetails: false, delay: false, fetchImpl })
  check('同版本目录变化保留旧详情供降级读取', read(recordFile(staleDir, 'character', characterId)).detail.generation === 1)
  check('旧详情不算新目录详情已完成', manifest(staleDir).channels[character.id].detailsComplete === false)
  await harvestSelected([character], { dataDir: staleDir, withDetails: true, delay: false, fetchImpl })
  check('再次开启详情刷新同版本变更后的内容', read(recordFile(staleDir, 'character', characterId)).detail.generation === 2)
}

console.log('\n=== ③ 版本变化、失败保旧与同目录恢复 ===')
const nextVersion = { ...versionInfo, version: '7.2.52' }
calls = []
await harvestSelected([character], {
  dataDir, delay: false, withDetails: true,
  fetchImpl: async (url, options) => {
    calls.push({ url, headers: options?.headers || {} })
    if (url.endsWith('/version.json')) return json(nextVersion)
    if (url.endsWith('/charlist.json')) return json(catalogs['charlist.json'])
    return json({ ...details.character, testMarker: '新版本详情' })
  }
})
check('新一轮重新读取官方版本', manifest(dataDir).channels[character.id].version === '7.2.52')
check('目录body相同但版本变化仍抓详情', read(recordFile(dataDir, 'character', characterId)).detail.testMarker === '新版本详情')
check('版本切换不复用旧LastModified', !calls[1].headers['if-modified-since'])
check('没有降回其它版本URL', calls.filter(item => !item.url.endsWith('/version.json')).every(item => item.url.includes('/7.2.52/')))
const changedCatalog = { [characterId]: { ...catalogs['charlist.json'][characterId], chsName: '更新后的摘要' } }
const failedDetail = await harvestSelected([character], {
  dataDir, delay: false, withDetails: true,
  fetchImpl: async url => url.endsWith('/version.json') ? json(nextVersion) : url.endsWith('/charlist.json') ? json(changedCatalog) : unavailable
})
check('详情失败记入error与failed', failedDetail[0].failed === 1 && Boolean(manifest(dataDir).channels[character.id].error))
check('详情失败仍保留旧detail', read(recordFile(dataDir, 'character', characterId)).detail.testMarker === '新版本详情')
check('详情失败仍更新目录摘要', read(recordFile(dataDir, 'character', characterId)).chsName === '更新后的摘要')
calls = []
await harvestSelected([character], {
  dataDir, delay: false, withDetails: true,
  fetchImpl: async (url, options) => {
    calls.push({ url, headers: options?.headers || {} })
    if (url.endsWith('/version.json')) return json(nextVersion)
    return url.endsWith('/charlist.json') ? json(changedCatalog) : json({ ...details.character, testMarker: '恢复后的详情' })
  }
})
check('目录不变仍恢复失败详情', read(recordFile(dataDir, 'character', characterId)).detail.testMarker === '恢复后的详情')
check('未完成频道不发条件请求', !calls[1].headers['if-modified-since'])
check('恢复后清除error并标记详情完成', manifest(dataDir).channels[character.id].error === '' && manifest(dataDir).channels[character.id].detailsComplete === true)
await harvestSelected([character], {
  dataDir, mode: 'full', delay: false, withDetails: true,
  fetchImpl: async url => url.endsWith('/version.json') ? json(nextVersion) : url.endsWith('/charlist.json') ? json(changedCatalog) : { ok: true, status: 200, text: '{bad json' }
})
check('200损坏JSON不擦除旧详情', read(recordFile(dataDir, 'character', characterId)).detail.testMarker === '恢复后的详情' && Boolean(manifest(dataDir).channels[character.id].error))
await harvestSelected([character], {
  dataDir, delay: false, withDetails: false,
  fetchImpl: async url => url.endsWith('/version.json') ? json(nextVersion) : json(changedCatalog)
})
check('失败后只更新摘要不误标详情完整', manifest(dataDir).channels[character.id].detailsComplete === false)
await harvestSelected([character], {
  dataDir, delay: false, withDetails: true,
  fetchImpl: async url => url.endsWith('/version.json') ? json(nextVersion) : url.endsWith('/charlist.json') ? json(changedCatalog) : json({ testMarker: '关闭再开启后的详情' })
})
check('失败后经过关闭再开启仍能恢复详情', read(recordFile(dataDir, 'character', characterId)).detail.testMarker === '关闭再开启后的详情')
const oldBytes = fs.readFileSync(recordFile(dataDir, 'character', characterId), 'utf8')
const versionFailed = await harvestSelected([character], { dataDir, delay: false, fetchImpl: async () => unavailable })
check('版本接口失败有明确失败结果', versionFailed[0].status === 'failed' && versionFailed[0].error.includes('version.json'))
check('版本失败不改旧记录', fs.readFileSync(recordFile(dataDir, 'character', characterId), 'utf8') === oldBytes)
calls = []
await harvestLunarisChannel({ ...character, version: '7.1.0' }, {
  dataDir, delay: false,
  fetchImpl: async url => { calls.push(url); return url.endsWith('/version.json') ? unavailable : json(catalogs['charlist.json']) }
})
check('显式channel.version覆盖仍可用且不换其它版本', calls[1] === 'https://api.lunaris.moe/data/7.1.0/charlist.json')
const oldQuestFile = recordFile(dataDir, 'quest', 'old')
fs.mkdirSync(path.dirname(oldQuestFile), { recursive: true })
fs.writeFileSync(oldQuestFile, '{"chsName":"旧任务"}\n')
await harvestLunarisChannels([channel('quest')], { dataDir, delay: false, fetchImpl: summaryFetch })
check('404缺席不删除旧文件', fs.readFileSync(oldQuestFile, 'utf8').includes('旧任务'))

console.log('\n=== ③b 官方详情模板与原字段保留 ===')
for (const [page, catalogName, expectedPath] of [
  ['character', 'charlist.json', 'chs/char/10000002.json'],
  ['weapon', 'weaponlist.json', 'chs/weapon/11101.json'],
  ['artifact', 'artifactlist.json', 'chs/artifact/10001.json'],
  ['monster', 'monsterlist.json', 'chs/monster/20010101.json'],
  ['tower', 'towerlist.json', 'chs/tower/1.json'],
  ['rolecombat', 'roleplaylist.json', 'chs/roleplay/1.json'],
  ['tutorial', 'tutoriallist.json', 'chs/tutorial/10001.json'],
  ['achievement', 'achievementlist.json', 'chs/goals/0.json'],
  ['tpsweapon', 'tpsweaponlist.json', 'chs/tpsweapon/224001.json']
]) {
  const dir = freshDir(`lunaris-detail-${page}`)
  const payload = details[page] || { testMarker: '官网模板的合成详情响应' }
  const results = await harvestSelected([channel(page)], {
    dataDir: dir, withDetails: true, delay: false,
    fetchImpl: async url => {
      if (url.endsWith('/version.json')) return json(versionInfo)
      if (url.endsWith(`/${catalogName}`)) return json(catalogs[catalogName])
      return url === `https://api.lunaris.moe/data/7.2.51/${expectedPath}` ? json(payload) : absent
    }
  })
  const id = Object.keys(catalogs[catalogName])[0]
  check(`详情模板正确且原字段保留 ${page}`, results[0].failed === 0 && JSON.stringify(read(recordFile(dir, page, id)).detail) === JSON.stringify(payload))
}

console.log('\n=== ④ 官网banner与leyline独立文件 ===')
const siteDir = freshDir('lunaris-site')
const leylineChannel = { ...channel('leyline'), ids: ['5269001', '5269002'] }
const secondPeriod = { ...leyline, scheduleId: 5269002, scheduleStartTime: '2025-08-06 10:00:00', scheduleEndTime: '2025-09-17 09:59:59' }
const siteFetch = async url => {
  if (url.endsWith('/version.json')) return unavailable
  if (url.endsWith('/banners.json')) return json(banners)
  return url.endsWith('/5269001.json') ? json(leyline) : json(secondPeriod)
}
const sites = await harvestSelected([character, channel('banner'), leylineChannel], { dataDir: siteDir, delay: false, fetchImpl: siteFetch })
check('API版本失败不阻断官网两类数据', sites[0].status === 'failed' && sites[1].status === 'ok' && sites[2].status === 'ok')
check('banner整份原样写__index', JSON.stringify(read(recordFile(siteDir, 'banner', '__index'))) === JSON.stringify(banners))
check('leyline原记录字段保留', JSON.stringify(read(recordFile(siteDir, 'leyline', '5269001'))) === JSON.stringify(leyline))
check('leyline期开始和结束时刻完整', manifest(siteDir).channels[leylineChannel.id].phases[0].begin === '2025-06-25 10:00:00' && manifest(siteDir).channels[leylineChannel.id].phases[0].end === '2025-08-06 09:59:59')
const firstLeylineBytes = fs.readFileSync(recordFile(siteDir, 'leyline', '5269001'), 'utf8')
calls = []
const site304 = await harvestSelected([channel('banner'), leylineChannel], {
  dataDir: siteDir, delay: false,
  fetchImpl: async (url, options) => { calls.push({ url, headers: options?.headers || {} }); return { ok: false, status: 304 } }
})
check('官网单文件和期文件都支持304跳过', site304.every(item => item.status === 'skipped'))
check('官网条件请求带各自LastModified', calls.length === 3 && calls.every(item => item.headers['if-modified-since']))
check('官网304保留原记录', fs.readFileSync(recordFile(siteDir, 'leyline', '5269001'), 'utf8') === firstLeylineBytes)
const sitesSameHash = await harvestSelected([channel('banner'), leylineChannel], { dataDir: siteDir, delay: false, fetchImpl: siteFetch })
check('官网相同内容指纹不重写', sitesSameHash.every(item => item.status === 'skipped'))
const failedPeriod = await harvestSelected([leylineChannel], {
  dataDir: siteDir, mode: 'full', delay: false,
  fetchImpl: async url => url.endsWith('/5269001.json') ? unavailable : json(secondPeriod)
})
check('单期失败保留旧记录与其期表', failedPeriod[0].failed === 1 && fs.readFileSync(recordFile(siteDir, 'leyline', '5269001'), 'utf8') === firstLeylineBytes
  && manifest(siteDir).channels[leylineChannel.id].phases.length === 2)
calls = []
await harvestSelected([leylineChannel], {
  dataDir: siteDir, delay: false,
  fetchImpl: async (url, options) => { calls.push({ url, headers: options?.headers || {} }); return siteFetch(url) }
})
check('官网失败期可在同目录恢复', manifest(siteDir).channels[leylineChannel.id].error === '' && calls.length === 2)
check('官网失败恢复不复用旧条件请求', calls.every(item => !item.headers['if-modified-since']))

console.log('\n=== ⑤ 导出隔离、显式时间与中断续抓 ===')
const exported = await exportAll(dataDir)
check('导出同名页面按源隔离', exported.index.games.gi.sources.nanoka.pages.character.entries.other.name === '其它源' && exported.index.games.gi.sources.lunaris.pages.character.entries[characterId].name === '更新后的摘要')
check('其它源原文件未改变', fs.readFileSync(path.join(dataDir, 'records/gi/nanoka/character/other.json'), 'utf8') === '{"name":"其它源"}\n')
check('tower显式时刻不截断', exported.periods.games.gi.lunaris.tower[0].begin === catalogs['towerlist.json']['1'].openTime && exported.periods.games.gi.lunaris.tower[0].end === catalogs['towerlist.json']['1'].closeTime)
check('rolecombat显式时刻不截断', exported.periods.games.gi.lunaris.rolecombat[0].begin === catalogs['roleplaylist.json']['1'].beginTime && exported.periods.games.gi.lunaris.rolecombat[0].end === catalogs['roleplaylist.json']['1'].endTime)
const siteExport = await exportAll(siteDir)
check('leyline导出来源及连续期号', siteExport.periods.games.gi.lunaris.leyline.length === 2 && siteExport.periods.games.gi.lunaris.leyline[0].source === 'lunaris' && siteExport.periods.games.gi.lunaris.leyline[1].no === 2)
check('leyline导出保留显式结束时刻', siteExport.periods.games.gi.lunaris.leyline[0].end === leyline.scheduleEndTime)
check('leyline沿用官网challengeName给出的期版本', siteExport.periods.games.gi.lunaris.leyline[0].version === leyline.challengeName && leyline.challengeName === '5.7')
const interruptedDir = freshDir('lunaris-interrupted')
let interrupted = false
try {
  await harvestSelected([character, channel('weapon')], {
    dataDir: interruptedDir, delay: false, fetchImpl: summaryFetch,
    onChannel () { throw new Error('合成调用方中断') }
  })
} catch { interrupted = true }
check('频道回调中断前首频道已落盘', interrupted && manifest(interruptedDir).channels[character.id]?.records === 1 && !manifest(interruptedDir).channels[channel('weapon').id])
const resumed = await harvestSelected([character, channel('weapon')], { dataDir: interruptedDir, delay: false, fetchImpl: summaryFetch })
check('中断后按台账继续未完成频道', resumed[0].status === 'skipped' && resumed[1].fetched === 1)

console.log('\n=== ⑥ 空目录与外部记录形状 ===')
{
  const dir = freshDir('lunaris-empty-catalog')
  const fetchImpl = async url => url.endsWith('/version.json') ? json(versionInfo) : json({})
  const empty = await harvestSelected([character], { dataDir: dir, withDetails: true, delay: false, fetchImpl })
  check('合法空目录成功且没有失败条目', empty[0].status === 'ok' && empty[0].records === 0 && empty[0].failed === 0 && empty[0].error === '')
  check('空目录在台账中明确记录0条', manifest(dir).channels[character.id].records === 0 && manifest(dir).channels[character.id].ids?.length === 0)
  const exported = await exportAll(dir)
  const page = exported.index.games.gi.sources.lunaris.pages.character
  check('空页正常导出空索引', page.records === 0 && page.ids.length === 0 && Object.keys(page.entries).length === 0)
  const skipped = await harvestSelected([character], { dataDir: dir, withDetails: true, delay: false, fetchImpl })
  check('健康空目录也支持同hash跳过', skipped[0].status === 'skipped' && skipped[0].skipped === 0)
}
{
  const dir = freshDir('lunaris-invalid-catalog-record')
  await harvestSelected([character], { dataDir: dir, delay: false, fetchImpl: summaryFetch })
  const before = fs.readFileSync(recordFile(dir, 'character', characterId), 'utf8')
  for (const [name, value] of [['null', null], ['数组', []], ['数字', 7], ['字符串', '错误记录']]) {
    const result = await harvestSelected([character], {
      dataDir: dir, mode: 'full', delay: false,
      fetchImpl: async url => url.endsWith('/version.json') ? json(versionInfo) : json({ ...catalogs['charlist.json'], invalid: value })
    })
    check(`字典含${name}条目时整目录失败并保旧`, result[0].status === 'failed' && result[0].error.includes('非对象记录')
      && fs.readFileSync(recordFile(dir, 'character', characterId), 'utf8') === before
      && !fs.existsSync(recordFile(dir, 'character', 'invalid')) && manifest(dir).channels[character.id].records === 1)
  }
}
{
  const dir = freshDir('lunaris-invalid-detail-shape')
  const fetchImpl = async url => url.endsWith('/version.json') ? json(versionInfo) : url.endsWith('/charlist.json') ? json(catalogs['charlist.json']) : json(details.character)
  await harvestSelected([character], { dataDir: dir, withDetails: true, delay: false, fetchImpl })
  for (const [name, value] of [['字符串', '错误详情'], ['数字', 42], ['数组', []], ['null', null]]) {
    const result = await harvestSelected([character], {
      dataDir: dir, mode: 'full', withDetails: true, delay: false,
      fetchImpl: async url => url.endsWith('/version.json') ? json(versionInfo) : url.endsWith('/charlist.json') ? json(catalogs['charlist.json']) : json(value)
    })
    check(`200 ${name}详情保留旧对象并记录失败`, result[0].failed === 1 && Boolean(manifest(dir).channels[character.id].error)
      && manifest(dir).channels[character.id].detailsComplete === false
      && JSON.stringify(read(recordFile(dir, 'character', characterId)).detail) === JSON.stringify(details.character))
  }
  const requests = []
  const recovered = await harvestSelected([character], {
    dataDir: dir, withDetails: true, delay: false,
    fetchImpl: async (url, options) => { requests.push({ url, headers: options?.headers || {} }); return fetchImpl(url) }
  })
  check('错误详情恢复时同目录重新采集', recovered[0].status === 'ok' && recovered[0].fetched === 1 && requests.length === 3)
  check('错误详情恢复后清除缺口且不发旧条件头', manifest(dir).channels[character.id].detailsComplete === true
    && manifest(dir).channels[character.id].error === '' && !requests[1].headers['if-modified-since'])
}

finish()
