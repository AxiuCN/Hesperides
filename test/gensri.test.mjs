import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mod, checker, freshDir, testDir, rootDir } from './_helper.mjs'

const { GENSRI_CHANNELS, GENSRI_ENDGAME_CHANNEL_IDS } = await import(mod('src/sources/gensri/channels.mjs'))
const { harvestGensriChannels } = await import(mod('src/sources/gensri/harvest.mjs'))
const { SOURCES, harvestSelected } = await import(mod('src/sources/registry.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { check, finish } = checker()
const fixtureDir = path.join(testDir, 'fixtures/gensri')
const fixture = name => JSON.parse(fs.readFileSync(path.join(fixtureDir, name + '.json'), 'utf8'))
const version = fixture('db-versions')
const channels = new Map(GENSRI_CHANNELS.map(channel => [channel.page, channel]))
const json = value => ({ ok: true, status: 200, text: JSON.stringify(value), lastModified: 'Mon, 09 Nov 2026 00:00:00 GMT' })
const absent = { ok: false, status: 404 }
const catalogs = { 'characters.json': fixture('characters'), 'weapons.json': fixture('weapons'), 'artifactlist.json': fixture('artifacts') }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const recordPath = (dir, page, id) => path.join(dir, 'records/gi/gensri', page, id + '.json')
const manifest = dir => read(path.join(dir, 'manifest.json'))
const rows = fixture('characters').filter(record => ['10000046', '10000147', '10000005_CRYO', '10000005_ANEMO'].includes(record.file))

async function run(name, task) {
  try { await task(); check(name, true) }
  catch (error) { check(name, false, error.message) }
}

await run('注册四源、四个原神频道与一个独立终局频道', () => {
  assert.deepEqual(SOURCES.map(source => source.source), ['nanoka', 'alioth', 'lunaris', 'gensri'])
  assert.deepEqual(GENSRI_CHANNELS.map(channel => channel.id), ['gensri:gi:character', 'gensri:gi:weapon', 'gensri:gi:artifact', 'gensri:gi:stygian'])
  assert.deepEqual(GENSRI_ENDGAME_CHANNEL_IDS, ['gensri:gi:stygian'])
})

const full = freshDir('gensri-full-catalogs')
let calls = []
const catalogFetch = async (url, options) => {
  calls.push({ url, headers: options?.headers || {} })
  if (url.endsWith('/versions.json')) return json(version)
  if (url.endsWith('/seasons.json')) return json(fixture('seasons'))
  return catalogs[url.split('/').at(-1)] ? json(catalogs[url.split('/').at(-1)]) : absent
}
const results = await harvestSelected(GENSRI_CHANNELS, { dataDir: full, fetchImpl: catalogFetch, delay: false })
await run('真实完整目录保留133角色、249武器、68套装和5期', () => {
  assert.deepEqual(results.map(result => result.records), [133, 249, 68, 5])
  assert.ok(results.every(result => result.status === 'ok'))
  assert.equal(calls.length, 5)
})
await run('旅行者七元素同数字ID仍有独立记录与标签', () => {
  const meta = manifest(full).channels['gensri:gi:character']
  const variants = meta.ids.filter(id => id.startsWith('10000005_'))
  assert.equal(variants.length, 7)
  assert.ok(meta.labels['10000005_CRYO'].name.includes('冰'))
  assert.equal(read(recordPath(full, 'character', '10000005_CRYO')).id, 10000005)
  assert.equal(read(recordPath(full, 'character', '10000005_ANEMO')).id, 10000005)
})
await run('schema v2导出按source隔离、官方五期按开启时间排序', async () => {
  const { index, periods } = await exportAll(full)
  assert.equal(index.schemaVersion, 2)
  assert.equal(index.games.gi.sources.gensri.pages.character.ids.length, 133)
  assert.deepEqual(periods.games.gi.gensri.stygian.map(period => period.id), ['st067', 'st070', 'st071', 'st072', 'st073'])
  assert.equal(periods.games.gi.gensri.stygian[3].begin, '2026-11-11T10:00:00+08:00')
  assert.equal(periods.games.gi.gensri.stygian[3].version, '7.2')
  assert.ok(Date.parse(periods.games.gi.gensri.stygian[4].begin) > Date.parse('2026-11-14T12:00:00+08:00'))
})

const dataDir = freshDir('gensri-details-recovery')
let fail = false
let alteredVersion = structuredClone(version)
let changedFile = false
const fetchDetails = async (url, options) => {
  calls.push({ url, headers: options?.headers || {} })
  if (url.endsWith('/versions.json')) return json(alteredVersion)
  if (url.endsWith('/characters.json')) return json(rows)
  if (url.endsWith('/weapons.json')) return json(catalogs['weapons.json'].filter(record => record.id === 12438))
  if (url.endsWith('/artifactlist.json')) return json({ 15040: catalogs['artifactlist.json']['15040'] })
  if (url.endsWith('/seasons.json')) return json(fixture('seasons'))
  if (url.includes('/985/')) return json(fixture('season-' + url.split('/').at(-2)))
  if (fail && url.includes('/characters/10000147')) return { ok: false, status: 503 }
  if (/10000147(?:%40|@)/.test(url)) return json({ ...fixture('character-10000147-current'), auditRevision: changedFile ? 2 : 1 })
  if (url.includes('/characters/10000046')) return json(fixture('character-10000046'))
  if (url.includes('/characters/10000005_')) return json(fixture('character-traveler-cryo'))
  if (url.includes('/weapons/12438')) return json(fixture('weapon-12438-current'))
  if (url.includes('/artifacts/15040')) return json(fixture('artifact-15040'))
  return absent
}
calls = []
await harvestGensriChannels(GENSRI_CHANNELS, { dataDir, fetchImpl: fetchDetails, withDetails: true, delay: false })
await run('五类真实详情和每期配置经真实采集器写入', () => {
  assert.equal(read(recordPath(dataDir, 'character', '10000046')).detail.info.name, '胡桃')
  assert.equal(read(recordPath(dataDir, 'weapon', '12438')).detail.name, '炎烈狮牙')
  assert.equal(read(recordPath(dataDir, 'artifact', '15040')).detail.info.setName, fixture('artifact-15040').info.setName)
  assert.equal(read(recordPath(dataDir, 'stygian', 'st072')).detail.enemies.length, 3)
  assert.ok(GENSRI_CHANNELS.every(channel => manifest(dataDir).channels[channel.id].detailsComplete))
})
await run('详情按versions首项文件取当前版本并保留实际来源', () => {
  const record = read(recordPath(dataDir, 'character', '10000147'))
  assert.equal(record.file, '10000147')
  assert.equal(record.sourceMeta.detailFile, '10000147@7.2.51')
  assert.equal(record.sourceMeta.detailVersion, '7.2.51')
  assert.ok(calls.some(call => /10000147(?:%40|@)7\.2\.51\.json$/.test(call.url)))
  assert.ok(!calls.some(call => call.url.endsWith('/characters/10000147.json')))
})

await run('摘要与版本映射未变时保留全部详情字节并跳过', async () => {
  const file = recordPath(dataDir, 'character', '10000147')
  const before = fs.readFileSync(file)
  calls = []
  const result = await harvestGensriChannels([channels.get('character')], { dataDir, fetchImpl: fetchDetails, withDetails: true, delay: false })
  assert.equal(result[0].status, 'skipped')
  assert.equal(calls.length, 2)
  assert.deepEqual(fs.readFileSync(file), before)
})
await run('同目录但versions详情文件变化时补抓，失败保留旧详情来源', async () => {
  alteredVersion.characters['10000147'][0] = { version: '7.2.52', file: '10000147@7.2.52' }
  changedFile = true
  fail = true
  const result = await harvestGensriChannels([channels.get('character')], { dataDir, fetchImpl: fetchDetails, withDetails: true, delay: false })
  assert.equal(result[0].failed, 1)
  const record = read(recordPath(dataDir, 'character', '10000147'))
  assert.equal(record.detail.auditRevision, 1)
  assert.equal(record.sourceMeta.requestedDetailFile, '10000147@7.2.52')
  assert.equal(record.sourceMeta.detailFile, '10000147@7.2.51')
  assert.equal(manifest(dataDir).channels['gensri:gi:character'].detailsComplete, false)
})
await run('详情恢复时同目录再次请求并更新实际来源', async () => {
  fail = false
  const result = await harvestGensriChannels([channels.get('character')], { dataDir, fetchImpl: fetchDetails, withDetails: true, delay: false })
  assert.equal(result[0].failed, 0)
  const record = read(recordPath(dataDir, 'character', '10000147'))
  assert.equal(record.detail.auditRevision, 2)
  assert.equal(record.sourceMeta.detailFile, '10000147@7.2.52')
  assert.equal(manifest(dataDir).channels['gensri:gi:character'].detailsComplete, true)
})
await run('健康304保留记录与导出元信息', async () => {
  const file = recordPath(dataDir, 'character', '10000147')
  const before = fs.readFileSync(file)
  const result = await harvestGensriChannels([channels.get('character')], { dataDir, withDetails: true, delay: false, fetchImpl: async (url, options) => {
    if (url.endsWith('/versions.json')) return json(alteredVersion)
    assert.ok(options?.headers['if-modified-since'])
    return { ok: false, status: 304 }
  } })
  assert.equal(result[0].status, 'skipped')
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(manifest(dataDir).channels['gensri:gi:character'].records, 4)
})

for (const [name, response] of [['404', absent], ['503', { ok: false, status: 503 }], ['坏JSON', { ok: true, status: 200, text: '{' }], ['错误根类型', json({ invalid: true })], ['重复file键', json([rows[0], rows[0]])]]) {
  await run(`${name}保留上次记录与ID`, async () => {
    const file = recordPath(dataDir, 'character', '10000147')
    const before = fs.readFileSync(file)
    const ids = manifest(dataDir).channels['gensri:gi:character'].ids
    const result = await harvestGensriChannels([channels.get('character')], { dataDir, mode: 'full', delay: false, fetchImpl: async url => url.endsWith('/versions.json') ? json(alteredVersion) : response })
    assert.ok(['absent', 'failed'].includes(result[0].status))
    assert.deepEqual(fs.readFileSync(file), before)
    assert.deepEqual(manifest(dataDir).channels['gensri:gi:character'].ids, ids)
  })
}
await run('版本端点失败不影响独立985频道', async () => {
  const result = await harvestSelected([channels.get('character'), channels.get('stygian')], { dataDir: freshDir('gensri-version-failed'), delay: false, fetchImpl: async url => url.endsWith('/seasons.json') ? json(fixture('seasons')) : absent })
  assert.equal(result[0].status, 'failed')
  assert.equal(result[1].records, 5)
})

await run('CLI正常公开入口列出并采集新频道，verify读取同一schema', () => {
  const directory = freshDir('gensri-cli')
  const fetch = pathToFileURL(path.join(fixtureDir, 'cli-fetch.mjs')).href
  const child = spawnSync(process.execPath, ['--import', fetch, path.join(rootDir, 'src/cli.mjs'), '--channel', 'gensri:gi:artifact', '--data-dir', directory, '--json'], { encoding: 'utf8', cwd: rootDir })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout).ok, 1)
  assert.equal(read(path.join(directory, 'index.json')).games.gi.sources.gensri.pages.artifact.ids.length, 68)
  const verified = spawnSync(process.execPath, [path.join(rootDir, 'src/cli.mjs'), '--verify', '--data-dir', directory, '--json'], { encoding: 'utf8', cwd: rootDir })
  assert.equal(verified.status, 0, verified.stdout + verified.stderr)
})

finish()
