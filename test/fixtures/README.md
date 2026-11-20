# test/fixtures

离线回归用的样本，**不是数据集**，也不要当缓存用。

| 路径 | 内容 | 性质 |
|---|---|---|
| `gensri/` | `characters.json` / `weapons.json` / `artifacts.json` / `db-versions.json` / `seasons.json`、3 个条目详情、5 期 `config.json` | 上游响应**原样捕获**（2026-11-14），`provenance.json` 逐文件记 URL 与 sha256 |
| `lunaris/` | 12 个目录、详情、banner、leyline、version | **手工裁剪**的最小样本，每个目录 1 条 |
| `cli-partial-fetch.mjs`、`gensri/cli-fetch.mjs` | 子进程注入脚本（`--import`） | 代码，不是数据 |

## 约定

1. **只收文本响应**：图片（`.png` / `.webp` / …）不入库——美术资源版权归原权利人，且图片层要验的是「下载 → 落盘路径 → mime 决定的后缀 → 第二轮复用」，合成字节足够覆盖，见 `test/gensri-images.test.mjs` 的 `syntheticImage()`。
2. **sha256 针对 LF 字节**：Windows 工作副本按 `.gitattributes` 显示为 CRLF，比对前归一化（同上套件的 `lfBytes()`）。
3. **刷新样本**：重抓上游 → 覆盖文件 → 更新 `provenance.json` 的 `capturedAt` 与 `sha256` → 跑 `node test/run.mjs --filter=gensri`。上游新增条目会让「总数」类断言变化，那是预期，不是解析坏了。
4. **不放抓取产物**：`data/` 在 `.gitignore` 里，本目录同样不收。
