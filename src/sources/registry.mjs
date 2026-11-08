/**
 * 数据源注册表：统一频道清单与抓取分发
 *
 * 调用方只与这里打交道：拿到全部频道 → 自行筛选 → 交给 `harvestSelected`。
 * 各源的差异（端点、版本、增量判据）都封在 `sources/<源>/` 内。
 */
import { ALIOTH_CHANNELS, ALIOTH_ENDGAME_CHANNELS } from './alioth/channels.mjs'
import { NANOKA_CHANNELS } from './nanoka/channels.mjs'
import { harvestChannels as harvestAliothChannels } from './alioth/harvest.mjs'
import { harvestNanokaChannels } from './nanoka/harvest.mjs'

/** 全部频道（玉璃 + nanoka） */
export const ALL_CHANNELS = [...ALIOTH_CHANNELS, ...NANOKA_CHANNELS]

/** 频道 id → 定义 */
export const CHANNEL_BY_ID = new Map(ALL_CHANNELS.map((channel) => [channel.id, channel]))

/** 玉璃侧的终局频道 id（nanoka 终局页保留作期时间交叉校验，不在这个集合里） */
export const ENDGAME_CHANNEL_IDS = [...ALIOTH_ENDGAME_CHANNELS]

/** 绝区零频道（玉璃没有绝区零，切后端时必须整组带上） */
export const ZZZ_CHANNEL_IDS = NANOKA_CHANNELS.filter((channel) => channel.game === 'zzz').map((channel) => channel.id)

/**
 * 按源分发抓取
 * @param {object[]} channels
 * @param {object} options - 透传各源；`withDetails` 只对 nanoka 生效
 * @returns {Promise<object[]>}
 */
export async function harvestSelected (channels, options) {
  const nanoka = channels.filter((channel) => channel.source === 'nanoka')
  const alioth = channels.filter((channel) => channel.source !== 'nanoka')
  const results = []
  if (alioth.length) results.push(...await harvestAliothChannels(alioth, options))
  if (nanoka.length) results.push(...await harvestNanokaChannels(nanoka, options))
  return results
}
