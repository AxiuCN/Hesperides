# Hesperides / 赫斯珀里得斯

多源游戏数据采集引擎，为 [Atlas-Plugin](https://github.com/AxiuCN/Atlas-Plugin) 提供规范化数据。

- 数据源一：**玉璃**（[alioth.wiki](https://alioth.wiki)）— 原神 / 星铁全量页面
- 数据源二：**nanoka.cc** — 原神 / 星铁 / 绝区零全量页面
- 运行环境：Node.js ≥ 20，零第三方依赖

## 快速开始

```bash
# 列出全部频道
node src/cli.mjs --list-channels

# 抓终局 7 个频道（增量）
node src/cli.mjs --channels alioth:gi:abyss,alioth:gi:theater,alioth:gi:stygian,alioth:hsr:chaos,alioth:hsr:fiction,alioth:hsr:as,alioth:hsr:arbitration

# 抓全部频道（含 TextMap 大文件，注意体积与耗时）
node src/cli.mjs --all

# 全量重抓单个频道
node src/cli.mjs --channel alioth:gi:abyss --mode full

# 只重建索引（不联网）
node src/cli.mjs --export

# 校验产物
node src/cli.mjs --verify
```

产物默认写在 `data/hesperides/`（不入库）：

```
data/hesperides/
├── index.json     频道状态 + 每页记录 id + 记录级图片元数据（imageCount / icon）
├── periods.json   期索引（终局类频道）
├── images.json    记录级图片引用与落盘路径
├── images/        图片文件（镜像 CDN、按资源名去重）
├── manifest.json  增量判据
└── records/<game>/<page>/<id>.json
```

## 设计要点

- **抓取决策权在调用方**：本仓库只声明"有哪些频道、怎么抓"，不决定"抓不抓、什么时候抓"。Atlas-Plugin 传入频道列表与模式
- **覆盖上游全部页面，不做业务裁剪**：与另一源重叠、或某个消费者暂时用不到的页面同样保留——Hesperides 保证可抓、可增量、可追溯，用哪些由调用方决定
- **增量省请求**：索引未变（304 或内容指纹一致）→ 整频道跳过；稳态一次更新只发 7 个请求
- **可续跑**：每频道结束即写 manifest，进程被杀后重跑只补没抓的
- **失败不删旧数据**：`failed` / `absent` / `unverified` 都保留上一轮数据，供插件降级展示
- **上游缺陷可审计地修正**：玉璃个别期的时间年份写错，规范化时修正并标 `timeCorrected`，原值留 `rawTime`

## 文档

| 文档 | 内容 |
|---|---|
| [docs/架构.md](docs/架构.md) | 分层、数据流、职责边界 |
| [docs/数据契约.md](docs/数据契约.md) | `schemaVersion`、产物结构、与插件/补丁的对应 |
| [docs/源适配.md](docs/源适配.md) | 玉璃端点、ID 来源实测、上游缺陷、覆盖范围 |
| [docs/抓取协议.md](docs/抓取协议.md) | 增量模型、状态语义、限速、期规范化、CLI |
| [docs/测试.md](docs/测试.md) | 套件与加套件约定 |

## 测试

```bash
pnpm test                # 全部离线套件
node test/run.mjs --list
```

## 合规

数据抓取自公开站点，**仅供本地自用**；数据版权归原权利人，本仓库不附带任何数据文件（`data/` 不入库）。
代码以 GPL-3.0-only 授权，见 [LICENSE](LICENSE)。
