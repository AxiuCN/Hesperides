import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mod, ensureTmp, checker } from './_helper.mjs'

const { scanImages, harvestImages, urlResourceKey } = await import(mod('src/images/store.mjs'))
const { pruneOrphanImages } = await import(mod('src/images/prune.mjs'))
const { writePageImages, readPageImages, reuseTable } = await import(mod('src/images/index.mjs'))
const { exportAll } = await import(mod('src/export/index.mjs'))
const { buildImageCandidates } = await import(mod('src/images/refs.mjs'))
const { check, finish } = checker()
const tmpRoot = path.join(ensureTmp(), 'image-prune-consistency')
fs.mkdirSync(tmpRoot, { recursive: true })

function fresh() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'))
}
function write(dir, relative, content) {
  const file = path.join(dir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}
function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function ref(url) {
  return { recordId: '202', fieldPath: 'icon', kind: 'image', candidates: [url] }
}
async function run(name, test) {
  try {
    await test()
    check(name, true)
  } catch (error) {
    check(name, false, error.message)
  }
}
async function projectedFixture() {
  const dir = fresh()
  const png = 'images/gi/UI_ItemIcon_202.png'
  const webp = 'images/gi/UI_ItemIcon_202.webp'
  write(dir, png, Buffer.alloc(30, 1))
  write(dir, webp, Buffer.alloc(10, 2))
  write(dir, 'manifest.json', JSON.stringify({ channels: {
    'nanoka:gi:item': { game: 'gi', source: 'nanoka', page: 'item', kind: 'page', status: 'ok', ids: ['202'], records: 1, labels: { 202: { name: '合成摩拉', rarity: 3 } } },
  } }))
  await writePageImages(dir, { gameId: 'gi', source: 'nanoka', page: 'item' }, {
    202: [{ fieldPath: 'icon', localPath: png, remoteUrl: 'https://img.alioth.wiki/gi/UI_ItemIcon_202.png', status: 'downloaded', placeholder: false, bytes: 30, etag: 'old-png-etag' }],
  })
  await exportAll(dir)
  return { dir, png, webp, refsFile: path.join(dir, 'imagerefs', 'gi', 'nanoka', 'item.json') }
}

await run('清理后引用和已导出图标都指向保留图片', async () => {
  const { dir, png, webp } = await projectedFixture()
  assert.equal(json(path.join(dir, 'index.json')).games.gi.sources.nanoka.pages.item.entries['202'].icon, png)
  await pruneOrphanImages({ dataDir: dir, apply: true })
  const refs = await readPageImages(dir, { gameId: 'gi', source: 'nanoka', page: 'item' })
  const icon = json(path.join(dir, 'index.json')).games.gi.sources.nanoka.pages.item.entries['202'].icon
  assert.equal(icon, webp)
  assert.equal(refs['202'][0].localPath, webp)
  assert.ok(fs.existsSync(path.join(dir, icon)))
})

await run('清理后连续两轮抓图保持元数据一致且无需HTTP', async () => {
  const { dir, png, webp } = await projectedFixture()
  const key = { gameId: 'gi', source: 'nanoka', page: 'item' }
  const url = 'https://img.alioth.wiki/gi/UI_ItemIcon_202.png'
  const calls = []
  await pruneOrphanImages({ dataDir: dir, apply: true })
  let records = await readPageImages(dir, key)
  const afterPrune = { ...records['202'][0] }
  const rounds = []
  for (let round = 0; round < 2; round++) {
    const harvested = await harvestImages([ref(url)], {
      dataDir: dir,
      previous: reuseTable(records),
      fetchImpl: async requested => {
        calls.push(requested)
        return { ok: true, buffer: Buffer.alloc(30, 1), contentType: 'image/png', etag: 'old-png-etag' }
      },
    })
    rounds.push(harvested.refs[0])
    await writePageImages(dir, key, { 202: harvested.refs })
    records = await readPageImages(dir, key)
  }
  assert.equal(calls.length, 0)
  assert.equal(afterPrune.bytes, 10)
  assert.equal(afterPrune.etag, '')
  assert.ok(rounds.every(item => item.localPath === webp && item.bytes === 10 && item.etag === ''))
  assert.ok(!fs.existsSync(path.join(dir, png)))
})

await run('引用写入失败时旧图可读且重试可完成', async () => {
  const { dir, png, webp, refsFile } = await projectedFixture()
  const nativeWrite = fs.writeFileSync
  let injected = false
  fs.writeFileSync = (file, ...args) => {
    if (!injected && String(file) === refsFile + '.tmp') {
      injected = true
      throw Object.assign(new Error('合成引用写入失败'), { code: 'EIO' })
    }
    return nativeWrite(file, ...args)
  }
  let failed = false
  try {
    await pruneOrphanImages({ dataDir: dir, apply: true })
  } catch {
    failed = true
  } finally {
    fs.writeFileSync = nativeWrite
  }
  assert.ok(injected && failed)
  assert.ok(fs.existsSync(path.join(dir, png)))
  await pruneOrphanImages({ dataDir: dir, apply: true })
  assert.equal(json(refsFile).records['202'][0].localPath, webp)
  assert.equal(json(path.join(dir, 'index.json')).games.gi.sources.nanoka.pages.item.entries['202'].icon, webp)
  assert.ok(!fs.existsSync(path.join(dir, png)))
})

await run('索引写入失败后重试仍会刷新投影再删图', async () => {
  const { dir, png, webp } = await projectedFixture()
  const indexFile = path.join(dir, 'index.json')
  const nativeRename = fsPromises.rename
  let injected = false
  fsPromises.rename = async (source, destination) => {
    if (!injected && String(destination) === indexFile) {
      injected = true
      throw Object.assign(new Error('合成索引写入失败'), { code: 'EIO' })
    }
    return nativeRename(source, destination)
  }
  let failed = false
  try {
    await pruneOrphanImages({ dataDir: dir, apply: true })
  } catch {
    failed = true
  } finally {
    fsPromises.rename = nativeRename
  }
  assert.ok(injected && failed)
  assert.ok(fs.existsSync(path.join(dir, png)))
  await pruneOrphanImages({ dataDir: dir, apply: true })
  assert.equal(json(indexFile).games.gi.sources.nanoka.pages.item.entries['202'].icon, webp)
  assert.ok(fs.existsSync(path.join(dir, webp)))
  assert.ok(!fs.existsSync(path.join(dir, png)))
})

await run('显式ETag变化后下载新图片', async () => {
  const dir = fresh()
  const url = 'https://static.nanoka.cc/assets/gi/UI_ItemIcon_202.webp'
  const localPath = 'images/gi/UI_ItemIcon_202.webp'
  const oldBytes = Buffer.from('old-image')
  const newBytes = Buffer.from('new-upstream-image')
  const file = write(dir, localPath, oldBytes)
  const calls = []
  await harvestImages([ref(url)], {
    dataDir: dir, verify: true,
    previous: { [url]: { url, localPath, status: 'downloaded', bytes: oldBytes.length, etag: 'old-etag' } },
    fetchImpl: async (requested, options = {}) => {
      calls.push(options.method || 'GET')
      return options.method === 'HEAD' ? { ok: true, etag: 'new-etag' } : { ok: true, buffer: newBytes, contentType: 'image/webp', etag: 'new-etag' }
    },
  })
  assert.deepEqual(calls, ['HEAD', 'GET'])
  assert.deepEqual(fs.readFileSync(file), newBytes)
})

await run('已有URL体积失配后下载完整图片', async () => {
  const dir = fresh()
  const url = 'https://static.nanoka.cc/assets/gi/UI_ItemIcon_202.webp'
  const localPath = 'images/gi/UI_ItemIcon_202.webp'
  const newBytes = Buffer.from('complete-image')
  const file = write(dir, localPath, 'bad')
  const calls = []
  await harvestImages([ref(url)], {
    dataDir: dir,
    previous: { [url]: { url, localPath, status: 'downloaded', bytes: newBytes.length } },
    fetchImpl: async requested => { calls.push(requested); return { ok: true, buffer: newBytes, contentType: 'image/webp' } },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(fs.readFileSync(file), newBytes)
})

await run('预览保持图片引用和索引原字节', async () => {
  const { dir, png, refsFile } = await projectedFixture()
  const refsBefore = fs.readFileSync(refsFile)
  const indexBefore = fs.readFileSync(path.join(dir, 'index.json'))
  const preview = await pruneOrphanImages({ dataDir: dir, apply: false })
  assert.equal(preview.applied, false)
  assert.ok(fs.existsSync(path.join(dir, png)))
  assert.deepEqual(fs.readFileSync(refsFile), refsBefore)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'index.json')), indexBefore)
})

await run('资源键跨源格式共享且隔离游戏和目录', async () => {
  assert.equal(urlResourceKey('https://static.nanoka.cc/assets/hsr/monsterfigure/Monster_1.webp'), urlResourceKey('https://img.alioth.wiki/sr/monsterfigure/Monster_1.png'))
  assert.notEqual(urlResourceKey('https://img.alioth.wiki/gi/Monster_1.png'), urlResourceKey('https://img.alioth.wiki/sr/Monster_1.png'))
  assert.notEqual(urlResourceKey('https://img.alioth.wiki/sr/monsterfigure/Monster_1.png'), urlResourceKey('https://img.alioth.wiki/sr/monstericon/Monster_1.png'))
  const dir = fresh()
  write(dir, 'images/gi/Monster_1.webp', 'gi-webp')
  write(dir, 'images/hsr/Monster_1.png', 'hsr-png')
  write(dir, 'images/hsr/other/Monster_1.webp', 'other-webp')
  const scan = await scanImages(dir)
  assert.equal(scan.index.size, 3)
  assert.equal(scan.duplicates.length, 0)
})

await run('迁移时直接复用已有另一格式', async () => {
  const dir = fresh()
  const localPath = 'images/hsr/monsterfigure/Monster_1.png'
  write(dir, localPath, 'existing-png')
  const calls = []
  const candidates = buildImageCandidates('hsr', 'alioth', 'monster', 'MonsterFigure/Monster_1', '1', 'Figure')
  const harvested = await harvestImages([{ ...ref(''), candidates }], {
    dataDir: dir,
    fetchImpl: async requested => { calls.push(requested); return { ok: false, status: 503 } },
  })
  assert.equal(calls.length, 0)
  assert.equal(harvested.refs[0].localPath, localPath)
})

await run('首选成功即停止且相同URL只下载一次', async () => {
  const dir = fresh()
  const url = 'https://static.nanoka.cc/assets/gi/UI_ItemIcon_202.webp'
  const calls = []
  const refs = [ref(url), { ...ref(url), recordId: '203' }].map(item => ({ ...item, candidates: [url, 'https://img.alioth.wiki/gi/UI_ItemIcon_202.png'] }))
  const harvested = await harvestImages(refs, {
    dataDir: dir,
    fetchImpl: async requested => { calls.push(requested); return { ok: true, buffer: Buffer.from('synthetic-image'), contentType: 'image/webp' } },
  })
  assert.deepEqual(calls, [url])
  assert.equal(harvested.refs.length, 2)
  assert.ok(harvested.refs.every(item => !item.placeholder))
})

await run('候选失败可回退且下轮复用成功格式', async () => {
  const dir = fresh()
  const first = 'https://static.nanoka.cc/assets/gi/UI_ItemIcon_202.webp'
  const fallback = 'https://img.alioth.wiki/gi/UI_ItemIcon_202.png'
  const calls = []
  const initial = await harvestImages([{ ...ref(first), candidates: [first, fallback] }], {
    dataDir: dir,
    fetchImpl: async requested => {
      calls.push(requested)
      return requested === first ? { ok: false, status: 503, error: '合成503' } : { ok: true, buffer: Buffer.from('fallback-image'), contentType: 'image/png' }
    },
  })
  assert.deepEqual(calls, [first, fallback])
  assert.equal(initial.refs[0].placeholder, false)
  const second = await harvestImages([{ ...ref(first), candidates: [first, fallback] }], {
    dataDir: dir, previous: initial.byUrl, previousFailures: initial.failures,
    fetchImpl: async () => { throw new Error('已知失败和可复用格式不应请求网络') },
  })
  assert.equal(second.refs[0].placeholder, false)
})

finish()
