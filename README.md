# Hesperides / 赫斯珀里得斯

多源游戏数据采集引擎，为 [Atlas-Plugin](https://github.com/AxiuCN/Atlas-Plugin) 提供规范化数据。

- 数据源一：**nanoka.cc** — 原神 / 星铁 / 绝区零**全部页面**
- 数据源二：**玉璃**（[alioth.wiki](https://alioth.wiki)）— 原神 / 星铁**全量页面**
- 数据源三：**Lunaris**（[lunaris.moe](https://lunaris.moe/)）— 原神14个频道，支持中文详情、期表与图片
- 运行环境：Node.js ≥ 20，零第三方依赖

## 快速开始

```bash
# 列出全部频道
node src/cli.mjs --list-channels

# 抓终局 7 个频道（增量）
node src/cli.mjs --channels alioth:gi:abyss,alioth:gi:theater,alioth:gi:stygian,alioth:hsr:chaos,alioth:hsr:fiction,alioth:hsr:as,alioth:hsr:arbitration

# 抓 Lunaris 角色、武器、圣遗物及其中文详情和图片
node src/cli.mjs --channels lunaris:gi:character,lunaris:gi:weapon,lunaris:gi:artifact --with-details --images

# 抓全部频道（含 TextMap 大文件，注意体积与耗时）
node src/cli.mjs --all

# 全量重抓单个频道
node src/cli.mjs --channel alioth:gi:abyss --mode full

# 只重建索引（不联网）
node src/cli.mjs --export

# 只读体检：索引契约 / 期表结构 / 记录文件 / 图片引用（不修数据）
node src/cli.mjs --verify
```

产物默认写在 `data/`（不入库）：

```
data/
├── index.json          频道状态 + 每源每页记录 id + 图片元数据（imageCount / icon）
├── periods.json        期索引（终局类频道，按 game/source/page 分组）
├── manifest.json       增量判据与台账（每频道的 hash / lastModified / 版本 / 期版本）
├── image-failures.json 失败候选（下一轮默认不再探测）
├── records/<game>/<source>/<page>/<id>.json   记录（v2 起带源，同名页不互相覆盖）
├── imagerefs/<game>/<source>/<page>.json      该页图片引用（读一页只加载一页）
├── upstream/<source>.json                     上游根清单快照（nanoka / Lunaris，玉璃无根清单）
└── images/<game>/<目录>/<文件>                图片文件（镜像 CDN、按 URL 去重）
```

## 设计要点

- **抓取决策权在调用方**：本仓库只声明"有哪些频道、怎么抓"，不决定"抓不抓、什么时候抓、取哪个源"。
  频道列表与模式由调用方传入——例如 Atlas-Plugin 只取 nanoka 全量 + 玉璃终局，那是它的取舍
- **各源对等，不做业务裁剪**：可抓的页面都抓、都保留。源之间重叠的、或某个消费者暂时用不到的页面同样保留；
  本仓库不判断哪个源更权威，也不替消费者选源
- **源可插拔**：新增源（例如防现役源跑路的备用源）只需在 `src/sources/registry.mjs` 的 `SOURCES` 加一项、
  在 `sources/<源>/` 下提供频道表与抓取器（有图片再加 `SOURCE_IMAGE_RULES` 一条）。
  产物按 `<source>` 分段，同名页不会互相覆盖，抓取 / 导出 / 去重逻辑都不用改
- **增量省请求**：相同版本且详情覆盖完整时，目录未变（304 或内容指纹一致）会跳过；新增详情采集会补齐已有目录
- **可续跑**：每频道结束即写 manifest，进程被杀后重跑只补没抓的
- **失败不删旧数据**：`failed` / `absent` / `unverified` 都保留上一轮数据，供插件降级展示
- **上游缺陷可审计地修正**：玉璃个别期的时间年份写错，规范化时修正并标 `timeCorrected`，原值留 `rawTime`

## 文档

| 文档 | 内容 |
|---|---|
| [docs/架构.md](docs/架构.md) | 分层、数据流、职责边界 |
| [docs/数据契约.md](docs/数据契约.md) | `schemaVersion`、产物结构、与插件/补丁的对应 |
| [docs/源适配.md](docs/源适配.md) | 各源的端点、频道形态、ID 来源实测、图片规则、上游缺陷与覆盖范围，以及新增源的接入点 |
| [docs/抓取协议.md](docs/抓取协议.md) | 增量模型、状态语义、限速、期规范化、CLI |
| [docs/测试.md](docs/测试.md) | 套件与加套件约定 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录（产物契约变更都记在这里） |

## 测试

```bash
pnpm test                # 全部离线套件
node test/run.mjs --list
```

## 名字的由来

赫斯珀里得斯（Hesperides）是希腊神话里**看守金苹果园的仙女**。

取名时沿着 Atlas 的神话关系往下找，而不是另起一个无关的希腊词：

```
Atlas（撑天的泰坦）
  └── 金苹果园（世界的极西，Hesperia = 黄昏之地）
        └── Hesperides（守园的仙女）
```

- 在**后期流传的版本**里，她们被称作「阿特拉斯之女」，金苹果园也与他有关；
  **更早的赫西俄德《神谱》**里，她们是夜之女神倪克斯的女儿——两种说法都见于传世文本，
  这里取的是「与 Atlas 同属一条神话链」的那一支。
- 职责上的呼应也很直接：Atlas 撑起天空，他的女儿们**看守、收集、维护**园中的金苹果。
  采集引擎干的正是同一件事——看守、收集、维护图鉴数据，作为 Atlas-Plugin 的上游而非另起炉灶。

## 鸣谢

没有这些项目就没有本引擎：

- [nanoka.cc](https://nanoka.cc/) — 数据源之一，覆盖原神 / 星铁 / 绝区零全部页面
- [玉璃 alioth.wiki](https://alioth.wiki/) — 数据源之一，提供原神 / 星铁全量页面，含终局期与期时间
- [nanoka-atlas-backend](https://github.com/MOPELotus/nanoka-atlas-backend) — 上一代采集引擎（已归档）。
  本引擎的频道类型划分、增量续跑语义、以及「每频道结束即写 checkpoint」的思路都来自它；
  v2 的「源进路径」与图片采集是对它已知问题的重做
- [Nwflower/Atlas](https://github.com/Nwflower/Atlas) — 图鉴插件的原始形态，消费端的字段口径源自这里
- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) — 运行框架
- [Lotus-ReFactor](https://github.com/MOPELotus/Lotus-ReFactor) — 搜索评分与频道组织的参考实现

## 许可

数据抓取自公开站点，**仅供本地自用**；数据版权归原权利人，本仓库不附带任何数据文件

代码以 GPL-3.0-only 授权，见 [LICENSE](LICENSE)。
