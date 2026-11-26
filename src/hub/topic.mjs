/**
 * topic.mjs —— 任务/主题（Topic）↔ 会话链（Thread）↔ 消息（Message）
 *
 * 设计：docs/design.md（2026-11-06，用户拍板 hub 层抽象）
 *
 * ══ 分层纪律 ══
 * 本文件在 `hub/`（渠道无关核心）：**不得出现渠道字样**（`dws` / `dingtalk` / `conversation` / `message_id`）。
 * 领域名词：`topic`（主题）、`scope`（会话标识）、`ext_id`（渠道侧消息 id）、`thread`（会话）。
 *
 * ══ 模型 ══
 *   hub_topics(topic_key, kind, title, status, meta_json, first_at, last_at, count)
 *   hub_topic_threads(topic_key, scope, kind, name, role, added_at)
 *   hub_topic_events(topic_key, ext_id)      —— 主题 ↔ 消息（多对多）
 *   hub_events(...)                          —— 消息正文与方向（direction = in/out）
 *
 * topic_key 采用 URI 风格：`mr:group/repo!42`、`issue:group/repo#123`、`adhoc:some-topic`。
 */

const TOPIC_KEY_RE = /^[a-z][a-z0-9_-]*:[^\s]+$/;

/** 规范化并校验主题 key（URI 风格）；非法抛错。 */
export function normalizeTopicKey(input) {
  const key = String(input || '').trim();
  if (!TOPIC_KEY_RE.test(key)) {
    const e = new Error(
      `主题 key 必须是 URI 风格（如 mr:group/repo!42 / issue:group/repo#123），收到：${JSON.stringify(key)}`,
    );
    e.usage = true;
    throw e;
  }
  return key;
}

/** 从 key 推断 kind（`mr:…` → mr）。 */
export function kindOf(key) {
  const m = /^([a-z][a-z0-9_-]*):/.exec(String(key || ''));
  return m ? m[1] : 'adhoc';
}

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function hydrateTopic(r) {
  if (!r) return null;
  return {
    key: r.topic_key,
    kind: r.kind,
    title: r.title,
    status: r.status || 'open',
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    first_at: r.first_at,
    last_at: r.last_at,
    count: r.count ?? 0,
  };
}

/** 新建/更新主题（存在则合并标题/状态）。 */
export function addTopic(store, { key, kind, title = null, status = 'open', meta = null, now = Date.now() }) {
  const topicKey = normalizeTopicKey(key);
  const t = iso(now);
  store.db
    .query(
      `INSERT INTO hub_topics (topic_key, kind, title, status, meta_json, first_at, last_at, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(topic_key) DO UPDATE SET
         kind = excluded.kind,
         title = COALESCE(excluded.title, hub_topics.title),
         status = excluded.status,
         meta_json = COALESCE(excluded.meta_json, hub_topics.meta_json)`,
    )
    .run(topicKey, kind || kindOf(topicKey), title, status, meta ? JSON.stringify(meta) : null, t, t);
  return getTopic(store, topicKey);
}

export function getTopic(store, key) {
  return hydrateTopic(store.db.query('SELECT * FROM hub_topics WHERE topic_key = ?').get(String(key)));
}

export function listTopics(store, { status = null, limit = 50 } = {}) {
  const rows = status
    ? store.db.query('SELECT * FROM hub_topics WHERE status = ? ORDER BY last_at DESC LIMIT ?').all(status, limit)
    : store.db.query('SELECT * FROM hub_topics ORDER BY last_at DESC LIMIT ?').all(limit);
  return rows.map(hydrateTopic);
}

export function setTopicStatus(store, key, status) {
  store.db.query('UPDATE hub_topics SET status = ? WHERE topic_key = ?').run(status, String(key));
  return getTopic(store, key);
}

/** 把会话挂到主题（幂等）。 */
export function linkThread(store, { topicKey, scope, kind = 'group', name = null, role = 'discuss', extRef = null, now = Date.now() }) {
  if (!scope) throw new Error('linkThread：缺少 scope（会话标识）');
  const key = normalizeTopicKey(topicKey);
  if (!getTopic(store, key)) addTopic(store, { key, title: null, now });
  store.db
    .query(
      `INSERT INTO hub_topic_threads (topic_key, scope, kind, name, role, ext_ref, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_key, scope) DO UPDATE SET
         kind = excluded.kind, name = COALESCE(excluded.name, hub_topic_threads.name),
         role = excluded.role, ext_ref = COALESCE(excluded.ext_ref, hub_topic_threads.ext_ref)`,
    )
    .run(key, String(scope), kind, name, role, extRef, iso(now));
  return listThreads(store, key).find((t) => t.scope === String(scope));
}

export function listThreads(store, topicKey) {
  return store.db
    .query('SELECT * FROM hub_topic_threads WHERE topic_key = ? ORDER BY added_at')
    .all(String(topicKey))
    .map((r) => ({ scope: r.scope, kind: r.kind, name: r.name, role: r.role, ext_ref: r.ext_ref || null, added_at: r.added_at }));
}

/**
 * 记录一条消息并挂到主题（幂等：同 ext_id 只更新正文/投递状态）。
 * @param {{direction?: 'in'|'out', delivery?: string|null}} opts
 */
export function recordMessage(store, {
  topicKey, scope, extId, direction = 'in', text = null, sender = null,
  at = null, meta = null, delivery = null, now = Date.now(),
}) {
  if (!extId) throw new Error('recordMessage：缺少 extId');
  const key = normalizeTopicKey(topicKey);
  const t = at || iso(now);
  store.db
    .query(
      `INSERT INTO hub_events (ext_id, scope, sender, text, at, source, outbound, delivery, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ext_id) DO UPDATE SET
         text = COALESCE(excluded.text, hub_events.text),
         delivery = COALESCE(excluded.delivery, hub_events.delivery),
         meta_json = COALESCE(excluded.meta_json, hub_events.meta_json)`,
    )
    .run(
      String(extId), String(scope), sender, text, t,
      direction === 'out' ? 'out' : 'in',
      direction === 'out' ? 1 : 0,
      delivery,
      meta ? JSON.stringify(meta) : null,
    );
  store.db
    .query('INSERT OR IGNORE INTO hub_topic_events (topic_key, ext_id) VALUES (?, ?)')
    .run(key, String(extId));
  const count = store.db
    .query('SELECT COUNT(*) AS n FROM hub_topic_events WHERE topic_key = ?')
    .get(key).n;
  const lastAt = store.db
    .query('SELECT MAX(at) AS last FROM hub_events WHERE ext_id IN (SELECT ext_id FROM hub_topic_events WHERE topic_key = ?)')
    .get(key).last;
  store.db
    .query(
      `UPDATE hub_topics SET count = ?, last_at = COALESCE(?, last_at), first_at = COALESCE(first_at, ?) WHERE topic_key = ?`,
    )
    .run(count, lastAt, t, key);
  return { topicKey: key, extId: String(extId), count };
}

/** 主题时间线（跨会话合并，按时间升序）。 */
export function feedTopic(store, { topicKey, since = null, limit = 50 } = {}) {
  const where = ['te.topic_key = ?'];
  const params = [String(topicKey)];
  if (since) {
    where.push('e.at >= ?');
    params.push(since);
  }
  params.push(limit);
  const rows = store.db
    .query(
      `SELECT e.* FROM hub_events e
       JOIN hub_topic_events te ON te.ext_id = e.ext_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.at DESC LIMIT ?`,
    )
    .all(...params);
  return rows.reverse().map((r) => ({
    ext_id: r.ext_id,
    scope: r.scope,
    sender: r.sender,
    text: r.text,
    at: r.at,
    direction: r.outbound ? 'out' : 'in',
    reply_to: r.reply_to,
    delivery: r.delivery || null,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
  }));
}

/**
 * 撤回候选：本主题下**我方已发出**的消息（可按文本/最近 N 条过滤）。
 * 只返回候选，不执行任何动作（执行由调用方确认后做）。
 */
export function recallCandidates(store, { topicKey, match = null, last = 5 } = {}) {
  const where = ['te.topic_key = ?', 'e.outbound = 1'];
  const params = [String(topicKey)];
  if (match) {
    where.push('e.text LIKE ?');
    params.push(`%${match}%`);
  }
  params.push(Math.max(1, Number(last) || 5));
  const rows = store.db
    .query(
      `SELECT e.* FROM hub_events e
       JOIN hub_topic_events te ON te.ext_id = e.ext_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.at DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    ext_id: r.ext_id,
    scope: r.scope,
    text: r.text,
    at: r.at,
    delivery: r.delivery || null,
  }));
}

/** 更新投递状态（sent / delivered / failed / unknown）。 */
export function markDelivery(store, { extId, delivery }) {
  store.db.query('UPDATE hub_events SET delivery = ? WHERE ext_id = ?').run(String(delivery), String(extId));
}

/** 主题统计（会话数 / 消息数 / 出站数 / 未投递数）。 */
export function topicStats(store, topicKey) {
  const key = String(topicKey);
  const threads = store.db.query('SELECT COUNT(*) AS n FROM hub_topic_threads WHERE topic_key = ?').get(key).n;
  const msgs = store.db.query('SELECT COUNT(*) AS n FROM hub_topic_events WHERE topic_key = ?').get(key).n;
  const out = store.db
    .query(
      `SELECT COUNT(*) AS n FROM hub_events e JOIN hub_topic_events te ON te.ext_id = e.ext_id
       WHERE te.topic_key = ? AND e.outbound = 1`,
    )
    .get(key).n;
  const bad = store.db
    .query(
      `SELECT COUNT(*) AS n FROM hub_events e JOIN hub_topic_events te ON te.ext_id = e.ext_id
       WHERE te.topic_key = ? AND e.outbound = 1 AND e.delivery IN ('failed','unknown')`,
    )
    .get(key).n;
  return { threads, messages: msgs, outbound: out, undelivered: bad };
}


/**
 * 自动发现：扫描「尚未归属任何主题」的消息，用注入的 extractor 提取业务对象
 * （MR / 工单 / 需求 …），为命中的消息建立主题 + 会话绑定 + 消息关联。
 *
 * @param {(text: string) => Array<{key: string, title?: string}>} extractor
 * @returns {Array<{topicKey: string, extId: string, scope: string}>}
 */
export function discoverTopics(store, { extractor, since = null, limit = 500, dryRun = false } = {}) {
  const where = ["te.ext_id IS NULL"];
  const params = [];
  if (since) {
    where.push('e.at >= ?');
    params.push(since);
  }
  params.push(limit);
  const rows = store.db
    .query(
      `SELECT e.* FROM hub_events e
       LEFT JOIN hub_topic_events te ON te.ext_id = e.ext_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.at DESC LIMIT ?`,
    )
    .all(...params);

  const found = [];
  for (const r of rows) {
    const hits = extractor(r.text || '') || [];
    for (const h of hits) {
      const topicKey = normalizeTopicKey(h.key);
      found.push({ topicKey, extId: r.ext_id, scope: r.scope });
      if (dryRun) continue;
      if (!getTopic(store, topicKey)) addTopic(store, { key: topicKey, title: h.title || null });
      linkThread(store, { topicKey, scope: r.scope });
      recordMessage(store, {
        topicKey,
        scope: r.scope,
        extId: r.ext_id,
        direction: r.outbound ? 'out' : 'in',
        text: r.text,
        sender: r.sender,
        at: r.at,
        delivery: r.delivery || null,
      });
    }
  }
  return found;
}
