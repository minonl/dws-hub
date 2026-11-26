/**
 * dws-hub · 会话跟进订阅（渠道无关）
 *
 * 能力：把「某个 agent 会话」与「明确的钉钉群 / 私聊」建立订阅关系，
 * 由 hub 的 `session-follow` 消费者把该会话的新消息投递到调用方自己的 inbox（`DWS_HUB_INBOX_CMD`）。
 *
 * 设计：`docs/design.md`
 * 前后端边界：
 *   - 本文件只认识 scope（`group:<cid>` / `direct:<uid>`）与事件结构，不认识 dws / 钉钉 API；
 *   - 实际拉取/发送由 `../dws/` 与 `../consumers/session-follow.mjs` 负责。
 *
 * 注册表：`$DWS_HUB_HOME/consumers/session-follows.json`（可用 `DWS_HUB_FOLLOWS` 覆盖，测试用）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { followsPath } from '../config.mjs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FOLLOWS_SCHEMA = 1;

const SESSION_RE = /^ses_[A-Za-z0-9_.-]{1,120}$/;
const SCOPE_RE = /^(group|direct):.+$/;

export function defaultFollowsPath(env = process.env) {
  return followsPath(env);
}

function nowIso() {
  return new Date().toISOString();
}

export function validateSession(session) {
  const s = String(session || '').trim();
  if (!SESSION_RE.test(s) || s.includes('..')) {
    throw new Error(`E_SESSION: 非法会话标识 ${s || '(empty)'}（应形如 ses_xxx）`);
  }
  return s;
}

export function validateScope(scope) {
  const s = String(scope || '').trim();
  if (!SCOPE_RE.test(s)) {
    throw new Error(`E_SCOPE: 非法 scope「${s || '(empty)'}」（只接受 group:<chatId> / direct:<userId>）`);
  }
  return s;
}

export function emptyFollows() {
  return { schema: FOLLOWS_SCHEMA, updated_at: nowIso(), sessions: {} };
}

/** 读注册表；不存在 / 损坏 → 空表（损坏时保留 `.broken-<ts>` 备份，不静默丢）。 */
export function loadFollows(path = defaultFollowsPath()) {
  if (!existsSync(path)) return emptyFollows();
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    if (!d || typeof d !== 'object' || typeof d.sessions !== 'object' || !d.sessions) return emptyFollows();
    for (const [sid, entry] of Object.entries(d.sessions)) {
      if (!entry || typeof entry !== 'object') delete d.sessions[sid];
      if (!entry.scopes || typeof entry.scopes !== 'object') entry.scopes = {};
    }
    return { schema: FOLLOWS_SCHEMA, updated_at: d.updated_at || nowIso(), sessions: d.sessions };
  } catch {
    try {
      renameSync(path, `${path}.broken-${Date.now()}`);
    } catch {}
    return emptyFollows();
  }
}

/** 原子写注册表（先写临时文件再 rename）。 */
export function saveFollows(doc, path = defaultFollowsPath()) {
  const out = {
    schema: FOLLOWS_SCHEMA,
    updated_at: nowIso(),
    sessions: doc.sessions || {},
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, path);
  return out;
}

/**
 * 新增/更新一条会话订阅。
 * 同一 (session, scope) 重复添加 = 更新 atme_only/label，不重复。
 */
export function addFollow(doc, { session, scope, atmeOnly = false, label = '' } = {}) {
  const sid = validateSession(session);
  const sc = validateScope(scope);
  const ts = nowIso();
  const entry = doc.sessions[sid] || { enabled: true, scopes: {}, created_at: ts };
  entry.enabled = true;
  entry.updated_at = ts;
  entry.scopes[sc] = {
    atme_only: Boolean(atmeOnly),
    ...(label ? { label: String(label) } : {}),
    added_at: entry.scopes[sc]?.added_at || ts,
    updated_at: ts,
  };
  doc.sessions[sid] = entry;
  return doc;
}

/**
 * 删除订阅：
 * - `--all`：删整个会话；
 * - 指定 scope：只删该 scope；
 * - 都不给：删整个会话。
 */
export function removeFollow(doc, { session, scope, all = false } = {}) {
  const sid = validateSession(session);
  if (!doc.sessions[sid]) return { doc, removed: 0 };
  if (!all && scope) {
    const sc = validateScope(scope);
    if (!doc.sessions[sid].scopes[sc]) return { doc, removed: 0 };
    delete doc.sessions[sid].scopes[sc];
    if (!Object.keys(doc.sessions[sid].scopes).length) delete doc.sessions[sid];
    return { doc, removed: 1 };
  }
  delete doc.sessions[sid];
  return { doc, removed: 1 };
}

/** 所有启用会话的 scope 并集（consumer targets 用）。 */
export function allScopes(doc) {
  const set = new Set();
  for (const entry of Object.values(doc.sessions || {})) {
    if (entry.enabled === false) continue;
    for (const sc of Object.keys(entry.scopes || {})) set.add(sc);
  }
  return [...set].sort();
}

/** 是否存在「只看 @我」的订阅（决定 consumer 是否要额外订阅 `atme:*`）。 */
export function hasAtmeOnly(doc) {
  return Object.values(doc.sessions || {}).some(
    (e) => e.enabled !== false && Object.values(e.scopes || {}).some((s) => s.atme_only),
  );
}

/**
 * 一条入站事件应投递给哪些会话（按 scope 精确匹配；atme_only 要求 mentionMe）。
 * @returns {{session:string, scope:string, entry:object}[]}
 */
export function sessionsForEvent(doc, event) {
  if (!event || event.outbound) return [];
  const scope = String(event.scope || '');
  if (!scope) return [];
  if (event.meta?.aiSendFlag) return []; // 我们自己 API 发出的消息回执，防止自激
  const hits = [];
  for (const [session, entry] of Object.entries(doc.sessions || {})) {
    if (entry.enabled === false) continue;
    const hit = entry.scopes?.[scope];
    if (!hit) continue;
    if (hit.atme_only && event.meta?.mentionMe !== true) continue;
    hits.push({ session, scope, entry: hit });
  }
  return hits;
}

/** 供 CLI 展示：扁平化输出。 */
export function listFollows(doc) {
  const rows = [];
  for (const [session, entry] of Object.entries(doc.sessions || {})) {
    for (const [scope, s] of Object.entries(entry.scopes || {})) {
      rows.push({
        session,
        scope,
        atme_only: Boolean(s.atme_only),
        label: s.label || '',
        enabled: entry.enabled !== false,
        updated_at: s.updated_at || entry.updated_at || '',
      });
    }
  }
  return rows.sort((a, b) => `${a.session}:${a.scope}`.localeCompare(`${b.session}:${b.scope}`));
}
