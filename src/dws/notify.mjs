/**
 * dws-hub · dws 适配层 —— 通知阶梯 + 出站标记
 *
 * 设计：docs/design.md（通知阶梯）/ docs/design.md（出站标记）
 *
 * ══ 为什么需要阶梯 ══
 * 用户 2026-10-16：「自己消息缺少了未读通知，所以需要有选择 ding 或者通过待办、日历降级通知自己」。
 * 实测：`todo +remind` 建待办、`todo +reminder --base-time customTime --at` 挂**真实提醒规则**；
 * `calendar +create` **无提醒参数**（提醒行为不可控）→ 故降级顺序 = DING → 待办 → 日历 → 自聊消息。
 *
 * ══ 档位（两档，与既有 escalate 契约一致）══
 * `info`   = 自聊消息（**无未读提醒**，定位是「可查」）
 * `strong` = DING（限频）→ 超限/静默 → 待办 → 日历 → 兜底消息
 * 「需要我决策」= payload 属性 `needsDecision`（**不是档位**），会建锚点等回复。
 *
 * ══ 安全默认 ══
 * 未设 `DWS_HUB_ENABLE=1` 时**只 dry-run**（不真发）—— 防止误发；测试与开发安全。
 */
import { dwsJson, isReal, outboundMarker } from './dws.mjs';
import { sendReply } from './send.mjs';
import { sendPersonalDing } from './ding.mjs';
import * as rl from '../hub/ratelimit.mjs';
import { createAnchor, lastInbound, newAnchorId, recordOutbound, setEmoji, transition } from '../hub/anchors.mjs';
import { EMOJI, addEmoji, removeEmoji } from './emoji.mjs';
import { createHash } from 'node:crypto';

export const ENDPOINTS = ['ding', 'ding_call', 'todo', 'calendar', 'message'];

// 同一条告警（consumer + 标题）在窗口内只发一次：防止调用方每轮都 notify，
// 否则一条持续告警会被刷成一串重复的待办/消息。
export const DEDUPE_WINDOW_MS = {
  ding: 2 * 3600e3,
  ding_call: 30 * 60e3,
  todo: 6 * 3600e3,
  calendar: 12 * 3600e3,
  message: 2 * 3600e3,
};

/** 去重键：`consumer + 标题`（**刻意不含正文** —— 正文常带时间戳/计数，含进去等于关掉去重）；
 *  同一 consumer 若要按事项细分，请在标题里带事项号（如 `!123 待评审`）。 */
export function dedupeKeyOf(consumer, title) {
  return createHash('sha1').update(`${consumer ?? ''}|${title ?? ''}`).digest('hex').slice(0, 16);
}

/** 该通道上这条告警是否在窗口内已经发过（窗口按通道区分）。 */
export function isDuplicate(store, endpoint, key, now = Date.now()) {
  const ts = Number(store?.kv?.get(`notify:dedupe:${endpoint}`, key, 0)) || 0;
  return !!ts && now - ts < (DEDUPE_WINDOW_MS[endpoint] || 0);
}

/** 记账：发送成功后标记（旁路，失败不打断主链路）。 */
export function markSeen(store, endpoint, key, now = Date.now()) {
  try { store?.kv?.set(`notify:dedupe:${endpoint}`, key, now); } catch { /* 台账旁路 */ }
}

/** 自聊消息：发给「我自己」（dws 用姓名解析到自己的单聊）。 */
export async function sendSelfMessage({ text, bin, selfName = process.env.DWS_HUB_SELF_NAME || '', selfUser = process.env.DWS_HUB_SELF_USER, matchText = null, attempts = 4 } = {}) {
  if (!isReal()) return { ok: true, dry_run: true, endpoint: 'message', ext_id: null };
  const r = await dwsJson(['chat', '+dm', '--to', selfName, '--content', text, '--yes', '--format', 'json'], { bin });
  if (!r.ok) return { ok: false, endpoint: 'message', error: r.data?.error?.message || 'send_failed', raw: r.data };
  // ⚠️ **`+dm` 返回的 `openTaskId` 不是消息 id**（2026-10-16 实测：返回 `EH3UFv2X…`，
  //    而该消息真实 `messageId` 是 `msgskWDQsCC8b…`）⇒ 直接拿它当锚点 ext_id，**引用回复永远匹配不上**。
  //    故：发完**回读**刚发那条消息，取真实 messageId（用正文里的唯一串匹配，如事项号）。
  const mid = matchText ? await readbackMessageId({ selfUser, matchText, bin, attempts }) : (r.data?.result?.openTaskId || null);
  return {
    ok: true, endpoint: 'message', ext_id: mid || null,
    send_task_id: r.data?.result?.openTaskId || null,
    ext_id_unverified: !!matchText && !mid,        // 回读失败：锚点将只能靠「事项号」兜底识别
  };
}

/** 回读刚发出的消息，拿真实 messageId（按正文里的唯一串匹配）。 */
export async function readbackMessageId({ selfUser, matchText, bin, attempts = 4, delayMs = 1500 } = {}) {
  if (!selfUser) return null;
  const since = new Date(Date.now() - 5 * 60e3).toISOString();
  for (let i = 0; i < attempts; i += 1) {
    const r = await dwsJson(['chat', '+messages-list-direct', '--user', selfUser, '--time', since,
      '--forward', '--page-all', '--page-limit', '20', '--format', 'json'], { bin });
    const msgs = r.data?.messages || r.data?.data?.messages || [];
    const hit = msgs.filter((m) => (m.text || '').includes(matchText)).pop();
    if (hit?.messageId) return hit.messageId;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

/** 强提醒：DING（需要自己的 openDingTalkId；缺则不可用 → 交给阶梯降级）。 */
export async function sendDing({ text, bin, openId = process.env.DWS_HUB_SELF_OPEN_ID } = {}) {
  if (!openId) return { ok: false, endpoint: 'ding', error: 'missing_self_open_id' };
  if (!isReal()) return { ok: true, dry_run: true, endpoint: 'ding', ext_id: null };
  const r = await dwsJson(['ding', '+send-personal', '--users', openId, '--content', text, '--yes', '--format', 'json'], { bin });
  return { ok: r.ok, endpoint: 'ding', ext_id: r.data?.openDingId || null, raw: r.data };
}

/** 电话 DING（仅 critical 用；有通信费用，额度 2/日、1/小时）。 */
export async function sendDingCall({ text, bin, openId = process.env.DWS_HUB_SELF_OPEN_ID } = {}) {
  if (!openId) return { ok: false, endpoint: 'ding_call', error: 'missing_self_open_id' };
  if (!isReal()) return { ok: true, dry_run: true, endpoint: 'ding_call' };
  const r = await sendPersonalDing({ openDingTalkId: openId, text, type: 'call', bin });
  return { ok: r.ok, endpoint: 'ding_call', ext_id: r.data?.openDingId || null, raw: r.data };
}

/** 降级一：待办（**带真实提醒规则**）。 */
export async function sendTodo({ text, at, bin } = {}) {
  if (!isReal()) return { ok: true, dry_run: true, endpoint: 'todo', ext_id: null };
  const title = text.split('\n').slice(0, 2).join(' ').slice(0, 180);
  const r = await dwsJson(['todo', '+remind', '--task', title, '--at', at, '--yes', '--format', 'json'], { bin });
  const taskId = r.data?.data?.taskId || r.data?.taskId;
  if (!r.ok || !taskId) return { ok: false, endpoint: 'todo', error: r.data?.error?.message || 'create_failed', raw: r.data };
  // 提醒规则：customTime（上游无读接口 → verified=false 属预期，见 dws.mjs 坑 3）
  const rem = await dwsJson(['todo', '+reminder', '--task-id', String(taskId), '--base-time', 'customTime', '--at', at, '--yes', '--format', 'json'], { bin });
  return { ok: true, endpoint: 'todo', ext_id: String(taskId), reminder: rem.data?.data?.action || null, raw: r.data };
}

/** 降级二：日历（**无提醒参数**，仅作时间锚点）。 */
export async function sendCalendar({ text, start, end, bin } = {}) {
  if (!isReal()) return { ok: true, dry_run: true, endpoint: 'calendar', ext_id: null };
  const title = text.split('\n')[0].slice(0, 120);
  const r = await dwsJson(['calendar', '+create', '--title', `[dws-hub] ${title}`,
    '--desc', text.slice(0, 1000), '--start', start, '--end', end, '--timezone', 'Asia/Shanghai', '--yes', '--format', 'json'], { bin });
  // ⚠️ 坑 2：读回校验可能误报（write actually succeeded）→ 用 +agenda 复核，禁止盲重试
  if (!r.ok) {
    const sub = r.data?.error?.subtype;
    if (sub === 'readback_field_missing') {
      const chk = await dwsJson(['calendar', '+agenda', '--format', 'json'], { bin });
      const hit = JSON.stringify(chk.data || {}).includes(title);
      return { ok: hit, endpoint: 'calendar', ext_id: null, verified_by: 'agenda', note: 'readback_false_negative' };
    }
    return { ok: false, endpoint: 'calendar', error: r.data?.error?.message || 'create_failed', raw: r.data };
  }
  return { ok: true, endpoint: 'calendar', ext_id: r.data?.data?.eventId || null };
}

/** 真实 reply 发送（L1 原语 sendReply）→ 归一成 notify 需要的 `{ok,ext_id,error}` 形态。 */
async function defaultReplyImpl({ conversationId, refMsgId, text, bin }) {
  const r = await sendReply(conversationId, refMsgId, text, { bin });
  return {
    ok: r?.ok !== false,
    ext_id: r?.data?.messageId || r?.data?.data?.messageId || r?.ext_id || null,
    error: r?.data?.error?.message || (r?.ok === false ? 'reply_failed' : undefined),
  };
}

/**
 * 发通知（带阶梯 + 限频 + 标记 + 可选锚点）。
 *
 * 「引用触发消息」：
 *   `refMsgId` + `conversationId` **同时**给出时，先用 **reply** 把通知发到触发消息所在的会话链里
 *   （告警已读后仍可回溯）；reply 失败/被限频 → 落回原阶梯（info=自聊 / strong=DING→…）。
 *   只给 `refMsgId` 不给 `conversationId`：**不进入 reply 分支**（避免发错会话）。
 *
 * @param replyImpl 注入的 reply 实现（测试/定制用）；签名 `({conversationId,refMsgId,text,bin}) => {ok,ext_id,error}`
 * @returns {{ok, endpoint, effective_strength, downgraded, anchor, ref, attempts, dry_run}}
 */
export async function notify(store, {
  consumer, title, text, strength = 'info', needsDecision = false,
  at = null, bin, now = Date.now(), force = false, dryRun = null,
  refMsgId = null, conversationId = null, replyImpl = null,
  // ⚠️ 调用方常用的凭据名是 `ANCHOR_SELF_OPEN_ID`（服务生命周期契约只要求设 ANCHOR_*），
  //    hub 自己的 `DWS_HUB_SELF_OPEN_ID` 未必存在 —— 通道层必须能把 openId **传进来**，
  //    否则 strong 会被静默降级成待办（真实 DING 永远发不出）。
  openId,
} = {}) {
  const attempts = [];
  // critical = 真·紧急（线上故障）→ 电话 DING；strong = 重要但可稍后 → DING→待办；info = 自聊
  const desired = strength === 'critical' ? ['ding_call', 'todo', 'calendar', 'message']
    : strength === 'strong' ? ['ding', 'todo', 'calendar', 'message'] : ['message'];
  const dedupeKey = dedupeKeyOf(consumer, title);
  // 锚点号**先定**，才能写进通知正文（否则「事项号兜底识别」形同虚设 —— 引用识别失效时救不回来）
  const anchorId = needsDecision ? newAnchorId(store, now) : null;
  const marker = outboundMarker(consumer);
  const deadline = at || new Date(now + 2 * 3600e3).toISOString();
  const guide = anchorId ? `\n\n事项：${anchorId}\n👉 直接引用本条回复即可处理` : '';
  let body = `${marker}\n${title}${text ? `\n${text}` : ''}${guide}`;
  let sent = null;
  /** reply 成功时的目标（用于锚点 scope/context：结果挂在哪条会话链下） */
  let repliedTo = null;

  // ── ① reply 优先（仅 ref + conversation 同时具备）──
  if (refMsgId && conversationId) {
    const gate = rl.allow(store, 'message', { now });
    if (!gate.ok) {
      attempts.push({ endpoint: 'reply', skipped: gate.reason });
    } else {
      try {
        let res;
        if (isReal()) res = await (replyImpl || defaultReplyImpl)({ conversationId, refMsgId, text: body, bin });
        else if (replyImpl) res = await replyImpl({ conversationId, refMsgId, text: body, bin });   // 干跑下仍可注入判定
        else res = { ok: true, dry_run: true, ext_id: null };                                       // 干跑：绝不发真实请求
        if (res?.ok) {
          const isDry = !isReal() || !!res.dry_run;
          if (!isDry) rl.charge(store, 'message', { now });
          attempts.push({ endpoint: 'reply', ok: true, dry_run: isDry });
          sent = { endpoint: 'reply', ext_id: res.ext_id || null, dry_run: isDry, ext_id_unverified: false, send_task_id: null };
          repliedTo = { conversationId, refMsgId };
        } else {
          attempts.push({ endpoint: 'reply', ok: false, error: res?.error || 'reply_failed' });
        }
      } catch (e) {
        attempts.push({ endpoint: 'reply', ok: false, error: e?.message || String(e) });
      }
    }
  }

  // ── ② 原阶梯（reply 未成功时）──
  for (const ep of sent ? [] : desired) {
    // 同一告警窗口内只发一次（不区分调用方；force 也不绕过——避免「重试即刷屏」）
    if (isDuplicate(store, ep, dedupeKey, now)) { attempts.push({ endpoint: ep, skipped: 'duplicate' }); continue; }
    const gate = ep === 'ding' ? rl.allow(store, 'strong_push', { now, force })
      : ep === 'ding_call' ? rl.allow(store, 'call', { now, force })
      : ep === 'todo' ? rl.allow(store, 'todo', { now })
        : ep === 'calendar' ? rl.allow(store, 'calendar', { now })
          : rl.allow(store, 'message', { now });
    if (!gate.ok) { attempts.push({ endpoint: ep, skipped: gate.reason }); continue; }
    // 自聊消息要回读真实 messageId（`+dm` 返回的是发送任务 id，不是消息 id）→ 传 matchText
    const payload = {
      text: body, at: deadline, start: deadline,
      end: new Date(Date.parse(deadline) + 30 * 60e3).toISOString(), bin,
      matchText: anchorId || null,
      // 显式传入的自身 openDingTalkId（undefined → sendDing 回退 DWS_HUB_SELF_OPEN_ID）。
      // ⚠️ 只对 ding 级生效：todo/calendar/message 的实现只取各自参数，不读 openId（不污染）。
      openId,
    };
    const res = ep === 'ding' ? await sendDing(payload)
      : ep === 'ding_call' ? await sendDingCall({ text: body, bin, openId })
      : ep === 'todo' ? await sendTodo(payload)
        : ep === 'calendar' ? await sendCalendar(payload)
          : await sendSelfMessage(payload);
    attempts.push({ endpoint: ep, ok: res.ok, error: res.error, dry_run: res.dry_run });
    if (res.ok) {
      if (!res.dry_run) { rl.charge(store, ep === 'ding' ? 'strong_push' : ep === 'ding_call' ? 'call' : ep, { now }); markSeen(store, ep, dedupeKey, now); }
      sent = { endpoint: ep, ext_id: res.ext_id, dry_run: !!res.dry_run, ext_id_unverified: !!res.ext_id_unverified, send_task_id: res.send_task_id || null };
      break;
    }
  }

  let anchor = null;
  if (needsDecision) {
    anchor = createAnchor(store, {
      id: anchorId, consumer, strength, needs_decision: true, title,
      // reply 成功 → 结果落在**触发消息所在会话**（scope=conversation，context 记会话 id）；
      // 否则保持原语义（scope=self，回复入口是我自己的自聊/掉落点）。
      scope: repliedTo ? 'conversation' : 'self', ext_id: sent?.ext_id || `dry:${now}`,
      // 会话 id 双写：`ext_scope` 是 hub 层的渠道无关字段（落库、replyInChain 读它），
      // `context.sent_to` 是人类可读的上下文（对象，非 JSON 字符串 —— store 侧负责序列化）。
      ext_scope: repliedTo ? repliedTo.conversationId : null,
      context: repliedTo ? { sent_to: repliedTo.conversationId, ref_msg_id: repliedTo.refMsgId } : null,
      now,
    });
    // dws 层的渠道侧别名（`anchor.conversation_id`）——方便调用方直接用，不影响持久化字段
    if (anchor && repliedTo) anchor.conversation_id = repliedTo.conversationId;
  }
  const wantedStrong = strength === 'strong' || strength === 'critical';
  const wantedEndpoint = strength === 'critical' ? 'ding_call' : 'ding';
  const effective = sent ? (wantedStrong && sent.endpoint !== wantedEndpoint ? 'info' : strength) : 'none';
  const downgraded = !!sent && wantedStrong && sent.endpoint !== wantedEndpoint;

  // ── ③ 台账（每次调用**一行**：成功 / 降级 / 全失败都记；docs/design.md）──
  // ⚠️ 台账是**旁路**：写入（含 id 生成/序列化）必须整体包在 try/catch 里，
  //    台账 bug 不得打断 DING 主链路，更不能改变返回值。
  const dingAttempt = attempts.find((x) => x.endpoint === 'ding' || x.endpoint === 'ding_call');
  const gate = !wantedStrong ? null : (dingAttempt ? (dingAttempt.skipped || 'ok') : null);
  const firstError = attempts.find((x) => x.error)?.error || null;
  try {
    store?.dingLog?.insert({
      id: newDingLogId(now),
      ts: new Date(now).toISOString(),
      consumer: consumer ?? null,
      requested_strength: strength,
      endpoint: sent?.endpoint || 'none',
      ok: !!sent,
      downgraded,
      gate,
      title: String(title ?? '').slice(0, 200),
      // 降级成功也保留「为什么没走 DING」（可解释性）；全失败记首个错误
      error: sent ? (downgraded ? firstError : null) : (firstError || 'no_endpoint_available'),
      anchor_id: anchor?.id || anchorId || null,
    });
  } catch (e) {
    console.warn(`[dws-hub notify] 台账写入失败（不影响发送）：${e?.message || e}`);
  }

  return {
    ok: !!sent, endpoint: sent?.endpoint || null, effective_strength: effective,
    downgraded, gate, anchor, ref: sent?.ext_id || null, attempts, body, dry_run: !!sent?.dry_run,
    // ⚠️ true = 回读不到消息 id（锚点只能靠正文里的**事项号**兜底识别，引用识别不可用）
    anchor_ext_unverified: !!sent?.ext_id_unverified || (!!anchor && !sent?.ext_id && !sent?.dry_run),
  };
}

/** 台账行 id：`ding-<compact ts>-<rand>`（docs/design.md）。 */
function newDingLogId(now) {
  const ts = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `ding-${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 在同一锚点链下引用回复（追问/结论）—— 顺带完成表情状态切换（ing → done，docs/design.md）。 */
/**
 * 选择「结果要挂在哪条消息下」的引用目标。
 * ⚠️ **合成事件 id 不能作为引用目标**（`<msgId>#rx:<emoji>:<user>` 不是真实消息 id，
 *    直接传给 `--ref-msg-id` 会失败）—— 表情回应输入的锚点要退回引用**锚点消息本身**（实测踩到）。
 */
export function replyTarget(anchor, refExtId = null) {
  if (refExtId) return refExtId;
  const inbound = lastInbound(anchor);
  const realInbound = inbound && !String(inbound.extId || '').includes('#rx:') ? inbound.extId : null;
  return realInbound || anchor?.ext_id || null;
}

export async function replyInChain(store, { anchorId, refExtId, text, bin } = {}) {
  const anchor = anchorId ? store.anchors.byId(anchorId) : null;
  const marker = outboundMarker(anchor?.consumer);
  const body = `${marker}\n${text}`;
  // 就近成链：默认引用**最近一条入站回复**（结果挂在用户那条话下面），否则退回引用锚点消息
  const target = refExtId || replyTarget(anchor);
  let res;
  if (!isReal()) res = { ok: true, dry_run: true, ext_id: null };
  else {
    // L1 原语（dws/send.mjs）——发送姿势的唯一实现：reply **不传 at、正文不写 @**（接口自动 @ 被回复人）
    const cid = anchor?.ext_scope || anchor?.conversation_id || anchor?.ext_conversation_id || anchor?.context?.sent_to || '';
    const r = await sendReply(cid, target, body, { bin });
    // dws 返回的 id 有时在顶层、有时在 `data` 里（历史实测两种都出现过）→ 两处都认
    res = { ok: r.ok !== false, ext_id: r.data?.messageId || r.data?.data?.messageId || r.ext_id || null, raw: r.data };
  }
  if (res.ok && anchorId && anchor) {
    recordOutbound(store, anchorId, { ext_id: res.ext_id, text: body, at: new Date().toISOString() });
    transition(store, anchorId, 'acting');
    // ③ 完成：贴过 ing → 撤 ing + 贴 done；**短任务**（没贴过 ing）→ 两个都不贴（用户 2026-10-16 口径）
    const em = anchor.emoji || {};
    if (em.ing) {
      await removeEmoji({ conversationId: em.ing.conversationId, msgId: em.ing.msgId, emoji: EMOJI.ing, bin });
      await addEmoji({ conversationId: em.ack.conversationId, msgId: em.ack.msgId, emoji: EMOJI.done, bin });
      setEmoji(store, anchorId, { done: { msgId: em.ack.msgId, at: new Date().toISOString() }, ing: null });
      res.emoji = 'ing→done';
    } else {
      res.emoji = 'skipped_short_task';
    }
  }
  return res;
}
