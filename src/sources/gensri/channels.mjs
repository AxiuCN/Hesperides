/** Gensri 官网目录、详情与幽境危战期表，分别来自 db 与主站公开前端。 */
export const GENSRI_DB_BASE = 'https://db.gensri.wiki'
export const GENSRI_SITE_BASE = 'https://www.gensri.wiki/985'

export const GENSRI_CHANNELS = [
  { page: 'character', endpoint: 'characters.json', versionKey: 'characters', detailFolder: 'characters' },
  { page: 'weapon', endpoint: 'weapons.json', versionKey: 'weapons', detailFolder: 'weapons' },
  { page: 'artifact', endpoint: 'artifactlist.json', versionKey: 'artifacts', detailFolder: 'artifacts' },
  { page: 'stygian', endpoint: 'data/seasons.json', scope: 'site', period: true }
].map(channel => ({
  ...channel,
  id: `gensri:gi:${channel.page}`,
  source: 'gensri',
  game: 'gi',
  pageKey: channel.page,
  kind: 'page'
}))

export const GENSRI_ENDGAME_CHANNEL_IDS = GENSRI_CHANNELS.filter(channel => channel.period).map(channel => channel.id)
