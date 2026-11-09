# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 minor 承载产物契约变更与重要新能力。

## 0.2.1

**图片按资源去重（修复同资源落两份）+ 已有数据平滑升级**

- **候选按格式体积排序（webp 优先）**：同一资源两个源都有时，候选固定 **nanoka webp → 玉璃 png**，与记录所属源无关。此前「记录所属源优先」会让玉璃频道命中 `.png`、nanoka 频道命中 `.webp`，同一条资源落成两份（实测某次全量多存 **1,319 个 / 150 MB**）。统一后两边命中的是同一个 URL，落盘路径一致、天然去重；玉璃独有资源仍回落到 png。
- **已有数据不用重抓**：新增 `urlResourceKey()` 与 `scanExistingImages()` —— 抓图时除了「按 URL 判活」，再加一层「按资源键复用」：只要磁盘上已有这个资源（哪怕是另一种格式/来自另一个源），就直接复用，不再重下。升级后第一次增量抓取实测 **下载 0、复用 909/911**，不会因为候选顺序变了而白下 150 MB。索引在批量抓取时只扫一次，所有频道共用。
- **新增 `--prune-images`**：清理历史遗留的多格式重复。默认只预览，加 `--yes` 才删；同 `<目录>/<基名>` 按扩展名优先级保留（`.webp` > `.png` > `.jpg` > …），删前校验首选文件非空；**删后同步改写 `imagerefs` 里指向被删文件的 `localPath`**（否则引用悬空、图片裂开）。本地实测删 190 个 / 省 **96 MB**、2,467 条引用改写后**零悬空**。
- **升级建议（0.2.0 用户）**：不必重抓。想看能省多少跑 `--prune-images`，确认后加 `--yes`。不跑也不影响功能，只是多占空间。
- **采集失败后可恢复**（本轮审核 H2/H3）：
  - 上一轮 `failed` 或带 `error` 的频道，下次不走 `if-modified-since`、不做同 hash 短路——否则上游恢复后索引没变就直接 `skipped`，缺的记录永远补不回来。
  - `phaseVersions` 只对**成功落盘**的期前进；更新失败的期保留旧文件与旧版本，下一轮重试。
  - nanoka 详情失败时**保留旧 `detail`**、只更新摘要，并把失败写进 `error` 驱动重试；HTTP 200 但内容解析不出来同样算失败（不能用空对象擦掉旧详情）。
- **图片候选：首命中即停 + 跨引用同 URL 复用**（H4）：早先是把所有候选并发下完再挑第一个成功的，一条引用常有 2~6 个候选，等于白下 2/3 流量。改成引用级并发、候选逐个试、命中即停，URL 级共享 Promise。实测某频道候选处理量 **911 → 304（−67%）**。
- **TextMap 目录分隔符**（H1）：不带末斜杠的根地址会拼出 `TextMapGI/TextMap.json` 这种错误路径。
- **`--json` 的 stdout 只留 JSON**（H5）：`--export --json` 原先把导出日志先打到 stdout，整段无法 `JSON.parse`（exit 仍 0）；现在 `--json` 时 info 日志切到 stderr，非 JSON 模式行为不变。
- **清理会同步刷新索引投影**（复审 N2）：此前 `--prune-images` 只改 `imagerefs.localPath`，已经导出的 `index.json` 里 `entries.icon` 仍指向被删的 png，插件读出来是空串。现在顺序改为「修正引用（含 bytes、清 etag）→ `exportAll()` 刷新投影 → 最后才删旧图」，任一步失败旧图仍在。
- **资源键复用不再绕过缓存校验**（复审 N3）：同 URL 的 `bytes`/ETag 校验失败后，不能再从「按资源键复用」取回同一旧文件——否则 `verify` 看到新 ETag、实际却 0 请求、文件保持旧内容。
- **源改为可插拔**：`src/sources/registry.mjs` 从「手拼两个源」改成 `SOURCES` 注册表——新增源（例如防跑路用的备用源）只需加一项 `{ source, channels, harvest, endgame? }`，分发按注册表遍历，不再有「非 nanoka 即玉璃」的二元判断。频道对象的 `source` 在注册时统一补齐，各处不必再用默认值兜。`ENDGAME_CHANNEL_IDS` 改为从各源的 `endgame` 声明汇总，`ZZZ_CHANNEL_IDS` 按游戏筛而不绑定源。
- **图片候选顺序从规则表派生**：`SOURCE_PREFERENCE` 由硬编码 `['nanoka', 'alioth']` 改为按各源 `ext` 的偏好排序（webp → png → …），新增源只要在 `SOURCE_IMAGE_RULES` 加一条就自动参与，不必再改候选生成代码。
- **文档：两个源的描述改为对等**：`README.md` 与 `docs/源适配.md` 此前把玉璃排在前、玉璃有六个小节而 nanoka 只有末尾一个，读起来像是给两个源分了等级。现在两源各成独立小节、字段对齐，并明确写明「**两者对等**：可抓的页面都抓、都保留，本仓库不判断谁更权威、也不替消费者选源」。
  - 同时纠正一处概念错误：`README` 与 `docs/源适配.md` 曾把 nanoka 写成「主数据源」、玉璃写成「终局数据源」——那是 **Atlas-Plugin 的取舍**（它取 nanoka 全量 + 玉璃终局），不是源本身的属性。引擎侧不区分主次，`Atlas-Plugin` 的取舍只写在插件自己的文档里。
  - 图片候选顺序的说明也改了措辞：顺序固定 nanoka webp → 玉璃 png 的依据是**格式体积**（webp 通常更小），**不是源的等级**。
  - 顺带修掉 README 目录树里残留的 v1 路径（`records/<game>/<page>`）与重复的 `manifest.json` 行。
- **文档：补「名字的由来」与「鸣谢」**：说明 Hesperides 这个名字怎么从 Atlas 的神话关系延伸出来（看守金苹果园的仙女，后期版本作「阿特拉斯之女」），并列出 nanoka.cc、玉璃、nanoka-atlas-backend、Nwflower/Atlas、TRSS-Yunzai、Lotus-ReFactor 六个来源。
- **台账只保留上游仍列出的期**：`phaseVersions` 此前会永久保留已被上游删除的期号，越积越多；现在每轮按当前 `phases` 过滤。
- **User-Agent 跟随版本号**：此前硬编码 `Hesperides/0.1`，与 package.json 脱节；改为读取 package.json 的 `version`。
- **文档口径**：`src/schema/index.mjs` 头注释与 `docs/架构.md` 里残留的「schema v1」更正为 v2。
- **条目级失败也影响退出码**（复审 N4）：频道状态 `ok` 但有条目 503 时，`summary.failed` 仍是 0、进程 exit 0，插件不会重试。现在退出码同时看「频道失败」与「任何频道 `result.failed > 0`」。
- **`--verify` 变成真的完整性检查**（复审 P2）：原先只校验 `index.json` 的 schema 再打印期页列表——记录文件缺失、图片引用指向已删文件都照样「校验通过」。现在分两级：`problems`（索引契约、期表结构、台账里有数据的频道缺记录目录/目录为空、图片引用指向不存在的文件）影响退出码；`notes`（台账与文件数不符、上一轮失败频道、占位图数量、只跑过 `--export`）只报告。顺带修正帮助文案——旧文案写「校验频道状态」，实现里根本没有这项检查。
  - 低配机器友好：记录只做一次 `readdir` 取文件名；图片存在性只遍历目录收集文件名、不 `stat`/不分组/不解码；图片引用逐页读取、读完即丢。实测 18,560 图 / 86,239 引用 **约 0.5 秒**（开发机）。
  - 边界按真实产物校准过三处：`records: 0` 的空页不要求记录目录；`skipped`（上游没变、沿用旧记录）与 `ok` 一样必须真有记录；大小写不敏感的文件系统上，上游只差大小写的两个资源会落到同一个文件，逐字符比对会误报，改为「真缺文件才报」。
- **文本请求的 5xx 也会重试**（复审 P1）：`fetchText()` 原先拿到响应就返回，5xx 一次都不重试，而 `fetchBuffer()` 除 403/404 都会重试——同一个上游抽风，图片能自愈、文本只能等下一轮。现在两边同一套规则：403/404 一次即返，网络异常、超时与其余状态码按线性退避重试。
- **占位图口径分两类**：`stats.placeholder` 拆成 `unmapped`（规则没覆盖到这个字段，压根没有候选 URL，改规则才会变）与 `unresolved`（有候选但本轮全部失败，下一轮还会试），前者是规则缺口、后者是抓取失败，混成一个数看不出该修哪儿。退出码不变——现有产物里有 2,514 条占位，把占位接进退出码会让每次抓取都判失败。
- **注释订正**：`src/images/refs.mjs` 文件头仍写「候选按源优先级生成」，实际早已改为按扩展名（格式体积）排序，与新增源者容易读串。

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