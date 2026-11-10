import fs from 'node:fs'
import path from 'node:path'
import { mod, freshDir, checker } from './_helper.mjs'

const { fetchText } = await import(mod('src/core/io.mjs'))
const { harvestChannels } = await import(mod('src/sources/alioth/harvest.mjs'))
const { ALIOTH_BY_ID } = await import(mod('src/sources/alioth/channels.mjs'))
const { harvestNanokaChannels, resetManifestCache } = await import(mod('src/sources/nanoka/harvest.mjs'))
const { NANOKA_BY_ID } = await import(mod('src/sources/nanoka/channels.mjs'))
const { check, finish } = checker()
const fast = { retries: 2, retryDelayMs: 1 }
const response = (status, text = '{}') => new Response(status === 304 ? null : text, { status, headers: { 'last-modified': 'Mon, 09 Nov 2026 00:00:00 GMT' } })
const originalFetch = globalThis.fetch
const rows = []
for (const statuses of [[200], [403], [404], [503, 200], [503], [304]]) {
  let calls = 0
  globalThis.fetch = async () => response(statuses[Math.min(calls++, statuses.length - 1)], 'healthy')
  const result = await fetchText('https://fixture.invalid/text', fast)
  rows.push({ statuses, calls, result })
  const expectedCalls = statuses[0] === 503 ? (statuses.length === 1 ? 3 : 2) : 1
  const expectedStatus = statuses[0] === 503 ? (statuses.length === 1 ? 0 : 200) : statuses[0]
  check(`文本HTTP ${statuses.join('→')} 保持状态与请求次数`, calls === expectedCalls && result.status === expectedStatus && result.ok === (expectedStatus === 200), JSON.stringify(rows.at(-1)))
}
for (const source of ['alioth', 'nanoka']) {
  const dataDir = freshDir('conditional-' + source)
  const calls = []
  let stage = 'initial'
  resetManifestCache()
  globalThis.fetch = async (url, options) => {
    calls.push({ url, stage, conditional: Boolean(options?.headers?.['if-modified-since']) })
    if (url.endsWith('/manifest.json')) return response(200, '{"gi":{"latest":"7.2"}}')
    if (url.endsWith('/monster.json')) return response(stage === 'conditional' ? 304 : 200, '{"Templates":{"101":{}}}')
    if (url.endsWith('/monster/101.json')) return response(200, '{"_id":101}')
    if (url.endsWith('/zh/item.json')) return response(stage === 'conditional' ? 304 : 200, '{"1":{"zh":"fixture"}}')
    throw new Error('unexpected fixture route ' + url)
  }
  const options = { dataDir, delay: false, fetchImpl: (url, options) => fetchText(url, { ...options, ...fast }) }
  const run = source === 'alioth' ? harvestChannels : harvestNanokaChannels
  const channel = source === 'alioth' ? ALIOTH_BY_ID.get('alioth:gi:monster') : NANOKA_BY_ID.get('nanoka:gi:item')
  const first = await run([channel], options)
  check(`${source} 真实文本传输首轮采集成功`, first[0].status === 'ok' && first[0].fetched === 1)
  stage = 'conditional'
  const second = await run([channel], options)
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')).channels[channel.id]
  const requests = calls.filter(call => call.stage === 'conditional')
  const row = { source, result: second[0], requests, manifest }
  rows.push(row)
  check(`${source} 条件增量304只请求一次并保留旧记录`, second[0].status === 'skipped' && requests.length === 1 && requests[0].conditional && manifest.records === 1 && manifest.status === 'skipped', JSON.stringify(row))
}
globalThis.fetch = originalFetch
console.log('CONDITIONAL_HTTP_RESULTS=' + JSON.stringify(rows))
finish()
