#!/usr/bin/env node
/**
 * 项目级事项监听 · 采集器骨架（复制到项目仓后按注释替换占位符）
 *
 * ## 契约（照抄，别猜字段）
 * stdin: `{ "consumer": "<name>", "events": [ {ext_id, scope, sender, text, at,
 *         source, reply_to, outbound, meta:{conversation_id}} ] }`
 * 退出码: 0 = 成功（推进游标）；非 0 = 失败（不推进 + 退避重试，不丢消息）
 *
 * ## 四条硬约束（详见同目录 README 的「硬约束」一节）
 * C1 路径持久（注册器负责，不在本文件）
 * C2 注册时机（注册器负责）
 * C3 归属不猜：显式 ID > 同作用域唯一活跃事项 > unmatched 待分拣
 * C4 只采集不回复：**本文件绝不调用任何发送接口**
 *
 * ## 复制到项目仓后需替换
 *   ITEMS_DIR           → 事项文件目录（相对本文件：`..`）
 *   ITEM_ID_PATTERN     → 事项编号正则（如 /RQ-\d{3}/）
 *   ACTIVE_STATUSES     → 视为「活跃」的状态值
 *   appendRow()         → 落档格式（事件流表格列）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 项目相关配置（复制后替换）────────────────────────────────────────────────
const ITEMS_DIR = join(HERE, '..');            // 事项 md 所在目录
const ITEM_FILE_RE = /^RQ-\d+-.+\.md$/;        // 事项文件命名
const ITEM_ID_PATTERN = /RQ-\d{3}/g;           // 正文里的事项编号
const ACTIVE_STATUSES_EXCLUDED = ['closed', 'cancelled'];
const SEEN_FILE = join(HERE, '.seen-ids.json');
const UNMATCHED_FILE = join(ITEMS_DIR, 'unmatched.md');

const DRY = process.argv.includes('--dry-run');

// ── 读 stdin（dws-hub 投递）──────────────────────────────────────────────────
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return { events: [] };
  try {
    return JSON.parse(raw);
  } catch {
    console.error('[adapter] stdin 不是合法 JSON，忽略本次投递');
    return { events: [] };
  }
}

// ── 载入事项（frontmatter + 群）─────────────────────────────────────────────
function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function loadItems() {
  if (!existsSync(ITEMS_DIR)) return [];
  return readdirSync(ITEMS_DIR)
    .filter((f) => ITEM_FILE_RE.test(f))
    .map((f) => {
      const path = join(ITEMS_DIR, f);
      const fm = parseFrontmatter(readFileSync(path, 'utf8'));
      // 群字段约定：`#群名 / cidxxx==` 或纯 cid
      const gm = /^(.*?)\s*\/\s*(\S+)$/.exec(fm.group || '');
      return {
        path,
        id: fm.rq || fm.id || '',
        status: fm.status || '',
        groupId: gm ? gm[2].trim() : (fm.group || '').trim(),
      };
    });
}

// ── C3：归属判定（不猜）─────────────────────────────────────────────────────
function matchItem(ev, items) {
  const text = ev.text || '';
  const convId = ev.meta?.conversation_id || '';

  // ① 显式编号最可靠（跨群也认）
  const mentioned = new Set((text.match(ITEM_ID_PATTERN) || []).map((s) => s.trim()));
  if (mentioned.size === 1) {
    const id = [...mentioned][0];
    const hit = items.filter((i) => i.id === id);
    if (hit.length === 1) return hit[0];
  }
  if (mentioned.size > 1) return null;   // 同时提到多个 → 不猜

  // ② 同群 + 唯一活跃（**必须同时满足**，否则任意群都会归给唯一活跃事项）
  if (convId) {
    const active = items.filter(
      (i) =>
        i.groupId === convId &&
        !ACTIVE_STATUSES_EXCLUDED.includes(i.status) &&
        !(i.status || '').startsWith('closed'),
    );
    if (active.length === 1) return active[0];
  }

  // ③ 兜底：不猜
  return null;
}

// ── 去重（持久化，防重启后重复写）──────────────────────────────────────────
function loadSeen() {
  if (!existsSync(SEEN_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-500)));
}

function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 落档（复制后按项目格式替换）─────────────────────────────────────────────
/** 追加一行到事项文件的「事件流」表格末尾（即下一个 `## ` 之前） */
function appendRow(itemPath, ev) {
  const row = `| ${fmtTime(ev.at)} | 钉钉群 | 答复 | ${ev.sender || '未知'}：${(ev.text || '').slice(0, 200)} | ${ev.ext_id || '—'} |`;
  const content = readFileSync(itemPath, 'utf8');
  // 在「## 待确认项」之前插入（按项目实际章节名替换）
  const updated = content.replace(/\n(## 待确认项)/, `\n${row}\n\n$1`);
  if (updated === content) {
    console.error(`[adapter] 未找到锚点章节，跳过：${itemPath}`);
    return false;
  }
  writeFileSync(itemPath, updated);
  return true;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const payload = await readStdin();
const events = payload.events || [];
if (!events.length) {
  console.log('[adapter] 无事件');
  process.exit(0);
}

const items = loadItems();
const seen = loadSeen();
const unmatched = [];
let appended = 0;

for (const ev of events) {
  // 跳过本能力自己发出的消息（防自环）
  if (ev.outbound) continue;

  const id = ev.ext_id;
  if (id && seen.has(id)) continue;

  const text = (ev.text || '').replace(/\s+/g, ' ').trim();
  if (!text) continue;

  const target = matchItem(ev, items);
  if (!target) {
    unmatched.push(ev);
  } else if (!DRY && appendRow(target.path, ev)) {
    appended += 1;
  }
  if (id) seen.add(id);
}

// 未匹配落盘，待人工分拣（不硬塞）
if (unmatched.length && !DRY) {
  const header = existsSync(UNMATCHED_FILE)
    ? ''
    : '# 未匹配消息\n\n> 自动采集但无法唯一归属，需人工分拣。\n\n| 时间 | 群 | 发送人 | 内容 | 消息 ID |\n| --- | --- | --- | --- | --- |\n';
  if (header) writeFileSync(UNMATCHED_FILE, header);
  for (const ev of unmatched) {
    appendFileSync(
      UNMATCHED_FILE,
      `| ${fmtTime(ev.at)} | ${ev.meta?.conversation_id || ''} | ${ev.sender || ''} | ${(ev.text || '').slice(0, 200)} | ${ev.ext_id || '—'} |\n`,
    );
  }
  console.log(`[adapter] ${unmatched.length} 条无法归属 → unmatched.md`);
}

if (!DRY) saveSeen(seen);
console.log(`[adapter] 完成：追加 ${appended} 条，未匹配 ${unmatched.length} 条${DRY ? '（dry-run）' : ''}`);
// 退出码 0 = 推进游标；有未匹配**不算失败**（否则会无限重试同一批）
process.exit(0);
