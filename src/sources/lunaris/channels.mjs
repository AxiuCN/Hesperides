/** Lunaris 官网已公开的原神目录与详情模板。版本由 version.json 或调用方显式指定。 */
export const LUNARIS_BASE = 'https://api.lunaris.moe/data'
export const LUNARIS_SITE_BASE = 'https://lunaris.moe/data'
export const LUNARIS_LANG = 'chs'

const PAGES = [
  { page: 'character', endpoint: 'charlist.json', detail: '{locale}/char/{id}.json' },
  { page: 'weapon', endpoint: 'weaponlist.json', detail: '{locale}/weapon/{id}.json' },
  { page: 'artifact', endpoint: 'artifactlist.json', detail: '{locale}/artifact/{id}.json' },
  { page: 'item', endpoint: 'materiallist.json' },
  { page: 'monster', endpoint: 'monsterlist.json', detail: '{locale}/monster/{id}.json' },
  { page: 'tower', endpoint: 'towerlist.json', detail: '{locale}/tower/{id}.json', period: { begin: 'openTime', end: 'closeTime' } },
  { page: 'rolecombat', endpoint: 'roleplaylist.json', detail: '{locale}/roleplay/{id}.json', period: { begin: 'beginTime', end: 'endTime' } },
  { page: 'tutorial', endpoint: 'tutoriallist.json', detail: '{locale}/tutorial/{id}.json' },
  { page: 'achievement', endpoint: 'achievementlist.json', detail: '{locale}/goals/{id}.json' },
  { page: 'tpsweapon', endpoint: 'tpsweaponlist.json', detail: '{locale}/tpsweapon/{id}.json' },
  { page: 'event', endpoint: 'eventlist.json' },
  { page: 'quest', endpoint: 'chapterlist.json' }
]

export const LUNARIS_CHANNELS = PAGES.map(definition => ({
  ...definition,
  id: `lunaris:gi:${definition.page}`,
  source: 'lunaris',
  game: 'gi',
  pageKey: definition.page,
  kind: 'page',
  versionSource: 'version.json'
}))

LUNARIS_CHANNELS.push(
  {
    id: 'lunaris:gi:banner', source: 'lunaris', game: 'gi', page: 'banner', pageKey: 'banner',
    kind: 'single', scope: 'site', endpoint: 'banners.json'
  },
  {
    id: 'lunaris:gi:leyline', source: 'lunaris', game: 'gi', page: 'leyline', pageKey: 'leyline',
    kind: 'ids', scope: 'site', item: 'leylinechallenge/{id}.json',
    // 官网 bundle 明确列出的期号，跟随官网更新，不推算未来期号。
    ids: ['5269001', '5269002', '5269003', '5269004', '5269005', '5269006', '5269007', '5269008', '5269009', '5269010', '5269011', '5269012', '5269013'],
    period: { begin: 'scheduleStartTime', end: 'scheduleEndTime', version: 'challengeName' }
  }
)

export const LUNARIS_BY_ID = new Map(LUNARIS_CHANNELS.map(channel => [channel.id, channel]))
export const LUNARIS_ENDGAME_CHANNEL_IDS = LUNARIS_CHANNELS.filter(channel => channel.period).map(channel => channel.id)
