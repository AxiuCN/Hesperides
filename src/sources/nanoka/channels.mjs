/**
 * nanoka.cc 频道表
 *
 * 端点规则（实测）：`https://static.nanoka.cc/{game}/{version}/{path}.json`
 *   - `{locale}` 段存在时按语言取，当前只取 `zh`
 *   - 版本取自 `https://static.nanoka.cc/manifest.json` 的 `[game].latest`
 *   - 页面内容是 **dict：记录 id → 记录对象**（部分页为数组）
 *   - 记录详情（如有）按 `detail` 模板再取一次
 *
 * 覆盖：上游**全部**页面（绝区零全部 + 原神/星铁全部，含终局页）。
 * 与玉璃重叠的页面**不裁剪**：同一份数据可能有多个消费者、不同用途，用哪一源由消费者决定；
 * gi 终局页的期时间可作玉璃的交叉校验，hsr 终局页的时间字段为空但条目仍可用。
 * 抓哪些频道仍由调用方决定，本表只描述"怎么抓"。
 */

export const NANOKA_BASE = 'https://static.nanoka.cc'
export const NANOKA_LANG = 'zh'

/** 各游戏要接的页面端点（与旧后端 dataEndpoints 对齐；不因与另一源重叠而裁剪） */
const PAGES = {
  zzz: [
    '{locale}/achievement/achievement',
    'character',
    'bangboo',
    'weapon',
    'equipment',
    'monster',
    '{locale}/item',
    '{locale}/item_all',
    'boss',
    'shiyu',
    'simul',
    '{locale}/hollow/tpp',
    '{locale}/hollow/card',
    '{locale}/hollow/gg',
    '{locale}/hollow/resonium'
  ],
  gi: [
    '{locale}/achievement/achievement',
    'character',
    'weapon',
    'artifact',
    'monster',
    'gcg',
    '{locale}/gcg/card',
    '{locale}/gcg/keyword',
    '{locale}/gcg/skill',
    'furniture',
    'suite',
    '{locale}/hyperlink',
    '{locale}/hyperlinkparam',
    '{locale}/item',
    '{locale}/item_all',
    '{locale}/beyond/lang_map',
    '{locale}/beyond/item',
    '{locale}/beyond/item_all',
    '{locale}/beyond/costume',
    '{locale}/beyond/costume_all',
    '{locale}/beyond/costume_suit',
    '{locale}/beyond/costume_suit_all',
    // 终局三页保留：不裁剪（消费者自行取舍），gi 的期时间可作交叉校验
    'leyline',
    'rolecombat',
    'tower'
  ],
  hsr: [
    '{locale}/achievement/achievement',
    'character',
    'lightcone',
    'relicset',
    'monster',
    '{locale}/item',
    '{locale}/item_all',
    '{locale}/currency/augment',
    '{locale}/currency/buff',
    '{locale}/currency/item',
    '{locale}/currency/role',
    '{locale}/currency/trait',
    'maze_boss',
    'maze',
    '{locale}/maze/version',
    'maze_peak',
    '{locale}/peak/version',
    'maze_extra',
    'monstervalue',
    'EliteGroup',
    'HardLevelGroup',
    'InfiniteEliteGroup'
  ]
}

/** 详情端点模板（与旧后端 detailEndpointPatterns 对齐；键为页面的原始 key） */
const DETAIL_PATTERNS = {
  zzz: {
    character: '{locale}/character/{id}.json',
    bangboo: '{locale}/bangboo/{id}.json',
    weapon: '{locale}/weapon/{id}.json',
    equipment: '{locale}/equipment/{id}.json',
    monster: '{locale}/monster/{id}.json',
    boss: '{locale}/boss/{id}.json',
    shiyu: '{locale}/shiyu/{id}.json',
    simul: '{locale}/simul/{id}.json'
  },
  gi: {
    character: '{locale}/character/{id}.json',
    weapon: '{locale}/weapon/{id}.json',
    artifact: '{locale}/artifact/{id}.json',
    monster: '{locale}/monster/{id}.json',
    leyline: '{locale}/leyline/{id}.json',
    rolecombat: '{locale}/rolecombat/{id}.json',
    tower: '{locale}/tower/{id}.json'
  },
  hsr: {
    character: '{locale}/character/{id}.json',
    lightcone: '{locale}/lightcone/{id}.json',
    relicset: '{locale}/relicset/{id}.json',
    monster: '{locale}/monster/{id}.json',
    'currency/role': '{locale}/currency/role/{id}.json',
    maze_boss: '{locale}/boss/{id}.json',
    maze: '{locale}/maze/{id}.json',
    maze_peak: '{locale}/peak/{id}.json',
    maze_extra: '{locale}/story/{id}.json'
  }
}

/**
 * 端点 → 页面 key（保留斜杠，用于查详情模板）
 * @param {string} endpoint
 * @returns {string}
 */
export function pageKeyOf (endpoint) {
  return endpoint.replace(/^\{locale\}\//, '')
}

/**
 * 页面 key → 频道 id 与目录名（斜杠换成 `-`）
 * @param {string} pageKey
 * @returns {string}
 */
export function pageDir (pageKey) {
  return pageKey.replace(/\//g, '-')
}

/**
 * 生成 nanoka 频道定义
 * @returns {object[]}
 */
export function buildNanokaChannels () {
  const channels = []
  for (const [game, endpoints] of Object.entries(PAGES)) {
    for (const endpoint of endpoints) {
      const pageKey = pageKeyOf(endpoint)
      const detail = DETAIL_PATTERNS[game]?.[pageKey] || null
      channels.push({
        id: `nanoka:${game}:${pageDir(pageKey)}`,
        source: 'nanoka',
        game,
        page: pageDir(pageKey),
        pageKey,
        endpoint,
        detail,
        kind: 'page',
        versionSource: 'manifest'
      })
    }
  }
  return channels
}

export const NANOKA_CHANNELS = buildNanokaChannels()

/** 频道 id → 定义 */
export const NANOKA_BY_ID = new Map(NANOKA_CHANNELS.map((channel) => [channel.id, channel]))

/** 绝区零全部频道（玉璃没有绝区零，切后端时这一组是必须的） */
export const NANOKA_ZZZ_CHANNELS = NANOKA_CHANNELS.filter((channel) => channel.game === 'zzz').map((channel) => channel.id)
