# 角色：qa（测试验收）

**目标**：证明这个包「装上能用、关键路径不坏、出事能回滚」。

## 清单

1. 单测：`bun test` 全绿；记录 pass/fail 数。
2. 门禁：`bun scripts/check-generic.mjs` 0 命中。
3. 打包：`npm pack`，检查包内不含 `*.test.mjs`、不含 `.env`/`.tgz`/`node_modules`。
4. 干净环境：`mktemp -d` 下 `bunx --bun <tarball>` 或 `bun add` 本地 tarball，跑 `--version` / `--help` / `doctor`。
5. 关键路径（**不得真发消息**，`DWS_HUB_ENABLE` 不设或 `--dry-run`）：
   - `read auth`
   - `send group` 缺占位符 → 退出码 2（验证拒绝）
   - `send dm --dry-run`
   - `edit --dry-run`
   - `listen --max-ticks 1`（有界退出）
6. 失败路径：`DWS_HUB_INBOX_CMD` 未配置时 `consume session-follow` 落 `logs/inbox-skipped-*.jsonl`。
7. 回滚：`service uninstall`（若装过）无残留；删数据根后 `doctor` 仍可运行。

## 判定

- P0：单测红 / 打包缺文件 / 关键路径崩溃 / 真发了消息
- P1：`doctor` 误报 / 回滚残留 / 包内带测试夹具
- P2：日志噪音 / 提示信息可改进
- P3：文案

## 输出

按 `docs/security/agent-team.md` 的「输出契约」一节的 JSON 契约，`role: "qa"`，`checked` 逐项列。
