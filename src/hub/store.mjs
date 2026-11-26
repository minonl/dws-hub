/**
 * dws-hub · hub 层（**渠道无关核心**）—— 统一库访问
 *
 * 设计：docs/design.md（数据模型）
 *
 * ══ 分层纪律（docs/design.md，硬约束）══
 * 本目录（hub/）**不得出现渠道字样**：不用 `message_id` / `conversation_id` / `dingtalk` / `dws`。
 * 领域名词：`ext_id`（渠道侧消息 id）、`scope`（会话标识）、`reply_to`（被引用消息 id）。
 * 渠道细节（怎么拉、怎么发）一律收敛在 ../dws/。
 *
 * ══ 库 ══
 * 统一库 `dws-hub.db`（2026-10-13 用户拍板：全仓统一库 + KV 底座 + 克制建表）。
 * 与旧设计 `channel_anchors` 不冲突：本模块表一律 `hub_` 前缀。
 * 零依赖：bun:sqlite（本机实测可用）；WAL 模式（并发读 + 单写）。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { dbPath } from '../config.mjs';

/** 库路径：由 config 统一解析（`<数据根>/db/dws-hub.db`，可被环境变量覆盖）。 */
export function defaultDbPath(env = process.env) {
  return dbPath(env);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_store (
  ns          TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (ns, key)
);
CREATE TABLE IF NOT EXISTS hub_consumers (
  name         TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  targets      TEXT NOT NULL,
  keywords     TEXT,
  batch_window INTEGER NOT NULL DEFAULT 60,
  on_event     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS hub_anchors (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  consumer       TEXT NOT NULL,
  strength       TEXT NOT NULL,
  needs_decision INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  scope          TEXT NOT NULL,
  ext_id         TEXT NOT NULL,
  ext_scope      TEXT,
  confirmed      INTEGER NOT NULL DEFAULT 0,
  context_json   TEXT,
  replies_json   TEXT,
  emoji_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_hub_anchor_ext    ON hub_anchors(ext_id);
CREATE INDEX IF NOT EXISTS idx_hub_anchor_status ON hub_anchors(status);
CREATE TABLE IF NOT EXISTS hub_events (
  ext_id        TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  sender        TEXT,
  text          TEXT,
  at            TEXT NOT NULL,
  source        TEXT NOT NULL,
  reply_to      TEXT,
  outbound      INTEGER NOT NULL DEFAULT 0,
  dispatched_at TEXT,
  meta_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_hub_events_scope ON hub_events(scope, at);
CREATE INDEX IF NOT EXISTS idx_hub_events_pending ON hub_events(dispatched_at);

-- scan 通道（见 scan 设计文档 docs/design.md）
CREATE TABLE IF NOT EXISTS hub_scan_cursors (
  name        TEXT PRIMARY KEY,
  watermark   TEXT NOT NULL,
  last_ok_at  TEXT,
  last_run_at TEXT,
  fails       INTEGER NOT NULL DEFAULT 0,
  backoff_ms  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hub_scan_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  window_from TEXT NOT NULL,
  window_to   TEXT NOT NULL,
  messages    INTEGER NOT NULL DEFAULT 0,
  pages       INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE TABLE IF NOT EXISTS hub_scan_watchlist (
  scope       TEXT PRIMARY KEY,
  title       TEXT,
  single_chat INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  score       REAL NOT NULL DEFAULT 0,
  reason_json TEXT,
  added_at    TEXT NOT NULL,
  decided_at  TEXT
);
CREATE TABLE IF NOT EXISTS hub_topics (
  topic_key TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  title     TEXT,
  first_at  TEXT,
  last_at   TEXT,
  count     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hub_topic_events (
  topic_key TEXT NOT NULL,
  ext_id    TEXT NOT NULL,
  PRIMARY KEY (topic_key, ext_id)
);
CREATE TABLE IF NOT EXISTS hub_topic_threads (
  topic_key TEXT NOT NULL,
  scope     TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'group',
  name      TEXT,
  role      TEXT NOT NULL DEFAULT 'discuss',
  added_at  TEXT NOT NULL,
  PRIMARY KEY (topic_key, scope)
);

-- 强提醒台账（见设计文档 docs/design.md「强提醒台账」）
-- ⚠️ 本目录是渠道无关核心：表名/字段一律用渠道无关命名（分层纪律见 layering.test.mjs）。
CREATE TABLE IF NOT EXISTS hub_ding_log (
  id                 TEXT PRIMARY KEY,
  ts                 TEXT NOT NULL,
  consumer           TEXT,
  requested_strength TEXT,
  endpoint           TEXT NOT NULL,
  ok                 INTEGER NOT NULL,
  downgraded         INTEGER NOT NULL DEFAULT 0,
  gate               TEXT,
  title              TEXT,
  error              TEXT,
  anchor_id          TEXT
);
CREATE INDEX IF NOT EXISTS idx_hub_ding_log_ts ON hub_ding_log(ts);
CREATE INDEX IF NOT EXISTS idx_hub_ding_log_consumer ON hub_ding_log(consumer, ts);
`;

/**
 * 轻量迁移：`CREATE TABLE IF NOT EXISTS` **不会给已存在的表加列** ⇒ 新列要显式 ALTER。
 * （dws-hub 已上生产库，不能靠「删表重建」。）
 */
function migrate(db) {
  const cols = (t) => db.query(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  const addIfMissing = (table, col, ddl) => {
    if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addIfMissing('hub_events', 'meta_json', 'meta_json TEXT');
  addIfMissing('hub_anchors', 'emoji_json', 'emoji_json TEXT');
  // 锚点所在会话（渠道侧会话标识；`ext_scope` 与 `ext_id` 同族，保持 hub 渠道无关）
  addIfMissing('hub_anchors', 'ext_scope', 'ext_scope TEXT');
  // 任务模型（scan docs/design.md）：domains 关注范围 + kind（task|inbox|observer）
  addIfMissing('hub_consumers', 'domains_json', 'domains_json TEXT');
  addIfMissing('hub_consumers', 'kind', "kind TEXT DEFAULT 'task'");
  // 主题模型（2026-11-06）：状态 + 元数据；出站消息投递状态
  addIfMissing('hub_topics', 'status', "status TEXT NOT NULL DEFAULT 'open'");
  addIfMissing('hub_topics', 'meta_json', 'meta_json TEXT');
  addIfMissing('hub_events', 'delivery', 'delivery TEXT');
  // 主题会话的渠道侧会话 id（单聊 scope=dm:<openId> 时，拉消息需要 conversationId）
  addIfMissing('hub_topic_threads', 'ext_ref', 'ext_ref TEXT');
}

/**
 * 打开（或创建）统一库并建表。**建表幂等**：重复调用无副作用（T1 验收项）。
 * @param {string} [path] 库路径（默认 {@link defaultDbPath}）
 */
export function openStore(path = defaultDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(SCHEMA);
  migrate(db);

  const nowIso = () => new Date().toISOString();

  const kv = {
    get(ns, key, dflt = null) {
      const row = db.query('SELECT value FROM kv_store WHERE ns = ? AND key = ?').get(ns, key);
      if (!row) return dflt;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },
    set(ns, key, value) {
      db.query(
        `INSERT INTO kv_store (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(ns, key, JSON.stringify(value ?? null), nowIso());
      return value;
    },
    /** 自增计数（限频闸用）：返回自增后的值。 */
    bump(ns, key, delta = 1) {
      return db.transaction(() => {
        const cur = Number(kv.get(ns, key, 0)) || 0;
        const next = cur + delta;
        kv.set(ns, key, next);
        return next;
      })();
    },
    del(ns, key) {
      db.query('DELETE FROM kv_store WHERE ns = ? AND key = ?').run(ns, key);
    },
    ns(ns) {
      return db.query('SELECT key, value FROM kv_store WHERE ns = ?').all(ns)
        .map((r) => [r.key, JSON.parse(r.value)]);
    },
  };

  const consumers = {
    upsert(c) {
      db.query(
        `INSERT INTO hub_consumers (name, created_at, targets, keywords, domains_json, kind, batch_window, on_event, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           targets = excluded.targets, keywords = excluded.keywords,
           domains_json = excluded.domains_json, kind = excluded.kind,
           batch_window = excluded.batch_window, on_event = excluded.on_event,
           enabled = excluded.enabled`,
      ).run(c.name, c.created_at || nowIso(), JSON.stringify(c.targets || []), c.keywords ? JSON.stringify(c.keywords) : null,
        c.domains ? JSON.stringify(c.domains) : null, c.kind || 'task',
        c.batch_window ?? 60, c.on_event, c.enabled === false ? 0 : 1);
      return consumers.byName(c.name);
    },
    byName(name) {
      const r = db.query('SELECT * FROM hub_consumers WHERE name = ?').get(name);
      return r ? hydrateConsumer(r) : null;
    },
    all({ enabledOnly = true } = {}) {
      const rows = enabledOnly
        ? db.query('SELECT * FROM hub_consumers WHERE enabled = 1 ORDER BY name').all()
        : db.query('SELECT * FROM hub_consumers ORDER BY name').all();
      return rows.map(hydrateConsumer);
    },
    remove(name) {
      db.query('DELETE FROM hub_consumers WHERE name = ?').run(name);
    },
  };

  const events = {
    /** 幂等插入（`ext_id` 主键去重）：返回 true 表示**新事件**。 */
    insert(e) {
      const res = db.query(
        `INSERT OR IGNORE INTO hub_events (ext_id, scope, sender, text, at, source, reply_to, outbound, dispatched_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.ext_id, e.scope, e.sender ?? null, e.text ?? null, e.at, e.source, e.reply_to ?? null,
        e.outbound ? 1 : 0, null, e.meta ? JSON.stringify(e.meta) : null);
      return res.changes > 0;
    },
    byExtId(id) {
      return hydrateEvent(db.query('SELECT * FROM hub_events WHERE ext_id = ?').get(id));
    },
    /** 合并写入事件的 `meta`（消费者需要知道「这条事件属于哪个锚点」，才能回结果成链）。 */
    setMeta(extId, patch) {
      const cur = events.byExtId(extId);
      if (!cur) return null;
      const meta = { ...(cur.meta || {}), ...patch };
      db.query('UPDATE hub_events SET meta_json = ? WHERE ext_id = ?').run(JSON.stringify(meta), extId);
      return meta;
    },
    /** 游标之后的事件（**按消费者游标**取，不看全局 dispatched 标记）—— 崩溃后可补派。 */
    since(sinceIso) {
      return db.query('SELECT * FROM hub_events WHERE at > ? ORDER BY at').all(sinceIso).map(hydrateEvent);
    },
    /** 未派发事件（按时间升序）—— 仅用于**可观测**（哪个事件还没被任何消费者取走）。 */
    pending({ scope = null } = {}) {
      const rows = scope
        ? db.query('SELECT * FROM hub_events WHERE dispatched_at IS NULL AND scope = ? ORDER BY at').all(scope)
        : db.query('SELECT * FROM hub_events WHERE dispatched_at IS NULL ORDER BY at').all();
      return rows.map(hydrateEvent);
    },
    markDispatched(extIds) {
      const stmt = db.query('UPDATE hub_events SET dispatched_at = ? WHERE ext_id = ?');
      const at = nowIso();
      for (const id of extIds) stmt.run(at, id);
    },
    /** 某 scope 在窗口内的事件数（通道能力自检用，docs/design.md）。 */
    countSince(scope, sinceIso) {
      return db.query('SELECT COUNT(*) AS n FROM hub_events WHERE scope = ? AND at >= ?').get(scope, sinceIso).n;
    },
  };

  const anchors = {
    insert(a) {
      db.query(
        `INSERT INTO hub_anchors (id, created_at, updated_at, consumer, strength, needs_decision, title, status, scope, ext_id, ext_scope, confirmed, context_json, replies_json, emoji_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id, a.created_at, a.updated_at, a.consumer, a.strength, a.needs_decision ? 1 : 0, a.title,
        a.status, a.scope, a.ext_id, a.ext_scope ?? null, a.confirmed ? 1 : 0,
        a.context ? JSON.stringify(a.context) : null, JSON.stringify(a.replies || []),
        a.emoji ? JSON.stringify(a.emoji) : null);
      return anchors.byId(a.id);
    },
    byId(id) {
      return hydrateAnchor(db.query('SELECT * FROM hub_anchors WHERE id = ?').get(id));
    },
    byExtId(extId) {
      return hydrateAnchor(db.query('SELECT * FROM hub_anchors WHERE ext_id = ?').get(extId));
    },
    byStatus(status) {
      return db.query('SELECT * FROM hub_anchors WHERE status = ? ORDER BY created_at').all(status).map(hydrateAnchor);
    },
    update(id, patch) {
      const cur = anchors.byId(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updated_at: nowIso() };
      db.query(
        `UPDATE hub_anchors SET updated_at = ?, status = ?, confirmed = ?, replies_json = ?, context_json = ?, emoji_json = ?
         WHERE id = ?`,
      ).run(next.updated_at, next.status, next.confirmed ? 1 : 0, JSON.stringify(next.replies || []),
        next.context ? JSON.stringify(next.context) : null,
        next.emoji ? JSON.stringify(next.emoji) : null, id);
      return anchors.byId(id);
    },
    /** 建锚点用的每日序号（`anchor-YYYY-MM-DD-NNN`）。 */
    nextSeq(day) {
      return kv.bump('anchors', `seq:${day}`, 1);
    },
  };

  /**
   * 强提醒台账（每次通知一行，成功/降级/全失败都记）。
   * ⚠️ 调用方（notify）**必须**把写入包在 try/catch 里：台账故障不得影响发送主链路。
   */
  const dingLog = {
    insert(row) {
      const ts = row.ts || nowIso();
      const id = row.id || `dl-${ts.replace(/[-:.]/g, '').replace('Z', '')}-${Math.random().toString(36).slice(2, 8)}`;
      db.query(
        `INSERT OR REPLACE INTO hub_ding_log
           (id, ts, consumer, requested_strength, endpoint, ok, downgraded, gate, title, error, anchor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ts, row.consumer ?? null, row.requested_strength ?? null, row.endpoint || 'none',
        row.ok ? 1 : 0, row.downgraded ? 1 : 0, row.gate ?? null,
        row.title == null ? null : String(row.title).slice(0, 200), row.error ?? null, row.anchor_id ?? null);
      return dingLog.byId(id);
    },
    byId(id) {
      return hydrateDingLog(db.query('SELECT * FROM hub_ding_log WHERE id = ?').get(id));
    },
    /**
     * 按时间倒序查台账。
     * @param {string|null} since 起始 ISO 时间（默认最近 24h）
     * @param {string|null} consumer 只查某消费者
     * @param {number} limit 条数上限（默认 50，夹在 1..500）
     */
    list({ since = null, consumer = null, limit = 50 } = {}) {
      const sinceIso = since || new Date(Date.now() - 24 * 3600e3).toISOString();
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const where = ['ts >= ?'];
      const params = [sinceIso];
      if (consumer) { where.push('consumer = ?'); params.push(consumer); }
      params.push(lim);
      return db.query(
        `SELECT * FROM hub_ding_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
      ).all(...params).map(hydrateDingLog);
    },
  };

  return {
    path, db, kv, consumers, events, anchors, dingLog,
    txn: (fn) => db.transaction(fn)(),
    /** 测试用：内存库自检。 */
    close: () => db.close(),
    _schema: SCHEMA,
  };
}

function hydrateConsumer(r) {
  return {
    name: r.name, created_at: r.created_at,
    targets: JSON.parse(r.targets || '[]'),
    keywords: r.keywords ? JSON.parse(r.keywords) : null,
    domains: r.domains_json ? JSON.parse(r.domains_json) : null,
    kind: r.kind || 'task',
    batch_window: r.batch_window, on_event: r.on_event, enabled: !!r.enabled,
  };
}

function hydrateDingLog(r) {
  if (!r) return null;
  return {
    id: r.id, ts: r.ts, consumer: r.consumer,
    requested_strength: r.requested_strength, endpoint: r.endpoint,
    ok: !!r.ok, downgraded: !!r.downgraded, gate: r.gate,
    title: r.title, error: r.error, anchor_id: r.anchor_id,
  };
}

function hydrateEvent(r) {
  if (!r) return null;
  return {
    ext_id: r.ext_id, scope: r.scope, sender: r.sender, text: r.text, at: r.at,
    source: r.source, reply_to: r.reply_to, outbound: !!r.outbound, dispatched_at: r.dispatched_at,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
  };
}

function hydrateAnchor(r) {
  if (!r) return null;
  return {
    id: r.id, created_at: r.created_at, updated_at: r.updated_at, consumer: r.consumer,
    strength: r.strength, needs_decision: !!r.needs_decision, title: r.title, status: r.status,
    scope: r.scope, ext_id: r.ext_id, ext_scope: r.ext_scope ?? null, confirmed: !!r.confirmed,
    // ⚠️ 向后兼容：历史锚点的 context 曾以 JSON 字符串直接落库（二次编码）→ 这里再解一层，
    //    保证 `anchor.context` 读回**永远是对象**（下游按对象取 `sent_to` / `ref_msg_id`）。
    context: parseContext(r.context_json),
    emoji: r.emoji_json ? JSON.parse(r.emoji_json) : null,
    replies: JSON.parse(r.replies_json || '[]'),
  };
}

/** 解 context：`null` / 对象 / （历史）被二次编码的 JSON 字符串 都归一成对象。 */
function parseContext(raw) {
  if (!raw) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return raw; }
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}
