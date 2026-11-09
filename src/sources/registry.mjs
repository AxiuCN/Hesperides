/**
 * 数据源注册表：统一频道清单与抓取分发
 *
 * **新增一个源只需动这里加一项**（外加 `sources/<源>/` 下的频道表与抓取器）：
 * 本模块按 `SOURCES` 遍历分发，不再对源名做二元判断。
 *
 * 调用方只与这里打交道：拿到全部频道 → 自行筛选 → 交给 `harvestSelected`。
 * 各源的差异（端点、版本、增量判据）都封在 `sources/<源>/` 内。
 */
import { ALIOTH_CHANNELS, ALIOTH_ENDGAME_CHANNELS } from './alioth/channels.mjs'
import { NANOKA_CHANNELS } from './nanoka/channels.mjs'
import { harvestChannels as harvestAliothChannels } from './alioth/harvest.mjs'
import { harvestNanokaChannels } from './nanoka/harvest.mjs'
import { sourceOf } from '../core/paths.mjs'

/**
 * 已注册的数据源。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `source` | 源标识，同时也是产物路径里的 `<source>` 段 |
 * | `channels` | 该源的全部频道定义 |
 * | `harvest` | 该源的抓取器 `(channels, options) => results` |
 * | `endgame` | （可选）该源里「终局玩法」的**频道 id 列表**，供消费者按玩法取期表 |
 *
 * 频道定义里没写 `source` 的（玉璃的历史写法）在这里统一补齐，
 * 之后各处读 `channel.source` 都可信，不必再用默认值兜。
 *
 * 待补的备用源按同样形状加一项即可；重复的页面会被 `schema` 按 `<source>` 分开存，
 * 不会互相覆盖，也不需要改任何抓取/导出逻辑。
 */
export const SOURCES = [
  {
    source: 'nanoka',
    channels: NANOKA_CHANNELS,
    harvest: harvestNanokaChannels
  },
  {
    source: 'alioth',
    channels: ALIOTH_CHANNELS.map((channel) => ({ ...channel, source: 'alioth' })),
    harvest: harvestAliothChannels,
    endgame: ALIOTH_ENDGAME_CHANNELS
  }
]

/** 源标识 → 注册项 */
export const SOURCE_BY_NAME = new Map(SOURCES.map((entry) => [entry.source, entry]))

/** 全部频道（所有已注册源） */
export const ALL_CHANNELS = SOURCES.flatMap((entry) => entry.channels)

/** 频道 id → 定义 */
export const CHANNEL_BY_ID = new Map(ALL_CHANNELS.map((channel) => [channel.id, channel]))

/** 全部「终局玩法」频道 id（来自各源注册项的可选 `endgame`，本身已是 id 列表） */
export const ENDGAME_CHANNEL_IDS = SOURCES.flatMap((entry) => entry.endgame || [])

/** 绝区零频道 id（按游戏筛，不绑定某个源——当前只有 nanoka 覆盖绝区零） */
export const ZZZ_CHANNEL_IDS = ALL_CHANNELS.filter((channel) => channel.game === 'zzz').map((channel) => channel.id)

/**
 * 按源分发抓取
 *
 * 按 `SOURCES` 的声明顺序逐个调用对应源的抓取器；不再假设「非 nanoka 即玉璃」。
 * @param {object[]} channels
 * @param {object} options - 透传各源；`withDetails` 只对支持详情的源生效
 * @returns {Promise<object[]>}
 */
export async function harvestSelected (channels, options) {
  const results = []
  for (const entry of SOURCES) {
    const subset = channels.filter((channel) => sourceOf(channel) === entry.source)
    if (!subset.length) continue
    results.push(...await entry.harvest(subset, options))
  }
  return results
}