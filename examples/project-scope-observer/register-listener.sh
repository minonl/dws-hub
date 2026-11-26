#!/bin/bash
# 项目级事项监听 · 注册器骨架（复制到项目仓后按注释替换占位符）
#
# ## 设计要点（详见同目录 README 的「硬约束」一节）
# - 路径必须持久：用 `git rev-parse --git-common-dir` 反推主 checkout，
#   **绝不用 worktree 路径**（收尾即静默失效，且无告警）。
# - 注册时机 = 脚本已进入主 checkout（随 MR 交付）；未合并时**显式拒绝**。
# - 只写本机 dws-hub，不修改项目代码、不随代码分发。
#
# ## 用法
#   bash register-listener.sh                    # 注册/更新
#   bash register-listener.sh --dry-run          # 只看会注册什么
#   bash register-listener.sh --unregister       # 注销
#
# ## 复制到项目仓后需替换
#   PLACEHOLDER_CONSUMER  → 你的 consumer 名（如 my-project-inbox）
#   PLACEHOLDER_ITEMS_DIR → 事项文件目录（相对仓库根，如 docs/requirements）
#   PLACEHOLDER_GROUP_SRC → 从哪个文件读群 ID（如 <items>/*.md 的 frontmatter）
set -uo pipefail

# ── 可调参数 ────────────────────────────────────────────────────────────────
CONSUMER="PLACEHOLDER_CONSUMER"
ITEMS_DIR="PLACEHOLDER_ITEMS_DIR"          # 相对仓库根
HUB_CLI="${DWS_HUB_CLI:-}"   # 必填：dws-hub CLI 入口（如 $(command -v dws-hub)）；不设默认私有路径

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$HUB_CLI" ]; then
  echo "[register] 需要 DWS_HUB_CLI 指向 dws-hub 入口（例：export DWS_HUB_CLI=\"$(command -v dws-hub)\"" >&2
  exit 2
fi

# ── 参数 ────────────────────────────────────────────────────────────────────
UNREGISTER=0; DRY=0
for a in "$@"; do
  case "$a" in
    --unregister) UNREGISTER=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "[register] 未知参数：$a" >&2; exit 2 ;;
  esac
done

# ── 反推主 checkout（worktree 与主仓共用 .git）──────────────────────────
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$COMMON_DIR" ]; then
  COMMON_DIR="$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd || true)"
fi
[ -n "$COMMON_DIR" ] || { echo "[register] ❌ 不在 git 仓库内" >&2; exit 1; }
REPO_ROOT="$(dirname "$COMMON_DIR")"

TARGET="$REPO_ROOT/$ITEMS_DIR/ops/adapter.mjs"
echo "[register] 主 checkout : $REPO_ROOT"
echo "[register] 采集脚本    : $TARGET"

# ── 群 ID：从**当前目录**读（不是主 checkout）────────────────────────────────
# 因为脚本可能在 worktree 里跑，而主 checkout 尚未合并、还没有这些文件。
# 群 ID 是「注册参数」，与被注册脚本的路径是两件事，不能混用同一个根。
ITEMS_ABS="$(dirname "$HERE")"
GROUP_ID="$(grep -h '^group:' "$ITEMS_ABS"/*.md 2>/dev/null \
  | sed -E "s/^group:[[:space:]]*//; s/^['\"]//; s/['\"]\$//" \
  | sed -E 's#.*/[[:space:]]*##' | head -1)"
[ -n "$GROUP_ID" ] || { echo "[register] ❌ 未能从事项文件解析群 ID" >&2; exit 1; }
echo "[register] 监听群      : $GROUP_ID"

# ── 未合并保护 ──────────────────────────────────────────────────────────
if [ "$UNREGISTER" = 0 ] && [ ! -f "$TARGET" ]; then
  cat >&2 <<EOF
[register] ❌ 主 checkout 里没有采集脚本：
           $TARGET

说明：本脚本随项目 MR 交付。**MR 合并后**主 checkout 才会有它。
在此之前注册 worktree 路径 = 埋一颗「收尾即失效」的雷（无告警）。
未合并期间请用一次性手动拉取（dws chat +chat-messages），不要固化成监听。
EOF
  exit 3
fi

# ── 注册 / 注销 ─────────────────────────────────────────────────────────────
if [ "$UNREGISTER" = 1 ]; then
  CMD=(bun "$HUB_CLI" consumers rm --name "$CONSUMER")
else
  # --cmd 指向主 checkout（已在上面解析），不含任何 worktree 字样
  CONSUMER_CMD="bash \"$TARGET\""
  CMD=(bun "$HUB_CLI" consumers add --name "$CONSUMER" \
       --targets "group:$GROUP_ID" --batch 60 --cmd "$CONSUMER_CMD")
fi

if [ "$DRY" = 1 ]; then
  echo "[register] dry-run：将执行"
  printf '           %q ' "${CMD[@]}"; echo
  exit 0
fi

"${CMD[@]}" || { echo "[register] ❌ dws-hub 调用失败" >&2; exit 1; }

echo
echo "[register] ✅ 完成。当前监听配置："
bun "$HUB_CLI" consumers list 2>/dev/null | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    mark = ' ←' if c['name'] == '$CONSUMER' else ''
    print(f\"  {c['name']:<16} {c['targets']}{mark}\")
" 2>/dev/null || true
