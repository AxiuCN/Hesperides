# AGENTS.md — Hesperides

本文件为 Hesperides 项目的 AI 协作指引。通用协作原则见用户级指令（`~/.dsh/AGENTS.md`）；本项目是 Atlas-Plugin 的数据子模块，插件侧约定见 `../AGENTS.md`。

## 项目概况

Hesperides（赫斯珀里得斯）— 多源游戏数据采集引擎，为 [Atlas-Plugin](../../../../AGENTS.md) 提供规范化数据。

- **单入口之一**：`src/cli.mjs`（命令行）；库入口按需 import `src/export/index.mjs`、`src/sources/**`
- **ESM**，`"type": "module"`，GPL-3.0-only
- **数据源**：玉璃（alioth.wiki）与原神/星铁终局的期与条目；nanoka.cc 覆盖上游全部页面（绝区零全部 + 原神/星铁全部，含终局页），两源重叠部分**不裁剪**，由消费者取舍（`src/sources/registry.mjs` 统一分发）
- **产物不入库**：`data/`（抓取结果，体积大且数据版权归原权利人）

## 核心约定

1. **抓取决策权在调用方，且不做业务裁剪** — 本仓库不提供"默认频道集合"，也没有频道开关；也**不因为"与另一源重复"或"某消费者用不到"而删除频道**（多消费者可各自取舍）。`plan` / `channels` 由调用方筛选后传入；CLI 的 `--all` 才是全部
2. **失败不删旧数据** — 任何状态（`failed` / `absent` / `unverified`）都必须保留上一轮记录，供插件降级展示
3. **原子写** — 记录、manifest、导出文件一律「临时文件 + rename」
4. **每频道结束即写 manifest** — 中断可续跑，这是与旧后端（nanoka-atlas-backend）最关键的区别
5. **不改口径** — 玉璃的 `Ver` 是"覆盖版本"，**不换算成开启版本**；期归属由调用方按 `begin` 判定
6. **上游缺陷可修但必须可审计** — 时间年份纠错要标 `timeCorrected` 并保留 `rawTime`
7. **日志中文、无依赖** — 用 `core/io.mjs` 的 `log`，不引入第三方库
8. **契约先行** — 改产物结构必须同步 `src/schema/index.mjs` 的 `SCHEMA_VERSION` 与 `docs/数据契约.md`

## 目录

| 目录 | 职责 |
|---|---|
| `src/core/` | HTTP、限速、并发池、原子写、日志 |
| `src/schema/` | `SCHEMA_VERSION`、产物骨架、校验 |
| `src/sources/<源>/` | 频道表、抓取、规范化（一源一目录） |
| `src/export/` | 产物汇总（`index.json` / `periods.json`） |
| `test/` | 离线回归套件（`pnpm test`） |
| `docs/` | 架构 / 数据契约 / 源适配 / 抓取协议 / 测试 |

## 文档索引

| 想了解 | 先读 |
|---|---|
| 分层、数据流、职责边界 | [`docs/架构.md`](docs/架构.md) |
| 产物结构、`schemaVersion` 规则、与插件/补丁的对应 | [`docs/数据契约.md`](docs/数据契约.md) |
| 玉璃端点、ID 来源实测、上游缺陷与覆盖范围 | [`docs/源适配.md`](docs/源适配.md) |
| 增量模型、状态语义、限速、期规范化、CLI | [`docs/抓取协议.md`](docs/抓取协议.md) |
| 套件与加套件约定 | [`docs/测试.md`](docs/测试.md) |

## 测试

```bash
pnpm test                     # 全部离线套件
node test/run.mjs --list      # 列出套件
node test/run.mjs --filter=harvest
```

约定：离线（注入 `fetchImpl`，**不访问网络**）、临时产物只写 `test/.test-tmp/`、断言必须能真的失败。

## 数据抓取（人工）

```bash
node src/cli.mjs --list-channels
node src/cli.mjs --channels alioth:gi:abyss,alioth:hsr:as
node src/cli.mjs --all --mode full
node src/cli.mjs --export      # 只重建索引
```

默认产物目录 `data/hesperides/`；`--json` 给机器读摘要，退出码 0/1。

## Git 约定

- 用户手动提交，助手不执行 `git commit`（除非明确授权）
- 提交摘要格式：`prefix: 中文描述` + 每条改动一行 `- `
- 数据目录、`node_modules/`、`config/*.yaml`、`docs/private/` 不入库
