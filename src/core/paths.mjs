/**
 * 产物路径约定（schema v2）
 *
 * v2 起「源」是产物路径的一等维度：同一 game 下两个源可以有同名页面（`weapon` / `monster` / `item`），
 * 不带源就会互相覆盖。所有路径都由本模块推导，避免各处拼字符串拼出不一致的结构。
 *
 *   records/<game>/<source>/<page>/<id>.json     记录
 *   imagerefs/<game>/<source>/<page>.json        该页的记录级图片引用（读一页只加载一页）
 *   images/<game>/<目录>/<文件>.<ext>            图片文件（镜像 CDN，按资源名去重，与源无关）
 *   image-failures.json                          失败候选（下一轮默认不再探测）
 */
import path from 'node:path'

/** 频道所属源（玉璃频道未显式声明 source） */
export function sourceOf (channel) {
  return channel?.source || 'alioth'
}

/** 某频道的记录目录 `<dataDir>/records/<game>/<source>/<page>` */
export function recordDir (dataDir, channel) {
  return path.join(dataDir, 'records', channel.game, sourceOf(channel), channel.page)
}

/** 某页的图片引用文件 `<dataDir>/imagerefs/<game>/<source>/<page>.json` */
export function imageRefsFile (dataDir, { gameId, source, page }) {
  return path.join(dataDir, 'imagerefs', gameId, source, `${page}.json`)
}

/** 失败候选文件（全局一份，体积小） */
export function imageFailuresFile (dataDir) {
  return path.join(dataDir, 'image-failures.json')
}
