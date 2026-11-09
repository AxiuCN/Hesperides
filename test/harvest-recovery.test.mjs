import fs from 'node:fs'
import path from 'node:path'
import { mod, checker, freshDir } from './_helper.mjs'

const { harvestChannel, harvestChannels } = await import(mod('src/sources/alioth/harvest.mjs'))
const { ALIOTH_BY_ID } = await import(mod('src/sources/alioth/channels.mjs'))
const { harvestNanokaChannels, resetManifestCache } = await import(mod('src/sources/nanoka/harvest.mjs'))
const { NANOKA_BY_ID } = await import(mod('src/sources/nanoka/channels.mjs'))
const { harvestImages } = await import(mod('src/images/store.mjs'))
const { check, finish } = checker()

const json = (value) => ({ ok: true, status: 200, text: JSON.stringify(value), lastModified: 'Mon, 09 Nov 2026 00:00:00 GMT' })
const missing = { ok: false, status: 503, text: '', error: 'synthetic 503' }
const tail = (url) => String(url).split('/').pop()

console.log('=== ① TextMap 目录分隔符 ===')
{
  const dataDir = freshDir('textmap')
  const calls = []
  const result = await harvestChannel(ALIOTH_BY_ID.get('alioth:textmap:gi'), {
    dataDir,
    delay: false,
    fetchImpl: async (url) => {
      calls.push(url)
      return url === 'https://json.alioth.wiki/TextMap/GI/TextMap.json' ? json({ hello: 'world' }) : missing
    }
  })
  check('请求的是带目录的正规地址', result.status === 'ok' && result.fetched === 1, `fetched=${result.fetched}`)
  check('URL 里没有 TextMapGI 这种粘连', calls.every((url) => !url.includes('TextMapGI')), calls[0])
}

console.log('\n=== ② 失败期在上游恢复后要补抓（索引没变也要抓）===')
{
  const dataDir = freshDir('alioth-resume')
  const channel = ALIOTH_BY_ID.get('alioth:gi:abyss')
  let recover = false
  const fetchImpl = async (url) => {
    if (url.endsWith('/abyss.json')) return json({ Phases: [{ _id: 1, Ver: '7.2', Time: '2026/11/01 - 2026/11/30' }] })
    return recover ? json({ _id: 1, marker: 'recovered' }) : missing
  }
  const first = await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  recover = true
  const second = await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  const file = path.join(dataDir, 'records/gi/alioth/abyss/1.json')
  check('第一轮失败并记了 error', first[0].status === 'failed' && Boolean(first[0].error), first[0].error)
  check('第二轮索引相同但补抓成功', second[0].fetched === 1 && fs.existsSync(file), `fetched=${second[0].fetched}`)
}
{
  const dataDir = freshDir('alioth-phase-keep')
  const channel = ALIOTH_BY_ID.get('alioth:gi:abyss')
  let stage = 'initial'
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/abyss.json')) {
      return json({
        Phases: [
          { _id: 1, Ver: '7.2', Time: '2026/11/01 - 2026/11/30' },
          { _id: 2, Ver: stage === 'initial' ? '7.2' : '7.3', Time: '2026/12/01 - 2026/12/30' }
        ]
      })
    }
    void options
    if (stage === 'failed' && url.endsWith('/2.json')) return missing
    return json({ _id: url.endsWith('/1.json') ? 1 : 2, marker: stage })
  }
  await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  stage = 'failed'
  await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  const old = JSON.parse(fs.readFileSync(path.join(dataDir, 'records/gi/alioth/abyss/2.json'), 'utf8'))
  const failedManifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'))
  check('更新失败时保留旧文件', old.marker === 'initial', old.marker)
  check('失败期不前进版本（仍记 7.2）', failedManifest.channels[channel.id].phaseVersions['2'] === '7.2',
    failedManifest.channels[channel.id].phaseVersions['2'])

  stage = 'recovered'
  const calls = []
  await harvestChannels([channel], {
    dataDir,
    delay: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options?.headers || {} })
      return fetchImpl(url, options)
    }
  })
  const current = JSON.parse(fs.readFileSync(path.join(dataDir, 'records/gi/alioth/abyss/2.json'), 'utf8'))
  const phaseCalls = calls.filter((c) => c.url.includes('/abyss/')).map((c) => tail(c.url))
  check('恢复后补到了新内容', current.marker === 'recovered', current.marker)
  check('只重抓失败那期，健康期不重抓', phaseCalls.join(',') === '2.json', phaseCalls.join(','))
  check('未完成的频道不发 if-modified-since', !calls[0].headers['if-modified-since'])

  const skipped = await harvestChannels([channel], {
    dataDir,
    delay: false,
    fetchImpl: async (url, options) => {
      if (!url.endsWith('/abyss.json') || !options?.headers?.['if-modified-since']) {
        throw new Error('健康频道应带 if-modified-since')
      }
      return { ok: false, status: 304 }
    }
  })
  check('完整成功后的 304 仍按跳过处理', skipped[0].status === 'skipped', skipped[0].status)
}
{
  const dataDir = freshDir('alioth-partial')
  const channel = ALIOTH_BY_ID.get('alioth:gi:monster')
  let recover = false
  const fetchImpl = async (url) => {
    if (url.endsWith('/monster.json')) return json({ Templates: { 101: {}, 102: {} } })
    return url.endsWith('/101.json') || recover ? json({ _id: url.endsWith('/101.json') ? 101 : 102 }) : missing
  }
  await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  recover = true
  const second = await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  check('部分 ids 失败后，索引不变也要补抓', second[0].fetched > 0
    && fs.existsSync(path.join(dataDir, 'records/gi/alioth/monster/102.json')), `fetched=${second[0].fetched}`)
}

console.log('\n=== ③ 详情失败保留旧 detail，恢复后补回 ===')
{
  resetManifestCache()
  const dataDir = freshDir('nanoka-detail')
  const channel = NANOKA_BY_ID.get('nanoka:zzz:boss')
  let stage = 'initial'
  const fetchImpl = async (url) => {
    if (url.endsWith('/manifest.json')) return json({ zzz: { latest: '2.4' } })
    if (url.endsWith('/boss.json')) return json({ 69001: { zh: stage === 'initial' ? 'old-name' : 'new-name' } })
    return stage === 'initial' ? json({ modes: ['old-detail'] }) : missing
  }
  await harvestNanokaChannels([channel], { dataDir, delay: false, fetchImpl, withDetails: true })

  stage = 'unavailable'
  const failed = await harvestNanokaChannels([channel], { dataDir, delay: false, fetchImpl, withDetails: true })
  const afterFailure = JSON.parse(fs.readFileSync(path.join(dataDir, 'records/zzz/nanoka/boss/69001.json'), 'utf8'))
  check('详情失败时旧 detail 仍在', afterFailure.detail?.modes?.[0] === 'old-detail', String(afterFailure.detail?.modes?.[0]))
  check('摘要仍更新为新名字', afterFailure.zh === 'new-name', afterFailure.zh)
  check('详情失败记进 error（驱动下一轮重试）', Boolean(failed[0].error), failed[0].error)

  stage = 'recovery'
  await harvestNanokaChannels([channel], {
    dataDir,
    delay: false,
    withDetails: true,
    fetchImpl: async (url) => {
      if (url.endsWith('/manifest.json')) return json({ zzz: { latest: '2.4' } })
      if (url.endsWith('/boss.json')) return json({ 69001: { zh: 'new-name' } })
      return json({ modes: ['new-detail'] })
    }
  })
  const afterRecovery = JSON.parse(fs.readFileSync(path.join(dataDir, 'records/zzz/nanoka/boss/69001.json'), 'utf8'))
  check('恢复后补回新 detail', afterRecovery.detail?.modes?.[0] === 'new-detail', String(afterRecovery.detail?.modes?.[0]))
}
{
  resetManifestCache()
  const dataDir = freshDir('nanoka-304')
  const channel = NANOKA_BY_ID.get('nanoka:zzz:boss')
  await harvestNanokaChannels([channel], {
    dataDir,
    delay: false,
    withDetails: true,
    fetchImpl: async (url) => (url.endsWith('/manifest.json')
      ? json({ zzz: { latest: '2.4' } })
      : url.endsWith('/boss.json') ? json({ 69001: { zh: 'healthy' } }) : json({ modes: ['healthy'] }))
  })
  const calls = []
  const skipped = await harvestNanokaChannels([channel], {
    dataDir,
    delay: false,
    withDetails: true,
    fetchImpl: async (url, options) => {
      calls.push(url)
      if (!url.endsWith('/boss.json') || !options?.headers?.['if-modified-since']) {
        throw new Error('健康频道应带 if-modified-since')
      }
      return { ok: false, status: 304 }
    }
  })
  check('健康的 nanoka 频道仍支持 304 跳过', skipped[0].status === 'skipped' && calls.length === 1, `calls=${calls.length}`)
}

console.log('\n=== ③b 台账只保留上游仍列出的期 ===')
{
  const dataDir = freshDir('phase-versions-prune')
  const channel = ALIOTH_BY_ID.get('alioth:gi:abyss')
  let listed = [1, 2, 3]
  const fetchImpl = async (url) => {
    if (url.endsWith('/abyss.json')) {
      return json({
        Phases: listed.map((id) => ({ _id: id, Ver: `7.${id}`, Time: '2026/11/01 - 2026/11/30' }))
      })
    }
    const id = Number(tail(url).replace('.json', ''))
    return json({ _id: id, marker: `phase-${id}` })
  }
  const first = await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  const versionsAfterFirst = Object.keys(first[0].phaseVersions).sort()
  check('三轮期都记进台账', versionsAfterFirst.join(',') === '1,2,3', versionsAfterFirst.join(','))

  // 上游删掉 2 和 3 → 台账里也不该再有
  listed = [1]
  const second = await harvestChannels([channel], { dataDir, delay: false, fetchImpl })
  const versionsAfterSecond = Object.keys(second[0].phaseVersions).sort()
  check('上游删掉的期从台账清除（用户观测点）', versionsAfterSecond.join(',') === '1', versionsAfterSecond.join(','))
  check('保留下来的期仍带原版本', second[0].phaseVersions['1'] === '7.1', String(second[0].phaseVersions['1']))

  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'))
  check('落盘台账同样已清理',
    Object.keys(manifest.channels[channel.id].phaseVersions).join(',') === '1',
    Object.keys(manifest.channels[channel.id].phaseVersions).join(','))
}

console.log('\n=== ④ 图片候选调度 ===')
{
  const dataDir = freshDir('image-fallback')
  const calls = []
  const refs = [{ recordId: '1', fieldPath: 'icon', originalValue: 'A', candidates: ['https://cdn.example/first.webp', 'https://cdn.example/fallback.webp'] }]
  const out = await harvestImages(refs, {
    dataDir,
    fetchImpl: async (url) => {
      calls.push(url)
      return { ok: true, status: 200, buffer: Buffer.from(url), contentType: 'image/webp' }
    }
  })
  check('首选成功就不再请求备选', calls.length === 1 && out.refs[0].remoteUrl === refs[0].candidates[0], `calls=${calls.length}`)
}
{
  const dataDir = freshDir('image-shared')
  const calls = []
  const url = 'https://cdn.example/shared.webp'
  const refs = [1, 2].map((id) => ({ recordId: String(id), fieldPath: 'icon', originalValue: 'A', candidates: [url] }))
  const out = await harvestImages(refs, {
    dataDir,
    concurrency: 2,
    fetchImpl: async (target) => {
      calls.push(target)
      return { ok: true, status: 200, buffer: Buffer.from('shared-image'), contentType: 'image/webp' }
    }
  })
  check('两条引用共用同一个 URL 只请求一次、落一个文件',
    calls.length === 1 && out.stats.downloaded === 1 && out.refs[0].localPath === out.refs[1].localPath,
    `calls=${calls.length} downloaded=${out.stats.downloaded}`)
}

finish()