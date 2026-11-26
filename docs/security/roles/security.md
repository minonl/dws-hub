# 角色：security（安全 / 脱敏验收）

**目标**：证明公开后不会暴露任何内部标识、凭据或个人数据。**这一票必须独立于实现者。**

## 清单（四层）

### 1) 当前树

```bash
bun scripts/check-generic.mjs          # 使用本地 denylist（git-ignored）或 DWS_HUB_DENYLIST
git ls-files | grep -E '\.(env|pem|key|p12)$'
grep -rniE 'api[_-]?key|secret|password|bearer |token=' $(git ls-files) | head
```

- 无凭据/私钥/`.env`
- 无内部域名、内网 IP、私有 registry
- 无真实 cid / openDingTalkId / 人名 / 邮箱 / 客户名
- 无「某个 agent 框架」的数据根或入口（本包必须可脱离任何框架运行）

### 2) git 历史

```bash
git log --all --oneline
git log --all -p | <scanner>          # 用同一份 denylist
git rev-list --all --objects | wc -l
git tag -l; git branch -a
```

- 所有可达 commit 干净；分支名/tag 无内部项目名

### 3) GitHub 元数据

```bash
gh repo view --json name,description,visibility,repositoryTopics,homepageUrl
gh release list; gh issue list --limit 20; gh pr list --limit 20
```

- description/topics/homepage 无内部信息
- 当前必须是 **private**（门禁通过前不得 public）

### 4) 包内

```bash
npm pack
mkdir -p /tmp/audit && tar -xzf dws-hub-*.tgz -C /tmp/audit
grep -rniE '<同一份 denylist>' /tmp/audit
find /tmp/audit -name '*.map' -o -name '.env*' -o -name '*.test.mjs'
```

- 无 source map、无测试夹具、无本地绝对路径、无 denylist 文件本身

## 判定

- P0：凭据 / 真实个人信息 / 内部域名 / 业务数据
- P1：可推断内部信息的组合（如内部项目名 + 组织名）
- P2：私有路径示例、无害但误导的内部术语
- P3：注释里的过时引用

## 输出

JSON 契约，`role: "security"`，必须包含 `history_clean`（true/false）与 `verdict`。
**证据里不得出现命中词的原文**，只写「类型 + 文件:行”。
