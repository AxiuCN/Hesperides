// `--verify` 的完整性边界：硬失败（产物读不了 / 指向不存在的东西）与只报告（数量对不上）
//
// 早先 verify 只校验 index 的 schema 并打印期页列表，记录文件缺失、图片引用指向已删文件
// 都照样「校验通过」。本套件同时锁住「该红的要红」和「不该红的别红」——
// 真实产物里本来就有上千条占位引用，把这类瑕疵判死会让这个命令失去意义。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rootDir, freshDir, checker } from './_helper.mjs'

const { check, finish } = checker()

/**
 * 造一份最小可用产物
 * @param {{records?: number, withManifest?: boolean, withImages?: boolean, channelStatus?: string, manifestRecords?: number}} [opts]
 */
function build (opts = {}) {
  const { records = 2, withManifest = true, withImages = true, channelStatus = 'ok', manifestRecords } = opts
  const dir = freshDir(`verify-${Math.random().toString(16).slice(2, 8)}`)
  const write = (rel, value) => {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
  write('index.json', {
    schemaVersion: 2,
    games: { gi: { channels: { 'nanoka:gi:character': 'ok' }, sources: { nanoka: { pages: { character: { records } } } } } }
  })
  write('periods.json', {
    schemaVersion: 2,
    games: { gi: { nanoka: { character: [{ id: '1', no: 1, begin: '2026-01-01', end: '2026-02-01' }] } } }
  })
  if (withManifest) {
    write('manifest.json', {
      channels: {
        'nanoka:gi:character': {
          source: 'nanoka', game: 'gi', page: 'character',
          status: channelStatus, records: manifestRecords ?? records
        }
      }
    })
  }
  for (let i = 1; i <= records; i++) write(`records/gi/nanoka/character/${i}.json`, { id: i })
  if (withImages) {
    write('images/gi/AvatarIcon/a.webp', 'fake-bytes')
    write('imagerefs/gi/nanoka/character.json', {
      schemaVersion: 2,
      records: {
        1: [{ fieldPath: 'icon', localPath: 'images/gi/AvatarIcon/a.webp', placeholder: false }],
        2: [{ fieldPath: 'derived.mindscape.1', localPath: 'images/_placeholder/unknown.svg', placeholder: true }]
      }
    })
    write('images/_placeholder/unknown.svg', '<svg/>')
  }
  return { dir, write }
}

/** 跑一次 --verify --json */
function run (dir) {
  const result = spawnSync(process.execPath, [path.join(rootDir, 'src/cli.mjs'), '--verify', '--json', '--data-dir', dir], {
    cwd: rootDir, encoding: 'utf8'
  })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {}
  return { exit: result.status, json, stdout: result.stdout, stderr: result.stderr }
}

console.log('=== ① 完好的产物：通过且不误报 ===')
{
  const { dir } = build()
  const res = run(dir)
  check('exit 0', res.exit === 0, `exit=${res.exit} stderr=${res.stderr.slice(0, 80)}`)
  check('没有硬失败', Array.isArray(res.json?.problems) && res.json.problems.length === 0,
    JSON.stringify(res.json?.problems))
  check('索引契约标记通过', res.json?.indexOk === true)
  check('统计到记录、期、图片引用', res.json?.channels?.ok === 1 && res.json?.periods === 1 && res.json?.images?.refs === 2,
    JSON.stringify(res.json?.images))
  check('占位引用不判死', res.json?.images?.placeholder === 1 && res.json.images.missing === 0)
}

console.log('\n=== ② 硬失败：产物指向不存在的东西 ===')
{
  const { dir } = build()
  fs.rmSync(path.join(dir, 'records/gi/nanoka/character'), { recursive: true, force: true })
  const res = run(dir)
  check('记录目录缺失 → exit 1', res.exit === 1, `exit=${res.exit}`)
  check('指出缺失的频道', String(res.json?.problems?.[0]).includes('记录目录缺失'), res.json?.problems?.[0])
}
{
  const { dir } = build()
  for (const name of fs.readdirSync(path.join(dir, 'records/gi/nanoka/character'))) {
    fs.rmSync(path.join(dir, 'records/gi/nanoka/character', name))
  }
  const res = run(dir)
  check('记录目录为空 → exit 1', res.exit === 1 && String(res.json?.problems?.[0]).includes('记录目录为空'),
    res.json?.problems?.[0])
}
{
  const { dir } = build()
  fs.rmSync(path.join(dir, 'images/gi/AvatarIcon/a.webp'))
  const res = run(dir)
  check('图片引用指向已删文件 → exit 1', res.exit === 1, `exit=${res.exit}`)
  check('指出缺失的 localPath', String(res.json?.problems?.[0]).includes('images/gi/AvatarIcon/a.webp'),
    res.json?.problems?.[0])
}
{
  const { dir, write } = build()
  write('periods.json', { schemaVersion: 2, games: { gi: { nanoka: { character: 'oops' } } } })
  const res = run(dir)
  check('期表页不是数组 → exit 1', res.exit === 1 && String(res.json?.problems?.[0]).includes('不是数组'),
    res.json?.problems?.[0])
}
{
  const { dir, write } = build()
  write('periods.json', { schemaVersion: 1, games: {} })
  const res = run(dir)
  check('期表 schema 版本不符 → exit 1', res.exit === 1 && String(res.json?.problems?.[0]).includes('schemaVersion'),
    res.json?.problems?.[0])
}
{
  // 真实产物里有三个 records 0 的 hsr 频道（上游页面是空数组，从来没建过目录）
  const { dir } = build({ records: 0, withImages: false })
  const res = run(dir)
  check('空页（records 0）不要求记录目录 → exit 0', res.exit === 0, `exit=${res.exit} ${res.json?.problems?.[0]}`)
}
{
  // skipped = 上游没变、沿用上一轮记录，同样必须有记录文件
  const { dir } = build({ channelStatus: 'skipped' })
  fs.rmSync(path.join(dir, 'records/gi/nanoka/character'), { recursive: true, force: true })
  const res = run(dir)
  check('skipped 频道同样校验记录目录', res.exit === 1 && String(res.json?.problems?.[0]).includes('记录目录缺失'),
    res.json?.problems?.[0])
}

console.log('\n=== ③ 只报告：不该红的别红 ===')
{
  const { dir } = build({ manifestRecords: 5 })
  const res = run(dir)
  check('台账与文件数不符 → 仍 exit 0', res.exit === 0, `exit=${res.exit}`)
  check('但记进 notes', (res.json?.notes || []).some((n) => n.includes('记录数不符')),
    JSON.stringify(res.json?.notes))
}
{
  const { dir } = build({ channelStatus: 'failed' })
  const res = run(dir)
  check('上一轮失败频道 → 仍 exit 0', res.exit === 0, `exit=${res.exit}`)
  check('但记进 notes', (res.json?.notes || []).some((n) => n.includes('上一轮失败')),
    JSON.stringify(res.json?.notes))
}
{
  const { dir } = build({ withManifest: false, withImages: false })
  const res = run(dir)
  check('只 --export 过（无台账 / 无图片）→ exit 0', res.exit === 0, `exit=${res.exit}`)
  const notes = res.json?.notes || []
  check('分别提示缺台账与缺图片引用', notes.some((n) => n.includes('manifest')) && notes.some((n) => n.includes('imagerefs')),
    JSON.stringify(notes))
}

console.log('\n=== ④ 人类可读输出 ===')
{
  const { dir } = build()
  const plain = spawnSync(process.execPath, [path.join(rootDir, 'src/cli.mjs'), '--verify', '--data-dir', dir], {
    cwd: rootDir, encoding: 'utf8'
  })
  check('通过时打印「校验通过」', plain.status === 0 && plain.stdout.includes('校验通过'))
  check('打印频道与图片统计', plain.stdout.includes('频道：') && plain.stdout.includes('图片：'))
  check('打印用时（低配机器据此判断开销）', /用时 \d+ms/.test(plain.stdout), plain.stdout.split('\n').pop())
}

finish()