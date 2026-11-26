#!/usr/bin/env bun
/**
 * dws 适配层 —— 表情回应（**处理状态信号**）
 *
 * 设计：docs/design.md（表情状态协议）
 * 三条硬规矩（都是实测踩出来的）：
 *   ① **一语义一名**（表情是对外信号，出现即有语义，不能复用别处的语义）
 *   ② **API 接受 ≠ 能渲染**（无效名会静默落库成空白；判据只能**肉眼看客户端**）
 *   ③ **表态必须伴随真办事**（发了「收到」就必须真有后续动作，否则是空头支票）
 *
 * ══ 本模块的语义登记（新增语义前先查下表，一语义一名）══
 * | 语义 | 表情名 | 说明 |
 * | 已收到（收到某条回复） | `收到` | 与既有语义「已收到（我看到了）」**同义**，故复用安全 |
 * | 处理中（开始干活） | `思考` | 新语义（`时间` 已被「评审中」占用，不复用） |
 * | 处理完成 | `撒花` | 新语义（`Done` 已被「评审通过」占用，不复用） |
 * ⚠️ 名字可经环境变量覆盖，**改动后必须肉眼复核渲染**。
 */
import { dwsJson, isReal } from './dws.mjs';

export const EMOJI = {
  ack: process.env.DWS_HUB_EMOJI_ACK || '收到',
  ing: process.env.DWS_HUB_EMOJI_ING || '思考',
  done: process.env.DWS_HUB_EMOJI_DONE || '撒花',
};

/** 表情 argv 构造（`dryRun` 回显与真发共用，防回显≠实发）。 */
export function buildEmojiArgs(action, { conversationId, msgId, emoji } = {}) {
  const verb = action === 'remove' ? '+messages-remove-emoji' : '+messages-add-emoji';
  return ['chat', verb, '--conversation-id', conversationId,
    '--msg-id', msgId, '--emoji', emoji, '--yes', '--format', 'json'];
}

/** 缺参回执：**形状与 send.\* 对齐**（ok:false + code + data:null），调用方可用同一套判定。 */
function missingArgs() {
  return { ok: false, code: 'E_MISSING_ARG', error: 'missing_args', data: null, raw: null };
}

/**
 * 给某条消息贴表情。
 * `--msg-id` = **消息 id**（形如 `msgXXX==`）；`--conversation-id` = 会话 id。
 * `dryRun`：只返回将执行的 argv，**不 spawn**（CLI `--dry-run` 零出网）。
 */
export async function addEmoji({ forceReal = false, conversationId, msgId, emoji, bin, dryRun = false } = {}) {
  if (!conversationId || !msgId || !emoji) return missingArgs();
  const args = buildEmojiArgs('add', { conversationId, msgId, emoji });
  if (dryRun || (!forceReal && !isReal())) {
    return { ok: true, dry_run: true, action: 'add', emoji, msg_id: msgId, argv: args, data: null, raw: { dry_run: true, argv: args } };
  }
  const r = await dwsJson(args, { bin });
  // ⚠️ 返回体恒为 `result: {}`（无法据以判成败）→ 只记意图，成败由**肉眼**确认（知识 ②）
  // ⚠️ **保留 dwsJson 完整信封**（ok/data/raw/code）：压平成 `raw: r.data` 会让上层
  //    classifyDwsFailure 读不到 `data.error.type` → 鉴权失败误判 3/E_DWS_FAILED（契约要 4/E_AUTH）、
  //    spawn_error/timeout 误判 3（契约要 5/E_INTERNAL），且 message 退化成 `[object Object]`。
  return { ...r, ok: r.ok, action: 'add', emoji, msg_id: msgId };
}

/** 移除某条消息上的某个表情（用于「ing → done」的状态切换）。 */
export async function removeEmoji({ forceReal = false, conversationId, msgId, emoji, bin, dryRun = false } = {}) {
  if (!conversationId || !msgId || !emoji) return missingArgs();
  const args = buildEmojiArgs('remove', { conversationId, msgId, emoji });
  if (dryRun || (!forceReal && !isReal())) {
    return { ok: true, dry_run: true, action: 'remove', emoji, msg_id: msgId, argv: args, data: null, raw: { dry_run: true, argv: args } };
  }
  const r = await dwsJson(args, { bin });
  // 同 addEmoji：保留完整信封（data/raw/code），让 CLI 能按契约分类失败。
  return { ...r, ok: r.ok, action: 'remove', emoji, msg_id: msgId };
}

export const TRUTHY = isReal;

// ── CLI（2026-11-06 补：供 skill/脚本直接调用）────────────────────────────
//
//   node emoji.mjs add    --conversation-id <cid> --msg-id <id> [--emoji 撒花]
//   node emoji.mjs remove --conversation-id <cid> --msg-id <id> [--emoji 撒花]
//
// 语义登记见文件头（ack/ing/done）；默认 done=撒花。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const [mode, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--conversation-id') opts.conversationId = rest[++i];
    else if (rest[i] === '--msg-id') opts.msgId = rest[++i];
    else if (rest[i] === '--emoji') opts.emoji = rest[++i];
  }
  opts.emoji = opts.emoji || EMOJI.done;
  if (!opts.conversationId || !opts.msgId) {
    console.error('用法：emoji.mjs add|remove --conversation-id <cid> --msg-id <id> [--emoji 撒花]');
    process.exit(2);
  }
  const fn = mode === 'remove' ? removeEmoji : addEmoji;
  fn(opts)
    .then(() => {
      console.log(`  ✓ 已${mode === 'remove' ? '移除' : '添加'}表情「${opts.emoji}」`);
    })
    .catch((e) => {
      console.error(`✗ ${e?.message || e}`);
      process.exit(1);
    });
}
