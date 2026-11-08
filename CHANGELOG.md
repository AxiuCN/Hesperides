# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 minor 承载产物契约变更与重要新能力。

## 0.2.0

**图片采集落地，产物升到 schema v2，图片 URL 按源分派**

- **产物 schema v2：源成为路径维度**（`10fb606`）：`records/<game>/<source>/<page>/<id>.json`、`imagerefs/<game>/<source>/<page>.json`。跨源同名页（`weapon`/`monster`/`item`）各写各的，不再靠抓取顺序保证。`index.json` 的 `games.<game>.sources.<source>.pages.<page>` 同步带上 `key`（上游 pageKey），`periods.json` 改为 `games.<game>.<source>.<page>`。路径统一由新增的 `core/paths.mjs` 推导，不再各处手拼。`SCHEMA_SUPPORTED` 收紧为只认 2——旧产物会被明确拒绝而不是读出半截数据。
- **图片采集**（`5f62162`）：从记录的**资源名**反推候选 URL，按游戏+页面+字段的启发式生成有序候选（同一个资源可能落在两三个上游目录里），命中即止。图片按 URL 去重落盘（镜像 CDN 结构），增量判据是「URL 相同 + 文件仍在 + 体积一致」，候选全失败落占位图 `images/_placeholder/unknown.svg`，**不删旧图**；失败候选写进 `image-failures.json`，下一轮默认不再探测（一个资源常有 2~6 个候选，输掉的那些每轮都试等于白跑上万请求）。一页一份引用文件，读一页只加载一页。
- **图片 URL 规则按源分派**（`b680282`，本次最大修复）：候选由 `SOURCE_IMAGE_RULES` 按源生成——玉璃 `img.alioth.wiki`、nanoka `static.nanoka.cc/assets`。此前所有源都拼 nanoka 域名，而**玉璃星铁的资源在 nanoka 根本不存在**（上游目录名还是 `mostericon` 这种拼写），导致玉璃占位率 **51.3%**；修复后玉璃 **0%**，全库 6.1% → **2.9%**。两个源的差异不止域名：
  - 玉璃星铁的 URL 路径段是 **`sr`，不是 `hsr`**；落盘时归一成 `hsr`，同一游戏的图不会拆成两个目录
  - 玉璃扩展名 `.png`，nanoka `.webp`
  - 玉璃原神只给资源名，目录靠前缀推（`UI_MonsterIcon_`/`UI_ItemIcon_` → `MonsterIcon/`、`UI_AvatarIcon_` → `AvatarIcon/`、`UI_Img_LeyLineChallenge_` → `LeyLineChallenge/`）；玉璃星铁的值自带目录
  - 本源候选优先、另一源兜底——同一资源名两边都有时，谁有就用谁；未登记的源返回空候选，**不静默套用别的源**
- **上游根清单快照**（`78ed4d6` + `f1aa462`）：抓取时顺手把 nanoka 根 `manifest.json` 落盘为 `data/upstream/nanoka.json`（内容未变不重写）。放 `upstream/` 而不是产物根目录，是为了区分「上游响应的原样副本」（输入素材）与「本引擎产出的索引」（产物）。**只有提供根清单的源才有这个文件**——玉璃上游没有根清单，版本信息分散在各期的 `Phases[].Ver` 里，所以不存在 `upstream/alioth.json`。消费者用它的 `latest`/`live` 与 `new`（本版本新增条目 id）。
- **新增 diff 单文件频道**（`10fb606`）：`{endpoint: 'diff/{locale}', page: 'diff', kind: 'single'}`，给「版本更新记录」这类需要「最新版 vs 前一版」差异的消费者用。
- **记录名与统计修正**（`149a911`）：
  - `pickRecordName` 支持嵌套结构——绝区零驱动盘这类页的 `zh` 是 `{ name, desc2, desc4 }`，此前整页 32 条记录名全变成 `[object Object]`
  - 跳过（`skipped`）的频道沿用上一轮记录数，不再被写成 0；导出侧对历史 manifest 里被写成 0 的频道按 `ids` 条数兜底
  - 频道条目带上 `version`（nanoka 的全局数据版本），供消费侧显示

**实测规模**（运行期口径：nanoka 全部页 + 玉璃终局 7 频道，共 72 频道）：55,518 条记录、18,750 张图片 / 761 MB。

**测试**：4 套件（`units` 40 / `nanoka` 33 / `harvest` 17 / `images` 68），共 **158 条断言**，全程离线（注入 `fetchImpl`，不访问网络）。

## 0.1.0

**首版：玉璃 + nanoka 双源采集，增量续跑**

- 玉璃（alioth.wiki）频道表与抓取：`json.alioth.wiki/data/{game}/{lang}/{...}`，期规范化（`Phases` → `begin`/`end`/`version`），上游缺陷在引擎内修正且可审计（时间年份纠错标 `timeCorrected` 并保留 `rawTime`）。
- nanoka.cc 接入（`003ff37`）：覆盖上游全部页面，页面地址带版本段（`/{game}/{version}/{page}.json`），详情按需抓取；与玉璃重叠的页面**不裁剪**，由消费者取舍。
- 统一频道注册表 `src/sources/registry.mjs`：一源一目录，`ALL_CHANNELS` 由各源频道表汇总，CLI 与消费者都从这里取。
- 增量与续跑：每频道结束即写 `manifest.json`，中断可续跑；上游 304 按「未变」跳过而不是当失败；失败/缺席/未验证都不删旧数据。
- 期表导出 `periods.json`、索引导出 `index.json`（含记录级 `name`/`rarity` 的 entries，`a42cf1c`）。
- CLI：`--list-channels` / `--channel` / `--channels` / `--all` / `--mode` / `--export` / `--verify` / `--json`，零第三方依赖。
- 文档：架构 / 数据契约 / 源适配 / 抓取协议 / 测试五册。