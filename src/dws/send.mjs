#!/usr/bin/env node
/**
 * send.mjs —— 钉钉发送的**固定姿势**（唯一入口；防「@ 不渲染 / 字面量占位符」反复发错）
 *
 * **分层定位（L1 传输原语，2026-10-19 校准）**：
 *   · 本文件 = **L1 发送姿势**（纯传输：群发 / 引用回复 / @ 渲染规则 / 读回校验），**不认识锚点、不碰业务**；
 *   · `notify.mjs::replyInChain` = **L2 回复链**（锚点/状态机/表情/限频）→ **依赖本文件的 L1 原语**；
 *   · 因此「@ 别人 = 开新链」属 L2 语义（由 anchors 建锚点决定），本文件只负责「把这条消息正确地发出去」。
 * 引用回复的 @ 由接口按引用自动带，正文不要再手写 @。
 *
 * 实测矩阵（2026-10-19，两条错误消息已撤回）：
 *   +messages-reply --markdown "<@id> …"            → ❌ 字面量，不渲染
 *   +messages-reply --content "<@id> …"（无 --at）   → ❌ 校验失败
 *   +messages-reply --content + --at-open-dingtalk-ids → ❌ 仍是字面量
 *   +messages-send --markdown + --at-open-dingtalk-ids → ✅ 真 @
 *   +messages-reply（不传 at、正文不写 @）             → ✅ 接口自动 @ 被回复人
 *
 * 用法（bun/node 均可）：
 *   bun src/dws/send.mjs group  <conversationId> "<正文>" [--at <openDingTalkId>...]
 *   bun src/dws/send.mjs reply  <conversationId> <refMessageId> "<正文>" [--allow-plain-at]
 *   bun src/dws/send.mjs verify <conversationId> [--limit 5]
 *
 * 硬校验（2026-11-10 加严，防「@ 不渲染 / 重复 @」事故）：
 *   · reply：**禁止 `--at`**（接口自动 @ 被回复人，传了不渲染）；
 *   · reply：**禁止正文手写 `@姓名`**（会与自动 @ 叠加）—— 确需纯文本用 `--allow-plain-at`；
 *   · 发送后读回**只判本次 messageId**，历史消息的字面量仅提示、不判失败（避免误撤回）。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dwsJson } from './dws.mjs';
import { buildNotifyBody } from './format.mjs';

const argv = process.argv.slice(2);
const [mode, ...rest] = argv;
const IS_CLI = !!mode && ['group', 'reply', 'verify', 'notify'].includes(mode);
const say = (...a) => { if (IS_CLI) console.log(...a); };

function fail(msg) { const e = new Error(msg); e.usage = true; throw e; }

function parseAt(args) {
  const ats = [];
  const plain = [];
  const flags = { allowPlainAt: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at') { while (i + 1 < args.length && !args[i + 1].startsWith('--')) ats.push(args[++i]); }
    else if (args[i] === '--limit') { i++; }
    else if (args[i] === '--allow-plain-at') { flags.allowPlainAt = true; }
    else plain.push(args[i]);
  }
  return { ats, plain, flags };
}

/**
 * 「手写 @姓名」检测（**引用回复 / 单聊禁用**：接口会自动 @，手写会变成重复 @ 或纯文本）。
 *
 * 只认「行首或空白/括号后的 @ + 姓名」，并排除邮箱（`a@b.com`）、代码（`@media` 命中前有字母 → 被 before 判定排除）。
 * 2026-11-10 事故：引用回复正文手写「@示例-张三-示例部门」→ 客户端显示双 @；
 * 确需纯文本 @（如正文引用他人原话）用 `--allow-plain-at` 显式绕过。
 */
const PLAIN_AT_RE = /(^|[\s（(])@([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_.-]{0,19}|[A-Za-z][A-Za-z0-9_.-]{1,19})/g;

export function findPlainMentions(body = '') {
  const hits = [];
  let m;
  PLAIN_AT_RE.lastIndex = 0;
  while ((m = PLAIN_AT_RE.exec(body))) {
    const atIdx = m.index + m[1].length;
    const before = body.slice(0, atIdx);
    // 邮箱 / 代码里的 @：紧邻前一个字符是字母数字或 ._%+- → 不是「@人」
    if (/[A-Za-z0-9._%+-]$/.test(before)) continue;
    hits.push(m[0].trim());
  }
  return hits;
}


/**
 * 幂等命中判定用**双关键词**（大小写不敏感）：同时出现 `repeated` 与 `uuid` 才算。
 * 实测文案 `Request is repeated with uuid '<key>'`；上游文案/大小写可能变化，
 * 故不做整句精确匹配（旧实现只认整句，文案一变就漏判 → 误报失败并触发重发）。
 */
const REPEATED_RE = /repeated/i;
const UUID_RE = /uuid/i;

function safeJson(v) {
  try { return JSON.stringify(v ?? ''); } catch { return ''; }
}

/**
 * 默认幂等键（**唯一来源**）：CLI 与 L1 共用，避免两处各造一套默认值。
 * ⚠️ 必须含时间戳——「同一句话发两次」是合法需求（内容哈希会被 dws 判 repeated → 静默假绿，
 * 见 docs/design.md）。
 */
export function defaultUuid(kind) {
  return `dws-hub-${kind}-${Date.now()}`;
}

/** 取 dws 返回值里的新消息 id（不同接口层级不同；取不到 → null）。 */
export function extractMessageId(r) {
  const d = r?.data && typeof r.data === 'object' ? r.data : {};
  return d.messageId || d.message_id || d.data?.messageId || d.result?.messageId || null;
}

/**
 * 「同幂等键重复」判定（发送防重的硬性规则）：
 * dws 对**已成功发出过**的同 key 重发返回
 * `category=api / reason=business_error / code=1` + `Request is repeated with uuid '<key>'`——
 * 信封形状和「服务端间歇故障」几乎一样，但语义是**成功**（幂等键在正常工作）。
 *
 * 判定口径：
 *   · 必须是失败信封（`ok === false`）——成功时一律不判定，避免误吃正常结果；
 *   · 检索范围**只看错误上下文**（`raw` + `data.error`），**不吃** `data` 其余字段
 *     （请求回显里常含 `--idempotency-key` 等字样，全量 haystack 会误判）；
 *   · `repeated` 与 `uuid` **同时命中**才成立（容忍大小写 / 文案变体）。
 */
export function isRepeatedUuid(r) {
  if (!r || r.ok !== false) return false;
  const err = r.data && typeof r.data === 'object' ? r.data.error : null;
  const hay = [
    r.raw || '',
    typeof err === 'string' ? err : (err?.message || ''),
    safeJson(err),
  ].join(' ');
  return REPEATED_RE.test(hay) && UUID_RE.test(hay);
}

/**
 * 把「同幂等键重复」归一成**成功信封**：`ok:true` + `duplicated:true`，且**不重试**。
 * `deduped:true` 作为**向后兼容别名**同时保留（历史调用方/用例按旧名断言）。
 * `raw` / `code` 原样保留（诊断用），原错误挂到 `data.repeated_error`。
 */
export function normalizeIdempotent(r) {
  if (!isRepeatedUuid(r)) return r;
  const data = { ...(r.data && typeof r.data === 'object' ? r.data : {}), ok: true, duplicated: true, deduped: true };
  if (data.error) { data.repeated_error = data.error; delete data.error; }
  return { ...r, ok: true, duplicated: true, deduped: true, data };
}

/** 读回校验：正文出现字面量 `<@` = @ 未渲染（发错了） */
export function findLiteralMentions(messages) {
  return (messages || []).filter((m) => (m.text || '').includes('<@'));
}

async function readBack(conv, limit = 5, { bin } = {}) {
  const r = await dwsJson(['chat', '+chat-messages', '--group', conv, '--limit', String(limit), '--format', 'json'], { bin });
  const d = typeof r === 'object' ? r : JSON.parse(r);
  return (d.data && d.data.messages) || d.messages || [];
}

/**
 * 读回校验。
 *
 * - **无 `expectMessageId`**（旧行为）：扫最近 5 条，任一字面量占位符 → 失败（退出码 1）。
 * - **有 `expectMessageId`（发送后推荐）**：**只判本次消息**；历史消息里的字面量仅提示、不判失败。
 *   2026-11-10 事故：拿历史告警当本次失败 → 撤回了已成功消息并重发（用户点名）。
 */
export async function verify(conv, { quiet = false, bin, expectMessageId } = {}) {
  const msgs = await readBack(conv, expectMessageId ? 10 : 5, { bin });
  const bad = findLiteralMentions(msgs);
  if (expectMessageId) {
    const current = msgs.find((m) => m.messageId === expectMessageId);
    if (!quiet) {
      console.log(`  本次消息：${current ? `${current.createTime} | ${current.sender} | ${(current.text || '').includes('<@') ? '❌字面量' : '✓'}` : '未在最近消息中定位到（可能延迟）'}`);
    }
    if (current && (current.text || '').includes('<@')) {
      console.error(`❌ 本次消息含字面量占位符（@ 未渲染）→ 撤回：${current.messageId}`);
      return 1;
    }
    const history = bad.filter((b) => b.messageId !== expectMessageId);
    if (history.length) {
      console.error(`ℹ️ 历史消息含字面量占位符（非本次，勿撤回）：${history.map((b) => b.messageId).join(', ')}`);
    }
    say('  ✓ 本次消息读回校验通过（无字面量占位符）');
    return 0;
  }
  if (!quiet) {
    for (const m of msgs.slice(-3)) {
      const flag = (m.text || '').includes('<@') ? '❌字面量' : '✓';
      console.log(`  ${m.createTime} | ${m.sender} | ${flag} | ${String(m.text || '').slice(0, 70)}`);
    }
  }
  if (bad.length) {
    console.error(`⚠️ 发现 ${bad.length} 条含字面量占位符的消息（@ 未渲染）→ 建议撤回：${bad.map((b) => b.messageId).join(', ')}`);
    return 1;
  }
  say('  ✓ 读回校验通过（无字面量占位符）');
  return 0;
}

/** @ 占位符校验（sendGroup / sendChat 共用）：正文必须含 `<@openDingTalkId>` */
function checkMentionPlaceholders(body, ats = []) {
  for (const a of ats) {
    if (!body.includes(`<@${a}>`)) fail(`正文缺少占位符 <@${a}>（send 必须成对出现，否则 dws 拒发）`);
  }
}

/**
 * 群发 argv 构造（`dryRun` 与真发共用同一份，防「回显的命令 ≠ 实发的命令」）。
 * `title` 非空时附 `--title`（markdown 卡片标题；通道本来就是 `--markdown`）。
 */
export function buildSendGroupArgs(conv, body, ats = [], { uuid, title } = {}) {
  checkMentionPlaceholders(body, ats);
  const args = ['chat', '+messages-send', '--as', 'user', '--group', conv, '--markdown', body,
    '--idempotency-key', uuid || defaultUuid('send'), '--yes', '--format', 'json'];
  if (ats.length) args.push('--at-open-dingtalk-ids', ats.join(','));
  if (title) args.push('--title', String(title));
  return args;
}

export async function sendGroup(conv, body, ats = [], { bin, uuid, title, dryRun = false } = {}) {
  const key = uuid || defaultUuid('send');
  const args = buildSendGroupArgs(conv, body, ats, { uuid: key, title });
  if (dryRun) return { ok: true, dry_run: true, argv: args, uuid: key };
  const r = normalizeIdempotent(await dwsJson(args, { bin }));
  say(`  ✓ 已发送（${ats.length ? `@ ${ats.length} 人` : '无 @'}）`);
  return r;
}

/**
 * 单聊 argv 构造。`kind`：`user` → `--user <userId>`；`open`（默认）→ `--open-dingtalk-id`。
 * 单聊无 @ 概念，正文不得含 `<@id>`。
 */
export function buildSendDirectArgs(to, body, { uuid, kind = 'open' } = {}) {
  if (/<@[A-Za-z0-9+/=]+>/.test(body)) fail('单聊正文不要写 <@…> 占位符：单聊没有「群成员 @」，占位符会原样显示');
  const idFlag = kind === 'user' ? '--user' : '--open-dingtalk-id';
  return ['chat', '+messages-send', '--as', 'user', idFlag, String(to),
    '--text', body, '--idempotency-key', uuid || defaultUuid('dm'), '--yes', '--format', 'json'];
}

/** 单聊发送（默认 openDingTalkId；`kind:'user'` 时走 `--user`）。 */
export async function sendDirect(to, body, { bin, uuid, kind = 'open', dryRun = false } = {}) {
  const key = uuid || defaultUuid('dm');
  const args = buildSendDirectArgs(to, body, { uuid: key, kind });
  if (dryRun) return { ok: true, dry_run: true, argv: args, uuid: key };
  const r = normalizeIdempotent(await dwsJson(args, { bin }));
  say('  ✓ 已发送单聊（无 @）');
  return r;
}

/**
 * 发到指定会话（--chat-id；自聊 / 已有 conversationId 场景），可带 @。
 * ats 非空时正文必须含对应 `<@openDingTalkId>` 占位符（与 sendGroup 同一校验）。
 */
export function buildSendChatArgs(chatId, body, { ats = [], uuid } = {}) {
  if (!chatId) fail('sendChat：缺少 chatId');
  checkMentionPlaceholders(body, ats);
  // ⚠️ @ 必须走 markdown 通道（与 sendGroup 同口径）：`--text` + `--at-open-dingtalk-ids` 实测不渲染占位符
  const args = ['chat', '+messages-send', '--as', 'user', '--chat-id', chatId,
    ats.length ? '--markdown' : '--text', body,
    '--idempotency-key', uuid || defaultUuid('chat'), '--yes', '--format', 'json'];
  if (ats.length) args.push('--at-open-dingtalk-ids', ats.join(','));
  return args;
}

export async function sendChat(chatId, body, { ats = [], bin, uuid, dryRun = false } = {}) {
  const key = uuid || defaultUuid('chat');
  const args = buildSendChatArgs(chatId, body, { ats, uuid: key });
  if (dryRun) return { ok: true, dry_run: true, argv: args, uuid: key };
  return normalizeIdempotent(await dwsJson(args, { bin }));
}

/**
 * 引用回复。
 *   · 默认（群）：`--group <openConversationId>`
 *   · direct（单聊）：`dws chat +messages-reply` **无 `--conversation-id`**——
 *     传 openDingTalkId 走 `--open-dingtalk-id`，否则省略会话让 CLI 从源消息只读定位（实测 help 支持）。
 *     两种姿势都不传 `--group`；正文同样禁止 `<@…>` 占位符（接口自动 @ 被回复人）。
 *   · `uuid` → `--idempotency-key <uuid>`（调用方幂等键；未给保留 `dws-hub-reply-<ts>` 默认）。
 *   · `as` → `--as <user|bot>`（默认 `user`，与历史调用一致）。
 */
export function buildSendReplyArgs(conv, refId, body, { direct = false, openDingTalkId, uuid, as = 'user', allowPlainAt = false } = {}) {
  // 正解：**不传 at、正文不写 @** —— 接口自动 @ 被回复的人
  if (/<@[A-Za-z0-9+/=]+>/.test(body)) {
    fail(direct
      ? '单聊引用回复正文不要写 <@…> 占位符：单聊没有「群成员 @」，接口会自动 @ 被回复的人（写了会显示字面量）'
      : '引用回复正文不要写 <@…> 占位符：接口会自动 @ 被回复的人（写了会显示字面量）');
  }
  // 手写 @姓名 同样禁止（2026-11-10 事故：与自动 @ 叠加成「@A @A」/纯文本）
  const plainAt = findPlainMentions(body);
  if (plainAt.length && !allowPlainAt) {
    fail(`引用回复正文不要手写 @姓名（接口会自动 @ 被回复人，写了会重复或成纯文本）：${plainAt.join('、')}`
      + '\n  确需纯文本 @（例如引用他人原话）→ 加 --allow-plain-at 显式放行');
  }
  const args = ['chat', '+messages-reply', '--as', as];
  if (direct) {
    if (openDingTalkId) args.push('--open-dingtalk-id', openDingTalkId);
  } else {
    args.push('--group', conv);
  }
  args.push('--ref-msg-id', refId,
    '--content', body, '--idempotency-key', uuid || defaultUuid('reply'), '--yes', '--format', 'json');
  return args;
}

export async function sendReply(conv, refId, body, { bin, direct = false, openDingTalkId, uuid, as = 'user', dryRun = false, allowPlainAt = false } = {}) {
  const key = uuid || defaultUuid('reply');
  const args = buildSendReplyArgs(conv, refId, body, { direct, openDingTalkId, uuid: key, as, allowPlainAt });
  if (dryRun) return { ok: true, dry_run: true, argv: args, uuid: key };
  const r = normalizeIdempotent(await dwsJson(args, { bin }));
  say(direct ? '  ✓ 已单聊引用回复（自动 @ 原消息作者）' : '  ✓ 已引用回复（自动 @ 原消息作者）');
  return r;
}

/** notify 参数解析 */
function parseNotifyArgs(args) {
  const out = { urls: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--reviewer-id') out.reviewerId = args[++i];
    else if (a === '--summary') out.summary = args[++i];
    else if (a === '--url') out.urls.push(args[++i]);
    else if (a === '--group') out.group = args[++i];
    else if (a === '--dm') out.dm = args[++i];
    else if (a === '--idempotency-key') out.uuid = args[++i];
    else if (a === '--send') out.send = true;
    else if (a === '--dry-run') out.send = false;
    else fail(`未知参数：${a}`);
  }
  if (!out.summary || !out.urls?.length) fail('用法: send.mjs notify --reviewer-id <id> --summary "…" --url <u> [--url …] [--group <cid>|--dm <id>] [--send]');
  if (!out.dm && !out.group) fail('notify 需要 --group <openConversationId> 或 --dm <openDingTalkId>');
  return { ...out, send: Boolean(out.send) };
}

async function main() {
  if (mode === 'group') {
    const { ats, plain } = parseAt(rest);
    const [conv, body] = plain;
    if (!conv || !body) fail('用法: send.mjs group <conversationId> "<正文>" [--at <id>...]');
    const r = await sendGroup(conv, body, ats);
    await verify(conv, { quiet: true, expectMessageId: extractMessageId(r) });
    return 0;
  }
  if (mode === 'reply') {
    const { ats, plain, flags } = parseAt(rest);
    const [conv, refId, body] = plain;
    if (!conv || !refId || !body) fail('用法: send.mjs reply <conversationId> <refMessageId> "<正文>" [--allow-plain-at]');
    // 引用回复不支持 --at：接口会自动 @ 被回复人，传了也不会渲染（CLI 层同样禁止，这里防绕过）
    if (ats.length) fail('引用回复不支持 --at（接口自动 @ 被回复人；传了不渲染）→ 去掉 --at 重发');
    const r = await sendReply(conv, refId, body, { allowPlainAt: flags.allowPlainAt });
    await verify(conv, { quiet: true, expectMessageId: extractMessageId(r) });
    return 0;
  }
  if (mode === 'notify') {
    const { reviewerId, summary, urls, group, dm, uuid, send } = parseNotifyArgs(rest);
    const body = buildNotifyBody({
      reviewerId,
      summary,
      urls,
      dm: Boolean(dm),
      onWarning: (w) => console.error(`  ⚠️  ${w}`),
    });
    if (!send) {
      console.error('  (dry-run) 未发送；加 --send 真发');
      console.log(body);
      return 0;
    }
    if (dm) {
      await sendDirect(dm, body, { uuid });
    } else {
      await sendGroup(group, body, reviewerId ? [reviewerId] : [], { uuid });
      await verify(group, { quiet: true });
    }
    // 通知发出后要有人接住回复，否则等于没发完
    console.log('  ⚠️  通知已发出 → 记得在可预期的时间窗内跟进回复（有界监听或人工查看）。');
    console.log('     例：dws-hub listen --interval 60 --stream-sec 1500 [--max-ticks N]');
    return 0;
  }
  if (mode === 'verify') {
    const { plain } = parseAt(rest);
    const [conv] = plain;
    if (!conv) fail('用法: send.mjs verify <conversationId> [--limit 5]');
    return await verify(conv);
  }
  console.log(`用法：
  send.mjs group  <conversationId> "<正文>" [--at <openDingTalkId>...]   # 群发（可 @，真渲染）
  send.mjs reply  <conversationId> <refMessageId> "<正文>"              # 引用回复（自动 @ 作者）
  send.mjs verify <conversationId>                                     # 读回校验字面量占位符
  send.mjs notify --reviewer-id <id> --summary "≤15 字" --url <u> [--url …] [--group <cid>] [--idempotency-key k] [--send]
  send.mjs notify --dm <openDingTalkId> --summary "≤15 字" --url <u>   # 单聊（正文无 <@id>）

  notify 默认 dry-run（只打印正文）；加 --send 才真发。
  ⚠️ --send 成功后记得跟进回复（见输出提示）。`);
  return 2;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isDirectRun()) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`✗ ${e?.message || e}`); process.exit(e?.usage ? 2 : 1); });
}
