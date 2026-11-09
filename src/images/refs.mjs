/**
 * 图片引用收集与候选 URL 生成
 *
 * 图片契约来自记录的**资源名**：记录里只写 `UI_AvatarIcon_Ayaka`、
 * `SpriteOutput/MonsterFigure/Monster_1002011.png`、`mostericon/Monster_1002040.png` 这类值，
 * 真实文件按**源**落在各自的 CDN 上。从资源名到 URL 的映射是「按源 + 游戏 + 页面 + 字段」的启发式，
 * 本模块是这套规则的**唯一副本**：
 *
 *   - `looksLikeImageField()` 判定哪些字段算图片（键名含 icon/image/… 或值带图片扩展名）
 *   - `buildImageCandidates()` 按源分派规则，生成**有序候选**，抓取时逐个试，命中即止
 *     （上游目录命名不统一，同一个资源可能落在两三个目录里）
 *   - `derivedImageRefs()` 补「记录里根本没写、但页面要展示」的派生图（名片、影画、命途图标…）
 *
 * 设计原则：
 *   - **只描述怎么算 URL，不决定抓不抓**——抓哪些频道、要不要图由调用方决定
 *   - **源是 URL 规则的第一维度**，不同源的 CDN、游戏路径段、目录命名都不同
 *     （例：玉璃星铁的资源在 `img.alioth.wiki/sr/…`，不是 `hsr`）
 *   - 候选按**源优先级**（nanoka → 玉璃）生成，与记录所属源无关：两边都有的资源统一走 webp，
 *     落盘路径一致、天然去重；玉璃独有的资源才回落到 png
 */

/** nanoka 的资源 CDN 根（保留导出，历史调用方仍在用） */
export const IMAGE_ASSET_BASE = 'https://static.nanoka.cc/assets'

/**
 * 各源的图片规则
 *
 * `gamePath` 是该源 URL 里的游戏路径段——注意**不等于** gameId：
 * 玉璃（alioth）的星铁资源放在 `sr/` 下，原神放在 `gi/` 下。
 * 返回 `null` 表示该源没有这个游戏的资源，调用方应跳过（不要凭空拼 URL）。
 */
export const SOURCE_IMAGE_RULES = {
  nanoka: {
    assetBase: IMAGE_ASSET_BASE,
    ext: '.webp',
    gamePath: (gameId) => gameId
  },
  alioth: {
    assetBase: 'https://img.alioth.wiki',
    ext: '.png',
    // 玉璃只覆盖原神与星铁（没有绝区零）；星铁在它的 URL 里写作 `sr`
    gamePath: (gameId) => (gameId === 'gi' ? 'gi' : gameId === 'hsr' ? 'sr' : null)
  }
}

/**
 * 候选的**源优先级**：与记录所属源无关，只看哪个源的图更优
 *
 * nanoka 给 `.webp`（体积小、格式统一），玉璃给 `.png`。同一个资源两个源都有时，
 * 若各按「记录所属源优先」取候选，会落成 `<名>.webp` 与 `<名>.png` **两份文件**
 * （实测服务器上 1,319 组重复 / 150 MB）。
 *
 * 所以候选顺序固定为 nanoka → 玉璃：两边都有的资源最终都命中同一个 nanoka URL，
 * 落盘路径一致、自动去重；玉璃独有的资源（如幽境危战展示图）nanoka 候选为空，自然回落到 png。
 */
const SOURCE_PREFERENCE = ['nanoka', 'alioth']

/**
 * 玉璃原神的「资源名前缀 → 目录」映射
 *
 * 玉璃的目录是按资源类型分的，但有两处反直觉：`UI_ItemIcon_*` 也放在 `MonsterIcon/` 下，
 * 幽境危战的展示图（`UI_Img_LeyLineChallenge_*`）单独一个目录。这些是实测结论，不能靠机械推导。
 */
const ALIOTH_GI_DIRS = [
  ['UI_Img_LeyLineChallenge_', 'LeyLineChallenge'],
  ['UI_ItemIcon_', 'MonsterIcon'],
  ['UI_MonsterIcon_', 'MonsterIcon'],
  ['UI_AvatarIcon_', 'AvatarIcon']
]

/**
 * 绝区零 `<IconMap:xxx>` 令牌 → 资源名（可能多个，按序尝试）
 *
 * 上游 zzz 的技能/按键图标用令牌引用，令牌本身不是文件名，必须过这张表。
 */
export const ZZZ_ICON_MAP = {
  Icon_Normal: ['Icon_Normal'],
  Icon_Evade: ['Icon_Evade'],
  Icon_Evaded: ['Icon_Evade'],
  Icon_Special: ['IconRoleSkillKeySpecial'],
  Icon_SpecialReady: ['IconRoleSkillKeySpecialV2'],
  Icon_SpecialReady_Rp: ['IconRoleSkillKeySpecialV3_02'],
  Icon_UltimateReady: ['Icon_UltimateReady'],
  Icon_Switch: ['Icon_Switch', 'CardSwitch01'],
  Icon_QTE: ['Icon_QTE', 'CardSwitch01'],
  Icon_Chain: ['Icon_UltimateReady', 'TransformChain01'],
  Icon_Assist: ['Icon_QTE', 'CardSwitch01'],
  Icon_CoreSkill: ['Icon_CoreSkill'],
  Icon_JoyStick: ['Icon_JoyStick'],
  Icon_AvatarClass_Attack: ['IconAttack'],
  Icon_AvatarClass_Anomaly: ['IconAnomaly'],
  Icon_AvatarClass_Rupture: ['IconRupture'],
  Icon_AvatarClass_Stun: ['IconStun'],
  Icon_GeneralBuff_PhysDmg: ['IconPhysDmg'],
  Icon_GeneralBuff_Thunder: ['IconThunder'],
  Icon_GeneralBuff_Fire: ['IconFire']
}

/** 去掉图片扩展名 */
export function stripImageExt (value) {
  return String(value || '').replace(/\.(png|webp|jpg|jpeg|avif)$/i, '')
}

/** 取路径里的文件名（去扩展名） */
export function basenameNoExt (value) {
  const parts = stripImageExt(String(value || '').replace(/\\/g, '/')).split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * 字段是否像图片引用
 * @param {string} key - 字段名
 * @param {string} value - 字段值
 * @returns {boolean}
 */
export function looksLikeImageField (key, value) {
  const cleanKey = String(key).toLowerCase()
  const cleanValue = String(value).trim()
  if (!cleanValue) return false
  // 模板占位（`{0}` / `{LINK#1}`）不是资源名
  if (/\{[^}]*}/.test(cleanValue)) return false
  if (cleanKey === 'type_icon' && !/[/\\._]/.test(cleanValue) && !/^https?:\/\//i.test(cleanValue)) return false
  if (/^(icon|image|picture|thumbnail|avatar|portrait|figure)$/.test(cleanKey)) return true
  if (/(^|_)(icon|image|picture|thumbnail|avatar|portrait|figure)($|_)/.test(cleanKey)) return true
  return /\.(png|webp|jpg|jpeg|avif)$/i.test(cleanValue)
}

/**
 * 遍历对象里的字符串叶子
 * @param {*} value
 * @param {string[]} pathParts
 * @param {(key: string, value: string, fieldPath: string) => void} visit
 */
export function walkStrings (value, pathParts, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, [...pathParts, String(index)], visit))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...pathParts, key]
      visit(key, child, childPath.join('.'))
      walkStrings(child, childPath, visit)
    }
  }
}

/**
 * 玉璃（alioth）的候选 URL
 *
 * URL 形状：`https://img.alioth.wiki/<gamePath>/<目录>/<资源名>.png`
 *
 * 目录来源分两种：
 *   - 记录值本身带目录（星铁：`mostericon/Monster_1002040.png`）→ 直接沿用
 *   - 记录值只有资源名（原神：`UI_MonsterIcon_xxx`）→ 按 `ALIOTH_GI_DIRS` 前缀表推
 * @param {string} gameId
 * @param {string} value - 记录里的原始值
 * @param {string} ext
 * @param {(url: string) => void} add
 */
function buildAliothCandidates (gameId, value, ext, add) {
  const rule = SOURCE_IMAGE_RULES.alioth
  const gamePath = rule.gamePath(gameId)
  // 玉璃没有这个游戏的资源（如绝区零）→ 不猜 URL
  if (!gamePath) return
  const base = `${rule.assetBase}/${gamePath}`
  const stripped = stripImageExt(String(value || '').replace(/^\/+/, '').replace(/\\/g, '/'))

  // 值自带目录（星铁的口径）
  if (stripped.includes('/')) {
    add(`${base}/${stripped}${ext}`)
    return
  }

  // 只有资源名（原神的口径）：按前缀表补目录
  const hit = ALIOTH_GI_DIRS.find(([prefix]) => stripped.startsWith(prefix))
  if (hit) add(`${base}/${hit[1]}/${stripped}${ext}`)
  // 保底：平铺（实测多为 404，但上游调整时可能生效，放最后）
  add(`${base}/${stripped}${ext}`)
}

/**
 * 资源名 → 按源分派的有序候选 URL
 * @param {string} gameId - gi / hsr / zzz
 * @param {string} source - 记录所属源（`nanoka` / `alioth`）
 * @param {string} pageKey - 页面 key（`character` / `item` / `achievement/achievement` …）
 * @param {string} rawValue - 记录里的资源名（或已是 http URL）
 * @param {string|number} recordId
 * @param {string} fieldPath - 字段点路径（zzz 影画背景要用）
 * @returns {string[]}
 */
export function buildImageCandidates (gameId, source, pageKey, rawValue, recordId, fieldPath = '') {
  const value = String(rawValue ?? '').trim()
  if (!value) return []
  if (/^https?:\/\//i.test(value)) return [value]
  // 未登记的源：不猜、不静默套用别的源，直接给空候选（调用方据此跳过并记日志）
  if (!SOURCE_IMAGE_RULES[source]) return []

  const candidates = []
  const add = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url)
  }

  // 按固定的源优先级生成候选（nanoka → 玉璃），**不按记录所属源排序**：
  // 两边都有的资源统一命中 nanoka 的 webp，落盘路径一致、天然去重。
  for (const ruleSource of SOURCE_PREFERENCE) {
    if (ruleSource === 'alioth') {
      buildAliothCandidates(gameId, value, SOURCE_IMAGE_RULES.alioth.ext, add)
    } else {
      buildNanokaCandidates(gameId, pageKey, value, recordId, fieldPath, add)
    }
  }

  return candidates
}

/**
 * nanoka 的候选 URL（原有规则）
 * @param {string} gameId
 * @param {string} pageKey
 * @param {string} value
 * @param {string|number} recordId
 * @param {string} fieldPath
 * @param {(url: string) => void} add
 */
function buildNanokaCandidates (gameId, pageKey, value, recordId, fieldPath, add) {
  const assetBase = `${IMAGE_ASSET_BASE}/${gameId}`
  const stripped = stripImageExt(value.replace(/^\/+/, ''))
  const baseName = basenameNoExt(value)

  const iconMapToken = value.match(/^<IconMap:([^>]+)>$/)?.[1] ?? value.match(/^IconMap:([^>]+)$/)?.[1]
  if (gameId === 'zzz' && iconMapToken) {
    for (const assetName of ZZZ_ICON_MAP[iconMapToken] ?? [iconMapToken]) {
      add(`${assetBase}/${stripImageExt(assetName)}.webp`)
    }
    return
  }

  if (gameId === 'hsr') {
    if (value.includes('/')) {
      const parts = stripped.split('/').filter(Boolean)
      const file = parts.at(-1)
      const folder = parts.at(-2)
      const normalized = value.replace(/\\/g, '/')
      if (/ItemFigures/i.test(value) && file) add(`${assetBase}/itemfigures/${file}.webp`)
      if (/SpriteOutput\/ItemIcon\//i.test(normalized) && file) add(`${assetBase}/itemfigures/${file}.webp`)
      if (/SpriteOutput\/ItemCurrency\//i.test(normalized) && file) add(`${assetBase}/itemfigures/${file}.webp`)
      if (/SpriteOutput\/TravelBrochure\/(?:StickFigures|StickIcons)\//i.test(normalized) && file) {
        add(`${assetBase}/itemfigures/${file}.webp`)
      }
      if (/SpriteOutput\/SkillIcons\/Avatar\//i.test(normalized) && file) {
        add(`${assetBase}/skillicons/${file}.webp`)
        const skillIconMatch = file.match(/^SkillIcon_(\d+)(_.+)$/)
        if (skillIconMatch) {
          const skillIconId = Number(skillIconMatch[1])
          // 技能图标有两种 id 口径（+10000），两种都试
          if (Number.isFinite(skillIconId) && skillIconId > 10000) {
            add(`${assetBase}/skillicons/SkillIcon_${skillIconId - 10000}${skillIconMatch[2]}.webp`)
          }
        }
      }
      if (/MonsterFigure/i.test(value) && file) add(`${assetBase}/monsterfigure/${file}.webp`)
      if (/SpriteOutput\/BattleEventIcon\//i.test(normalized) && file) add(`${assetBase}/monsterfigure/${file}.webp`)
      if (/SpriteOutput\/GridFight\/AugmentBig\//i.test(normalized) && file) add(`${assetBase}/gridfight/augmentbig/${file}.webp`)
      if (/SpriteOutput\/GridFight\/Portal\//i.test(normalized) && file) add(`${assetBase}/gridfight/portal/${file}.webp`)
      if (/SpriteOutput\/GridFight\/(?:GridItem|Equipment)\//i.test(normalized) && file) {
        add(`${assetBase}/gridfight/equipment/${file}.webp`)
      }
      if (/SpriteOutput\/GridFight\/TraitIcon\/(?:Icon|MiniIcon)\//i.test(normalized) && file) {
        add(`${assetBase}/gridfight/icon/${file}.webp`)
        add(`${assetBase}/gridfight/icon/${file.replace(/S$/i, '')}.webp`)
      }
      if (/(?:SpriteOutput\/GridFight\/BattleIcon\/BuffIcon|SpriteOutput\/BuffIcon\/Inlevel\/Avatar)\//i.test(normalized) && file) {
        const roleId = file.match(/(\d+)/)?.[1]
        if (roleId) add(`${assetBase}/avatarroundicon/${roleId}.webp`)
      }
      if (folder && file) add(`${assetBase}/${folder.toLowerCase()}/${file}.webp`)
    }
    if (/^SkillIcon_/i.test(baseName)) add(`${assetBase}/skillicons/${baseName}.webp`)
    add(`${assetBase}/${stripped}.webp`)
    add(`${assetBase}/${baseName}.webp`)
  } else if (gameId === 'gi') {
    add(`${assetBase}/${baseName}.webp`)
    const avatarCardMatch = baseName.match(/^UI_AvatarIcon_(.+)_Card$/)
    if (avatarCardMatch) add(`${assetBase}/UI_AvatarIcon_${avatarCardMatch[1]}.webp`)
    const nameCardMatch = baseName.match(/^UI_NameCardIcon_(.+)$/)
    if (nameCardMatch) {
      add(`${assetBase}/UI_NameCardPic_${nameCardMatch[1]}_P.webp`)
      add(`${assetBase}/UI_NameCardPic_${nameCardMatch[1]}_Alpha.webp`)
    }
    if (baseName.startsWith('Gcg_')) add(`${assetBase}/UI_${baseName}.webp`)
    add(`${assetBase}/${stripped}.webp`)
  } else if (gameId === 'zzz') {
    // 角色页的潜力详情图是「觉醒背景」，上游目录里带 AvatarSpecialAwakenBg_ 前缀
    if (pageKey === 'character' && /(?:^|\.)potential_detail\.\d+\.image$/i.test(fieldPath)) {
      const awakenBg = baseName.startsWith('AvatarSpecialAwakenBg_') ? baseName : `AvatarSpecialAwakenBg_${baseName}`
      add(`${assetBase}/${awakenBg}.webp`)
    }
    add(`${assetBase}/${baseName}.webp`)
    if (baseName.startsWith('IconMonster_')) add(`${assetBase}/${baseName.replace(/^IconMonster_/, 'Monster_')}.webp`)
    add(`${assetBase}/${stripped}.webp`)
  }

  // 原神角色头像 → 抽卡立绘
  if (gameId === 'gi' && pageKey === 'character' && String(fieldPath).endsWith('icon')) {
    add(`${assetBase}/${String(value).replace('UI_AvatarIcon_', 'UI_Gacha_AvatarImg_')}.webp`)
  }
  // 星铁角色页：头像商店图按角色 id 直拼
  if (gameId === 'hsr' && pageKey === 'character' && recordId) {
    add(`${assetBase}/avatarshopicon/${recordId}.webp`)
  }
}

/**
 * 派生引用：记录里没有、但页面要展示的图
 * @param {string} gameId
 * @param {string} pageKey
 * @param {string|number} recordId
 * @param {object} record
 * @returns {{fieldPath: string, kind: string, originalValue: string, candidates: string[]}[]}
 */
export function derivedImageRefs (gameId, source, pageKey, recordId, record) {
  if (!record || typeof record !== 'object') return []
  const id = String(recordId)
  const refs = []
  const push = (fieldPath, originalValue) => {
    refs.push({
      fieldPath,
      kind: 'derived',
      originalValue,
      candidates: buildImageCandidates(gameId, source, pageKey, originalValue, id, fieldPath)
    })
  }

  if (gameId === 'hsr') {
    if (pageKey === 'character') {
      push('derived.avatarShopIcon', `avatarshopicon/${id}`)
      push('derived.avatarDrawCard', `avatardrawcard/${id}`)
      if (record.damageType) push('derived.element', `element/${String(record.damageType).toLowerCase()}`)
      if (record.baseType) push('derived.path', `pathicon/${String(record.baseType).toLowerCase()}`)
    }
    if (pageKey === 'lightcone') {
      push('derived.lightConeMediumIcon', `lightconemediumicon/${id}`)
      if (record.baseType) push('derived.path', `pathicon/${String(record.baseType).toLowerCase()}`)
    }
    if (pageKey === 'monster' && record.icon) push('derived.monsterFigure', `monsterfigure/${basenameNoExt(record.icon)}`)
    if (pageKey.endsWith('item') && record.item_figure_icon_path) {
      push('derived.itemFigure', `itemfigures/${basenameNoExt(record.item_figure_icon_path)}`)
    }
  }

  if (gameId === 'zzz' && pageKey === 'character') {
    for (const index of [1, 2, 3]) push(`derived.mindscape.${index}`, `Mindscape_${id}_${index}`)
  }

  return refs
}

/**
 * 收集一条记录的图片引用
 * @param {object} options
 * @param {string} options.gameId
 * @param {string} options.pageKey
 * @param {string|number} options.recordId
 * @param {object} options.record
 * @returns {{recordId: string, fieldPath: string, kind: string, originalValue: string, candidates: string[]}[]}
 */
export function collectRecordImageRefs ({ gameId, source, pageKey, recordId, record }) {
  const id = String(recordId)
  const refs = []
  const seen = new Set()
  const push = (fieldPath, kind, originalValue, candidates) => {
    if (!candidates.length) return
    const key = `${fieldPath}|${originalValue}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ recordId: id, fieldPath, kind, originalValue, candidates })
  }

  walkStrings(record, [], (key, value, fieldPath) => {
    if (typeof value !== 'string') return

    const iconMapToken = value.match(/^<IconMap:([^>]+)>$/)?.[1] ?? value.match(/^IconMap:([^>]+)$/)?.[1]
    if (gameId === 'zzz' && iconMapToken) {
      push(fieldPath, 'iconmap', value, buildImageCandidates(gameId, source, pageKey, value, id, fieldPath))
      return
    }
    if (!looksLikeImageField(key, value)) return

    const candidates = buildImageCandidates(gameId, source, pageKey, value, id, fieldPath)
    // 星铁物品页：图标常只给 id，需要借记录里的 figure/icon 路径再补候选
    if (gameId === 'hsr' && ['item', 'item_all'].includes(pageKey) && /(^|\.)item_(?:icon|currency_icon)_path$/i.test(fieldPath)) {
      for (const context of [record.item_figure_icon_path, record.item_icon_path]) {
        if (typeof context === 'string' && context.trim()) {
          for (const candidate of buildImageCandidates(gameId, source, pageKey, context, id, fieldPath)) {
            if (!candidates.includes(candidate)) candidates.push(candidate)
          }
        }
      }
    }
    push(fieldPath, 'field', value, candidates)
  })

  for (const derived of derivedImageRefs(gameId, source, pageKey, recordId, record)) {
    push(derived.fieldPath, derived.kind, derived.originalValue, derived.candidates)
  }

  return refs
}
