#!/usr/bin/env bun
/**
 * dws-hub CLI —— 发送 / 读取 / 监听 / 分派 / 服务
 *
 * 设计：docs/design.md（能力接口）
 *
 * 子命令：
 *   notify   发通知（阶梯：DING→待办→日历→自聊；`--needs-decision` 建锚点）
 *   anchors  看/回锚点（`list` / `reply`）
 *   consumers 订阅管理（`list` / `add` / `rm`）
 *   follow   会话跟进订阅（`list` / `add` / `rm` / `sync` / `status`）
 *   pull     只拉增量（权威轮询，幂等落库）
 *   tick     跑一轮完整 tick（拉取 + 锚点 + 分派 + 超时 + 阶梯）
 *   listen   常驻循环（**有界长连接**闹钟 + 轮询；由 launchd 托管，禁 `--duration 0`）
 *   probe    通道能力自检（收到几条 vs 同窗口权威几条）
 *   health   健康快照（档位/水位/游标/限频/锚点）
 *   ding-log 强提醒台账（每次通知一行：成功/降级/全失败）
 *   ding     DING 强提醒单次发送（`ding send`；人工命令，不接自动流程）
 *
 * ⚠️ 安全默认分命令：`notify` 未设 `DWS_HUB_ENABLE=1` 时只走逻辑与落库（dry-run）；
 *    `send` / `emoji` / `ding` / `edit` 默认真发，只认显式 `--dry-run`。
 */
import { ackReplies, applyInboundToAnchors, createHub, health, probeScope, pullAll, scopesOf, scanOnce, tick, runLoop } from './index.mjs';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as scanCh from './hub/scan.mjs';
import { addFollow, allScopes, defaultFollowsPath, hasAtmeOnly, listFollows, loadFollows, removeFollow, saveFollows, validateSession } from './hub/follows.mjs';
import { parseTargets } from './hub/targets.mjs';
import { fileURLToPath } from 'node:url';
import { notify, replyInChain } from './dws/notify.mjs';
import { isReal } from './dws/dws.mjs';
import {
  defaultUuid, extractMessageId, normalizeIdempotent,
  sendChat, sendDirect, sendGroup, sendReply,
} from './dws/send.mjs';
import { EMOJI, addEmoji, removeEmoji } from './dws/emoji.mjs';
import { atMe, authStatus, chatMessages, searchAtMe, searchMessages } from './dws/query.mjs';
import { buildEditArgs, editMessage, readMessage } from './dws/edit.mjs';
import { sendPersonalDing } from './dws/ding.mjs';
import { findDuplicate, isDone, toIso } from './dws/todo-util.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function print(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + '\n');
}

/** `--since`：支持 `2026-11-09`（按本地零点）与 ISO 时间。 */
function parseSince(v) {
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`--since 解析失败：${s}（支持 ISO 日期/时间，如 2026-11-09）`);
  return d.toISOString();
}

const db = process.env.DWS_HUB_DB || undefined;

/* ══ send / emoji：单次发送原语（同步调用方友好） ══════════════════════════
 * 设计：docs/design.md
 * 约定：stdout **只有 JSON 信封**（`--json` 单行压缩 / 缺省缩进）；人类文案一律 stderr。
 * 退出码：0 成功或幂等命中或 dry-run / 2 参数 / 3 dws 失败 / 4 鉴权缺配 / 5 未预期。
 * ⚠️ 与老子命令的差异：send/emoji 的**未知子命令/未知参数一律退出 2**（不继承「未知→0」的宽容）。
 */
const SEND_SUBS = ['dm', 'group', 'reply', 'chat'];
const EMOJI_SUBS = ['add', 'remove'];
const SUB_BOOL_FLAGS = new Set(['direct', 'json', 'dry-run', 'allow-cost']);
const SEND_ALLOWED = new Set([
  'to', 'to-kind', 'group', 'chat-id', 'conversation-id', 'ref-msg-id', 'direct',
  'text', 'at', 'title', 'uuid', 'as', 'json', 'dry-run', 'bin',
]);
const EMOJI_ALLOWED = new Set(['conversation-id', 'msg-id', 'emoji', 'json', 'dry-run', 'bin']);
/** 必须带值的 flag（其余 flag 未给值时按布尔处理）。缺值 → E_MISSING_VALUE（**绝不**降级成 `true`）。 */
const VALUE_FLAGS = new Set([
  'to', 'to-kind', 'group', 'chat-id', 'conversation-id', 'ref-msg-id',
  'text', 'at', 'title', 'uuid', 'as', 'bin', 'emoji', 'msg-id',
  'content', 'type',
]);

/** 参数/鉴权错误载体：`exit` 决定进程退出码（缺省 2）。 */
class CliError extends Error {
  constructor(code, message, { hint = null, exit = 2 } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exit = exit;
  }
}

/** send/emoji 专用解析：`--at` 可重复 / 逗号分隔 / 空格分隔（多值），布尔 flag 不吃值。 */
function parseSubArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) { out._.push(raw); continue; }
    const k = raw.slice(2);
    if (SUB_BOOL_FLAGS.has(k)) { out[k] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      // ⚠️ 缺值绝不能塞成布尔 `true`：`--uuid` 会被当字面量键 `"true"`（全调用共用同一幂等键 →
      // 第二次起 dws 判 repeated → CLI 误报「已送达」而消息根本没发）。已知取值 flag 一律报参数错误。
      if (VALUE_FLAGS.has(k)) {
        throw new CliError('E_MISSING_VALUE', `--${k} 需要一个值（当前位于行尾或后面紧跟另一个 --flag）`, {
          hint: `请写成 --${k} <值>；布尔 flag 只有 ${[...SUB_BOOL_FLAGS].map((f) => `--${f}`).join(' / ')}`,
        });
      }
      out[k] = true;
      continue;
    }
    // `--at` 是**多值** flag：沿用旧 `send.mjs` 的 `[--at <id>...]` 姿势，
    // 连续吃掉后面所有非 flag token（`--at o1 o2` == `--at o1,o2`）——
    // 否则第 2 个起的 id 会掉进 `_`（位置参数）被 plan 静默丢弃，正文 `<@o2>` 原样发出。
    if (k === 'at') {
      const vals = [next];
      i += 1;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
      out.at = [...(out.at || []), ...vals];
      continue;
    }
    i += 1;
    out[k] = next;
  }
  return out;
}

function checkAllowed(a, allowed, ctx) {
  for (const k of Object.keys(a)) {
    if (k === '_') continue;
    if (!allowed.has(k)) {
      throw new CliError('E_UNKNOWN_ARG', `${ctx} 不支持参数 --${k}`, { hint: '拼错的参数不会被静默忽略；请核对参数名' });
    }
  }
}

function needStr(a, key, label) {
  const v = a[key];
  if (v === undefined || v === true || String(v).trim() === '') {
    throw new CliError('E_MISSING_ARG', `缺少必填参数 ${label}`);
  }
  return String(v);
}

function optStr(a, key) {
  if (!(key in a)) return null;
  const v = a[key];
  if (v === true || String(v) === '') throw new CliError('E_BAD_VALUE', `--${key} 需要一个非空值`);
  return String(v);
}

/**
 * `--uuid` 解析：未给 → 模块默认键（含时间戳）；给了但缺值/空串 → E_BAD_VALUE。
 * ⚠️ 不能写成 `a.uuid ? String(a.uuid) : …`——缺值时是布尔 `true` → 字面量键 `"true"`（静默假绿）。
 */
function uuidArg(a, kind) {
  return optStr(a, 'uuid') ?? defaultUuid(kind);
}

function enumArg(a, key, allowed, dflt) {
  if (!(key in a)) return dflt;
  const v = a[key];
  if (v === true || !allowed.includes(String(v))) {
    throw new CliError('E_BAD_VALUE', `--${key} 取值非法：${v === true ? '(缺值)' : v}`, { hint: `可选值：${allowed.join(' | ')}` });
  }
  return String(v);
}

/** 互斥校验：这些参数**不允许**出现在该子命令里。 */
function assertAbsent(a, keys, ctx) {
  const hit = keys.filter((k) => k in a);
  if (hit.length) {
    throw new CliError('E_CONFLICT', `${ctx} 不支持 ${hit.map((k) => `--${k}`).join('、')}`, { hint: '互斥/无意义参数不做静默降级，请按子命令语法传参' });
  }
}

/** `--at` 展开：可重复 + 逗号分隔；空值 → E_BAD_VALUE（不静默跳过）。 */
function expandAt(v) {
  if (v === undefined) return [];
  if (v === true) throw new CliError('E_BAD_VALUE', '--at 需要一个 openDingTalkId', { hint: '--at 只收 openDingTalkId（不接受 userId），可逗号/空格分隔或重复给' });
  const ids = [];
  for (const raw of [].concat(v)) {
    for (const part of String(raw).split(',')) {
      const id = part.trim();
      if (!id) throw new CliError('E_BAD_VALUE', `--at 含空值：${JSON.stringify(String(raw))}`, { hint: '去掉多余逗号/空串' });
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

const HAS_MENTION = /<@[^>]*>/;

/**
 * `--at` 必须与正文占位符**双向**成对（继承 send.mjs 硬校验，CLI 不放松）：
 *   · `--at` 有 id ⇒ 正文必须有 `<@id>`（否则 dws 拒发）；
 *   · 正文有 `<@id>` ⇒ `--at` 必须声明该 id（否则 dws 只 @ 已声明的，
 *     未声明的占位符**原样显示**——静默失败，本模块的核心防护目标）。
 */
function assertPaired(text, ats) {
  const body = String(text);
  const declared = new Set(ats);
  for (const id of ats) {
    if (!body.includes(`<@${id}>`)) {
      throw new CliError('E_MENTION_UNPAIRED', `--at ${id} 但正文缺少占位符 <@${id}>（必须成对出现，否则 dws 拒发）`, {
        hint: `请在正文中补 <@${id}>（--at 只收 openDingTalkId）`,
      });
    }
  }
  for (const m of body.matchAll(/<@([^>]*)>/g)) {
    const id = m[1].trim();
    if (!declared.has(id)) {
      throw new CliError('E_MENTION_UNPAIRED', `正文含占位符 <@${id}>，但 --at 未声明该 id（dws 会原样显示该占位符）`, {
        hint: `补 --at ${id}（多个 id 用空格或逗号分隔），或从正文移除 <@${id}>`,
      });
    }
  }
}

/** openDingTalkId 形态的**保守**启发式：只认强特征，避免误伤普通 userId。 */
function looksLikeOpenId(v) {
  const s = String(v || '');
  return s.startsWith('$:') || s.includes('$:LWCP') || (s.length >= 20 && /[+/=]/.test(s));
}

/**
 * **DING 通道**的 openDingTalkId 形态启发式（`ding send` 的 `--to` 专用）。
 *
 * 与 {@link looksLikeOpenId} 的分工（两者判据**故意不同**，勿合并）：
 *   · `looksLikeOpenId` 服务 `send dm --to-kind`：它把 `$:…` / 含 `+/=` 的串视为 openId 强特征；
 *   · 真实 openDingTalkId 是**纯字母数字**（实测形态 33 位、大小写+数字混排，**不含** `+` `/` `=` `$:`）——
 *     拿上一条判据套 `--to` 会把**每一条合法 DING** 判成「形态可疑」（`+/=` 命中即 true，
 *     语义恰好相反）且把 `$:LWCP_v1:…`（userId 形态）放行 ⇒ 两个方向都错。
 *
 * 因此这里只认「长 + 纯字母数字 + 至少含一个字母」：
 *   · 纯数字长串（17 位以上）= userId → 判否（DING 用它会静默无效）；
 *   · 太短（< 16）→ 判否（`u1234` 之类）；
 *   · 含 `+/=:$`/空白/`<>` → 判否（`<>` 由 `E_BAD_TARGET` 先拦）。
 * ⚠️ 诚实边界：仍是启发式，假阳/假阴不可避免（阈值口径见docs/design.md）。
 */
function looksLikeOpenDingTalkId(v) {
  const s = String(v ?? '').trim();
  if (s.length < 16) return false;
  if (!/^[A-Za-z0-9]+$/.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  return true;
}

function planDm(a, bin) {
  assertAbsent(a, ['group', 'chat-id', 'conversation-id', 'ref-msg-id', 'title'], 'send dm');
  assertAbsent(a, ['at'], 'send dm（单聊无「群成员 @」）');
  assertAbsent(a, ['direct'], 'send dm（--direct 只用于 send reply）');
  const as = enumArg(a, 'as', ['user', 'bot'], 'user');
  if (as === 'bot') throw new CliError('E_CONFLICT', '--as bot 只允许用于 send reply', { hint: '群/单聊/会话发送固定 user 身份' });
  const to = needStr(a, 'to', '--to');
  const text = needStr(a, 'text', '--text');
  const toKind = enumArg(a, 'to-kind', ['user', 'open'], 'user');
  if (HAS_MENTION.test(text)) {
    throw new CliError('E_MENTION_FORBIDDEN', '单聊正文禁止 <@…> 占位符（单聊无「群成员 @」，会原样显示）', { hint: '去掉 <@id>；要 @ 请用 send group / send chat' });
  }
  if (toKind === 'user' && looksLikeOpenId(to)) {
    throw new CliError('E_AUTH', `--to ${to} 形如 openDingTalkId，但当前按 userId 传递（dws --user）`, {
      exit: 4,
      hint: '若这是 openDingTalkId，请加 --to-kind open；若是 userId，请核对取值来源（dws 会把错型 id 静默当无接收人）',
    });
  }
  const uuid = uuidArg(a, 'dm');
  return {
    command: 'send.dm', conversationId: null, uuid,
    messageIdOf: (r) => extractMessageId(r),
    invoke: ({ dryRun }) => sendDirect(to, text, { bin, uuid, kind: toKind, dryRun }),
  };
}

function planGroup(a, bin) {
  assertAbsent(a, ['to', 'chat-id', 'conversation-id', 'ref-msg-id', 'direct', 'to-kind'], 'send group');
  const as = enumArg(a, 'as', ['user', 'bot'], 'user');
  if (as === 'bot') throw new CliError('E_CONFLICT', '--as bot 只允许用于 send reply', { hint: '群发送固定 user 身份' });
  const group = needStr(a, 'group', '--group');
  const text = needStr(a, 'text', '--text');
  const ats = expandAt(a.at);
  assertPaired(text, ats);
  const title = optStr(a, 'title');
  const uuid = uuidArg(a, 'send');
  return {
    command: 'send.group', conversationId: group, uuid,
    messageIdOf: (r) => extractMessageId(r),
    invoke: ({ dryRun }) => sendGroup(group, text, ats, { bin, uuid, title, dryRun }),
  };
}

function planChat(a, bin) {
  assertAbsent(a, ['to', 'group', 'conversation-id', 'ref-msg-id', 'title', 'direct', 'to-kind'], 'send chat');
  const as = enumArg(a, 'as', ['user', 'bot'], 'user');
  if (as === 'bot') throw new CliError('E_CONFLICT', '--as bot 只允许用于 send reply', { hint: '会话发送固定 user 身份' });
  const chatId = needStr(a, 'chat-id', '--chat-id');
  const text = needStr(a, 'text', '--text');
  const ats = expandAt(a.at);
  assertPaired(text, ats);
  const uuid = uuidArg(a, 'chat');
  return {
    command: 'send.chat', conversationId: chatId, uuid,
    messageIdOf: (r) => extractMessageId(r),
    invoke: ({ dryRun }) => sendChat(chatId, text, { ats, bin, uuid, dryRun }),
  };
}

function planReply(a, bin) {
  assertAbsent(a, ['group', 'chat-id', 'title'], 'send reply');
  assertAbsent(a, ['at'], 'send reply（接口自动 @ 被回复人）');
  // `--direct` 的 `--to` 固定按 openDingTalkId 透传（sendReply → --open-dingtalk-id）⇒ `--to-kind` 无意义
  assertAbsent(a, ['to-kind'], 'send reply（--direct 的 --to 固定按 openDingTalkId）');
  const refId = needStr(a, 'ref-msg-id', '--ref-msg-id');
  const text = needStr(a, 'text', '--text');
  const direct = a.direct === true;
  const as = enumArg(a, 'as', ['user', 'bot'], 'user');
  if (HAS_MENTION.test(text)) {
    throw new CliError('E_MENTION_FORBIDDEN', '引用回复正文禁止 <@…> 占位符（接口会自动 @ 被回复人，写了会显示字面量）', { hint: '去掉 <@id>，回复接口自己会 @' });
  }
  let conv = null;
  let openId = null;
  if (direct) {
    openId = 'to' in a ? needStr(a, 'to', '--to') : null;
  } else {
    if ('to' in a) throw new CliError('E_CONFLICT', 'send reply 非 --direct 时不要传 --to（会话由 --conversation-id 指定）');
    conv = needStr(a, 'conversation-id', '--conversation-id');
  }
  const uuid = uuidArg(a, 'reply');
  return {
    command: 'send.reply', conversationId: conv, uuid,
    messageIdOf: (r) => extractMessageId(r),
    invoke: ({ dryRun }) => sendReply(conv, refId, text, { bin, direct, openDingTalkId: openId, uuid, as, dryRun }),
  };
}

function planEmoji(a, bin) {
  const sub = a._[0];
  if (!EMOJI_SUBS.includes(sub)) {
    throw new CliError('E_UNKNOWN_SUBCOMMAND', `未知 emoji 子命令：${sub ?? '(缺失)'}`, { hint: `可用：${EMOJI_SUBS.join(' | ')}` });
  }
  const extra = a._.slice(1);
  if (extra.length) {
    throw new CliError('E_UNKNOWN_ARG', `emoji ${sub} 有多余的位置参数：${extra.join(' ')}`, {
      hint: '所有参数都要带 -- 前缀',
    });
  }
  assertAbsent(a, ['text', 'at', 'uuid', 'title', 'as'], `emoji ${sub}`);
  checkAllowed(a, EMOJI_ALLOWED, `emoji ${sub}`);
  const conversationId = needStr(a, 'conversation-id', '--conversation-id');
  const msgId = needStr(a, 'msg-id', '--msg-id');
  const emoji = optStr(a, 'emoji') || EMOJI.done;
  if (/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/.test(emoji)) {
    throw new CliError('E_BAD_VALUE', '--emoji 含不可见字符（API 会接受但客户端渲染为空白）', { hint: '用可渲染的表情名（如 收到 / 思考 / 撒花）' });
  }
  return {
    command: `emoji.${sub}`, conversationId, uuid: null,
    messageIdOf: () => null,
    invoke: ({ dryRun }) => (sub === 'remove' ? removeEmoji : addEmoji)({ conversationId, msgId, emoji, bin, dryRun, forceReal: !dryRun }),
  };
}

/* ══ ding：DING 强提醒（单次 / 单接收人；人工命令，不接自动流程） ═════════════
 * 设计：docs/design.md
 * 与 send/emoji 同一套信封与退出码（0 成功或幂等命中或 dry-run / 2 参数 / 3 dws 失败 / 4 鉴权 / 5 未预期）。
 * ⚠️ `ding` 下**只有** `send`：非 send 子命令一律退出 2（不继承老「未知子命令 → 打印用法退出 0」）；
 *    台账查询仍叫 `ding-log`（既有子命令名不变）。
 */
const DING_SUBS = ['send'];
const DING_ALLOWED = new Set(['to', 'content', 'type', 'allow-cost', 'uuid', 'json', 'dry-run', 'bin']);
const DING_TYPES = ['app', 'sms', 'call'];
/** 有**通信费用**的通道：必须显式 `--allow-cost` 放行（该 flag 只做 CLI 侧放行，**不进 dws argv**）。 */
const DING_COST_TYPES = ['sms', 'call'];

/** DING 回执的 id 字段是 `openDingId`；取不到 → null。 */
function extractOpenDingId(r) {
  const raw = typeof r?.raw === 'string' ? r.raw : '';
  const m = raw.match(/"openDingId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function planDing(a, bin) {
  checkAllowed(a, DING_ALLOWED, 'ding send');
  // ① 必填（缺值 ∉ 这里：`--uuid` 行尾缺值由 parseSubArgs 抛 E_MISSING_VALUE）
  const to = needStr(a, 'to', '--to');
  const content = needStr(a, 'content', '--content');
  // ② `--type` 取值 + `--allow-cost` 语义（单独出现 = 误解，必须报错而非静默降级）
  const type = enumArg(a, 'type', DING_TYPES, 'app');
  const allowCost = a['allow-cost'] === true;
  if (allowCost && !DING_COST_TYPES.includes(type)) {
    throw new CliError('E_BAD_VALUE', `--allow-cost 只对 --type ${DING_COST_TYPES.join('|')} 有意义（app 免费，无需放行）`, {
      hint: '去掉 --allow-cost，或补 --type sms|call（有通信费用，请先人工确认）',
    });
  }
  // ③ 结构非法（改参数类，2）：空白 / 换行 / `<@…>` 占位符
  if (/[<>\s]/.test(to)) {
    throw new CliError('E_BAD_TARGET', `--to 含结构性非法字符（空白 / < / >）：${JSON.stringify(to)}`, {
      hint: 'DING 的 --to 要一长串字母数字（openDingTalkId），不是 <@id> 占位符',
    });
  }
  // ④ 成本闸（2，**零出网零费用**）：sms/call 未带 --allow-cost 一律拒绝
  if (DING_COST_TYPES.includes(type) && !allowCost) {
    throw new CliError('E_COST_REQUIRED', `--type ${type} 是有通信费用的通道，必须显式 --allow-cost 放行`, {
      hint: '确认本次人工催办可以产生费用后加 --allow-cost（该 flag 不进 dws argv）',
    });
  }
  // ⑤ 形态可疑（配置/身份类，4）：DING 只收 openDingTalkId；userId 会被 dws 静默当「无接收人」
  if (!looksLikeOpenDingTalkId(to)) {
    throw new CliError('E_AUTH', `--to ${to} 不像 openDingTalkId（DING 只收 openDingTalkId，不是 userId）`, {
      exit: 4,
      hint: '用 dws contact user search 换 openDingTalkId 再发；数值型 userId 不能直接当 --to',
    });
  }
  // 未给 `--uuid` → **不传** dws `--uuid`（不自造默认键），信封回显 uuid:null
  const uuid = optStr(a, 'uuid') ?? null;
  return {
    command: 'ding.send', to, type, uuid,
    messageIdOf: (r) => extractOpenDingId(r),
    invoke: ({ dryRun }) => sendPersonalDing({ openDingTalkId: to, text: content, uuid, type, bin, dryRun }),
  };
}

function emitEnvelope(o, json) {
  process.stdout.write((json ? JSON.stringify(o) : JSON.stringify(o, null, 2)) + '\n');
}

function emitCliFailure(e, json) {
  emitEnvelope({ ok: false, code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }, json);
  process.stderr.write(`[dws-hub] ✗ ${e.code}: ${e.message}${e.hint ? `\n  提示：${e.hint}` : ''}\n`);
  return e.exit ?? 2;
}

/** dws 失败分类：3 普通失败 / 4 鉴权缺配 / 5 未预期（spawn/超时/非 JSON）。 */
function classifyDwsFailure(r) {
  const d = r && typeof r.data === 'object' && r.data ? r.data : {};
  const type = d?.error?.type || null;
  const raw = String(r?.raw || '');
  let errJson = '';
  try { errJson = JSON.stringify(d?.error ?? d ?? ''); } catch { errJson = ''; }
  const hay = `${raw} ${errJson}`;
  const low = hay.toLowerCase();
  if (type === 'spawn_error') {
    return { code: 'E_INTERNAL', exit: 5, message: `无法启动 dws：${d?.error?.message || 'spawn 失败'}`, hint: '检查 --bin / DWS_BIN / PATH 是否指向可执行的 dws' };
  }
  if (type === 'timeout') {
    return { code: 'E_INTERNAL', exit: 5, message: 'dws 调用超时', hint: '重试（同 --uuid 安全）；持续超时检查 dws 可用性' };
  }
  if (d._raw !== undefined) {
    return { code: 'E_INTERNAL', exit: 5, message: `dws 输出不是合法 JSON：${String(d._raw).slice(0, 200)}`, hint: '用 --bin 确认 dws 版本/输出格式' };
  }
  if (/unauthorized|401|403|forbidden|invalid token|token expired|not logged in|请先登录|鉴权|无权限/.test(low)) {
    return {
      code: 'E_AUTH', exit: 4,
      message: `dws 判定鉴权/身份不可用：${hay.trim().slice(0, 200)}`,
      hint: '检查 dws 登录态（dws auth status）；--as bot 还需确认 bot 身份已配置',
    };
  }
  return { code: 'E_DWS_FAILED', exit: 3, message: `dws 返回失败：${hay.trim().slice(0, 300)}`, hint: null };
}

/**
 * 消息纠正（`dws-hub edit`）：**编辑原消息** + 默认读回校验。
 *
 * 原则：消息发错只编辑，不撤回重发、不发新消息。
 * 退出码：0 = 编辑成功且读回无字面量占位符；1 = 读回发现 `<@` 字面量；2 = 用法；3 = dws 失败。
 */
const EDIT_ALLOWED = new Set(['conversation-id', 'message-id', 'text', 'title', 'bin', 'dry-run', 'no-verify']);

async function runEdit(rest) {
  try {
    const a = parseArgs(rest);
    for (const k of Object.keys(a)) {
      if (k === '_') continue;
      if (!EDIT_ALLOWED.has(k)) {
        throw new CliError('E_UNKNOWN_ARG', `edit 不支持参数：--${k}`, {
          hint: `可用：--conversation-id --message-id --text [--title] [--no-verify] [--dry-run]`,
        });
      }
    }
    const bin = typeof a.bin === 'string' ? a.bin : undefined;
    const conv = typeof a['conversation-id'] === 'string' ? a['conversation-id'] : '';
    const msgId = typeof a['message-id'] === 'string' ? a['message-id'] : '';
    const text = typeof a.text === 'string' ? a.text : '';
    const title = typeof a.title === 'string' ? a.title : undefined;
    const argv = buildEditArgs(conv, msgId, text, { title });

    if (a['dry-run'] === true) {
      process.stderr.write(`[dws-hub edit] dry-run（未调用 dws）：${argv.join(' ')}\n`);
      print({ ok: true, command: 'edit', dry_run: true, argv });
      return 0;
    }

    const r = await editMessage(conv, msgId, text, { bin, title });
    if (!r?.ok) {
      print({ ok: false, command: 'edit', messageId: msgId, code: 3, data: r?.data ?? null, raw: r?.raw ?? null });
      process.stderr.write('[dws-hub edit] ❌ 编辑失败（dws 返回失败信封）\n');
      return 3;
    }

    // 编辑回执不给正文 → 默认读回校验（--no-verify 可跳过，但不推荐）
    const verify = a['no-verify'] === true ? null : await readMessage(msgId, { bin });
    const ok = !verify || (verify.ok && !verify.hasLiteralMention);
    print({ ok, command: 'edit', messageId: msgId, edit: r?.data ?? null, verify });
    if (verify && verify.hasLiteralMention) {
      process.stderr.write('[dws-hub edit] ❌ 读回发现字面量 <@ 占位符（@ 未渲染）——改正正文后再编辑一次（不要撤回重发）\n');
    } else if (verify && !verify.ok) {
      process.stderr.write('[dws-hub edit] ⚠️ 编辑已提交但读回定位不到该消息（可能延迟）——稍后用 chat message list-by-ids 复核\n');
    }
    return ok ? 0 : 1;
  } catch (e) {
    if (e?.usage || e instanceof CliError) {
      process.stderr.write(`[dws-hub edit] ${e.message}\n`);
      print({ ok: false, command: 'edit', code: e.code || 'E_USAGE', message: e.message });
      return e.exit ?? 2;
    }
    process.stderr.write(`[dws-hub edit] ❌ ${e?.message || e}\n`);
    return 5;
  }
}

/**
 * 读取入口（`dws-hub read`）：读类操作的统一姿势——优先走这里，而不是裸调 CLI。
 *
 * 子命令：
 *   read atme   查 @我（跨会话；`--group` 收窄到某群）
 *   read chat   读指定会话最近消息
 *   read search 关键词搜消息（可选群/会话/@我）
 *
 * 只读、无副作用；输出统一 JSON（`{ok, command, count, messages, …}`）。
 * 退出码：0 = 成功；2 = 用法；3 = dws 失败；4 = 鉴权/身份不可用。
 */
async function runRead(rest) {
  const a = parseArgs(rest);
  const bin = typeof a.bin === 'string' ? a.bin : undefined;
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const num = (v) => (typeof v === 'string' ? Number(v) : undefined);
  const usage = (msg) => Object.assign(new Error(msg), { usage: true });
  const sub = a._[0];
  try {
    if (sub === 'atme') {
      const days = num(a.days) ?? 7;
      const group = str(a.group);
      const chatId = str(a['chat-id']);
      const sendersRaw = str(a.senders);
      const senders = sendersRaw
        ? sendersRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      if (group && (chatId || (senders && senders.length))) {
        throw usage('read atme：--group 与 --senders / --chat-id 互斥（只能给一个收窄条件）');
      }
      const r = group
        ? { messages: await searchAtMe({ group, days, pageAll: true, bin }), complete: null, stopReason: null }
        : await atMe({ days, pageAll: true, senders, chatId, bin });
      print({
        ok: true, command: 'read.atme', days, group: group ?? null,
        count: r.messages.length, complete: r.complete, stopReason: r.stopReason,
        messages: r.messages,
      });
      return 0;
    }

    if (sub === 'auth') {
      const st = await authStatus({ bin });
      print({ ok: true, command: 'read.auth', ...st });
      return 0;
    }

    if (sub === 'chat') {
      const conversationId = str(a['conversation-id']);
      if (!conversationId) throw usage('read chat：缺 --conversation-id（会话 openConversationId）');
      const messages = await chatMessages({
        conversationId,
        limit: num(a.limit),
        since: str(a.start),
        end: str(a.end),
        order: str(a.order),
        pageAll: !!a['page-all'],
        noReactions: !a.reactions,
        bin,
      });
      print({ ok: true, command: 'read.chat', conversationId, count: messages.length, messages });
      return 0;
    }

    if (sub === 'search') {
      const query = str(a.query);
      if (!query) throw usage('read search：缺 --query（搜索关键词）');
      const messages = await searchMessages({
        query,
        group: str(a.group),
        conversationId: str(a['conversation-id']),
        allTime: !!a['all-time'],
        days: num(a.days),
        since: str(a.start),
        end: str(a.end),
        order: str(a.order),
        limit: num(a.limit),
        pageAll: !!a['page-all'],
        atMe: !!a['at-me'],
        noReactions: !a.reactions,
        bin,
      });
      print({
        ok: true, command: 'read.search', query,
        group: str(a.group) ?? null, conversationId: str(a['conversation-id']) ?? null,
        count: messages.length, messages,
      });
      return 0;
    }

    process.stderr.write('用法：dws-hub read atme|chat|search …（详见 dws-hub 帮助）\n');
    return 2;
  } catch (e) {
    if (e?.usage) {
      process.stderr.write(`[dws-hub read] ${e.message}\n`);
      return 2;
    }
    const msg = String(e?.message || e);
    process.stderr.write(`[dws-hub read] ❌ ${msg}\n`);
    // 鉴权类失败给 4（与帮助一致），其它一律 3（不透传 dws 的 1）
    if (/auth|login|token|not\s*logged|未登录|授权|鉴权/i.test(msg)) return 4;
    return 3;
  }
}

async function runSendEmoji(ns, rest) {
  const json = rest.includes('--json');
  try {
    const a = parseSubArgs(rest);
    if (a.bin === true) throw new CliError('E_BAD_VALUE', '--bin 需要一个可执行文件路径');
    const bin = typeof a.bin === 'string' ? a.bin : (process.env.DWS_BIN || 'dws');
    let plan;
    if (ns === 'send') {
      const sub = a._[0];
      if (!SEND_SUBS.includes(sub)) {
        throw new CliError('E_UNKNOWN_SUBCOMMAND', `未知 send 子命令：${sub ?? '(缺失)'}`, { hint: `可用：${SEND_SUBS.join(' | ')}` });
      }
      // 多余的**位置参数**一律报错：不静默丢弃（典型误用 `--at o1 o2` 少写 flag 前缀）。
      const extra = a._.slice(1);
      if (extra.length) {
        throw new CliError('E_UNKNOWN_ARG', `send ${sub} 有多余的位置参数：${extra.join(' ')}`, {
          hint: '所有参数都要带 -- 前缀；--at 支持多个 id（空格或逗号分隔）',
        });
      }
      checkAllowed(a, SEND_ALLOWED, `send ${sub}`);
      plan = ({ dm: planDm, group: planGroup, reply: planReply, chat: planChat })[sub](a, bin);
    } else {
      plan = planEmoji(a, bin);
    }

    // dry-run：**只认显式 --dry-run**（2026-11-09 修）。
    // ⚠️ 不能复用 `isReal()`（= DWS_HUB_ENABLE==='1'）：那是 **notify 的安全默认**，
    //    而 send/emoji 是「调用方明确要求发送」的原语 —— 若也吃这个开关，
    //    未设该变量的宿主（后台服务 / cron）会把**所有发送变成 dry-run 假成功**。
    const dryRun = a['dry-run'] === true;
    const r = await plan.invoke({ dryRun });
    return settleSend({ plan, r, bin, json, dryRun, base: { conversationId: plan.conversationId } });
  } catch (e) {
    return settleSendError(e, json);
  }
}

/**
 * 发送结果收口（`send` / `emoji` / `ding` **同一套**信封与退出码）：
 *   dry-run → 0（`raw:{dry_run,bin,argv}`，未 spawn）
 *   幂等命中 → 0（`idempotentHit:true`、`messageId:null`）
 *   成功 → 0；失败 → 3 / 4 / 5（`classifyDwsFailure`），失败信封 `detail:{exit,dwsCode}`
 */
function settleSend({ plan, r, bin, json, dryRun, base = {} }) {
  if (dryRun) {
    const argv = Array.isArray(r?.argv) ? r.argv : [];
    process.stderr.write(`[dws-hub ${plan.command}] dry-run（未调用 dws）：${bin} ${argv.join(' ')}\n`);
    emitEnvelope({
      ok: true, command: plan.command, ...base, messageId: null,
      uuid: plan.uuid, idempotentHit: false, dryRun: true,
      raw: { dry_run: true, bin, argv },
    }, json);
    return 0;
  }

  const norm = normalizeIdempotent(r);
  // JSON 解析失败（dws 输出非 JSON）→ 5：不能当成功（raw 里只有 `_raw` 截断串）
  const rawBad = (norm?.data && typeof norm.data === 'object' && norm.data._raw !== undefined)
    ? norm.data._raw
    : (norm?.raw && typeof norm.raw === 'object' ? norm.raw._raw : undefined);
  if (rawBad !== undefined) {
    throw new CliError('E_INTERNAL', `dws 输出不是合法 JSON：${String(rawBad).slice(0, 200)}`, {
      exit: 5, hint: '用 --bin 确认 dws 版本/输出格式（本 CLI 需要 JSON 信封）',
    });
  }
  const idempotentHit = !!norm?.duplicated;
  if (norm?.ok) {
    const messageId = idempotentHit ? null : plan.messageIdOf(norm);
    emitEnvelope({
      ok: true, command: plan.command, ...base, messageId,
      uuid: plan.uuid, idempotentHit, dryRun: false,
      // `raw` = dws 原始串（诊断），`data` = 解析后的信封（emoji 的 `result:{}` 也在这里）
      raw: norm.raw ?? null, data: norm?.data ?? null,
    }, json);
    process.stderr.write(`[dws-hub ${plan.command}] ✓ 已送达${idempotentHit ? '（幂等命中：同键已发过，未重复发送）' : ''}\n`);
    return 0;
  }
  const f = classifyDwsFailure(norm);
  emitEnvelope({
    ok: false, command: plan.command, code: f.code, message: f.message,
    ...(f.hint ? { hint: f.hint } : {}),
    detail: { exit: f.exit, dwsCode: norm?.code ?? null },
  }, json);
  process.stderr.write(`[dws-hub ${plan.command}] ✗ ${f.message}${f.hint ? `\n  提示：${f.hint}` : ''}\n`);
  return f.exit;
}

/** 统一异常收口（send / emoji / ding）：CliError 原样；L1 的 `usage` → 2；其余 → 5（不静默降级）。 */
function settleSendError(e, json) {
  if (e instanceof CliError) return emitCliFailure(e, json);
  if (e?.usage) return emitCliFailure(new CliError('E_PARAM', e.message, { hint: e.hint || null }), json);
  return emitCliFailure(new CliError('E_INTERNAL', e?.message || String(e), { exit: 5 }), json);
}

/**
 * `ding` 命名空间（**只有 `send`**）：走与 send/emoji 同一套 dry-run / 信封 / 退出码。
 * `ding <其它>` → `E_UNKNOWN_SUBCOMMAND`（退出 2）；台账查询仍是顶层 `ding-log`。
 */
/**
 * todo：跨设备查看 / 去重创建我的待办（钉钉待办是账号级，多端天然同步）
 *   todo list [--limit N] [--json]
 *   todo add  --text "标题/内容" [--due ISO] [--json]
 * 去重：先 `dws todo +search` 模糊搜标题，命中**未完成**即跳过（已完成不挡，见 `dws/todo-util.mjs`）。
 */
async function runTodo(rest) {
  const json = rest.includes('--json');
  const a = parseSubArgs(rest);
  const sub = a._[0] || 'list';
  const bin = typeof a.bin === 'string' ? a.bin : (process.env.DWS_BIN || 'dws');
  const call = (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 90_000, env: process.env });
    if (r.error) return { ok: false, error: String(r.error.message || r.error).slice(0, 200) };
    let data = null;
    try { data = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
    return { ok: r.status === 0, status: r.status, data, raw: (r.stdout || '').slice(0, 500), error: (r.stderr || '').trim().slice(0, 300) };
  };

  if (sub === 'list') {
    const r = call(['todo', '+get-related-tasks', '--format', 'json']);
    if (!r.ok) {
      if (json) print({ ok: false, error: r.error });
      else process.stderr.write(`[dws-hub todo] 查询失败：${r.error}\n`);
      return r.status || 3;
    }
    // ⚠️ `+get-related-tasks` 返回 `data.tasks`（字段 title/planFinishDate）；
    //    `+search` 返回 `data.todos`（字段 subject/dueTime）—— 两种都兼容
    const raw = r.data?.data || {};
    const todos = raw.todos || raw.tasks || [];
    // `--limit abc` 曾是 NaN → slice 出空列表（静默骗人）；非法值退回 20
    const n = Number(a.limit);
    const limit = Number.isFinite(n) && n > 0 ? n : 20;
    const slim = todos.slice(0, limit).map((t) => ({
      taskId: String(t.taskId || ''), subject: t.subject || t.title || '',
      due: toIso(t.dueTime ?? t.planFinishDate),   // 数值/ISO/纯日期都吃，解析不了返回 null（不抛）
      done: isDone(t),
    }));
    if (json) print({ ok: true, count: slim.length, todos: slim });
    else {
      process.stdout.write(`我的待办（${slim.length}）\n`);
      for (const t of slim) process.stdout.write(`- ${t.done ? '[x]' : '[ ]'} ${t.subject.slice(0, 80)}${t.due ? `  due=${t.due}` : ''}\n`);
    }
    return 0;
  }

  if (sub === 'add') {
    const text = typeof a.text === 'string' ? a.text : '';
    if (!text) {
      process.stderr.write('用法：todo add --text "<标题/内容>" [--due ISO]\n');
      return 2;
    }
    const title = text.split('\n')[0].slice(0, 60);
    // 去重：按标题模糊搜，**只认未完成**（否则上周已完成的同名待办会让周期性待办永远建不出来）
    const found = call(['todo', '+search', '--query', title, '--format', 'json']);
    const todos = found.data?.data?.todos || found.data?.todos || [];
    const dup = findDuplicate(todos, title);
    if (dup) {
      if (json) print({ ok: true, skipped: 'duplicate', taskId: String(dup.taskId || '') });
      else process.stdout.write(`已存在同类待办，跳过：${String(dup.subject || dup.title || '').slice(0, 80)}\n`);
      return 0;
    }
    const due = typeof a.due === 'string' ? a.due : new Date(Date.now() + 3 * 86_400e3).toISOString();
    const r = call(['todo', '+remind', '--task', title, '--at', due, '-y', '--format', 'json']);
    if (!r.ok) {
      if (json) print({ ok: false, error: r.error });
      else process.stderr.write(`[dws-hub todo] 创建失败：${r.error}\n`);
      return 3;
    }
    const taskId = r.data?.data?.taskId || r.data?.data?.data?.taskId || '';
    if (json) print({ ok: true, taskId: String(taskId), due });
    else process.stdout.write(`已创建待办：${title}（due=${due}）\n`);
    return 0;
  }

  process.stderr.write('用法：dws-hub todo list|add …\n');
  return 2;
}

async function runDing(rest) {
  const json = rest.includes('--json');
  try {
    const a = parseSubArgs(rest);
    const sub = a._[0];
    if (!DING_SUBS.includes(sub)) {
      throw new CliError('E_UNKNOWN_SUBCOMMAND', `未知 ding 子命令：${sub ?? '(缺失)'}`, {
        hint: `可用：${DING_SUBS.join(' | ')}（强提醒台账查询用 ding-log）`,
      });
    }
    const extra = a._.slice(1);
    if (extra.length) {
      throw new CliError('E_UNKNOWN_ARG', `ding ${sub} 有多余的位置参数：${extra.join(' ')}`, { hint: '所有参数都要带 -- 前缀' });
    }
    if (a.bin === true) throw new CliError('E_BAD_VALUE', '--bin 需要一个可执行文件路径');
    const bin = typeof a.bin === 'string' ? a.bin : (process.env.DWS_BIN || 'dws');
    const plan = planDing(a, bin);
    // dry-run 与 send/emoji 同一条通路：只认显式 `--dry-run`（不吃 isReal()）
    const dryRun = a['dry-run'] === true;
    const r = await plan.invoke({ dryRun });
    return settleSend({ plan, r, bin, json, dryRun, base: { to: plan.to, type: plan.type } });
  } catch (e) {
    return settleSendError(e, json);
  }
}

/* ══ session-follow：会话 ↔ 钉钉群/私聊 订阅 ══════════════════════════════
 * - registry: `$DWS_HUB_HOME/consumers/session-follows.json`（hub/follows.mjs）
 * - consumer: `session-follow` → `$DWS_HUB_HOME/bin/dws-hub-follow`（稳定入口）
 * - 投递：由 `DWS_HUB_INBOX_CMD` 决定（未配置则落 logs/inbox-skipped-*.jsonl）
 */

function dataRoot() {
  return process.env.DWS_HUB_HOME || join(homedir(), '.dws-hub');
}

function writeFollowWrapper() {
  const binDir = join(dataRoot(), 'bin');
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'dws-hub-follow');
  const fallbackBin = process.argv[1] || 'dws-hub';
  const script = `#!/bin/bash
# 稳定入口（勿手改）：dws-hub consumer session-follow
set -u
BIN="$(command -v dws-hub 2>/dev/null || true)"
[ -n "$BIN" ] || BIN=${JSON.stringify(fallbackBin)}
exec "$BIN" consume session-follow
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

function syncFollowConsumer(store) {
  const doc = loadFollows();
  const scopes = allScopes(doc);
  if (!scopes.length) {
    store.consumers.remove('session-follow');
    return { consumer: 'session-follow', enabled: false, targets: [], note: '无订阅，已移除 consumer' };
  }
  const targets = [...scopes, ...(hasAtmeOnly(doc) ? ['atme:*'] : [])];
  const wrapper = writeFollowWrapper();
  const existed = store.consumers.byName('session-follow');
  const c = store.consumers.upsert({
    name: 'session-follow',
    targets,
    keywords: null,
    domains: null,
    kind: 'session',
    batch_window: 10,
    on_event: `bash ${JSON.stringify(wrapper)}`,
    enabled: true,
  });
  // 新订阅默认从「现在」开始，避免把历史消息一次性灌进会话 inbox。
  // 需要补历史请用 `dws chat +chat-messages` / `+search-msg` 手动拉。
  if (!existed) store.kv.set('cursor', 'session-follow', new Date().toISOString());
  return { consumer: c.name, enabled: c.enabled, targets: c.targets, cmd: c.on_event, registry: defaultFollowsPath() };
}

function usage() {
  return `dws-hub —— 可靠的 dws 能力层（发送 / 监听 / 分派 / 回复链）

用法：
  dws-hub notify --consumer <n> --title <标题> [--text 正文] [--strength info|strong|critical] [--needs-decision] [--at ISO] [--force] [--send]
                 [--ref-msg-id <openMsgId> --conversation-id <openConversationId>]   # 引用触发消息（优先 reply，失败降级阶梯）
  dws-hub anchors list [--status open] | anchors reply --id <anchorId> --text <内容> | anchors rescan [--minutes 120]
  dws-hub consumers list | consumers add --name <n> --targets 'self,group:<id>' --cmd '<shell>' [--keywords k] [--batch N] [--disabled] | consumers rm --name <n>
  dws-hub follow list | follow add --scope group:<cid>|direct:<uid> [--session ses_x] [--atme] [--label 名称] [--no-sync]
  dws-hub follow rm [--session ses_x] [--scope ...|--all] | follow sync | follow status | follow scopes
  dws-hub pull | tick | listen [--interval 60] [--stream-sec 1500] [--max-ticks N]
  dws-hub probe --scope <self|group:<id>|direct:<id>> [--window 60]
  dws-hub stream-status [--json]     长连接生效状态（消费方据此停/启兜底）
  dws-hub health [--reconnect]
  dws-hub ding-log [--since 2026-11-09] [--consumer <n>] [--limit 50] [--json]   强提醒台账（每次通知一行）
  dws-hub scan status|run|coverage [since]|prune   全量扫描（入库/覆盖审计/清理）
  dws-hub topic add|link|list|show|feed|reply|recall|status|auto|watch   主题聚合
  dws-hub service install|uninstall|status   常驻服务（launchd / systemd --user）
  dws-hub doctor                        环境自检（bun / dws / 登录态 / 数据根 / 服务）
  dws-hub consume session-follow        consumer 入口（hub 派发时调用）
  dws-hub read auth                     登录态（dws auth status）
  dws-hub read atme  [--days N] [--group <群名|openConversationId>] [--senders a,b] [--chat-id <cid>]
  dws-hub read chat  --conversation-id <cid> [--limit N] [--start <时间>] [--end <时间>] [--order asc|desc] [--page-all]
  dws-hub read search --query <关键词> [--group <群名>] [--conversation-id <cid>] [--days N] [--all-time] [--limit N] [--at-me]
  dws-hub send dm    --to <id> [--to-kind user|open] --text <正文> [--uuid k] [--json] [--dry-run]
  dws-hub send group --group <cid> --text <正文> [--at <openId>…] [--title 标题] [--uuid k] [--json] [--dry-run]
  dws-hub send reply --ref-msg-id <msgId> --text <正文> (--conversation-id <cid> | --direct [--to <openId>]) [--as user|bot] [--uuid k] [--json] [--dry-run]
  dws-hub send chat  --chat-id <cid> --text <正文> [--at <openId>…] [--uuid k] [--json] [--dry-run]
  dws-hub emoji add|remove --conversation-id <cid> --msg-id <msgId> [--emoji 撒花] [--json] [--dry-run]
  dws-hub edit --conversation-id <cid> --message-id <msgId> --text <新正文> [--title 标题] [--no-verify] [--dry-run]
      （消息发错→编辑原消息纠正，不撤回重发；默认读回断言无 <@ 字面量）
  dws-hub ding send --to <openDingTalkId> --content <正文> [--type app|sms|call] [--allow-cost] [--uuid k] [--json] [--dry-run]
  dws-hub todo list [--limit N] [--json]          # 我的待办（账号级，多端同步）
  dws-hub todo add --text "<标题>" [--due ISO]    # 去重创建（标题已存在则跳过）
  （退出码：0 成功/幂等命中/dry-run · 1 业务未达成（读回断言失败/长连接不健康）· 2 参数 · 3 dws 失败 · 4 鉴权缺配 · 5 未预期）

环境：
  DWS_HUB_ENABLE=1     notify（通知阶梯）真发；缺省不调用 dws（dry-run），但仍会落台账/锚点并输出 JSON 回执
                        ⚠️ send / emoji / ding / edit 不在该开关下：默认**真发**，只认显式 --dry-run
  DWS_HUB_HOME=<dir>   数据根（默认 ~/.dws-hub）
  DWS_HUB_DB=<path>    覆盖库路径（默认 $DWS_HUB_HOME/db/dws-hub.db）
  DWS_HUB_INBOX_CMD    投递命令模板（默认关闭；模板可用 $DWS_HUB_INBOX_* 变量）
  DWS_HUB_SELF_USER    自己的 userId（自聊轮询需要）
  DWS_HUB_SELF_OPEN_ID 自己的 openDingTalkId（DING 强提醒需要）
  DWS_HUB_MARKER       出站标记模板（默认 "🤖 dws-hub · {consumer}"）
  DWS_HUB_TZ           展示用本地时区（默认 Asia/Shanghai）
  DWS_HUB_SESSION_ID   会话 id（follow add/rm 未给 --session 时使用）
  DWS_HUB_FOLLOWS      订阅注册表路径（默认 $DWS_HUB_HOME/consumers/session-follows.json）
  DWS_BIN              dws 可执行文件（默认从 PATH 找 dws）
`;
}

async function main() {
  const argv = process.argv.slice(2);
  // ⚠️ `--help` / `-h` / `help` 必须**在任何分支之前短路**（2026-11-24 实测事故）：
  //    `listen --help` 被当成普通 listen 参数 → 直接起了 4 个 stream 监听子进程
  //    （`--stream-sec 1500`），挂了 25 分钟才自然退出，且与常驻服务的监听重复。
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(usage());
    return 0;
  }
  // send / emoji / ding 走专用通路：不建 hub 库（dry-run 必须零副作用）、退出码独立
  if (argv[0] === 'send' || argv[0] === 'emoji') return await runSendEmoji(argv[0], argv.slice(1));
  if (argv[0] === 'read') return await runRead(argv.slice(1));
  if (argv[0] === 'ding') return await runDing(argv.slice(1));
  if (argv[0] === 'todo') return await runTodo(argv.slice(1));
  // 消息纠正（编辑原消息）：不建 hub 库（dry-run 零副作用）
  if (argv[0] === 'edit') return await runEdit(argv.slice(1));
  // 服务与自检
  if (argv[0] === 'service') {
    const sub = argv[1] || 'status';
    const svc = await import('./service/install.mjs');
    if (sub === 'install') {
      print(svc.install());
      return 0;
    }
    if (sub === 'uninstall') {
      print(svc.uninstall());
      return 0;
    }
    if (sub === 'status') {
      print(svc.status());
      return 0;
    }
    process.stderr.write('用法：dws-hub service install|uninstall|status\n');
    return 2;
  }
  if (argv[0] === 'topic') {
    const mod = await import('./dws/topic-cli.mjs');
    return await mod.main(argv.slice(1));
  }
  if (argv[0] === 'doctor') {
    const { doctor } = await import('./doctor.mjs');
    const r = doctor();
    print(r);
    // 缺省恒 0（配置项缺失不算运行故障）；--strict 让退出码跟随 ok
    return argv.includes('--strict') && !r.ok ? 1 : 0;
  }
  // 通用 consumer 入口：供 hub 派发调用（stdin JSON），也可手动：
  //   echo '<events>' | dws-hub consume session-follow
  if (argv[0] === 'consume') {
    const name = argv[1];
    if (!name) {
      process.stderr.write('用法：dws-hub consume <consumer>（当前支持：session-follow）\n');
      return 2;
    }
    if (name === 'session-follow') {
      const mod = await import('./consumers/session-follow.mjs');
      return await mod.main();
    }
    process.stderr.write(`未知 consumer：${name}\n`);
    return 2;
  }
  const a = parseArgs(argv);
  const cmd = a._[0];
  const hub = createHub({ dbPath: db });
  const { store } = hub;

  switch (cmd) {
    case 'notify': {
      if (!a.consumer || !a.title) throw new Error('用法：notify --consumer <n> --title <标题> [--text 正文] [--strength info|strong|critical] [--needs-decision] [--at ISO] [--ref-msg-id <msgId> --conversation-id <cid>]');
      // kebab 参数值可能是 `true`（缺值）→ 只认字符串，避免把布尔当 id 透传
      const str = (v) => (typeof v === 'string' ? v : null);
      const refMsgId = str(a['ref-msg-id']);
      const conversationId = str(a['conversation-id']);
      // 半套参数 = 意图不明（reply 需要「引用目标 + 会话」两者）→ 明确提示但不报错，按普通阶梯发送
      if (!!refMsgId !== !!conversationId) {
        const missing = refMsgId ? '--conversation-id' : '--ref-msg-id';
        const ignored = refMsgId ? '--ref-msg-id' : '--conversation-id';
        process.stderr.write(
          `[dws-hub notify] ${missing} 与 ${ignored} 需同时提供；本次不进入 reply 分支（已忽略 ${ignored}），按普通阶梯发送\n`,
        );
      }
      const bothRef = refMsgId && conversationId ? { refMsgId, conversationId } : { refMsgId: null, conversationId: null };
      // `--send` 与 `DWS_HUB_ENABLE=1` 等价（都表示「这次真的发」）；缺省=只打印正文
      const prevEnable = process.env.DWS_HUB_ENABLE;
      if (a.send) process.env.DWS_HUB_ENABLE = '1';
      let r;
      try {
        r = await notify(store, {
        consumer: a.consumer, title: a.title, text: a.text || '',
        strength: a.strength === 'critical' ? 'critical' : a.strength === 'strong' ? 'strong' : 'info',
        needsDecision: !!('needs-decision' in a), at: a.at || null,
          force: !!a.force, now: Date.now(),
          ...bothRef,
        });
      } finally {
        if (a.send) {
          if (prevEnable === undefined) delete process.env.DWS_HUB_ENABLE;
          else process.env.DWS_HUB_ENABLE = prevEnable;
        }
      }
      const realRun = !!a.send || isReal();
      // dry_run 以运行时 isReal() 为**唯一真值来源**（不被 notify 返回值里的 dry_run 覆盖）
      print({ ...r, dry_run: !realRun });
      return r.ok ? 0 : 1;
    }

    case 'anchors': {
      const sub = a._[1] || 'list';
      if (sub === 'list') {
        const status = a.status || null;
        const rows = status ? store.anchors.byStatus(status) : ['open', 'answered', 'acting', 'expired', 'closed'].flatMap((s) => store.anchors.byStatus(s));
        print(rows.map((x) => ({ id: x.id, status: x.status, consumer: x.consumer, strength: x.strength, title: x.title, replies: x.replies.length, ext_id: x.ext_id })));
        return 0;
      }
      if (sub === 'reply') {
        const anchor = store.anchors.byId(a.id);
        if (!anchor) throw new Error(`找不到锚点 ${a.id}`);
        const r = await replyInChain(store, { anchorId: anchor.id, refExtId: a.text ? null : anchor.ext_id, text: a.text || '' });
        // dry_run 以运行时 isReal() 为唯一真值来源
        print({ ...r, dry_run: !isReal() });
        return r.ok ? 0 : 1;
      }
      // 补扫：对**已有事件**重跑锚点匹配 + 补 ack（服务停过/修完 bug 后的一次性恢复手段）
      // 幂等：`recordReply` 按 ext_id 去重、`ackReplies` 按锚点 ack 幂等 → 可反复跑
      if (sub === 'rescan') {
        const minutes = Number(a.minutes) || 120;
        const since = new Date(Date.now() - minutes * 60e3).toISOString();
        const evs = store.events.since(since);
        const hits = applyInboundToAnchors(store, evs);
        const acked = await ackReplies(store, hits, { bin: a.bin });
        print({ scanned: evs.length, since, matched: hits.map((h) => ({ anchor: h.anchor, via: h.via, ext_id: h.ext_id })), acked });
        return 0;
      }
      throw new Error(`未知子命令 anchors ${sub}`);
    }

    case 'consumers': {
      const sub = a._[1] || 'list';
      if (sub === 'list') {
        print(store.consumers.all({ enabledOnly: false }).map((c) => ({ name: c.name, targets: c.targets, keywords: c.keywords, batch_window: c.batch_window, on_event: c.on_event, enabled: c.enabled })));
        return 0;
      }
      if (sub === 'add') {
        if (!a.name || !a.targets || !a.cmd) throw new Error("用法：consumers add --name <n> --targets 'self,group:<id>' [--keywords a,b] [--batch 60] --cmd '<shell>'");
        // 白名单校验（docs/design.md）：非法形态 → 参数错误（main 统一 exit 2），**先校验再落库**。
        const targets = parseTargets(String(a.targets).split(','));
        const c = store.consumers.upsert({
          name: a.name,
          targets,
          keywords: a.keywords ? String(a.keywords).split(',').map((s) => s.trim()).filter(Boolean) : null,
          batch_window: a.batch === undefined ? 60 : Number(a.batch),
          on_event: a.cmd,
          enabled: a.disabled ? false : true,
        });
        print(c);
        return 0;
      }
      if (sub === 'rm') {
        store.consumers.remove(a.name);
        print({ removed: a.name });
        return 0;
      }
      throw new Error(`未知子命令 consumers ${sub}`);
    }

    case 'follow': {
      const sub = a._[1] || 'list';
      const envSession = process.env.DWS_HUB_SESSION_ID;
      const session = typeof a.session === 'string' ? a.session : envSession;
      if (sub === 'list') {
        print(listFollows(loadFollows()));
        return 0;
      }
      if (sub === 'add') {
        if (typeof a.scope !== 'string' || !a.scope) {
          throw new Error("用法：follow add --scope group:<id>|direct:<uid> [--session ses_xxx] [--atme] [--label 名称] [--no-sync]");
        }
        if (!session) throw new Error('缺少会话：--session / DWS_HUB_SESSION_ID');
        const doc = loadFollows();
        addFollow(doc, {
          session,
          scope: a.scope,
          atmeOnly: Boolean(a.atme),
          label: typeof a.label === 'string' ? a.label : '',
        });
        saveFollows(doc);
        const synced = a['no-sync'] ? null : syncFollowConsumer(store);
        print({ ok: true, session: validateSession(session), scope: a.scope, synced });
        return 0;
      }
      if (sub === 'rm') {
        if (!session) throw new Error('缺少会话：--session / DWS_HUB_SESSION_ID');
        const doc = loadFollows();
        const r = removeFollow(doc, {
          session,
          scope: typeof a.scope === 'string' ? a.scope : undefined,
          all: Boolean(a.all),
        });
        saveFollows(doc);
        const synced = a['no-sync'] ? null : syncFollowConsumer(store);
        print({ ok: true, removed: r.removed, synced });
        return 0;
      }
      if (sub === 'sync') {
        print({ ok: true, ...syncFollowConsumer(store) });
        return 0;
      }
      if (sub === 'status') {
        const doc = loadFollows();
        const expected = [...allScopes(doc), ...(hasAtmeOnly(doc) ? ['atme:*'] : [])];
        const consumer = store.consumers.byName('session-follow');
        const actual = consumer?.targets || [];
        const missing = expected.filter((t) => !actual.includes(t));
        const extra = actual.filter((t) => !expected.includes(t));
        const { skippedLogPath } = await import('./consumers/session-follow.mjs');
        let todaySkipped = 0;
        try {
          const logFile = skippedLogPath();
          const { readFileSync } = await import('node:fs');
          todaySkipped = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          todaySkipped = 0;
        }
        print({
          registry: defaultFollowsPath(),
          follows: listFollows(doc),
          consumer,
          expected_targets: expected,
          drift: { in_sync: !missing.length && !extra.length, missing, extra },
          today_skipped: todaySkipped,
        });
        return 0;
      }
      if (sub === 'scopes') {
        print(allScopes(loadFollows()));
        return 0;
      }
      throw new Error(`未知子命令 follow ${sub}（list/add/rm/sync/status/scopes）`);
    }

    case 'pull': {
      const r = await pullAll(store, { scopes: scopesOf(store), endIso: new Date().toISOString() });
      print(r);
      return 0;
    }

    case 'tick': {
      const r = await tick(store, { now: Date.now() });
      print(r);
      return 0;
    }

    case 'listen': {
      const intervalMs = (Number(a.interval) || 60) * 1000;
      const streamSec = Number(a['stream-sec']) || 1500;
      const maxTicks = a['max-ticks'] ? Number(a['max-ticks']) : Infinity;
      let ticks = 0;   // ⚠️ 不能用 `state`（TDZ：回调在 await 完成前就可能被调用 → 启动即崩，实测踩到）
      const state = await runLoop(store, {
        intervalMs, streamSec, maxTicks,
        onTick: (r) => {
          ticks += 1;
          const detail = Object.entries(r.pull.scopes || {})
            .map(([s, v]) => `${s}:seen=${v.seen},ins=${v.inserted},complete=${v.complete}${v.error ? `,ERR=${v.error}` : ''}`)
            .join(' ');
          process.stdout.write(`[tick ${ticks}] inserted=${r.pull.inserted} ${detail} rx=${(r.reactions || {}).inserted || 0} watch=${(r.watched || {}).insertedEvents?.length || 0}/${(r.watched || {}).watched || 0} anchors=${JSON.stringify((r.anchorHits || []).map((h) => `${h.anchor}/${h.via}`))} acked=${JSON.stringify((r.acked || []).map((x) => x.action || x.skipped))} ing=${JSON.stringify((r.ing || []).map((x) => x.action))} dispatched=${JSON.stringify(r.dispatch)} ladder=${JSON.stringify(r.ladder)}\n`);
        },
      });
      print(state);
      return 0;
    }

    case 'probe': {
      if (!a.scope) throw new Error('用法：probe --scope <self|group:<id>|direct:<id>> [--window 60]');
      const r = await probeScope(store, { scope: a.scope, windowSec: Number(a.window) || 60 });
      print(r);
      return 0;
    }

    case 'stream-status': {
      // 长连接**生效状态**（消费方据此决定停/启兜底）
      const st = store.kv.get('stream', 'state', null);
      const kinds = [...new Set(scopesOf(store).map((s2) => `stream:${s2.split(':')[0]}`))];
      const { rollup } = await import('./hub/ladder.mjs');
      const lr = rollup(store, kinds, { now: Date.now() });
      const broken = Object.entries(lr).filter(([, v]) => v.state !== 'healthy').map(([k, v]) => `${k}:${v.state}`);
      const ageMs = st?.at ? Date.now() - Date.parse(st.at) : null;
      const stale = ageMs === null || ageMs > 3 * 60 * 1000;      // >3min 没更新 ⇒ 视为不健康
      const out = {
        ok: !!(st?.streaming) && !stale && broken.length === 0,
        streaming: !!st?.streaming, last_state_at: st?.at || null, state_age_ms: ageMs,
        unhealthy_kinds: broken, ladder: lr,
      };
      if (a.json) print(out);
      else process.stdout.write(`长连接：${out.ok ? '✅ 生效中' : '✗ 未生效'}（streaming=${out.streaming}, 状态更新于 ${st?.at || '—'}, 异常档位=${broken.join(',') || '无'}）\n`);
      return out.ok ? 0 : 1;
    }

    case 'scan': {
      const sub = a._[1] || 'status';
      if (sub === 'status') {
        const runs = store.db.query('SELECT * FROM hub_scan_runs ORDER BY id DESC LIMIT 5').all();
        print({ ...scanCh.getScanState(store), due: scanCh.shouldScan(store, {}).due, recent_runs: runs });
        return 0;
      }
      if (sub === 'run') {
        print(await scanOnce(store, {}));
        return 0;
      }
      if (sub === 'coverage') {
        const since = a._[2] || new Date(Date.now() - 7 * 86400e3).toISOString();
        print(scanCh.coverage(store, { consumers: store.consumers.all(), sinceIso: since }));
        return 0;
      }
      if (sub === 'prune') {
        print(scanCh.prune(store, {}));
        return 0;
      }
      process.stdout.write('用法：dws-hub scan <status|run|coverage [since]|prune>\n');
      return 2;
    }

    case 'ding-log': {
      const since = a.since ? parseSince(a.since) : null;
      const rows = store.dingLog.list({
        since,
        consumer: typeof a.consumer === 'string' ? a.consumer : null,
        limit: Number(a.limit) || 50,
      });
      if (a.json) { print(rows); return 0; }
      const head = 'ts | consumer | endpoint | ok | downgraded | gate | title';
      process.stdout.write(`${head}\n${'-'.repeat(head.length)}\n`);
      for (const r of rows) {
        const title = String(r.title ?? '').replace(/\s+/g, ' ').slice(0, 60);
        process.stdout.write(`${r.ts} | ${r.consumer ?? '-'} | ${r.endpoint} | ${r.ok ? 'ok' : 'FAIL'} | ${r.downgraded ? 'y' : '-'} | ${r.gate ?? '-'} | ${title}\n`);
      }
      if (rows.length === 0) process.stdout.write('（最近窗口内无记录）\n');
      return 0;
    }

    case 'health': {
      if (a.reconnect) {
        const { reset } = await import('./hub/ladder.mjs');
        const kinds = [...new Set(scopesOf(store).map((s) => `stream:${s.split(':')[0]}`))];
        print(kinds.map((k) => reset(store, k, { reason: 'manual_reconnect' })));
        return 0;
      }
      print(health(store));
      return 0;
    }

    default:
      if (cmd) {
        process.stderr.write(`未知命令：${cmd}\n\n`);
        process.stdout.write(usage());
        return 2;
      }
      process.stdout.write(usage());
      return 0;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    process.stderr.write(`[dws-hub] ${e.message}\n`);
    process.exit(2);
  });
