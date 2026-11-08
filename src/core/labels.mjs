/**
 * 记录级元数据抽取（各源字段名不同，统一在这里兜底）
 *
 * 用途：导出 `index.json` 时给每条记录带一个轻量 `{ name, rarity }`，
 * 让消费者（如 Atlas-Plugin）不用读全量记录就能建索引。
 */

/**
 * 取展示名（玉璃用 `Name`/`name`，nanoka 用 `zh`）
 * @param {object} record
 * @returns {string}
 */
export function pickRecordName (record) {
  if (!record || typeof record !== 'object') return ''
  for (const key of ['Name', 'name', 'zh', 'Title', 'title']) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
    // 绝区零驱动盘这类页的 zh 是 { name, desc2, desc4 }，取里面的 name
    if (value && typeof value === 'object') {
      for (const sub of ['name', 'Name', 'zh', 'title', 'Title']) {
        if (typeof value[sub] === 'string' && value[sub]) return value[sub]
      }
    }
  }
  return ''
}

/**
 * 取稀有度（各源字段名不同；数组取最大值）
 * @param {object} record
 * @returns {number|string}
 */
export function pickRecordRarity (record) {
  if (!record || typeof record !== 'object') return ''
  for (const key of ['Rarity', 'rarity', 'rank', 'Rank', 'star']) {
    const value = record[key]
    if (typeof value === 'number') return value
    if (Array.isArray(value) && value.length) return Math.max(...value.filter((n) => typeof n === 'number'))
  }
  return ''
}
