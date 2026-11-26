/**
 * dws-hub —— 装配层：把 hub 层（渠道无关核心）与 dws 适配层拼成可运行的服务循环
 *
 * 设计：docs/design.md
 *  主流程 · 三通道 · 分派 · 通知阶梯 · 降级/恢复 · 限频 · 运行时自检
 *
 * ══ 一轮 tick 做什么 ══
 * ① poll：按各 scope 水位拉增量（**权威**）→ 幂等落库
 * ② anchor：入站事件尝试匹配锚点（引用 / 事项号）→ 记录回复、推进状态
 * ③ dispatch：逐消费者取「窗口已过」的事件合并一次回调（触发合并 = 写外部系统限流护栏）
 * ④ anchor 超时：24h 提醒一次 / 72h 归档
 * ⑤ ladder：degraded 态按节奏做恢复探测（强判据 + 防抖 → 自动回升）
 *
 * ══ stream 的角色 ══
 * 只当**闹钟**：收到事件 → 立刻触发一次 poll（缩短延迟），业务判定一律基于 poll 数据。
 */
import { openStore } from './hub/store.mjs';
import * as ladder from './hub/ladder.mjs';
import * as rl from './hub/ratelimit.mjs';
import { atmeTargets, dispatchOnce, shouldDeliver } from './hub/dispatch.mjs';
import { dueAnchors, lastInbound, markExpired, markReminded, matchReply, recordReply, setEmoji, transition } from './hub/anchors.mjs';
import { boundedStream, mgetMessages, pollScope, pullAtMe, pullReactions, pullScopes } from './dws/listen.mjs';
import { notify, replyInChain } from './dws/notify.mjs';
import { EMOJI, addEmoji } from './dws/emoji.mjs';
import { isReal } from './dws/dws.mjs';
import * as scanCh from './hub/scan.mjs';
import { scanAll } from './dws/listen.mjs';

export const POLL_NS = 'poll';

export function createHub({ dbPath, bin, selfUser = process.env.DWS_HUB_SELF_USER } = {}) {
  const store = openStore(dbPath);
  return { store, bin, selfUser };
}

/** 从消费者订阅表推导需要监听的 scope 集合（去重）。 */
export function scopesOf(store) {
  const set = new Set();
  for (const c of store.consumers.all()) {
    for (const t of c.targets || []) {
      // 通配模式（`direct:*` / `group:*` / `*`）不能当具体 scope 轮询（poll 会报 peerUid is required）；
      // 未订阅会话由 scan 通道覆盖。
      if (!t || t.includes('*')) continue;
      // `atme:*` / `atme:chat:<cid>` / `atme:user:<uid>` 是**选择器不是 scope**：
      // 送进 pollScope 会落 `bad_scope`（`atme:chat:c1` 不含 `*`，光靠上面那行过滤不掉）。
      if (t.startsWith('atme:')) continue;
      set.add(t);
    }
  }
  return [...set];
}

/** 每个 scope 的水位（上次 poll 到的时间）—— 与消费者游标独立。 */
export const EPOCH = '1970-01-01T00:00:00.000Z';

/** 首次运行的回溯上限（小时）：**防止 epoch 水位把全部历史拉一遍**（实测踩坑：会打爆 dws 且极慢）。 */
export const INITIAL_LOOKBACK_MS = Number(process.env.DWS_HUB_INITIAL_LOOKBACK_H || 24) * 3600e3;

export function scopeWatermark(store, scope) {
  return store.kv.get(POLL_NS, scope, EPOCH);
}

/** 实际拉取起点：水位为 epoch（首跑）时只回看最近 N 小时。 */
export function effectiveSince(store, scope, now = Date.now()) {
  const wm = scopeWatermark(store, scope);
  return wm === EPOCH ? new Date(now - INITIAL_LOOKBACK_MS).toISOString() : wm;
}

export function setScopeWatermark(store, scope, iso) {
  return store.kv.set(POLL_NS, scope, iso);
}

/**
 * 拉取所有 scope 的增量（幂等）。
 * ⚠️ **完整性门禁**：某 scope `complete=false` → **不推进该 scope 水位**（下轮重拉同窗口，幂等不丢）。
 */
export async function pullAll(store, { scopes, endIso, bin, selfUser, now = Date.now() } = {}) {
  const report = { scopes: {}, inserted: 0, insertedEvents: [] };
  for (const scope of scopes) {
    const since = effectiveSince(store, scope, now);
    const r = await pullScopes(store, { scopes: [scope], sinceIso: since, endIso, bin, selfUser });
    report.inserted += r.inserted;
    report.insertedEvents.push(...r.insertedEvents);
    report.scopes[scope] = { since, ...r.per[scope] };
    if (r.per[scope]?.complete) setScopeWatermark(store, scope, endIso);
    else report.scopes[scope].watermark_stuck = since;
  }
  return report;
}

/** ② 锚点：把入站事件关联到锚点、记录回复（识别不出→不猜）。 */
export function applyInboundToAnchors(store, events) {
  const matched = [];
  for (const e of events) {
    const m = matchReply(store, e);
    if (!m) continue;
    recordReply(store, m.anchor, e);
    // 把锚点归属写进事件 meta：消费者收到事件后据此回结果（`anchors reply --id <anchor>`）
    store.events.setMeta(e.ext_id, { anchor_id: m.anchor.id, anchor_via: m.via });
    e.meta = { ...(e.meta || {}), anchor_id: m.anchor.id, anchor_via: m.via };
    matched.push({ anchor: m.anchor.id, via: m.via, consumer: m.anchor.consumer, ext_id: e.ext_id, event: e });
  }
  return matched;
}

/**
 * 表情状态协议（docs/design.md）：
 *   ① **收到**：收到人工回复 → 立刻在**那条回复**上贴 ack（收到）；
 *   ② **处理中**：若超过 `ingAfterMs`（默认 60s）仍未处理完 → 再贴 ing（思考，**ack 保留**）；
 *   ③ **完成**：消费者回结果时（`notify.replyInChain`）撤 ing、贴 done（撒花）；
 *      短任务（未到阈值就处理完）**不贴** ing/done —— 免得为秒回的事刷两个表情。
 */
export async function ackReplies(store, matches, { bin, now = Date.now(), emoji = EMOJI } = {}) {
  const out = [];
  for (const m of matches) {
    const anchor = store.anchors.byId(m.anchor);
    if (!anchor || (anchor.emoji || {}).ack) continue;             // 幂等：一条回复只 ack 一次
    const cid = m.event?.meta?.conversation_id;
    if (!cid) { out.push({ anchor: m.anchor, skipped: 'no_conversation_id' }); continue; }
    // ⚠️ 输入是**表情回应**时，`ext_id` 是合成 id（不是真实消息）⇒ ack 要贴在**被回应的那条消息**上
    const target = m.event?.meta?.reaction ? m.event.reply_to : m.ext_id;
    if (!target) { out.push({ anchor: m.anchor, skipped: 'no_target_message' }); continue; }
    const r = await addEmoji({ conversationId: cid, msgId: target, emoji: emoji.ack, bin });
    // ⚠️ dry-run（未 `DWS_HUB_ENABLE=1`）**不落状态** —— 否则服务的空跑会「占位」，
    //    之后真发的那次 run 会因「已 ack」而跳过 ⇒ 表情永远贴不上（实测设计缺陷）。
    if (!r.dry_run) setEmoji(store, m.anchor, { ack: { msgId: target, conversationId: cid, at: new Date(now).toISOString(), ok: r.ok, via: m.via, input: m.event?.meta?.reaction ? 'reaction' : 'reply' } });
    out.push({ anchor: m.anchor, action: 'ack', ok: r.ok, dry_run: !!r.dry_run, target });
  }
  return out;
}

/**
 * ② 处理中：`answered` 且超过阈值、尚未贴过 ing 的锚点 → 贴 ing（ack 保留）。
 *
 * ⚠️ **阈值的生效值必须小于心跳间隔**（2026-10-16 实测边界 bug）：
 *    默认 60s 阈值 + 60s tick 间隔 ⇒ `now - ack.at` 恰好在边界附近（59.9x s）⇒
 *    **整轮跳过**；而下一轮时锚点往往已被结果回复推进到 `acting`（不再被扫）⇒
 *    「处理中」表情**随机不出现**。故：`生效阈值 = min(ingAfterMs, tickMs - 5s)`（下限 5s）。
 */
export async function ingUpgrade(store, { bin, now = Date.now(), ingAfterMs = Number(process.env.DWS_HUB_ING_AFTER_MS || 60_000), tickMs = 60_000, emoji = EMOJI } = {}) {
  const effectiveMs = Math.max(5_000, Math.min(ingAfterMs, tickMs - 5_000));
  const out = [];
  for (const a of store.anchors.byStatus('answered')) {
    const em = a.emoji || {};
    if (!em.ack || em.ing || em.done) continue;                    // 已 ing/已 done/没 ack → 跳过
    const since = Date.parse(em.ack.at || a.updated_at);
    if (now - since < effectiveMs) continue;                       // 短任务：还没到阈值，不贴
    const r = await addEmoji({ conversationId: em.ack.conversationId, msgId: em.ack.msgId, emoji: emoji.ing, bin });
    if (!r.dry_run) setEmoji(store, a.id, { ing: { msgId: em.ack.msgId, conversationId: em.ack.conversationId, at: new Date(now).toISOString(), ok: r.ok } });
    out.push({ anchor: a.id, action: 'ing', ok: r.ok, dry_run: !!r.dry_run });
  }
  return out;
}

/** ④ 锚点超时处理：24h 提醒一次（strong）/ 72h 归档。 */
export async function sweepAnchors(store, { now = Date.now(), bin } = {}) {
  const { toRemind, toExpire } = dueAnchors(store, { now });
  const reminded = [];
  for (const a of toRemind) {
    const r = await notify(store, {
      consumer: a.consumer, strength: 'strong', needsDecision: false, now,
      title: `⏰ 事项超 24h 未回复：${a.title}`,
      text: `事项 ${a.id}（${a.status}）`,
    });
    markReminded(store, a.id);
    reminded.push({ id: a.id, via: r.endpoint });
  }
  for (const a of toExpire) markExpired(store, a.id);
  return { reminded, expired: toExpire.map((a) => a.id) };
}

/**
 * **锚点看护**（state-change watch，2026-10-16 用户点破后新增）：
 *
 * 水位只管「新消息」；**旧消息上的状态变化**（贴表情 / 将来：撤回、编辑）水位看不到。
 * 故对**未终结的锚点**，按 id 重读「锚点消息 + 它的入站往来」，把后到的表情抽成事件。
 * 幂等靠合成 id（`<msgId>#rx:<emoji>:<user>`）去重 ⇒ 每轮重读无副作用。
 * @param limit 一次最多重读多少条（`+messages-mget` 上限 50）
 */
export async function watchAnchors(store, { bin, now = Date.now(), limit = 50 } = {}) {
  const live = [
    ...store.anchors.byStatus('open'),
    ...store.anchors.byStatus('answered'),
    ...store.anchors.byStatus('acting'),
  ];
  const ids = [];
  for (const a of live) {
    if (a.ext_id && !String(a.ext_id).startsWith('dry:')) ids.push(a.ext_id);
    for (const r of (a.replies || []).filter((x) => x.direction === 'in')) {
      if (r.extId && !String(r.extId).includes('#rx:')) ids.push(r.extId);
    }
  }
  const uniq = [...new Set(ids)].slice(-limit);
  if (uniq.length === 0) return { watched: 0, insertedEvents: [], anchors: live.length };
  const msgs = await mgetMessages({ msgIds: uniq, bin });
  const insertedEvents = [];
  for (const m of msgs) for (const e of m.reactions) if (store.events.insert(e)) insertedEvents.push(e);
  return { watched: uniq.length, insertedEvents, anchors: live.length };
}

/** ⑤ 降级态下的恢复探测（自动回升 / 结构性不可用判定）。 */
export async function ladderTick(store, { scopes, now = Date.now(), bin, selfUser, windowSec = 60 } = {}) {
  const out = [];
  for (const scope of scopes) {
    const kind = scopeKind(scope);
    if (!ladder.isSupported(store, kind)) { out.push({ kind, state: 'unsupported', skipped: true }); continue; }
    if (ladder.getState(store, kind) === 'degraded' && ladder.shouldProbe(store, kind, now)) {
      // 探测：有界 stream + 同窗口权威对照
      const { received, authoritative } = await probeScope(store, { scope, bin, selfUser, windowSec });
      const res = ladder.evaluate(store, kind, { received, authoritative, connected: true }, { now });
      out.push({ kind, scope, received, authoritative, ...res });
    }
  }
  return out;
}

export function scopeKind(scope) {
  return `stream:${String(scope).split(':')[0]}`;
}

/** 有界探测某 scope 的事件通道（收到几条 + 同窗口权威几条）。 */
export async function probeScope(store, { scope, bin, selfUser, windowSec = 60 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - windowSec * 1000);
  let received = 0;
  const stream = boundedStream({
    scopes: [scope], durationSec: windowSec, bin,
    onEvent: () => { received += 1; },
  });
  const { events } = await pollScope({
    scope, sinceIso: start.toISOString(), endIso: end.toISOString(), bin, selfUser,
  });
  await stream.done.catch(() => {});
  return { received, authoritative: events.length };
}

/**
 * 一轮完整 tick。
 * @param {object} o
 * @param {boolean} [o.stream] 是否本轮启动长连接闹钟（有界）
 */
/**
 * scan 通道：一轮全量增量扫描（设计 docs/design.md）。
 * 开关：`DWS_HUB_SCAN=on` 才跑（默认 off，服务 plist 显式开启）；`DWS_HUB_SCAN_DISPATCH=1` 才把 scan 事件交给 dispatch。
 */
export async function scanOnce(store, { bin, now = Date.now(), lookbackH } = {}) {
  const gate = scanCh.shouldScan(store, { now });
  if (!gate.due) return { skipped: gate.reason, intervalMs: gate.intervalMs };
  const win = scanCh.planWindow(store, {
    now,
    lookbackH: lookbackH ?? Number(process.env.DWS_HUB_SCAN_LOOKBACK_H || 24),
  });
  const startedAt = new Date(now).toISOString();
  const r = await scanAll({
    start: win.from,
    end: win.to,
    maxItems: Number(process.env.DWS_HUB_SCAN_MAX_ITEMS || 2000),
    bin,
  });
  if (!r.ok) {
    scanCh.recordFailure(store, { now, error: r.error });
    scanCh.recordRun(store, { startedAt, finishedAt: new Date().toISOString(), from: win.from, to: win.to, ok: false, error: String(r.error).slice(0, 300) });
    return { ok: false, error: r.error, window: win };
  }
  const inserted = scanCh.ingest(store, r.events);
  // 水位推进到**本批最大 at**（不是窗口末），避免窗口尾部消息丢失
  const lastAt = r.events.reduce((m, e) => (e.at > m ? e.at : m), r.events[0]?.at || win.to);
  scanCh.advanceWatermark(store, lastAt, { now, messages: r.events.length });
  scanCh.recordRun(store, {
    startedAt, finishedAt: new Date().toISOString(), from: win.from, to: win.to,
    messages: r.events.length, pages: r.paging?.pages || 0, ok: true,
  });
  // 每日清理（保留期滚动；失败不影响 scan）
  let pruned = null;
  try {
    pruned = scanCh.maybePrune(store, { now, retainDays: Number(process.env.DWS_HUB_SCAN_RETAIN_DAYS || 90) });
  } catch (e) {
    pruned = { skipped: false, error: String(e?.message || e).slice(0, 200) };
  }
  return { ok: true, inserted, messages: r.events.length, paging: r.paging, window: win, pruned };
}

export async function tick(store, { bin, selfUser, now = Date.now(), run, streamSec = 0, windowSec = 60, emoji = EMOJI, tickMs = Number(process.env.DWS_HUB_INTERVAL || 60) * 1000, dispatchMode = 'sync' } = {}) {
  const scopes = scopesOf(store);
  const endIso = new Date(now).toISOString();
  const pull = await pullAll(store, { scopes, endIso, bin, selfUser, now });
  // **@我 通道**（selector 不是 scope）：`+search-msg --at-me` 权威轮询，事件补 `meta.mentionMe`。
  // ⚠️ 不接这条 → `atme:*` 订阅永远收不到事件（分派要求 `meta.mentionMe === true`，而 scope 轮询不产出该字段）。
  const atmeSelectors = atmeTargets(store);
  const atme = atmeSelectors.length
    ? await pullAtMe(store, { consumers: store.consumers.all(), bin, now, windowSec })
    : { consumers: 0, targets: [], scanned: 0, inserted: 0, updated: 0, insertedEvents: [], incomplete: [], failed: [], per: {} };
  // 表情**回看**：表情贴在对旧消息上，增量窗口抓不到（实测踩到）→ 单独回扫最近 N 分钟
  const reactions = await pullReactions(store, { scopes, bin, selfUser, now });
  // 锚点看护：按 id 重读已知消息 → 抓「后到的表情」（水位看不到旧消息的状态变化）
  const watched = await watchAnchors(store, { bin, now });
  // ⚠️ 只用**本轮新插入**的事件做锚点关联（否则每轮重扫历史 → 重复归档，实测踩到）
  const anchorHits = applyInboundToAnchors(store,
    [...(pull.insertedEvents || []), ...(atme.insertedEvents || []), ...(reactions.insertedEvents || []), ...(watched.insertedEvents || [])]);
  const acked = await ackReplies(store, anchorHits, { bin, now, emoji });   // ① 收到 ack
  // ⚠️ 本轮新插入的事件要**显式**喂给 dispatch：@我 消息可能早于消费者游标（跨会话回看），
  //    只靠 `pendingFor`（`at > cursor`）会把它整批跳过。dispatch 内部会与待派发集合并去重。
  const dispatchEvents = [...(pull.insertedEvents || []), ...(atme.insertedEvents || [])];
  const dispatch = await dispatchOnce({ store, now, run, mode: dispatchMode, events: dispatchEvents });
  const anchors = await sweepAnchors(store, { now, bin });
  const ing = await ingUpgrade(store, { bin, now, emoji, tickMs });         // ② 处理中 ing
  const ladderRes = await ladderTick(store, { scopes, now, bin, selfUser, windowSec });
  // scan 通道（全量低频）：默认入库不派发；失败不影响本轮 L1/L3
  let scanRes = null;
  if (process.env.DWS_HUB_SCAN === 'on') {
    try {
      scanRes = await scanOnce(store, { bin, now });
    } catch (e) {
      scanRes = { ok: false, error: String(e?.message || e) };
    }
  }
  return { scopes, pull, atme, reactions, watched, anchorHits, acked, ing, dispatch, anchors, ladder: ladderRes, scan: scanRes, streamSec };
}

/**
 * 常驻循环（由 launchd 托管的**有界**进程调用；禁止 `--duration 0`，坑 4）。
 * stream 每 `streamSec` 起一次有界长连接；收到事件立即触发一次 poll tick。
 */
export async function runLoop(store, { bin, selfUser, intervalMs = 60_000, streamSec = 1500, maxTicks = Infinity, onTick, tickFn = tick } = {}) {
  let stop = false;
  let wake = () => {};
  const stopFn = () => {
    stop = true;
    wake();                                   // 打断等待，立即退出（否则 SIGTERM 后要等满一个 interval）
  };
  process.on('SIGTERM', stopFn);
  process.on('SIGINT', stopFn);
  const state = { ticks: 0, started_at: new Date().toISOString(), stream: null };
  let streamHandle = null;
  const startStream = () => {
    if (streamHandle) return;
    const scopes = scopesOf(store);
    streamHandle = boundedStream({
      scopes, bin, durationSec: streamSec,
      onEvent: () => { quickPull(); },                      // 闹钟：立刻拉一次
    });
    // 可观测（2026-10-16 diag）：流是否真的持住、退出原因是什么
    if (streamHandle?.skip) {
      console.log(`[stream] skip：无可流式 scope（scopes=${JSON.stringify(scopes)}）`);
    } else {
      console.log(`[stream] started count=${streamHandle?.count ?? '?'} duration=${streamSec}s scopes=${JSON.stringify(scopes)}`);
    }
    streamHandle.done?.then((rs) => {
      const reasons = (Array.isArray(rs) ? rs : [rs]).map((r) => (r?.exited || '').split('\n').filter(Boolean).pop() || `code=${r?.code}`).join(' | ');
      console.log(`[stream] exited: ${reasons.slice(0, 220)}`);
    }).finally(() => { streamHandle = null; });
  };
  const quickPull = async () => {
    try { await pullAll(store, { scopes: scopesOf(store), endIso: new Date().toISOString(), bin, selfUser }); }
    catch { /* 闹钟路径失败不致命，下轮 tick 会兜底 */ }
  };
  while (!stop && state.ticks < maxTicks) {
    startStream();
    const r = await tickFn(store, { bin, selfUser, now: Date.now(), dispatchMode: 'async' });
    state.ticks += 1;
    state.last_tick = new Date().toISOString();
    // **长连接生效状态可读**（用户 2026-10-16 要求「长链接生效时要告知」）：
    // 写进 kv，`health` 会带出；台账兜底据此决定「停跑 or 启用」（见docs/design.mdc）
    store.kv.set('stream', 'state', {
      streaming: !!streamHandle,          // 当前是否持有长连接（有界窗口内）
      at: state.last_tick,
      interval_ms: intervalMs,
      stream_sec: streamSec,
    });
    state.last = { pull_inserted: r.pull.inserted, dispatch: r.dispatch, anchors: r.anchors, ladder: r.ladder, acked: r.acked, ing: r.ing };
    onTick?.(r);
    if (stop) break;
    await interruptibleSleep(intervalMs, (set) => { wake = set; });   // 可被 SIGTERM 打断（否则要等满一个 interval）
  }
  streamHandle?.kill?.();
  process.off('SIGTERM', stopFn);
  process.off('SIGINT', stopFn);
  return state;
}

/** 可打断的等待：`wake()` 立即返回（服务停止要**及时**，否则 launchd 会 SIGKILL）。 */
function interruptibleSleep(ms, register) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      resolve();
    }
    register(finish);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** health 快照（`dws-hub health`）：通道档位 / 水位 / 游标 / 限频用量 / 锚点分布。 */
export function health(store, { now = Date.now() } = {}) {
  const scopes = scopesOf(store);
  const kinds = [...new Set(scopes.map(scopeKind))];
  const consumers = store.consumers.all();
  const anchorsByStatus = {};
  for (const a of store.anchors.byStatus('open').concat(store.anchors.byStatus('answered'), store.anchors.byStatus('acting'), store.anchors.byStatus('expired'))) {
    anchorsByStatus[a.status] = (anchorsByStatus[a.status] || 0) + 1;
  }
  // ⚠️ pending 要**只数「有消费者会收」的事件**：机器消息（自聊里的服务通知等）永远不派发，
  //    若一并计入，指标会随时间单调膨胀、看起来像「积压」（2026-10-16 实测发现）。
  const pendingAll = store.events.pending();
  const pendingRelevant = pendingAll.filter((e) => !e.outbound && consumers.some((c) => shouldDeliver(c, e)));
  return {
    // ⚠️ 这是**本进程**的真发开关（服务的模式看它的 plist/环境）；命名要说清，避免误读
    real_send_this_process: isReal(),
    db: store.path,
    consumers: consumers.map((c) => ({
      name: c.name,
      targets: c.targets,
      batch_window: c.batch_window,
      // ★ 最近一次成功消费时间（null = 从未成功）——区分「进程活着」与「真的在消费」
      last_delivered_at: store.kv.get(`dispatch:${c.name}`, 'last_delivered_at', null),
    })),
    scopes: scopes.map((s) => ({ scope: s, watermark: scopeWatermark(store, s), kind: scopeKind(s) })),
    cursors: Object.fromEntries(consumers.map((c) => [c.name, store.kv.get('cursor', c.name, null)])),
    stream: store.kv.get('stream', 'state', null),   // ★ 长连接生效状态（streaming/at/…）
    scan: { ...scanCh.getScanState(store), due: scanCh.shouldScan(store, { now }).due },
    // ⚠️ pending_events 是「未被任何消费者取走」的**可观测值**（dispatched_at 多消费者共享，非正确性指标）
    pending_events: pendingRelevant.length,
    pending_all_events: pendingAll.length,
    // ★ 按各消费者游标计算的真实待处理量（2026-11-05）
    pending_by_consumer: Object.fromEntries(consumers.map((c) => {
      const cursor = store.kv.get('cursor', c.name, '1970-01-01T00:00:00.000Z');
      return [c.name, store.events.since(cursor).filter((e) => !e.outbound && shouldDeliver(c, e)).length];
    })),
    anchors: anchorsByStatus,
    ladder: ladder.rollup(store, kinds, { now }),
    ratelimit: rl.usage(store, { now }),
  };
}

export { notify, replyInChain, pullAtMe };
