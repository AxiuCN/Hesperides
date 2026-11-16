import fs from 'node:fs'

globalThis.fetch = async input => {
  const url = String(input)
  const file = url.endsWith('/data/versions.json') ? 'db-versions.json'
    : url.endsWith('/data/artifactlist.json') ? 'artifacts.json' : null
  return file ? new Response(fs.readFileSync(new URL(file, import.meta.url)), {
    status: 200, headers: { 'content-type': 'application/json', 'last-modified': 'Mon, 09 Nov 2026 00:00:00 GMT' }
  }) : new Response(null, { status: 404 })
}
