/**
 * 玉璃数据规范化：期排序与时间纠错
 *
 * 上游实测存在两类缺陷（2026-11 抓取时发现）：
 *   ① 危战（stygian）6.4~6.7 四期的 `Time` 年份写成 2025（应为 2026），导致按时间排序时期号错位
 *   ② 个别期 `end` 早于 `begin`（同一年份笔误）
 *
 * 处理原则：
 *   - **期序按 `Ver` 排**（版本号单调增，与期号一致），同版本再按 `begin`
 *   - 时间只做"年份修正"：若某期 begin 早于前一期，尝试 +1/+2 年，取仍保持单调的最小修正
 *   - 任何被改动的期标 `timeCorrected: true`，原始值留在 `rawTime`，可审计
 *
 * 不改口径：`Ver` 仍然是上游标注的"覆盖版本"，**不换算成开启版本**。
 */

/**
 * 解析版本号用于排序（`7.2` / `4.6-4.7` / `1.0-1.1` → 取首个版本；无版本返回最大）
 * @param {string} version
 * @returns {[number, number]}
 */
export function versionKey (version) {
  const matched = String(version || '').match(/(\d+)\.(\d+)/)
  if (!matched) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  return [Number(matched[1]), Number(matched[2])]
}

/** 版本号比较 */
export function compareVersion (a, b) {
  const [a1, a2] = versionKey(a)
  const [b1, b2] = versionKey(b)
  return a1 - b1 || a2 - b2
}

/**
 * 年份加 n 年（保持月日）
 * @param {string} date - `YYYY-MM-DD`
 * @param {number} years
 * @returns {string}
 */
export function shiftYear (date, years) {
  const matched = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) return date
  const year = Number(matched[1]) + years
  const month = matched[2]
  const day = matched[3]
  // 2 月 29 日跨到平年时退到 28 日
  const lastDay = new Date(year, Number(month), 0).getDate()
  const safeDay = Math.min(Number(day), lastDay)
  return `${year}-${month}-${String(safeDay).padStart(2, '0')}`
}

/**
 * 规范化期列表：按版本排序 + 时间年份纠错
 * @param {{id: string, name: string, version: string, begin: string, end: string}[]} phases
 * @returns {object[]} 已排序并纠错（带 timeCorrected / rawTime 标记）
 */
export function normalizePhases (phases) {
  const list = phases.map((phase) => ({ ...phase }))

  list.sort((a, b) => compareVersion(a.version, b.version) || (a.begin || '').localeCompare(b.begin || ''))

  let previousBegin = ''
  for (const phase of list) {
    const rawBegin = phase.begin
    const rawEnd = phase.end

    // begin 早于前一期 → 尝试加年，取最小的可行偏移
    if (rawBegin && previousBegin && rawBegin < previousBegin) {
      for (const shift of [1, 2]) {
        const candidate = shiftYear(rawBegin, shift)
        if (candidate >= previousBegin) {
          phase.begin = candidate
          break
        }
      }
    }

    // end 早于 begin → 同样加年
    if (phase.begin && rawEnd && rawEnd < phase.begin) {
      for (const shift of [1, 2]) {
        const candidate = shiftYear(rawEnd, shift)
        if (candidate >= phase.begin) {
          phase.end = candidate
          break
        }
      }
    }

    if (phase.begin !== rawBegin || phase.end !== rawEnd) {
      phase.timeCorrected = true
      phase.rawTime = { begin: rawBegin, end: rawEnd }
    }
    if (phase.begin) previousBegin = phase.begin
  }

  return list
}
