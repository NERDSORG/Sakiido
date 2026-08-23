# AGENTS.md — sakiido 设计与约定

sakiido 是 [Mutsumi](https://github.com/guilimao/Mutsumi)（本地仓库 `/home/guilimao/code/Mutsumi`）的配套迁移工具：
把任意历史版本的 `.mtm` 会话文件迁移到最新磁盘格式。Mutsumi 只认 `formatVersion` 等于其当前值的文件，
旧文件一律拒绝打开并提示使用 standalone migration tool——那就是本工具。

修改本仓库前请先读完本文档。核心原则只有三条：

1. **版本链**：迁移永远是"相邻版本逐级跳"，不做"任意旧版 → 最新"的直通转换。
2. **步骤冻结**：一个迁移步骤被更新的步骤取代后永不修改。
3. **单一注册点**：哪个版本被支持只由 `src/core/registry.ts` 决定，其余代码一律版本无关。

## 版本命名轴

项目里有两套版本号，**内部一律以格式版本（formatVersion）为正典**：

- v0 = 无 `formatVersion` 字段的布局（Mutsumi 0.0.8 写入的格式）
- v1 = `formatVersion: 1`（Mutsumi `refactor(mtm): finalize format v1` 提交起）
- v2、v3… = 未来 Mutsumi bump `MTM_FORMAT_VERSION` 之后的格式

应用版本（0.0.8、0.1.x…）只出现在面向用户的说明里，且映射关系只写在 README 的支持矩阵，
不要让代码或文件名依赖应用版本。备份文件命名同理：`<名字>.v<N>.bak`（N 为源格式版本）。

## 架构

```
            detect           steps（每步校验）           encode
JSON 解析 ─────────▶ 版本 N ──▶ N+1 ──▶ … ──▶ LATEST ─────────▶ 写盘
                     │  ▲
                     │  └── registry：v0→v1→…→LATEST 的连续链
```

```
src/
  cli.ts                 CLI 外壳：参数、遍历、备份、报告。版本无关，加新版本时不需要改。
  core/
    step.ts              MigrationStep 接口 + MigrationInputError
    detect.ts            结构嗅探出格式版本号（v0 无标记，靠形状识别）
    registry.ts          ★ 步骤注册表——唯一需要改动以支持新版本的地方
    pipeline.ts          链式执行器：detect → 逐 step 迁移并校验 → 序列化
  formats/
    v0.ts                v0 结构类型（只做输入，无校验器）
    v1.ts                v1 结构类型 + 严格校验器（移植自 Mutsumi mtmFormat.ts）
  steps/
    v0-to-v1.ts          v0 → v1 转换逻辑（已冻结）
  providers.ts           provider ID 重映射 / api 推断表
test/
  core/pipeline.test.ts  链的连续性、全量 fixture 链式迁移、各检测结果
  steps/v0-to-v1.test.ts 冻结步骤的行为测试
  cli.test.ts            CLI 端到端
  fixtures/v0/… v1/…     fixture 按源格式版本分目录
docs/
  format-v0-v1.md        冻结步骤的格式差异规格
```

设计意图：

- **每个步骤只描述相邻两版的差异**，小而可测。代码量随版本数线性增长，而不是平方。
- **pipeline 在每步之后调用 `step.validateTarget`**，单步 bug 不会级联污染后续步骤；
  最终写入的文件必然通过最新格式的严格校验。
- 旧文件跨多个版本时（如 v0 文件在 v2 时代迁移），一次运行走完整条链，
  备份只备份最初的源文件（`v0.bak`），中间版本不落盘。
- 幂等：已是最新格式的文件跳过，重复运行安全。

## 步骤冻结规则

一旦出现 `v1 → v2` 步骤，`steps/v0-to-v1.ts` 与 `formats/v1.ts` 即冻结：

- **不再修改**，包括重构、风格调整、"顺手改进"。冻结步骤的回归会静默破坏用户的历史数据，
  任何改动收益都抵不过这个风险。
- 唯一例外：真实世界数据暴露出步骤 bug。此时必须先在 `fixtures/v0/` 添加暴露该 bug 的最小
  fixture，再修复，让回归永久有测试兜底。
- 冻结不等于删除：任何时代的用户都可能拿着任意旧格式的文件前来迁移，链上所有步骤永远保留。

## 新增一个格式版本（Mutsumi bump 了 MTM_FORMAT_VERSION）

按顺序做，做完之外什么都不用改（cli、pipeline、detect 都不需要动）：

1. **formats/v(N).ts**：从 Mutsumi 的 `src/mtmFormat.ts` / `src/types.ts` 移植新版的类型与严格校验器，
   保持忠实移植（见下节"与 Mutsumi 的同步"）。不要在旧版本模块上就地升级。
2. **steps/v(N-1)-to-v(N).ts**：写新步骤。转换规则先在 `docs/format-v(N-1)-v(N).md` 里成文，
   步骤实现对照文档写；所有有信息损失的处理必须进 `warnings`。
3. **registry.ts**：把新步骤追加到 `STEPS`。`LATEST_FORMAT_VERSION` 自动推导，不用手写。
4. **fixtures/v(N-1)/**：按新版写入路径构造真实样本。`pipeline.test.ts` 的
   "every v0 fixture migrates through the full chain" 模式会自动把新 fixture 纳入链式回归。
5. **README**：更新支持矩阵（含应用版本 ↔ 格式版本的对应），sakiido 版本号升一个 minor。
6. 从此 `steps/v(N-1)-to-v(N).ts` 之外的上一步进入冻结。

## 与 Mutsumi 的同步

sakiido 的校验器是 Mutsumi `src/mtmFormat.ts` 的人工移植——这是本项目最大的漂移风险。
约定：

- `formats/v(N).ts` 的文件头必须注明移植来源（文件 + 提交）。移植时保持结构对应、
  不做"改进"，让逐段比对尽可能容易。
- **TODO（漂移检测）**：增加一个测试，对固定 pinned commit 的 Mutsumi 源码与移植版做归一化对比，
  防止移植版日后被悄悄改动。待 Mutsumi 仓库可被 CI 访问后实现。
- **长期方案**：推动 Mutsumi 把格式定义（types + validator + `MTM_FORMAT_VERSION`）抽成无
  vscode 依赖的共享模块（`mtmFormat.ts` 目前只依赖 pi-ai 和内部模块，具备条件），
  届时 sakiido 直接引用，移植环节整体消失。
- 对 Mutsumi 的期望约定：每次 bump `formatVersion` 时留下格式变更说明，作为新步骤的规格来源，
  而不是让 sakiido 从 diff 里逆向。

## 测试约定

- `npm run check-types`（tsc --noEmit）与 `npm test`（node --test）都必须通过；
  Node ≥ 23.6 直接运行 TS，无构建步骤、无运行时依赖，保持这样。
- fixture 一律按源格式版本放 `fixtures/v<N>/`；新增 fixture 自动进入链式回归测试，无注册成本。
- 步骤测试只测单步行为；跨版本链的正确性由 `pipeline.test.ts` 的全量 fixture 测试保证。
- 链的连续性（v0 起步、无缺口、末尾等于 LATEST）有专门测试，注册表写错会被直接抓住。

## 非目标

明确不做，避免范围蔓延（有真实需求时先修订本节再动手）：

- **降级**（新格式 → 旧格式）：不做。
- **修复同版本损坏文件**：校验失败报 FAILED 并保留原文件，不尝试修复。
- **迁移 Mutsumi 的 VS Code settings**（`mutsumi.providers` 等）：`.mtm` 内的 provider ID
  重映射已由迁移步骤处理；settings.json 属于另一块迁移面，如需支持应作为独立子命令设计。
