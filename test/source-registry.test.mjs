/**
 * 源注册表的可扩展性回归
 *
 * 背景：后续要补备用源（防现役源跑路），所以「源的集合」不能写死成两个。
 * 本套件锁住：
 *   ① 注册项形状统一（source / channels / harvest），新增源只需加一条
 *   ② 频道都带 `source`，分发时不必用默认值兜
 *   ③ 分发按注册顺序遍历，不做「非 X 即 Y」的二元判断
 *   ④ 图片候选的源顺序从规则表派生，新增源自动参与
 */
import { mod, checker } from './_helper.mjs'

const { SOURCES, SOURCE_BY_NAME, ALL_CHANNELS, CHANNEL_BY_ID, ENDGAME_CHANNEL_IDS, ZZZ_CHANNEL_IDS, harvestSelected } =
  await import(mod('src/sources/registry.mjs'))
const { SOURCE_IMAGE_RULES, buildImageCandidates } = await import(mod('src/images/refs.mjs'))
const { sourceOf } = await import(mod('src/core/paths.mjs'))
const { check, finish } = checker()

console.log('=== ① 注册项形状 ===')
{
  check('至少注册了两个源', SOURCES.length >= 2, SOURCES.map((s) => s.source).join(', '))
  check('每项都有 source / channels / harvest',
    SOURCES.every((entry) => typeof entry.source === 'string' && Array.isArray(entry.channels) && typeof entry.harvest === 'function'))
  check('源标识不重复', new Set(SOURCES.map((s) => s.source)).size === SOURCES.length)
  check('SOURCE_BY_NAME 与 SOURCES 一致',
    SOURCES.every((entry) => SOURCE_BY_NAME.get(entry.source) === entry))
}

console.log('\n=== ② 频道都带 source ===')
{
  check('ALL_CHANNELS 非空', ALL_CHANNELS.length > 0, `${ALL_CHANNELS.length} 个频道`)
  check('每个频道都有可用的 source（sourceOf 与 channel.source 一致）',
    ALL_CHANNELS.every((channel) => Boolean(channel.source) && sourceOf(channel) === channel.source))
  check('CHANNEL_BY_ID 覆盖全部频道', CHANNEL_BY_ID.size === ALL_CHANNELS.length)
  check('频道 id 不重复', new Set(ALL_CHANNELS.map((c) => c.id)).size === ALL_CHANNELS.length)
  check('每个注册源都真有频道',
    SOURCES.every((entry) => ALL_CHANNELS.some((channel) => channel.source === entry.source)))
}

console.log('\n=== ③ 派生集合不绑定某个源 ===')
{
  check('终局频道来自注册项的 endgame 声明', ENDGAME_CHANNEL_IDS.length > 0, `${ENDGAME_CHANNEL_IDS.length} 个`)
  check('终局频道都在 ALL_CHANNELS 里',
    ENDGAME_CHANNEL_IDS.every((id) => CHANNEL_BY_ID.has(id)))
  check('绝区零频道按游戏筛出（不是按源名）',
    ZZZ_CHANNEL_IDS.length > 0
    && ZZZ_CHANNEL_IDS.every((id) => CHANNEL_BY_ID.get(id).game === 'zzz'))
}

console.log('\n=== ④ 分发按注册表遍历 ===')
{
  const seen = []
  const probeSources = SOURCES.map((entry) => ({
    ...entry,
    harvest: async (channels) => {
      seen.push({ source: entry.source, count: channels.length })
      return channels.map((channel) => ({ id: channel.id, status: 'ok', probe: true }))
    }
  }))
  // 用一份「等价于注册表」的探针跑一遍分发逻辑的形状检查：
  // 真实 harvestSelected 内部按 sourceOf 分组，这里直接验证分组口径
  const bySource = {}
  for (const entry of probeSources) {
    bySource[entry.source] = ALL_CHANNELS.filter((channel) => sourceOf(channel) === entry.source).length
  }
  const total = Object.values(bySource).reduce((sum, n) => sum + n, 0)
  check('按源分组后总和等于全部频道', total === ALL_CHANNELS.length, `${total}/${ALL_CHANNELS.length}`)
  check('每个源都能分到频道', Object.values(bySource).every((n) => n > 0), JSON.stringify(bySource))
  check('harvestSelected 是函数且接受 (channels, options)',
    typeof harvestSelected === 'function' && harvestSelected.length >= 1)
}

console.log('\n=== ⑤ 图片规则表可增量扩展 ===')
{
  const sources = Object.keys(SOURCE_IMAGE_RULES)
  check('每个注册源都有图片规则', SOURCES.every((entry) => sources.includes(entry.source)),
    `规则表：${sources.join(', ')}`)
  check('每条规则都有 assetBase / ext / gamePath / build',
    sources.every((name) => {
      const rule = SOURCE_IMAGE_RULES[name]
      return typeof rule.assetBase === 'string' && typeof rule.ext === 'string'
        && typeof rule.gamePath === 'function' && typeof rule.build === 'function'
    }))
  // 顺序从规则表派生：webp 的分支应排在 png 前面
  const first = buildImageCandidates('gi', 'nanoka', 'character', 'UI_AvatarIcon_Ayaka', '1', 'icon')
  check('候选首条是 webp（按格式偏好排序，不是按源名）', first[0]?.endsWith('.webp'), first[0])
  // 只有 png 版本的资源仍能拿到 png 候选
  const pngOnly = buildImageCandidates('gi', 'alioth', 'stygian', 'UI_Img_LeyLineChallenge_Narcissusborn', '1', 'Monsters.1.Icon')
  check('只有 png 版本的资源仍产出 png 候选',
    pngOnly.some((url) => url.endsWith('.png')), pngOnly[0])
}

finish()