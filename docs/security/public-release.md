# dws-hub 公开发布门禁（Public Release Gate）

> 状态：**发布门禁生效中**。任何一项未通过，**不得 push 到 GitHub、不得发 npm、不得转 public**。
> 原则：推送 / 转 public / 发 npm 之前，必须通过测试、法务、产品、设计四道验收 + 独立安全审核。

## 0. 三条原则

1. **宁可晚发，不可回滚**。公告仓公开后才发现内部标识，只能**重建 git 历史 + 删库重建 + 重新公开**——成本远高于公开前多花一天。
   公开前的成本最低，公开后的补救成本最高。
2. **自签无效**。脱敏与验收必须由**非作者**执行：独立审核 agent / 同事 / 用户签字。作者自己的「我看过了」不算通过。
3. **证据落盘**。每道验收产出 `docs/security/audits/<YYYY-MM-DD>-<team>.json`，**不含 secret 原文**，只含结论 + 位置 + 修法。

## 1. 四道验收 + 独立审核

| 验收方 | 关注 | 通过条件（全部满足） | 证据 |
|---|---|---|---|
| **测试** | 功能、回归、发布物 | 单测全绿；干净机器可装可用；关键路径冒烟通过；回滚演练通过；`npm pack` 清单符合预期 | `audits/<date>-test.json` |
| **法务** | 许可、商标、第三方、数据 | 代码许可清晰；无第三方专有代码；依赖许可兼容；不暗示官方；无客户/员工数据 | `audits/<date>-legal.json` |
| **产品** | 定位、范围、对外表述 | 定位与 README 一致；能力表不夸大（未实现的写「迁移中」）；范围只含通用能力；路线图无内部计划 | `audits/<date>-product.json` |
| **设计** | 文档、CLI 体验、术语 | 信息层级清楚；CLI 输出/退出码一致；术语统一；无内部缩写；中英边界明确 | `audits/<date>-design.json` |
| **独立审核（安全）** | 脱敏、历史、元数据、打包 | 树/历史/元数据/包内 四层扫描通过；无 P0/P1；无法扫描记为 `unknown`（不算通过） | `audits/<date>-security.json` |

### 1.1 测试验收清单

```bash
bun test                                   # 含 check-generic 自测 + layering + 各模块单测
bun scripts/check-generic.mjs              # 0 命中
npm pack --dry-run                         # 文件清单符合预期，无 test 夹具/本地文件
bun bin/dws-hub.mjs --version
```

- [ ] 幂等发送：重复 `--uuid` 不产生第二条消息（单测 + dry-run）
- [ ] @ 渲染：群发缺占位符被拒（退出码 2）
- [ ] 编辑纠正：`edit` 默认读回断言无 `<@` 字面量
- [ ] 监听有界：`listen --max-ticks 1` 正常退出
- [ ] 限频/静默时段：单测覆盖
- [ ] 降级/恢复：单测覆盖
- [ ] 未配置 `DWS_HUB_INBOX_CMD`：消息落 `logs/inbox-skipped-*.jsonl`，不丢
- [ ] 回滚：卸载后无残留；删数据根后可重建
- [ ] 干净机器（无本项目历史）：`bunx dws-hub --version` / `doctor` 可用

### 1.2 法务验收清单

- [ ] `LICENSE`（MIT）覆盖全部代码与文档
- [ ] 运行时依赖：仅 `node:*` 内建 + `bun:sqlite`（0 个第三方包）
- [ ] 开发依赖（若有）：许可为 MIT/Apache-2.0/BSD 类，无 GPL/AGPL 传染
- [ ] 无复制的第三方专有代码；引用的外部文档注明来源
- [ ] 商标：`dws` 指钉钉官方 CLI；README **不**声称官方/授权/合作
- [ ] 数据：无客户数据、员工个人信息、真实会话 id、内网域名、工号、组织 ID
- [ ] 提交历史/分支名/tag 不含内部项目名
- [ ] 出口/合规：通用工具，无加密与受控技术

### 1.3 产品验收清单

- [ ] 一句话定位与 README 首段一致
- [ ] 能力表只写已实现能力；未实现的标「迁移中」或删除
- [ ] 范围：只含「换个公司也成立」的 dws 能力；业务能力明确留在消费方
- [ ] 路线图（若有）不含内部计划、客户名、日期承诺
- [ ] 命名：仓库名 / npm 包名 / CLI 名一致（`dws-hub`）
- [ ] 对外承诺：支持的 bun / dws 版本、平台（macOS/Linux）写明

### 1.4 设计验收清单

- [ ] README 信息层级：是什么 → 为什么 → 安装 → 快速开始 → 数据/配置 → 边界 → 许可
- [ ] SKILL.md 与 README 不重复冲突；SKILL 只给 agent 用的执行要点
- [ ] CLI：`--help` 列全可用命令；未实现命令明确提示「迁移中」
- [ ] 退出码一致：0 成功 / 2 参数 / 3 下游失败 / 4 鉴权缺失 / 5 未预期
- [ ] 错误信息只含通用路径（`$DWS_HUB_HOME`），不含真实用户目录
- [ ] 术语统一：send / reply / edit / listen / consumer / follow / anchor / topic
- [ ] 语言边界（**唯一规则来源**）：对外主文档（README / SKILL / docs）英文；示例可中文；CLI 输出目前为中文，须在 README 注明
- [ ] 无内部缩写（内部规则编号、内部 agent 名、内部流程代号）出现在对外文档

### 1.5 独立安全审核（自签无效）

扫描四层，输出 verdict JSON：

| 层 | 命令 | 通过条件 |
|---|---|---|
| 当前树 | `bun scripts/check-generic.mjs`（含本地 denylist 或 `DWS_HUB_DENYLIST`） | 0 命中 —— **必要非充分**：规则集必须覆盖真实内部词表，且不能替代人工/agent 结构扫描 |
| git 历史 | `git log --all -p \| <scanner>`；`git rev-list --all --objects` | 所有可达 commit 干净 |
| GitHub 元数据 | description / topics / releases / issues / PR / wiki / Actions 日志 | 无内部信息 |
| 打包 | `npm pack --dry-run`；解包后扫 `*.tgz` 内容 | 无 `.env`、无 source map、无测试夹具、无本地路径 |

```json
{
  "verdict": "pass|blocked|unknown",
  "scope": "commit:<sha>",
  "history_clean": true,
  "findings": [{ "id": "...", "severity": "P0|P1|P2|P3", "area": "tree|history|metadata|package", "evidence": "...", "fix": "..." }],
  "signed_by": "<非作者>",
  "date": "YYYY-MM-DD"
}
```

- 任一 P0/P1 → `blocked`
- 无法扫描（缺工具/权限/历史不完整）→ `unknown`，**不得算通过**

## 2. 绝对脱敏：词表与位置

> **词表本身不入库**：放 `scripts/denylist.txt`（git-ignored）或 CI secret `DWS_HUB_DENYLIST`。

| 类别 | 示例（占位） | 说明 |
|---|---|---|
| 组织标识 | 公司名、产品名、部门名、团队名 | 代码/文档/注释/测试夹具 |
| 人员 | 真实姓名、邮箱、工号 | 同上 |
| 网络 | 内网域名、内网 IP、私有 registry | 同上 |
| 钉钉 | 真实 `cid…`、`openDingTalkId`、群名 | 夹具必须用合成值 |
| 业务 | 客户名、商品/组织数据、业务黑话 | 一律不进包 |
| 框架 | 其他 agent 框架的数据根 / 入口 | 通用层不得绑定 |

**位置全景**（全部都要扫）：源码、注释、测试夹具、文档、**提交信息**、分支名、tag、issue/PR 正文、
Actions 日志、npm 包内文件、仓库 description/topics。

## 3. 通过后的发布动作（人工，按序）

1. 独立审核 `pass` + 四位负责人签字（测试/法务/产品/设计）
2. 转 public（`gh repo edit --visibility public --accept-visibility-change-consequences`）
3. 配 GitHub secret `DWS_HUB_DENYLIST`（CI 用）
4. `npm publish --access public`（人工 token 操作）
5. 打 tag `v0.1.0`；GitHub Release 说明不引用内部信息

## 4. 已发生记录

| 日期 | 事件 | 处理 |
|---|---|---|
| 2026-11-26 | 包骨架 + 门禁脚本首次推送时仓库为 public | 按发布纪律**立即转 private**；内容仅骨架与门禁脚本，无内部标识。后续代码在门禁通过前**不再推送** |
| 2026-11-26 | 重写历史后，远端仍保留旧 commit（含内部路径/短 sha） | **删除 GitHub 仓库**（本地内容完整）；门禁通过后重新创建 private 仓并推送单条干净 commit，避免不可达旧对象残留 |
