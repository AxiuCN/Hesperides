import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mod, ensureTmp, checker } from './_helper.mjs'

const { harvestImages } = await import(mod('src/images/store.mjs'))
const { check, finish } = checker()
const tmp = path.join(ensureTmp(), 'image-cache-fallback')
fs.mkdirSync(tmp, { recursive: true })
const first = 'https://static.nanoka.cc/assets/gi/UI_ItemIcon_202.webp'
const fallback = 'https://img.alioth.wiki/gi/UI_ItemIcon_202.png'
const localPath = 'images/gi/UI_ItemIcon_202.webp'

for (const mode of ['bytes', 'etag']) {
  const name = mode === 'bytes' ? '体积拒绝后首候选失败仍请求备用图片' : 'ETag拒绝后首候选失败仍请求备用图片'
  try {
    const dir = fs.mkdtempSync(path.join(tmp, mode + '-'))
    fs.mkdirSync(path.join(dir, 'images/gi'), { recursive: true })
    const previousBytes = Buffer.from(mode === 'bytes' ? 'bad' : 'previous-stale-image')
    const nextBytes = Buffer.from('complete-fallback-image')
    fs.writeFileSync(path.join(dir, localPath), previousBytes)
    const calls = []
    const out = await harvestImages([{ recordId: '202', fieldPath: 'icon', kind: 'image', candidates: [first, fallback] }], {
      dataDir: dir,
      verify: mode === 'etag',
      previous: { [first]: { url: first, localPath, status: 'downloaded', bytes: mode === 'bytes' ? 100 : previousBytes.length, etag: 'old-etag' } },
      fetchImpl: async (url, options = {}) => {
        const method = options.method || 'GET'
        calls.push({ url, method })
        if (method === 'HEAD') return { ok: true, etag: 'new-etag' }
        if (url === first) return { ok: false, status: 503, error: '合成503' }
        return { ok: true, buffer: nextBytes, contentType: 'image/png', etag: 'fallback-etag' }
      },
    })
    assert.deepEqual(calls.filter(call => call.method === 'GET').map(call => call.url), [first, fallback])
    assert.equal(out.refs[0].localPath, 'images/gi/UI_ItemIcon_202.png')
    assert.equal(out.refs[0].bytes, nextBytes.length)
    assert.equal(out.refs[0].etag, 'fallback-etag')
    assert.deepEqual(fs.readFileSync(path.join(dir, out.refs[0].localPath)), nextBytes)
    assert.deepEqual(fs.readFileSync(path.join(dir, localPath)), previousBytes)
    check(name, true)
  } catch (error) { check(name, false, error.message) }
}

try {
  const dir = fs.mkdtempSync(path.join(tmp, 'restored-'))
  fs.mkdirSync(path.join(dir, 'images/gi'), { recursive: true })
  fs.writeFileSync(path.join(dir, localPath), 'bad')
  const nextBytes = Buffer.from('restored-preferred-image')
  const calls = []
  const out = await harvestImages([
    { recordId: '202', fieldPath: 'icon', candidates: [first] },
    { recordId: '203', fieldPath: 'icon', candidates: [fallback] },
  ], {
    dataDir: dir,
    concurrency: 1,
    previous: { [first]: { url: first, localPath, status: 'downloaded', bytes: 100 } },
    fetchImpl: async url => { calls.push(url); return { ok: true, buffer: nextBytes, contentType: 'image/webp' } },
  })
  assert.deepEqual(calls, [first])
  assert.ok(out.refs.every(ref => ref.localPath === localPath && ref.bytes === nextBytes.length))
  assert.equal(out.stats.downloaded, 1)
  assert.equal(out.stats.reused, 1)
  assert.deepEqual(fs.readFileSync(path.join(dir, localPath)), nextBytes)
  check('成功重下后相同路径可供后续候选复用', true)
} catch (error) { check('成功重下后相同路径可供后续候选复用', false, error.message) }
finish()
