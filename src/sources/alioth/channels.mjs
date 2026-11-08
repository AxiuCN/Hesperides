/**
 * 玉璃（alioth.wiki）频道表
 *
 * 数据源：https://json.alioth.wiki/data/{game}/{lang}/{...}
 * 契约来源：alioth-wiki-code 仓库的 `data-directories.json`（本仓库 pin 一份副本见 docs/源适配.md）
 *
 * 频道（channel）是抓取的最小单位，id 形如 `alioth:gi:abyss`。
 * **本模块只描述"怎么抓"，不描述"要不要抓"**——抓哪些频道由调用方（Atlas-Plugin / CLI）决定。
 *
 * kind 取值：
 *   - single   ：单个 JSON 文件（无分片）
 *   - phased   ：索引里 `Phases[]._id` → `{page}/{id}.json`，并产出期索引
 *   - ids      ：用选择器从索引取 id → `{page}/{id}.json`
 *   - static   ：固定文件列表
 *   - text     ：TextMap 大文本（默认不在任何"全量"里，需显式点名）
 */

export const ALIOTH_DATA_BASE = 'https://json.alioth.wiki/data'
export const ALIOTH_TEXTMAP_BASE = 'https://json.alioth.wiki/TextMap'

/** 语言目录（玉璃用 ch/en/jp/kr，不是 zh） */
export const ALIOTH_LANG = 'ch'

/**
 * 频道定义
 *
 * 字段说明：
 *   id       频道 id（source:game:page）
 *   game     gi / hsr
 *   page     产物里的 pageKey（records/<game>/<page>/<id>.json 的 <page>）
 *   kind     single / phased / ids / static / text
 *   scope    locale（默认，{game}/{lang}/）或 root（{game}/）
 *   index    索引文件名（相对 scope）
 *   ids      ids 类型的选择器
 *   item     分片路径模板（相对 scope，`{id}` 占位）
 *   files    static 类型的文件列表（相对 scope）
 *   period   phased 类型的期字段映射
 */
export const ALIOTH_CHANNELS = [
  /* ================= 原神 ================= */
  // 终局（期索引 + 条目）
  {
    id: 'alioth:gi:abyss',
    game: 'gi',
    page: 'abyss',
    kind: 'phased',
    index: 'abyss.json',
    item: 'abyss/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  {
    id: 'alioth:gi:theater',
    game: 'gi',
    page: 'theater',
    kind: 'phased',
    index: 'theater.json',
    item: 'theater/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time', timePrecision: 'month' }
  },
  {
    id: 'alioth:gi:stygian',
    game: 'gi',
    page: 'stygian',
    kind: 'phased',
    index: 'stygian.json',
    item: 'stygian/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  // 角色及其派生（ID 全部来自 char.json：Avatar / Gun / Flycloak）
  {
    id: 'alioth:gi:char',
    game: 'gi',
    page: 'char',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/{id}.json'
  },
  {
    id: 'alioth:gi:char-story',
    game: 'gi',
    page: 'char-story',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/story/{id}.json'
  },
  {
    id: 'alioth:gi:char-voice',
    game: 'gi',
    page: 'char-voice',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/voice/{id}.json'
  },
  {
    id: 'alioth:gi:char-gun',
    game: 'gi',
    page: 'char-gun',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Gun', 'ID']] },
    item: 'char/gun/{id}.json'
  },
  {
    id: 'alioth:gi:char-flycloak',
    game: 'gi',
    page: 'char-flycloak',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Flycloak', 'ID']] },
    item: 'char/flycloak/{id}.txt',
    ext: 'txt'
  },
  // 武器 / 圣遗物：无独立索引，ID 来自 char.json（实测已确认）
  {
    id: 'alioth:gi:weapon',
    game: 'gi',
    page: 'weapon',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Weapon', 'ID']] },
    item: 'weapon/{id}.json'
  },
  {
    id: 'alioth:gi:relic',
    game: 'gi',
    page: 'relic',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Relic', 'ID']] },
    item: 'relic/{id}.json'
  },
  // 怪物：Templates 是 id→对象 的字典
  {
    id: 'alioth:gi:monster',
    game: 'gi',
    page: 'monster',
    kind: 'ids',
    index: 'monster.json',
    ids: { type: 'keysAt', path: 'Templates' },
    item: 'monster/{id}.json'
  },
  // 单文件类
  { id: 'alioth:gi:achievement', game: 'gi', page: 'achievement', kind: 'single', index: 'achievement.json' },
  { id: 'alioth:gi:item', game: 'gi', page: 'item', kind: 'single', index: 'item.json' },
  { id: 'alioth:gi:item-food', game: 'gi', page: 'item-food', kind: 'single', index: 'item_food.json' },
  { id: 'alioth:gi:item-quest', game: 'gi', page: 'item-quest', kind: 'single', index: 'item_quest.json' },
  { id: 'alioth:gi:formulae', game: 'gi', page: 'formulae', kind: 'single', index: 'formulae.json' },
  { id: 'alioth:gi:guidepage', game: 'gi', page: 'guidepage', kind: 'single', index: 'guidepage.json' },
  { id: 'alioth:gi:legend', game: 'gi', page: 'legend', kind: 'single', index: 'legend.json' },
  { id: 'alioth:gi:load', game: 'gi', page: 'load', kind: 'single', index: 'load.json' },
  { id: 'alioth:gi:prop', game: 'gi', page: 'prop', kind: 'single', index: 'prop.json' },
  { id: 'alioth:gi:quest', game: 'gi', page: 'quest', kind: 'single', index: 'quest.json' },
  { id: 'alioth:gi:theater-blessings', game: 'gi', page: 'theater-blessings', kind: 'single', index: 'theater_blessings.json' },
  { id: 'alioth:gi:theater-tarot', game: 'gi', page: 'theater-tarot', kind: 'single', index: 'theater_tarot.json' },
  { id: 'alioth:gi:tutorial', game: 'gi', page: 'tutorial', kind: 'single', index: 'tutorial.json' },
  {
    id: 'alioth:gi:tps',
    game: 'gi',
    page: 'tps',
    kind: 'static',
    files: ['tps/mercenaries.json', 'tps/weapons.json']
  },
  {
    id: 'alioth:gi:quest-special',
    game: 'gi',
    page: 'quest-special',
    kind: 'static',
    files: ['quest/selenic.json', 'quest/meeting.json', 'quest/tsarist.json', 'quest/saveteyvat.json']
  },
  // 根级（不按语言分目录）
  { id: 'alioth:gi:banner', game: 'gi', page: 'banner', kind: 'single', scope: 'root', index: 'banner.json' },
  { id: 'alioth:gi:grow-curves', game: 'gi', page: 'grow-curves', kind: 'single', scope: 'root', index: 'GrowCurves.json' },

  /* ================= 星穹铁道 ================= */
  {
    id: 'alioth:hsr:chaos',
    game: 'hsr',
    page: 'chaos',
    kind: 'phased',
    index: 'chaos.json',
    item: 'chaos/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  {
    id: 'alioth:hsr:fiction',
    game: 'hsr',
    page: 'fiction',
    kind: 'phased',
    index: 'fiction.json',
    item: 'fiction/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  {
    id: 'alioth:hsr:as',
    game: 'hsr',
    page: 'as',
    kind: 'phased',
    index: 'as.json',
    item: 'as/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  {
    id: 'alioth:hsr:arbitration',
    game: 'hsr',
    page: 'arbitration',
    kind: 'phased',
    index: 'arbitration.json',
    item: 'arbitration/{id}.json',
    period: { sourcePhases: 'Phases', id: '_id', name: 'Name', version: 'Ver', time: 'Time' }
  },
  {
    id: 'alioth:hsr:char',
    game: 'hsr',
    page: 'char',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/{id}.json'
  },
  {
    id: 'alioth:hsr:char-story',
    game: 'hsr',
    page: 'char-story',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/story/{id}.json'
  },
  {
    id: 'alioth:hsr:char-voice',
    game: 'hsr',
    page: 'char-voice',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Avatar', 'ID']] },
    item: 'char/voice/{id}.json'
  },
  {
    id: 'alioth:hsr:weapon',
    game: 'hsr',
    page: 'weapon',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayFields', fields: [['Weapon', 'ID']] },
    item: 'weapon/{id}.json'
  },
  {
    id: 'alioth:hsr:relic',
    game: 'hsr',
    page: 'relic',
    kind: 'ids',
    index: 'char.json',
    ids: { type: 'arrayOfArrays', path: 'Relic', id: 'ID' },
    item: 'relic/{id}.json'
  },
  {
    id: 'alioth:hsr:monster',
    game: 'hsr',
    page: 'monster',
    kind: 'ids',
    index: 'monster.json',
    ids: { type: 'arrayAt', path: 'Templates', id: '_id' },
    item: 'monster/{id}.json'
  },
  {
    id: 'alioth:hsr:cw-char',
    game: 'hsr',
    page: 'cw-char',
    kind: 'ids',
    index: 'cw.json',
    ids: { type: 'arrayAt', path: 'Characters', id: '_id' },
    item: 'cw/{id}.json'
  },
  { id: 'alioth:hsr:achievement', game: 'hsr', page: 'achievement', kind: 'single', index: 'achievement.json' },
  { id: 'alioth:hsr:cw', game: 'hsr', page: 'cw', kind: 'single', index: 'cw.json' },
  { id: 'alioth:hsr:formulae', game: 'hsr', page: 'formulae', kind: 'single', index: 'formulae.json' },
  { id: 'alioth:hsr:guidepage', game: 'hsr', page: 'guidepage', kind: 'single', index: 'guidepage.json' },
  { id: 'alioth:hsr:item', game: 'hsr', page: 'item', kind: 'single', index: 'item.json' },
  { id: 'alioth:hsr:load', game: 'hsr', page: 'load', kind: 'single', index: 'load.json' },
  { id: 'alioth:hsr:prop', game: 'hsr', page: 'prop', kind: 'single', index: 'prop.json' },
  { id: 'alioth:hsr:tutorial', game: 'hsr', page: 'tutorial', kind: 'single', index: 'tutorial.json' },
  {
    id: 'alioth:hsr:cw-categories',
    game: 'hsr',
    page: 'cw-categories',
    kind: 'static',
    files: [
      'cw/augments.json',
      'cw/economy.json',
      'cw/equipment.json',
      'cw/portals.json',
      'cw/stages.json',
      'cw/talents.json',
      'cw/traits.json'
    ]
  },
  { id: 'alioth:hsr:banner', game: 'hsr', page: 'banner', kind: 'single', scope: 'root', index: 'banner.json' },
  { id: 'alioth:hsr:eg', game: 'hsr', page: 'eg', kind: 'single', scope: 'root', index: 'eg.json' },
  { id: 'alioth:hsr:hlg', game: 'hsr', page: 'hlg', kind: 'single', scope: 'root', index: 'hlg.json' },
  { id: 'alioth:hsr:hsrboss', game: 'hsr', page: 'hsrboss', kind: 'single', scope: 'root', index: 'hsrboss.json' },

  /* ================= 文本（TextMap） ================= */
  { id: 'alioth:textmap:gi', game: 'gi', page: 'textmap', kind: 'text', files: ['GI/TextMap.json'] },
  { id: 'alioth:textmap:gi-readable', game: 'gi', page: 'textmap-readable', kind: 'text', files: ['GI/Readable_CH.json', 'GI/Readable_EN.json'] },
  { id: 'alioth:textmap:gi-dialog', game: 'gi', page: 'textmap-dialog', kind: 'text', files: ['GI/Dialog_CH.json', 'GI/Dialog_EN.json'] },
  { id: 'alioth:textmap:hsr', game: 'hsr', page: 'textmap', kind: 'text', files: ['HSR/TextMap.json'] },
  { id: 'alioth:textmap:hsr-readable', game: 'hsr', page: 'textmap-readable', kind: 'text', files: ['HSR/Readable_CH.json', 'HSR/Readable_EN.json'] },
  { id: 'alioth:textmap:hsr-dialog', game: 'hsr', page: 'textmap-dialog', kind: 'text', files: ['HSR/Dialog_CH.json', 'HSR/Dialog_EN.json'] }
]

/** 频道 id → 定义 */
export const ALIOTH_BY_ID = new Map(ALIOTH_CHANNELS.map((channel) => [channel.id, channel]))

/**
 * 终局频道（Atlas-Plugin 日常只需要这一组，选不选由插件决定，本仓库不设默认开关）
 */
export const ALIOTH_ENDGAME_CHANNELS = [
  'alioth:gi:abyss',
  'alioth:gi:theater',
  'alioth:gi:stygian',
  'alioth:hsr:chaos',
  'alioth:hsr:fiction',
  'alioth:hsr:as',
  'alioth:hsr:arbitration'
]
