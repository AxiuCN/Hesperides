globalThis.fetch = async input => {
  const url = String(input)
  const headers = { 'last-modified': 'Mon, 09 Nov 2026 00:00:00 GMT' }
  if (url === 'https://json.alioth.wiki/data/gi/ch/monster.json') {
    return new Response('{"Templates":{"101":{},"102":{}}}', { status: 200, headers })
  }
  if (url === 'https://json.alioth.wiki/data/gi/ch/monster/101.json' && process.env.HESPERIDES_TEST_STAGE !== 'all-failed') {
    return new Response('{"_id":101,"Name":"healthy"}', { status: 200 })
  }
  if (url === 'https://json.alioth.wiki/data/gi/ch/monster/102.json' && process.env.HESPERIDES_TEST_STAGE === 'recovered') {
    return new Response('{"_id":102,"Name":"recovered"}', { status: 200 })
  }
  if (url.startsWith('https://json.alioth.wiki/data/gi/ch/monster/')) return new Response('synthetic unavailable', { status: 503 })
  throw new Error('unexpected synthetic route ' + url)
}
