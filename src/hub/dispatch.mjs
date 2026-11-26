/**
 * dws-hub · hub 层（渠道无关）—— 订阅与分派
 *
 * 设计：docs/design.md（订阅与分派）/ docs/design.md 边界 B6–B10
 *
 * ══ 交付语义（关键）══
 * **每个消费者一条独立游标**（kv: ns=`cursor:<name>`）—— 同一事件流多消费者互不影响。
 * `hub_events.dispatched_at` 只作**可观测**（首次被任一方成功派发的时间），**不参与正确性判断**
 * （多消费者共用一列会互相覆盖）。
 *
 * 触发合并（batch window）：同一消费者窗口内的多个事件合并为**一次**回调 —— 这是
 * 「避免外部系统写入频率限制」的第一道护栏（用户 2026-10-16 要求）。
 */
import { spawn } from 'node:child_process';

/** 作用域模式匹配：支持 `*` 通配（`self` / `group:cid…` / `*`）。 */
export function matchScope(pattern, scope) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === scope;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  return re.test(scope);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 任务关注范围（scan docs/design.md）：domains 优先，缺省回落到 targets/keywords（向后兼容）。 */
export function domainsOf(consumer) {
  const d = consumer.domains || {};
  return {
    scopes: d.scopes ?? (consumer.targets || []),
    keywords: d.keywords ?? consumer.keywords ?? null,
    mentionMe: Boolean(d.mentionMe),
    senders: d.senders || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * `atme` 选择器（docs/design.md）—— **selector 不是 scope**
 *
 * @我 横跨群聊与单聊，事件 scope 仍是**真实会话**（`group:<cid>` / `direct:<uid>`），
 * 因此不能拿 `atme:*` 去 `matchScope`（会永远不命中）。分派侧按选择器求值：
 *   `atme:*`            → 只要 `event.meta.mentionMe === true`
 *   `atme:chat:<cid>`   → @我 + 事件会话等于该 cid（`event.scope` / `meta.conversationId|chatId`）
 *   `atme:user:<uid>`   → @我 + 事件发送者等于该 uid
 * ⚠️ `mentionMe` **只判定一次**（`event.meta.mentionMe === true`）——不重复判断、
 *    也不用文本 `@` 反推（声明了 `domains.mentionMe` 但事件没带该字段 ⇒ 不投递）。
 *    ⇒ 该字段**必须由事件生产者写入**：`dws/listen.mjs` 的 `pullAtMe`（`+search-msg --at-me` 权威通道）
 *      显式标记 `mentionMe: true`；`normalizeMessage` 也会识别消息自带的 @ 标记。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 是否是 `atme` 选择器（`atme:*` / `atme:chat:<cid>` / `atme:user:<uid>`）。 */
export function isAtmeSelector(pattern) {
  return typeof pattern === 'string' && (pattern === 'atme:*' || pattern.startsWith('atme:chat:') || pattern.startsWith('atme:user:'));
}

/** 事件的会话 id（scope 去掉 `group:`/`direct:` 前缀；`meta.conversationId` 优先）。 */
function eventChatId(event) {
  const meta = event.meta || {};
  const declared = meta.conversationId ?? meta.chatId;
  if (declared != null && String(declared) !== '') return String(declared);
  const scope = String(event.scope || '');
  const i = scope.indexOf(':');
  return i >= 0 ? scope.slice(i + 1) : scope;
}

/** 事件的发送者 uid（兼容 `user:<uid>` 前缀形态；裸 uid 原样）。 */
function eventSenderId(event) {
  const sender = String(event.sender ?? '');
  const i = sender.indexOf(':');
  return i >= 0 ? sender.slice(i + 1) : sender;
}

/**
 * 该消费者声明的 `atme` 选择器（`domains.scopes` 优先，回落 `targets`）。
 * 装配层据此决定「这一轮要不要拉 @我 通道」——**没订阅就不拉**，避免无谓的上游调用。
 */
export function atmeSelectorsOf(consumer) {
  return (domainsOf(consumer).scopes || []).filter(isAtmeSelector);
}

/**
 * 全部消费者声明的 `atme` 选择器（去重）。
 * @param {{consumers:{all:Function}}} store
 */
export function atmeTargets(store) {
  const set = new Set();
  for (const c of store.consumers.all()) {
    for (const s of atmeSelectorsOf(c)) set.add(s);
  }
  return [...set];
}

/** 单个 `atme` 选择器是否命中（调用方已确认 `mentionMe === true`）。 */
function atmeSelectorHit(pattern, event) {
  if (pattern === 'atme:*') return true;
  if (pattern.startsWith('atme:chat:')) {
    const cid = pattern.slice('atme:chat:'.length);
    return cid === '*' || cid === eventChatId(event);
  }
  if (pattern.startsWith('atme:user:')) {
    const uid = pattern.slice('atme:user:'.length);
    return uid === '*' || uid === eventSenderId(event) || uid === String(event.sender ?? '');
  }
  return false;
}

/**
 * 该消费者是否应收到这条事件。
 * 语义（AND）：scopes 声明了就必须命中（普通 scope 按模式匹配，atme 按选择器求值）；
 * senders/mentionMe/keywords 声明了也都要命中。多任务命中 = 各自都收（互不抢占）。
 */
export function shouldDeliver(consumer, event) {
  if (event.outbound) return false;                       // docs/design.md 防自我回环
  const d = domainsOf(consumer);
  const mentionMe = event.meta?.mentionMe === true;        // ★ 单次判定，全局复用
  const scopes = d.scopes || [];
  const atmeSelectors = scopes.filter(isAtmeSelector);
  const plainScopes = scopes.filter((p) => !isAtmeSelector(p));
  if (scopes.length) {
    const scopeHit = plainScopes.some((p) => matchScope(p, event.scope));
    // atme 选择器一律要求「@我」；收窄条件（chat/user）再叠加
    const atmeHit = atmeSelectors.length > 0 && mentionMe
      && atmeSelectors.some((p) => atmeSelectorHit(p, event));
    if (!scopeHit && !atmeHit) return false;
  }
  if (d.senders?.length && !d.senders.includes(event.sender)) return false;
  if (d.mentionMe && !mentionMe) return false;
  if (d.keywords?.length) {
    const t = event.text || '';
    if (!d.keywords.some((k) => t.includes(k))) return false;
  }
  return true;
}

/**
 * 触发合并：只取「已过窗口」的事件（纯函数，便于测试）。
 * @param {number} windowMs 合并窗口（0 = 立即）
 */
export function selectBatch(events, windowMs, nowMs) {
  if (!windowMs || windowMs <= 0) return events;
  return events.filter((e) => nowMs - Date.parse(e.at) >= windowMs);
}

export function getCursor(store, name) {
  return store.kv.get('cursor', name, '1970-01-01T00:00:00.000Z');
}

export function setCursor(store, name, iso) {
  return store.kv.set('cursor', name, iso);
}

/** 未派发给该消费者的事件（**按该消费者游标**取 + 只留该消费者该收的），按时间升序。 */
export function pendingFor(store, consumer) {
  const since = getCursor(store, consumer.name);
  return store.events.since(since)
    .filter((e) => shouldDeliver(consumer, e))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * 合并「本轮新插入的候选事件」与「按游标待派发的事件」，按 `ext_id` 去重、按 `at` 升序。
 * 新插入集合可能包含**早于游标**的事件（@我 跨会话回看）——所以不能只用游标取数。
 */
export function mergeCandidates(extra, pending) {
  const map = new Map();
  for (const e of (extra || [])) if (e?.ext_id) map.set(e.ext_id, e);
  for (const e of (pending || [])) if (e?.ext_id && !map.has(e.ext_id)) map.set(e.ext_id, e);
  return [...map.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** 失败退避（边界 B7）：连续失败 → 指数退避，封顶 30min。 */
export function backoffState(store, name, now = Date.now()) {
  const ns = `dispatch:${name}`;
  return {
    fails: Number(store.kv.get(ns, 'fails', 0)) || 0,
    nextAttemptAt: store.kv.get(ns, 'next_attempt_at', 0) || 0,
    revisiting: now,
  };
}

export function recordFailure(store, name, now = Date.now()) {
  const ns = `dispatch:${name}`;
  const fails = Number(store.kv.get(ns, 'fails', 0)) + 1;
  const delay = Math.min(30 * 60e3, 2 ** Math.min(fails, 10) * 1000);
  store.kv.set(ns, 'fails', fails);
  store.kv.set(ns, 'next_attempt_at', now + delay);
  return { fails, retryInMs: delay };
}

export function recordSuccess(store, name) {
  store.kv.set(`dispatch:${name}`, 'fails', 0);
  store.kv.set(`dispatch:${name}`, 'next_attempt_at', 0);
}

/**
 * 执行消费者回调：事件 JSON 经 **stdin** 传入（语言无关：Python/Node 都能消费）。
 * 带超时（边界 B10），超时杀进程并记失败 —— 不影响其他消费者。
 */
export function runConsumer(consumer, events, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(consumer.on_event, { shell: true, cwd });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, code: null, reason: 'timeout', stdout: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: false, code: null, reason: 'spawn_error', stdout: out, stderr: String(e?.message || e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, reason: code === 0 ? 'ok' : 'nonzero_exit', stdout: out, stderr: err });
    });
    child.stdin.end(JSON.stringify({ consumer: consumer.name, events }, null, 2));
  });
}

/**
 * 进行中的消费者回调（按消费者名去重）。
 * ⚠️ **慢消费者不能阻塞 tick**（2026-10-16 实测踩到）：消费者可能要跑几十秒~百秒，
 *    同步等待会让「ack/ing/看护」等所有 tick 逻辑一起停摆（实测：demo 消费者 sleep 100s ⇒
 *    整轮 tick 被卡住 ⇒ 「处理中」表情永远没机会贴）。⇒ 派发改为**可异步**，完成后再落游标。
 */
const inflight = new Map();

export function inflightConsumers() {
  return [...inflight.keys()];
}

/**
 * 一轮分派：逐消费者取「窗口已过 + 匹配」的事件合并成一次回调。
 * @param {'sync'|'async'} mode `async` = 回调后台跑（服务循环用）；`sync` = 等待结果（测试/一次性命令用）
 * @returns 每个消费者的结果摘要（供 health / 日志）；`async` 模式下为 `{started: n}`
 */
export async function dispatchOnce({ store, events, now = Date.now(), run = runConsumer, timeoutMs, cwd, mode = 'sync' } = {}) {
  const summary = {};
  for (const consumer of store.consumers.all()) {
    // 同一消费者已有回调在跑 → 本轮跳过（**至少一次**语义：游标未推进 = 下轮重投，不会丢）
    if (inflight.has(consumer.name)) {
      summary[consumer.name] = { skipped: 'in_flight' };
      continue;
    }
    const bo = backoffState(store, consumer.name, now);
    if (bo.nextAttemptAt > now) {
      summary[consumer.name] = { skipped: 'backoff', retryInMs: bo.nextAttemptAt - now };
      continue;
    }
    // `events` = 本轮**新插入**的候选事件（可能早于消费者游标，如跨会话 @我 回看）；
    // 必须与「按游标取」的待派发集**合并去重**，否则喂了 events 就会漏掉崩溃后待补派的积压。
    const matched = mergeCandidates(events, pendingFor(store, consumer)).filter((e) => shouldDeliver(consumer, e));
    const batch = selectBatch(matched, (consumer.batch_window ?? 60) * 1000, now);
    if (batch.length === 0) {
      summary[consumer.name] = { delivered: 0, pending: matched.length };
      continue;
    }
    const settle = async () => {
      const res = await run(consumer, batch, { timeoutMs: timeoutMs ?? 120_000, cwd });
      if (res.ok) {
        // 游标**只前进不后退**：显式喂进来的历史事件（@我 回看）不得把游标拉回去。
        const last = batch[batch.length - 1].at;
        const cur = getCursor(store, consumer.name);
        const curMs = Date.parse(cur);
        if (!Number.isFinite(curMs) || !(Date.parse(last) <= curMs)) setCursor(store, consumer.name, last);
        store.events.markDispatched(batch.map((e) => e.ext_id));
        recordSuccess(store, consumer.name);
        // ★ 2026-11-03：暴露「最近一次成功消费时间」——health 与定时兜底据此判断
        //   「实时通道是否真的在消费」，而不只是「stream 进程活着」。
        store.kv.set(`dispatch:${consumer.name}`, 'last_delivered_at', new Date(now).toISOString());
        return { delivered: batch.length, last: batch[batch.length - 1].at };
      }
      const f = recordFailure(store, consumer.name, now);
      return { delivered: 0, failed: batch.length, reason: res.reason, fails: f.fails, retryInMs: f.retryInMs };
    };
    if (mode === 'async') {
      const p = settle().catch((e) => ({ delivered: 0, failed: batch.length, reason: `settle_error:${e?.message || e}` }))
        .finally(() => inflight.delete(consumer.name));
      inflight.set(consumer.name, p);
      summary[consumer.name] = { started: batch.length };
      continue;
    }
    summary[consumer.name] = await settle();
  }
  return summary;
}
