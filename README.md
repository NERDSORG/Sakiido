# sakiido

把旧版 [Mutsumi](https://github.com/guilimao/Mutsumi) 的 `.mtm` 会话文件迁移到最新磁盘格式的小工具。


## 什么时候需要它

- 升级 Mutsumi 后，打开以前的会话报 `UNSUPPORTED_MTM_FORMAT`；
- 或者你想先把旧会话迁移好再升级。

## 使用

要求 Node.js ≥ 23.6（直接运行 TypeScript，无需构建、无需安装依赖）。

```bash
# 先预演，看看会发生什么（不写任何文件）
node src/cli.ts ~/my-project/.mutsumi --dry-run

# 迁移整个 .mutsumi 目录（原地迁移，旧文件保留为 <名字>.v0.bak 备份）
node src/cli.ts ~/my-project/.mutsumi

# 或者迁移到别的目录，原文件完全不动
node src/cli.ts ~/my-project/.mutsumi --out ~/migrated
```

也可以对单个文件使用：`node src/cli.ts 某个会话.mtm`。

### 选项

| 选项 | 说明 |
|------|------|
| `--dry-run` | 只报告将发生什么，不写任何文件 |
| `--out <dir>` | 把迁移结果写到该目录（镜像输入目录结构），原文件不动；已是最新格式的文件会被原样复制过去，使输出目录完整可用 |
| `--no-backup` | 原地迁移时不生成 `<名字>.v<N>.bak` 备份 |
| `-h, --help` | 帮助 |

### 行为说明

- 已是最新格式的文件自动跳过（不改动、不备份），可以放心重复运行。
- 每个迁移结果写入前都会经过与扩展一致的严格校验，**保证输出一定能被新版 Mutsumi 打开**；校验不过则保留原文件并报 FAILED。
- 所有有信息损失的转换（如无法保留的旧字段）都会以 `⚠` 逐条列出，迁移后请留意输出。
- 目录输入会递归扫描 `*.mtm`（跳过 `node_modules`、`.git`）。
- 退出码：全部成功或安全跳过为 0，任一文件失败为 1。
- 如果文件比本工具支持的格式还新（说明你的 Mutsumi 比本工具新），会明确提示更新 sakiido，不会乱动文件。

## 更多信息

- 两版格式的完整差异与逐条迁移规则：[docs/format-v0-v1.md](docs/format-v0-v1.md)
- 项目架构与开发约定（如何支持未来的新格式版本）：[AGENTS.md](AGENTS.md)

## 许可证

Apache License 2.0
