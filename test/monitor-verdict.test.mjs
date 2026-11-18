// 源监控的判定口径：`absent` 是上游 404 的正常状态，不能把监控判红
//
// 背景：每周全量在 2026-11-18 首次手动运行时被判红，唯一原因是 `lunaris:gi:quest` 为 `absent`
// （Lunaris 的 chapterlist 本来就没发布，接入时按 absent 记录并保留旧数据）。本套件锁住三档口径。
import { mod, checker } from './_helper.mjs'

const { verdictOf } = await import(mod('tools/validate-sources.mjs'))
const { check, finish } = checker()

const row = (id, status, records) => ({ id, status, records })

console.log('=== 三档判定 ===')
{
  const all = [row('a', 'ok', 10), row('b', 'ok', 0 + 5)]
  const verdict = verdictOf({ exit: 0, rows: all })
  check('全部 ok → green', verdict.level === 'green')
}

{
  const verdict = verdictOf({ exit: 0, rows: [row('a', 'ok', 1), row('b', 'failed', 0)] })
  check('有 failed → red', verdict.level === 'red' && verdict.broken.map((r) => r.id).join(',') === 'b')
}

{
  const verdict = verdictOf({ exit: 0, rows: [row('a', 'ok', 1), row('b', 'missing', 0)] })
  check('没写进台账 → red', verdict.level === 'red' && verdict.broken.map((r) => r.id).join(',') === 'b')
}

{
  const verdict = verdictOf({ exit: 0, rows: [row('a', 'ok', 1), row('b', 'ok', 0)] })
  check('有频道 0 条 → yellow', verdict.level === 'yellow' && verdict.empty.map((r) => r.id).join(',') === 'b')
}

console.log('=== absent 是正常状态 ===')
{
  const rows = [row('nanoka:gi:character', 'ok', 154), row('lunaris:gi:quest', 'absent', 0)]
  const verdict = verdictOf({ exit: 0, rows })
  check('只有 absent → green（不判红）', verdict.level === 'green', verdict.level)
  check('absent 单独列出', verdict.absent.map((r) => r.id).join(',') === 'lunaris:gi:quest')
  check('absent 不算 broken/empty', verdict.broken.length === 0 && verdict.empty.length === 0)
}

{
  const rows = [row('a', 'failed', 0), row('b', 'absent', 0)]
  const verdict = verdictOf({ exit: 0, rows })
  check('failed + absent 同时存在 → 仍红，且 absent 不被当成原因', verdict.level === 'red'
    && verdict.broken.map((r) => r.id).join(',') === 'a' && verdict.absent.length === 1)
}

console.log('=== 退出码 ===')
{
  const verdict = verdictOf({ exit: 1, rows: [row('a', 'ok', 1)] })
  check('CLI 退出码非 0 → red（即使频道都 ok）', verdict.level === 'red')
}

finish()