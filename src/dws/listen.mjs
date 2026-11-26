/**
 * dws-hub · dws 适配层 —— 三通道监听
 *
 * 通道分工 + 运行时自检见 docs/design.md
 *
 * ══ 三通道分工（实证决定，不靠猜）══
 * | 通道   | 触发            | 数据来源                        | 权威性 | 实证 |
 * | stream | 钉钉事件推送    | 只当**闹钟**（有新消息 → 立刻 poll） | 非权威 | 他人单聊 ✅ 收到；群 ⚠️ 未证实 |
 * | poll   | tick（60s）     | `+chat-messages`                | **权威** | 生产在用 |
 * | self   | tick（60s）     | `+messages-list-direct --user 我` | **权威** | 自聊消息被 self-loop 过滤，事件流收不到 |
 *
 * ══ 自聊的判据（关键）══
 * 自聊里所有消息的发送者都是我 → **无法靠 sender 区分**「我本人的回复」与「本能力发出的通知」，
 * 只能靠**出站标记**（docs/design.md）：带标记 = 本能力发出（outbound），不带 = 我本人的话（入站事件）。
 */
import { dwsJson, dwsStream, isMachineText } from './dws.mjs';
import { EMOJI } from './emoji.mjs';
import { atMe as queryAtMe } from './query.mjs';

export const SELF_SCOPE = 'self';

/** scope（渠道无关）→ dws 目标参数。 */
/** 看起来像 openDingTalkId（字母开头、>=16 位、非纯数字）——dws 的 `--user` 只收 userId。 */
export function looksLikeOpenId(id) {
  const s = String(id || '');
  return /^[A-Za-z]/.test(s) && s.length >= 16 && !/^\d+$/.test(s);
}

export function scopeSpec(scope) {
  if (scope === SELF_SCOPE) return { kind: 'self' };
  const [kind, ...rest] = String(scope).split(':');
  const id = rest.join(':');
  if (kind === 'group') return { kind: 'group', id, args: ['--group', id] };
  if (kind === 'direct') {
    return { kind: 'direct', id, args: [looksLikeOpenId(id) ? '--open-dingtalk-id' : '--user', id] };
  }
  return { kind: 'unknown', id };
}

/** 轮询失败重试（默认 3 次）：可用参数或环境变量覆盖（测试用 0 延迟）。 */
function pollRetryOpts(o = {}) {
  const attempts = Math.max(1, Number(o.attempts ?? process.env.DWS_HUB_POLL_ATTEMPTS ?? 3));
  const delayMs = Math.max(0, Number(o.retryDelayMs ?? process.env.DWS_HUB_POLL_RETRY_MS ?? 250));
  return { attempts, delayMs };
}

/**
 * 对「未完成/失败」的轮询做有界重试。
 *
 * 为什么需要（2026-10-21 实测）：钉钉某个边缘 IP（59.82.23.104）约 8–17% 的握手返回
 * **Kubernetes Ingress Controller Fake Certificate**（自签）→ Go 客户端报
 * `x509: certificate signed by unknown authority`；下一分钟重试通常就正常。
 * 不重试的表现 = 该 scope `complete=false` → 水位不推进 → 消息延迟一个 tick（不丢，但抖动）。
 * 这里做 2–3 次短重试（指数退避 + 抖动），把「偶发坏 IP」消掉。
 *
 * 边界：只重试「未完成」；`missing_self_user` / `bad_scope` 这类**确定性错误不重试**。
 */
async function withPollRetry(run, { attempts, delayMs }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (last.complete) return last;
    if (last.error === 'missing_self_user' || last.error === 'bad_scope') return last;
    if (i + 1 < attempts) {
      const wait = delayMs * (i + 1) + Math.floor(Math.random() * Math.max(1, delayMs));
      console.warn(`[dws-hub] poll 未完成（${last.error || 'incomplete'}）→ ${wait}ms 后重试 ${i + 1}/${attempts - 1}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return last;
}

/**
 * 权威拉取某个 scope 的消息（不落库，供 pull / 探测复用）。
 * @returns {Promise<{events:Array, complete:boolean, error:string|null}>}
 */
export async function pollScope(o = {}) {
  const { scope, sinceIso, endIso, bin, selfUser = null } = o;
  const spec = scopeSpec(scope);
  if (spec.kind === 'self') {
    const user = selfUser || process.env.DWS_HUB_SELF_USER;
    if (!user) return { events: [], complete: false, error: 'missing_self_user' };
    return withPollRetry(async () => {
      const r = await dwsJson(['chat', '+messages-list-direct', '--user', user, '--time', sinceIso,
        '--forward', '--page-all', '--page-limit', '100', '--format', 'json'], { bin });
      const msgs = r.data?.messages || r.data?.data?.messages || [];
      const complete = r.ok && r.data?.complete === true && Array.isArray(msgs) && r.data?.truncated !== true;
      return {
        events: [...msgs.map((m) => normalizeMessage(m, { scope, source: 'self' })),
          ...msgs.flatMap((m) => extractReactionEvents(m, { scope, source: 'self' }))],
        complete,
        error: complete ? null : (r.data?.error?.message || r.data?.error?.type || (r.data?._raw ? `unparsable:${String(r.data._raw).slice(0, 80)}` : `incomplete(code=${r.code})`)),
      };
    }, pollRetryOpts(o));
  }
  if (!spec.args) return { events: [], complete: false, error: 'bad_scope' };
  return withPollRetry(async () => {
    const r = await dwsJson(['chat', '+chat-messages', ...spec.args, '--start', sinceIso, '--end', endIso,
      '--order', 'asc', '--page-all', '--page-limit', '100', '--format', 'json'], { bin });
    const msgs = r.data?.messages || [];
    const complete = r.ok && r.data?.complete === true && Array.isArray(msgs) && r.data?.truncated !== true;
    return {
      events: [...msgs.map((m) => normalizeMessage(m, { scope, source: 'poll' })),
        ...msgs.flatMap((m) => extractReactionEvents(m, { scope, source: 'poll' }))],
      complete,
      error: complete ? null : (r.data?.error?.message || r.data?.error?.type || (r.data?._raw ? `unparsable:${String(r.data._raw).slice(0, 80)}` : `incomplete(code=${r.code})`)),
    };
  }, pollRetryOpts(o));
}

/**
 * 文本里**独立出现**的 `@我`（前后是分隔符/边界）。
 * ⚠️ 真实 @我 在钉钉里通常渲染成昵称（`@王示例 …`），故这只是**保守兜底**；
 *    权威判据是 `+search-msg --at-me` 通道（{@link pullAtMe}）或消息自带标记。
 *    `@我们` 这类不以「我」结尾的词不算。
 */
const MENTION_ME_TEXT_RE = /(^|[\s，,。.：:；;!?！？、])@我(?=$|[\s，,。.：:；;!?！？、）)])/;

/**
 * 消息是否 @我（消息自带标记优先，其次保守文本兜底）。
 *
 * ⚠️ `shouldDeliver` 要求 `event.meta.mentionMe === true`，而这个字段**必须由生产者写入**——
 *    本函数就是「dws 消息 → mentionMe」的唯一判定处；漏了它，`atme` 订阅会静默收不到任何事件。
 */
export function isMentionMeMessage(m, text = '') {
  if (!m || typeof m !== 'object') return false;
  for (const k of ['isAtMe', 'atMe', 'mentionMe', 'mentionedMe', 'isMentioned']) {
    const v = m[k];
    if (v === true || (typeof v === 'string' && /^(true|1|yes)$/i.test(v))) return true;
  }
  for (const k of ['atMeList', 'atMeUserIds', 'mentionMeList', 'mentionedMeList']) {
    if (Array.isArray(m[k]) && m[k].length > 0) return true;
  }
  return MENTION_ME_TEXT_RE.test(String(text ?? m.text ?? m.content ?? ''));
}

/** dws 消息 → 渠道无关事件。 */
export function normalizeMessage(m, { scope, source, machineExtra = [], mentionMe } = {}) {
  const text = m.text ?? m.content ?? '';
  const quoted = m.quotedMessage || m.quote || null;
  const mentioned = mentionMe === true || (mentionMe !== false && isMentionMeMessage(m, text));
  const meta = {};
  if (m.conversationId) meta.conversation_id = m.conversationId;
  // ⚠️ 身份与「是否 API 自发」必须随事件带走（2026-11-10）：消费侧要靠 meta.senderId 判受理名单、
  //    靠 meta.aiSendFlag 过滤自发回执；只带昵称（sender）会导致白名单全部 reject / 自激。
  const senderId = m.senderId || m.openDingTalkId || m.senderUserId || null;
  if (senderId) meta.senderId = String(senderId);
  if (m.messageAiSendFlag) meta.aiSendFlag = String(m.messageAiSendFlag);
  if (mentioned) meta.mentionMe = true;
  return {
    ext_id: m.messageId || m.message_id || m.msgId,
    scope,
    sender: m.sender ?? m.senderName ?? null,
    text,
    at: toIso(m.createTime || m.create_time || m.timestamp),
    source,
    reply_to: quoted?.messageId || quoted?.message_id || null,
    outbound: isMachineText(text, { extra: machineExtra }),
    meta: Object.keys(meta).length ? meta : null,
  };
}

/**
 * **表情回应的意图映射**（docs/design.md 输入路径②）
 *
 * 用户 2026-10-16 指出：「我回了个表情（好像漏了这个路径？！）」——确实漏了：
 * 除了「引用回复」，**对消息贴表情**同样是有效输入（实测 `+chat-messages`/`+messages-list-direct`
 * 默认就返回 `reactions: {counts, details:[{emoji,replyUsers}]}`）。
 */
export const REACTION_INTENT = {
  OK: 'ack', 收到: 'ack', 点赞: 'ack', 赞: 'ack',
  Done: 'approve', 打叉: 'reject', 拒绝: 'reject',
};

export function reactionIntent(emoji) {
  return REACTION_INTENT[emoji] || 'other';
}

/** 我们自己贴的**状态表情**（不是人的输入 → 抽取时必须跳过，否则自我回环）。 */
function isOurStateEmoji(name) {
  return [EMOJI.ack, EMOJI.ing, EMOJI.done].includes(name);
}

/**
 * 把「消息上的表情回应」抽成**入站事件**（相当于一条回复）。
 * - `ext_id` 合成且稳定：`<msgId>#rx:<emoji>:<user>`（天然去重）
 * - `reply_to` = 被回应消息的 id ⇒ **复用锚点的引用匹配**（表情贴在锚点消息上即命中）
 * - `outbound: false` = 这是**人的输入**（即使被回应的那条消息是我们发的机器消息）
 */
export function extractReactionEvents(m, { scope, source = 'poll' } = {}) {
  const details = (m?.reactions?.details) || [];
  const out = [];
  for (const d of details) {
    const emoji = d?.emoji;
    if (!emoji || isOurStateEmoji(emoji)) continue;
    for (const user of (d.replyUsers || [])) {
      out.push({
        ext_id: `${m.messageId}#rx:${emoji}:${user}`,
        scope,
        sender: user,
        text: `[表情] ${emoji}`,
        at: toIso(m.createTime || m.create_time),
        source,
        reply_to: m.messageId,
        outbound: false,
        meta: {
          conversation_id: m.conversationId || null,
          reaction: emoji,
          intent: reactionIntent(emoji),
          on_message: m.messageId,
        },
      });
    }
  }
  return out;
}

/** 宽松时间归一：毫秒数 / ISO / `YYYY-MM-DD HH:mm:ss`（+08:00 语义）。 */export function toIso(v) {
  if (!v) return new Date().toISOString();
  if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const iso = s.length === 16 ? `${s}:00` : s;
    return new Date(`${iso.replace(' ', 'T')}+08:00`).toISOString();
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? new Date().toISOString() : new Date(d).toISOString();
}

/**
 * 拉取多个 scope 的增量并**幂等落库**（`ext_id` 主键去重）。
 * ⚠️ 任一 scope `complete=false` → 不改该 scope 的水位（由调用方决定窗口推进），避免漏数据。
 */
export async function pullScopes(store, { scopes, sinceIso, endIso, bin, selfUser = null } = {}) {
  const report = { inserted: 0, seen: 0, per: {}, incomplete: [], insertedEvents: [] };
  for (const scope of scopes) {
    const { events, complete, error } = await pollScope({ scope, sinceIso, endIso, bin, selfUser });
    let ins = 0;
    for (const e of events) {
      if (!e.ext_id) continue;
      if (store.events.insert(e)) { ins += 1; report.insertedEvents.push(e); }
    }
    report.seen += events.length;
    report.inserted += ins;
    report.per[scope] = { seen: events.length, inserted: ins, complete, error: error || null };
    if (!complete) report.incomplete.push(scope);
  }
  return report;
}

/**
 * **表情回看**（2026-10-16 实测补的关键路径）：
 *
 * 增量轮询只拉「水位之后的新消息」——但**表情是贴在对旧消息上的**（人看到消息后才贴），
 * 那条消息早已出了窗口 ⇒ 表情永远读不到（实测：用户给 1 分钟前那条贴 OK，服务毫无反应）。
 * 故每轮额外**回看最近 N 分钟的消息**，只抽其中的**表情事件**（消息本身靠增量轮询，不重复处理）。
 * 幂等靠合成 id（`<msgId>#rx:<emoji>:<user>`）主键去重 ⇒ 反复回看不会重复。
 */
export async function pullReactions(store, { scopes, lookbackMs = Number(process.env.DWS_HUB_REACTION_LOOKBACK_MIN || 30) * 60e3, bin, selfUser = null, now = Date.now() } = {}) {
  const report = { scanned: 0, inserted: 0, insertedEvents: [] };
  const since = new Date(now - lookbackMs).toISOString();
  const end = new Date(now).toISOString();
  for (const scope of scopes) {
    const { events } = await pollScope({ scope, sinceIso: since, endIso: end, bin, selfUser });
    const rx = events.filter((e) => e.meta?.reaction);
    report.scanned += rx.length;
    for (const e of rx) {
      if (store.events.insert(e)) { report.inserted += 1; report.insertedEvents.push(e); }
    }
  }
  return report;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * `atme` 选择器的权威轮询（docs/design.md）
 *
 * `atme` **不是 scope**：@我 横跨群聊与单聊，没有单一会话 id 可传给 `+chat-messages`。
 * 故它走 `chat +search-msg --at-me`（{@link queryAtMe}）→ 归一成**真实会话 scope** 的事件，
 * 并显式写 `meta.mentionMe = true`（分派侧只认这个字段）。
 *
 * ⚠️ 不推进任何 scope 水位：atme 是「跨会话视图」，水位仍由各 scope 轮询负责；
 *    重复读靠 `hub_events.ext_id` 主键去重（同一条消息不会被派发两次）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 默认搜索窗（天）：显式传 `--days`，不依赖 CLI 默认漂移；hub 策略上限 30。 */
export function atMeDays(v = process.env.DWS_HUB_ATME_DAYS ?? 7) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(30, Math.max(1, Math.trunc(n))) : 7;
}

/** atme 游标命名空间（**与 scope 水位 `poll` 完全隔离**：atme 绝不推进 scope 水位）。 */
export const ATME_NS = 'atme';
export const ATME_MAX_DAYS = 30;
/** 无游标时的首跑回看（天）：与 scope 轮询的 24h 口径对齐（不是 `atMe` 的 CLI 默认 7 天）。 */
export const ATME_DEFAULT_LOOKBACK_DAYS = 1;

/** 消费者声明的 `atme` 选择器（`domains.scopes` 优先，回落 `targets`）。 */
export function atmeTargetsOf(consumer) {
  const scopes = consumer?.domains?.scopes ?? consumer?.targets ?? [];
  return (Array.isArray(scopes) ? scopes : [])
    .filter((t) => typeof t === 'string' && (t === 'atme:*' || t.startsWith('atme:chat:') || t.startsWith('atme:user:')));
}

/** 某消费者的 atme 游标（ISO；`null` = 从未成功拉取过）。 */
export function atmeCursor(store, name) {
  return store.kv.get(ATME_NS, `cursor:${name}`, null);
}

export function setAtmeCursor(store, name, iso) {
  return store.kv.set(ATME_NS, `cursor:${name}`, iso);
}

/**
 * 搜索窗（天）= 「游标 → now」的跨度（向上取整），clamp 到 **1..30**。
 * 无游标（首跑）→ 默认回看 {@link ATME_DEFAULT_LOOKBACK_DAYS} 天。
 * ⚠️ 必须是**整数**且 ≥1：`query.atMe` 对 `days` 做 1..30 整数校验，传 0/小数 = 参数错误（整通道静默失效）。
 */
export function atmeDaysFor({ now = Date.now(), cursor = null, windowSec = 60 } = {}) {
  const fromWindow = Math.ceil((Number(windowSec) || 0) / 86400);
  const base = Math.min(ATME_MAX_DAYS, Math.max(1, fromWindow || ATME_DEFAULT_LOOKBACK_DAYS));
  if (!cursor) return base;
  const ms = now - Date.parse(cursor);
  if (!Number.isFinite(ms)) return base;
  return Math.min(ATME_MAX_DAYS, Math.max(1, Math.ceil(ms / 86400e3)));
}

/** `atme` 选择器 → `query.atMe` 收窄入参（chat / user / 全量，三者互斥）。 */
export function atmeQueryOf(target) {
  if (target === 'atme:*') return {};
  if (typeof target !== 'string') return null;
  if (target.startsWith('atme:chat:')) {
    const chatId = target.slice('atme:chat:'.length);
    return chatId ? { chatId } : null;
  }
  if (target.startsWith('atme:user:')) {
    const uid = target.slice('atme:user:'.length);
    return uid ? { senders: [uid] } : null;
  }
  return null;
}

/**
 * @我 事件的**真实会话 scope**（`group:<cid>` / `direct:<uid>`）。
 * `+search-msg` 不返回会话类型：已知 `singleChat` 时按它分派，否则默认群 scope
 * （`atme` 选择器只看 `mentionMe`，scope 前缀不参与投递判定）。
 * 无法映射到任何真实会话（系统通知等）→ `null`，调用方**丢弃并记 report**（不猜 direct 投错会话）。
 */
export function atMeScope(m = {}) {
  if (m.singleChat === true) {
    const uid = m.senderId || m.sender || '';
    return uid ? `direct:${uid}` : null;
  }
  const cid = m.openConversationId || m.conversationId || '';
  return cid ? `group:${cid}` : null;
}

/** @我 事件的会话 id（写入 `meta.conversationId`：群 = cid，单聊 = 会话 id 优先、否则 uid）。 */
function atMeConversationId(m = {}) {
  if (m.singleChat === true) return m.conversationId || m.senderId || m.sender || null;
  return m.openConversationId || m.conversationId || null;
}

/**
 * 消费者 → atme 拉取规格（每个消费者独立游标 / 独立 days）。
 * 同一消费者同时声明 `atme:chat:` 与 `atme:user:`（或同种多个 id）→ 收窄条件冲突，
 * 记 **配置错**并跳过该消费者（不替用户猜，避免把两条收窄拍到一次 `+search-msg` 上）。
 */
function atmeSpecsOf(store, consumers, { now, windowSec, days }) {
  const specs = [];
  const per = {};
  for (const c of consumers) {
    const sels = atmeTargetsOf(c);
    if (!sels.length) continue;
    const chats = [...new Set(sels.filter((t) => t.startsWith('atme:chat:')).map((t) => t.slice('atme:chat:'.length)))];
    const users = [...new Set(sels.filter((t) => t.startsWith('atme:user:')).map((t) => t.slice('atme:user:'.length)))];
    if ((chats.length && users.length) || chats.length > 1 || users.length > 1) {
      per[c.name] = {
        targets: sels, complete: false, cursor: atmeCursor(store, c.name),
        error: 'atme_selector_conflict（chat / user 收窄互斥，请拆成两个消费者或只保留一个）',
      };
      continue;
    }
    const cursor = atmeCursor(store, c.name);
    const d = days ?? atmeDaysFor({ now, cursor, windowSec });
    // selector 求值优先级（docs/design.md）：chat 收窄 > user 收窄 > 全量。
    // 同一消费者既写 `atme:*` 又写收窄时，只按收窄拉（否则同一批消息会被拉两次、白烧限频）。
    const effective = chats.length === 1
      ? [`atme:chat:${chats[0]}`]
      : (users.length === 1 ? [`atme:user:${users[0]}`] : sels);
    specs.push({ name: c.name, targets: effective, cursor, days: d });
  }
  return { specs, per };
}

/**
 * 拉取 @我 的增量并幂等落库（**不推进 scope 水位**）。
 *
 * 每个 `atme` 消费者按**自己的游标**（`kv: ns=atme, key=cursor:<name>`）计算搜索窗；
 * 重复读靠 `hub_events.ext_id` 主键去重。已存在的事件（poll / scan 先入库、没有 mentionMe）
 * 会被**补标记** —— 否则 `shouldDeliver` 永远看不到 `mentionMe=true`，`atme` 消费者会静默饿死。
 *
 * 完整性门禁：某次拉取 `complete=false` 或抛错 → **不推进**该批消费者的 atme 游标（下轮重拉，幂等不丢），
 * 失败只记 `report.per`，不阻塞其它通道与其它目标。
 *
 * @param {object} o
 * @param {object[]} [o.consumers] 消费者列表（缺省 = `store.consumers.all()`）
 * @param {string[]} [o.targets] 仅指定选择器（无消费者场景的兼容用法；不维护游标）
 * @param {number} [o.days] 固定搜索窗（覆盖游标换算）
 * @param {number} [o.windowSec] tick 窗口（换算首跑 days）
 * @returns {{consumers:number, targets:string[], scanned:number, inserted:number, updated:number,
 *            dropped:number, insertedEvents:Array, incomplete:string[], failed:Array, per:object}}
 */
export async function pullAtMe(store, { consumers = null, targets = null, days, bin, now = Date.now(), windowSec = 60 } = {}) {
  const report = {
    consumers: 0, targets: [], scanned: 0, inserted: 0, updated: 0, dropped: 0,
    insertedEvents: [], incomplete: [], failed: [], per: {},
  };

  // 两种调用姿势：按消费者（常态，带游标）或按选择器（兼容/查询式，无游标）
  let specs = [];
  let targetDays = new Map();          // target → days（多消费者共享同一 target 时取最大窗）
  if (Array.isArray(consumers)) {
    const built = atmeSpecsOf(store, consumers, { now, windowSec, days });
    specs = built.specs;
    report.per = built.per;
    for (const s of specs) for (const t of s.targets) targetDays.set(t, Math.max(targetDays.get(t) || 1, s.days));
  } else {
    for (const t of [...new Set(targets || [])]) targetDays.set(t, days ?? atMeDays());
  }
  report.consumers = specs.length;
  report.targets = [...targetDays.keys()];
  if (!report.targets.length) return report;

  const seen = new Set();
  const targetsReport = {};
  for (const [target, tDays] of targetDays) {
    const narrow = atmeQueryOf(target);
    if (!narrow) {
      targetsReport[target] = { skipped: 'unknown_selector' };
      continue;
    }
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop —— 目标通常只有 1~2 个；串行避免触发钉钉限频
      r = await queryAtMe({ days: tDays, ...narrow, bin });
    } catch (e) {
      targetsReport[target] = { days: tDays, error: String(e?.message || e), code: e?.code ?? null, complete: false };
      report.incomplete.push(target);
      report.failed.push({ target, code: e?.code ?? null, error: String(e?.message || e) });
      continue;
    }
    const events = [];
    let dropped = 0;
    for (const m of (r.messages || [])) {
      const scope = atMeScope(m);
      if (!scope) { dropped += 1; continue; }                     // 无真实会话 → 丢弃（不投错会话）
      const e = normalizeMessage(m, { scope, source: 'atme', mentionMe: true });
      const convId = atMeConversationId(m);
      if (convId) e.meta = { ...(e.meta || {}), conversationId: convId };
      if (!e.ext_id || seen.has(e.ext_id)) continue;
      seen.add(e.ext_id);
      events.push(e);
    }
    let inserted = 0;
    let updated = 0;
    for (const e of events) {
      if (store.events.insert(e)) {
        inserted += 1;
        report.insertedEvents.push(e);
        continue;
      }
      // 已被别的通道先入库 → 只补 mentionMe（不改 scope/sender/text，保持原事件口径）
      const cur = store.events.byExtId(e.ext_id);
      if (cur && cur.meta?.mentionMe !== true) {
        store.events.setMeta(e.ext_id, { mentionMe: true });
        updated += 1;
      }
    }
    report.scanned += events.length;
    report.inserted += inserted;
    report.updated += updated;
    report.dropped += dropped;
    targetsReport[target] = { days: tDays, scanned: events.length, inserted, updated, dropped, complete: r.complete ?? null };
    if (r.complete === false) report.incomplete.push(target);
  }

  // 消费者视图：聚合它声明的选择器，并在**全部完整**时才推进自己的 atme 游标
  const nowIso = new Date(now).toISOString();
  for (const s of specs) {
    const parts = s.targets.map((t) => [t, targetsReport[t]]);
    const failed = parts.filter(([, p]) => p?.error);
    const incomplete = parts.filter(([, p]) => p && p.complete === false);
    const complete = failed.length === 0 && incomplete.length === 0;
    const sum = (k) => parts.reduce((n, [, p]) => n + (Number(p?.[k]) || 0), 0);
    report.per[s.name] = {
      days: s.days,
      targets: s.targets,
      scanned: sum('scanned'),
      inserted: sum('inserted'),
      updated: sum('updated'),
      dropped: sum('dropped'),
      complete,
      error: failed.length ? failed.map(([t, p]) => `${t}: ${p.error}`).join('; ') : null,
      cursor: complete ? nowIso : s.cursor,
      ...(complete ? {} : { cursor_stuck: s.cursor }),
    };
    if (complete) setAtmeCursor(store, s.name, nowIso);
  }
  report.now = nowIso;
  return report;
}

/**
 * **按 id 批量重读消息**（`+messages-mget`，≤50 条/次；**默认主动补查 Reaction**）。
 *
 * 为什么需要它（2026-10-16 用户点破）：**水位只认「新消息」，看不见「旧消息的状态变化」**——
 * 人可能过很久才看消息、才贴表情；撤回/编辑同理。⇒ 对**我们知道的那几条消息**按 id 重读，
 * 比猜时间窗可靠得多（用户原话：「不是最后一分钟，而是最后几条……很多时候不会很快查看消息」）。
 */
export async function mgetMessages({ msgIds = [], bin, scope = 'self' } = {}) {
  const ids = [...new Set(msgIds.filter(Boolean))].slice(-50);
  if (ids.length === 0) return [];
  const r = await dwsJson(['chat', '+messages-mget', '--msg-ids', ids.join(','), '--format', 'json'], { bin });
  const msgs = r.data?.messages || [];
  return msgs.map((m) => ({
    messageId: m.messageId,
    at: toIso(m.createTime || m.create_time),
    text: m.text ?? m.content ?? '',
    reactions: extractReactionEvents(m, { scope, source: 'watch' }),
    // ⚠️ 撤回后该消息会从回读结果里消失（后续可据此判「撤回」）；编辑会改 text（后续可 diff）
    present: true,
  }));
}

/** 长连接：把 scope 编译成 `dws event +listen-im` 参数（`self` 无事件通道 → 返回 null，走轮询）。 */
export function streamArgsFor(scope, extra = []) {
  const spec = scopeSpec(scope);
  if (spec.kind === 'self') return null;                       // 自聊消息不走事件流
  if (spec.kind === 'group') {
    // ⚠️ dws 区分两个参数：**`--chat-id` 收稳定 ID**、`--chat-query` 收**群名**。
    //    把 openConversationId 传给 `--chat-query` ⇒ 流**起来就退**（打印
    //    「请使用当前命令的稳定 ID 参数」）—— 2026-10-16 实测钉死（服务侧流一直 streaming=false 的根因）。
    const isId = /^cid/i.test(String(spec.id));
    return ['event', '+listen-im', '--kind', 'group', isId ? '--chat-id' : '--chat-query', spec.id, ...extra];
  }
  if (spec.kind === 'direct') {
    return ['event', '+listen-im', '--kind', 'sender', looksLikeOpenId(spec.id) ? '--open-dingtalk-id' : '--user', spec.id, ...extra];
  }
  return null;
}

/**
 * 一次性**有界**长连接（禁止 `--duration 0`，坑 4）。
 * stream 只当闹钟：收到事件即回调（调用方立刻触发一次权威 poll）。
 */
export function boundedStream({ scopes, durationSec = 1500, onEvent, onLifecycle, bin } = {}) {
  const args = [];
  const targets = [];
  for (const scope of scopes) {
    const a = streamArgsFor(scope);
    if (a) targets.push({ scope, kind: scopeSpec(scope).kind });
  }
  if (targets.length === 0) return { skip: true, reason: 'no_streamable_scope', kill: () => {}, done: Promise.resolve({ code: 0 }) };
  // dws `+listen-im` 一次只接一个目标 → 多目标时串行起多个流
  const handles = [];
  for (const t of targets) {
    args.length = 0;
    args.push(...streamArgsFor(t.scope, ['--duration', `${durationSec}s`, '-f', 'ndjson']));   // 单一来源
    const h = dwsStream(args, (evt) => {
      onEvent?.({
        scope: t.scope,
        ext_id: evt.message_id || evt.messageId,
        sender: evt.sender,
        text: evt.content || evt.text || '',
        at: toIso(evt.create_time || evt.timestamp),
        source: 'stream',
        outbound: isMachineText(evt.content || evt.text || ''),
      }, evt);
      onLifecycle?.(evt);
    }, { bin });
    handles.push(h);
  }
  return {
    kill: () => handles.forEach((h) => h.kill()),
    done: Promise.all(handles.map((h) => h.done)),
    count: handles.length,
  };
}

/**
 * **通道能力自检**（有界 stream + 同窗口权威对照）——
 * 有界探测该 scope 的事件通道，并与**同窗口权威消息数**对照：
 *   received>0        → 通道可用（强判据）
 *   received=0 且权威=0 → 无信号（弱，不判死）
 *   received=0 且权威>0 → 落差（通道不可靠的证据）
 * 也不需要人工蹲自然流量：真实流量一到，本轮对照即可判定。
 */
export async function probeCapability(store, { scope, windowSec = 60, bin, selfUser = null } = {}) {
  const spec = scopeSpec(scope);
  if (spec.kind === 'self') {
    return { scope, received: 0, authoritative: 0, connected: false, note: 'self 无事件通道' };
  }
  const end = new Date();
  const start = new Date(end.getTime() - windowSec * 1000);
  const iso = (d) => d.toISOString();
  let received = 0;
  const stream = boundedStream({
    scopes: [scope], durationSec: windowSec,
    onEvent: () => { received += 1; },
    bin,
  });
  const authoritative = (await pollScope({ scope, sinceIso: iso(start), endIso: iso(end), bin, selfUser })).events.length;
  await stream.done.catch(() => {});
  return { scope, received, authoritative, connected: received > 0 || true, windowSec };
}

/** ISO → dws 时间参数（本地时区 `yyyy-MM-dd HH:mm:ss`）。 */
export function fmtDwsTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * **scan 通道**：跨全部会话增量拉取（设计 docs/design.md）。
 * 一次调用覆盖所有群 + 单聊（含新入群），**不逐群轮询**。
 * @returns {{ok:boolean, events:Array, paging:{total:number,pages:number,hasMore:boolean,truncated:boolean}|null, error?:any}}
 */
export async function scanAll({ start, end, maxItems = 2000, bin, timeoutMs = 120_000 } = {}) {
  const args = ['chat', 'message', 'list-all',
    '--start', fmtDwsTime(start), '--end', fmtDwsTime(end),
    '--page-all', '--no-reactions', '--max-items', String(maxItems), '--format', 'json'];
  const r = await dwsJson(args, { bin, timeoutMs });
  if (!r.ok) return { ok: false, events: [], paging: null, error: r.data?.error || String(r.raw || '').slice(0, 300) };
  const d = r.data || {};
  const paging = d.paging || {};
  const groups = d.result?.conversationMessagesList || [];
  const events = [];
  for (const g of groups) {
    for (const m of (g.messages || [])) {
      const scope = m.singleChat
        ? `direct:${m.senderId || m.conversationId}`
        : `group:${m.openConversationId || m.conversationId}`;
      const e = normalizeMessage(m, { scope, source: 'scan' });
      e.meta = { ...(e.meta || {}), kind: m.singleChat ? 'direct' : 'group', title: m.conversationTitle || null };
      if (e.ext_id) events.push(e);
    }
  }
  return {
    ok: true,
    events,
    paging: {
      total: paging.total ?? events.length,
      pages: paging.pages ?? 0,
      hasMore: Boolean(paging.hasMore),
      truncated: Boolean(paging.truncated),
    },
  };
}
