# 验收 agent 团队（固定角色）

> 公开前的验收由 **agent 团队**执行，不是找人签字。角色固定、输入输出固定、判定规则固定。
> 目的：公开前的验收由**固定角色的 agent 团队**执行，结论可复现、可追溯。

## 0. 为什么用 agent 团队

- **可重复**：同一份角色定义 + 同一份清单，每次发布都能跑一遍，结论可复现。
- **独立**：验收 agent 与实现者**不是同一个会话**；每个角色只看自己那一面，避免「我做完了所以没问题」。
- **可追溯**：每个角色产出固定格式 JSON，聚合为 `docs/security/audits/<date>-<role>.json`。

## 1. 角色与边界

| 角色 | 关注面 | 允许做的事 | 禁止 |
|---|---|---|---|
| `qa` 测试验收 | 单测、干净环境安装、关键路径、回滚 | 跑测试 / 打包 / 临时目录冒烟 | 改仓库、真发消息、推送 |
| `legal` 法务验收 | 许可、依赖、商标、数据、历史 | 读文件 / 读 git 历史 / 读依赖声明 | 改仓库、给法律意见之外的推断 |
| `product` 产品验收 | 定位、能力表真实性、范围、命名 | 读 README/文档/代码对照 | 改仓库、承诺未实现能力 |
| `design` 设计验收 | 文档层级、CLI 一致性、术语、i18n | 读文档 / 跑 `--help` / 读退出码定义 | 改仓库、改文案 |
| `security` 安全验收 | 脱敏（树/历史/元数据/包）、凭据、PII | 跑门禁 / 扫描 / 读 gh 元数据 | 改仓库、输出敏感词原文、推送 |

**共同约束**

1. **只读**：不得修改仓库任何文件；需要写东西只能写系统临时目录。
2. **不推送**：不得 `git push` / `gh repo edit` / `npm publish`。
3. **不输出敏感词**：证据里只写「命中类型 + 位置」，不贴具体词/真实 id。
4. **不知道就算 unknown**：无法扫描（缺工具/权限/信息）必须记 `unknown`，**不能**写成 pass。
5. **0 命中 ≠ 干净**：门禁只证明「已知词表没命中」；每个角色仍要按自己的清单做结构扫描（如长数字 id、三段式展示名、内部 slug 形态）。

## 2. 输出契约（所有角色一致）

```json
{
  "role": "qa|legal|product|design|security",
  "verdict": "pass|blocked|unknown",
  "scope": "commit:<sha>",
  "findings": [
    { "id": "short-id", "severity": "P0|P1|P2|P3", "area": "...", "evidence": "file:line / command", "fix": "one line" }
  ],
  "checked": ["清单项…"],
  "notes": "可选：一句话结论"
}
```

- 任一 `P0`/`P1` → `verdict=blocked`
- 无法完成清单项 → `verdict=unknown`（不得 pass）
- 全部清单项通过且无 P0/P1/P2 → `verdict=pass`

## 3. 门禁合成

5 份 verdict 全部 `pass` 才允许：

1. 推送 GitHub
2. 转 public
3. `npm publish`
4. 打 tag / 建 release

任一 `blocked` → 打回实现方整改；任一 `unknown` → 补能力后重跑该角色。

## 4. 角色定义文件

- `docs/security/roles/qa.md`
- `docs/security/roles/legal.md`
- `docs/security/roles/product.md`
- `docs/security/roles/design.md`
- `docs/security/roles/security.md`

每个文件 = 该角色的检查清单 + 判定标准。**改清单必须走 MR**（清单本身也受 review）。
