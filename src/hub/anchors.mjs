/**
 * dws-hub · hub 层（渠道无关）—— 锚点（回复链）语义
 *
 * 设计：docs/design.md（锚点识别）/ docs/design.md（状态机）
 *
 * 锚点 = 「一件需要我关注的事」的对话入口：通知发出去 → 我引用它回复 → 认得出属于哪件事。
 * 识别优先级：① 引用（`reply_to` 命中锚点的 `ext_id`）② 文本含事项号 ③ 识别不出就**不猜**。
 *
 * 本层只认「事件 / 锚点」这些渠道无关概念；怎么拉、怎么发由 ../dws/ 负责。
 */

/** 事项号形态：`anchor-YYYY-MM-DD-NNN`（人类可读、可手写、可正则兜底）。捕获组 1 = 完整事项号。 */
export const ANCHOR_RE = /(anchor-\d{4}-\d{2}-\d{2}-\d{3})/;

/** 时区偏移（默认 +08:00，钉钉场景）；影响事项号里的日期。 */
const TZ_OFFSET_H = Number(process.env.DWS_HUB_TZ_OFFSET_H ?? 8);

export function localDay(now = Date.now()) {
  return new Date(now + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
}

export function newAnchorId(store, now = Date.now()) {
  const day = localDay(now);
  const seq = store.anchors.nextSeq(day);
  return `anchor-${day}-${String(seq).padStart(3, '0')}`;
}

/**
 * 建锚点（由 notify 在「发出需要回复的通知」后调用）。
 * @param ext_scope 锚点所在会话的渠道侧标识（可空；非会话场景为 null，不污染 self 语义）
 * @returns 落库后的锚点对象
 */
export function createAnchor(store, { id, consumer, strength = 'info', needs_decision = true, title, scope, ext_id, ext_scope = null, context = null, now = Date.now() }) {
  const iso = new Date(now).toISOString();
  return store.anchors.insert({
    id: id || newAnchorId(store, now),
    created_at: iso, updated_at: iso,
    consumer, strength, needs_decision: !!needs_decision, title,
    status: 'open', scope, ext_id, ext_scope, confirmed: false, context, replies: [],
  });
}

/**
 * 判断一条入站事件是否在回复某个锚点。
 * @returns {{anchor: object, via: 'quote'|'id'}|null} —— null = 识别不出（**不猜**）
 */
export function matchReply(store, event) {
  if (!event || event.outbound) return null;                 // 自己发出的消息永不当作「人的回复」
  if (event.reply_to) {
    const a = store.anchors.byExtId(event.reply_to);
    if (a) return { anchor: a, via: 'quote' };
  }
  const m = ANCHOR_RE.exec(event.text || '');
  if (m) {
    const a = store.anchors.byId(m[1]);
    if (a) return { anchor: a, via: 'id' };
  }
  return null;
}

/** 记录一条入站回复：`open/answered → answered`；`acting` 保持 acting；`expired → acting`（迟到的回复仍认）。
 *  **幂等**：同一条消息（`ext_id`）只记一次 —— 否则每轮 tick 重扫都会重复归档（实测踩到）。 */
export function recordReply(store, anchor, event, now = Date.now()) {
  if ((anchor.replies || []).some((r) => r.direction === 'in' && r.extId === event.ext_id)) return anchor;
  const replies = [...(anchor.replies || []), {
    extId: event.ext_id, direction: 'in', text: event.text ?? '', at: event.at || new Date(now).toISOString(),
  }];
  const status = { open: 'answered', answered: 'answered', acting: 'acting', expired: 'acting', closed: 'closed' }[anchor.status] || 'answered';
  return store.anchors.update(anchor.id, { replies, status });
}

/** 表情状态（docs/design.md）：合并写入 `emoji` 字段（`{ack,ing,done}` 各自的 msgId/at）。 */
export function setEmoji(store, anchorId, patch) {
  const a = store.anchors.byId(anchorId);
  if (!a) return null;
  return store.anchors.update(anchorId, { emoji: { ...(a.emoji || {}), ...patch } });
}

/** 最近一条入站回复（用于就近成链 + 贴状态表情）。 */
export function lastInbound(anchor) {
  const ins = (anchor.replies || []).filter((r) => r.direction === 'in');
  return ins.length ? ins[ins.length - 1] : null;
}

/** 记录一条出站（我方在同一锚点链下的追问/结论）。 */
export function recordOutbound(store, anchorId, { ext_id, text, at = new Date().toISOString() }) {
  const a = store.anchors.byId(anchorId);
  if (!a) return null;
  return store.anchors.update(anchorId, { replies: [...(a.replies || []), { extId: ext_id, direction: 'out', text, at }] });
}

export function transition(store, anchorId, status) {
  return store.anchors.update(anchorId, { status });
}

export function markConfirmed(store, anchorId) {
  return store.anchors.update(anchorId, { confirmed: true });
}

/**
 * 需要提醒 / 需要归档的锚点（docs/design.md + 边界 B5）。
 * @param remindAfterMs 多久没回复提醒一次（默认 24h，只提醒一次）
 * @param expireAfterMs 多久归档为 expired（默认 72h）
 */
export function dueAnchors(store, { now = Date.now(), remindAfterMs = 24 * 3600e3, expireAfterMs = 72 * 3600e3 } = {}) {
  const toRemind = [], toExpire = [];
  for (const a of store.anchors.byStatus('open')) {
    const age = now - Date.parse(a.created_at);
    const last = a.replies?.length ? Date.parse(a.replies[a.replies.length - 1].at) : Date.parse(a.created_at);
    if (age >= expireAfterMs) toExpire.push(a);
    else if (now - last >= remindAfterMs && !store.kv.get('anchors', `reminded:${a.id}`, false)) toRemind.push(a);
  }
  return { toRemind, toExpire };
}

export function markReminded(store, anchorId) {
  store.kv.set('anchors', `reminded:${anchorId}`, true);
}

export function markExpired(store, anchorId) {
  const a = store.anchors.byId(anchorId);
  if (!a) return null;
  return store.anchors.update(anchorId, {
    status: 'expired',
    replies: [...(a.replies || []), { extId: null, direction: 'sys', text: '72h 无回复，自动归档（未处理）', at: new Date().toISOString() }],
  });
}

/** 渲染锚点通知正文（含事项号，便于人工引用与追溯）。 */
export function renderAnchorText(anchor, body, { marker = '' } = {}) {
  const head = marker ? `${marker}\n` : '';
  return `${head}${body}\n\n事项：${anchor.id}\n👉 直接引用本条回复即可处理`;
}
