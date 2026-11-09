/**
 * Hesperides 数据契约（schema v2）
 *
 * 产物结构：
 *   data/index.json      频道状态 + 每源每页的记录 id 列表（不含正文）
 *   data/periods.json    期索引（终局类频道）
 *   data/manifest.json   每频道的增量判据（hash / lastModified / 记录数）
 *   data/records/<game>/<page>/<id>.json   单条记录的原始数据
 *
 * schemaVersion 由本模块定义并写入产物；**不是从数据推导**。插件读到不兼容版本应拒绝加载。
 * 何时 +1：字段重命名 / 删除 / 语义变化 / 新增必填字段。纯新增可选字段不加。
 */

export const SCHEMA_VERSION = 2

/** 频道状态取值 */
export const CHANNEL_STATUS = Object.freeze({
  OK: 'ok', // 抓取成功
  SKIPPED: 'skipped', // 内容未变，整频道跳过
  ABSENT: 'absent', // 上游 404（契约里有、线上没有）
  FAILED: 'failed', // 本轮失败，沿用旧数据
  UNVERIFIED: 'unverified' // 尚未验证 ID 来源，暂不抓
})

/**
 * 空索引骨架
 * @param {string} [generatedAt]
 */
export function emptyIndex (generatedAt = new Date().toISOString()) {
  return { schemaVersion: SCHEMA_VERSION, generatedAt, games: {} }
}

/**
 * 空期索引骨架
 * @param {string} [generatedAt]
 */
export function emptyPeriods (generatedAt = new Date().toISOString()) {
  return { schemaVersion: SCHEMA_VERSION, generatedAt, games: {} }
}

/**
 * 把期记录转换成期索引条目（统一口径：期号连续、版本与起止必填）
 * @param {object[]} periods - 已按开启时间升序
 * @param {string} source
 * @returns {{id: string, no: number, name: string, version: string, begin: string, end: string, source: string}[]}
 */
export function toPeriodEntries (periods, source) {
  return periods.map((period, index) => ({
    id: String(period.id),
    no: index + 1,
    name: period.name || '',
    version: period.version || '',
    begin: period.begin || '',
    end: period.end || '',
    source
  }))
}

/**
 * 校验产物是否可被当前版本的插件读取
 * @param {object} index
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateIndex (index) {
  if (!index || typeof index !== 'object') return { ok: false, reason: 'index 为空或不是对象' }
  if (index.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion=${index.schemaVersion}，当前只支持 ${SCHEMA_VERSION}` }
  }
  if (!index.games || typeof index.games !== 'object') return { ok: false, reason: '缺少 games 字段' }
  for (const [gameId, game] of Object.entries(index.games)) {
    if (!game.channels || typeof game.channels !== 'object') {
      return { ok: false, reason: `${gameId} 缺少 channels` }
    }
    // v2：页面挂在源下面，同源同页唯一，跨源同名页互不覆盖
    if (!game.sources || typeof game.sources !== 'object') {
      return { ok: false, reason: `${gameId} 缺少 sources（v2 起页面按源分组）` }
    }
    for (const [source, group] of Object.entries(game.sources)) {
      if (!group || typeof group.pages !== 'object') {
        return { ok: false, reason: `${gameId}.${source} 缺少 pages` }
      }
    }
  }
  return { ok: true }
}
