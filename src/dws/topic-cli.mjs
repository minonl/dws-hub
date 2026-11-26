#!/usr/bin/env bun
/**
 * topic-cli.mjs —— 主题（Topic）命令行（2026-11-06，最小闭环）
 *
 * 设计：docs/design.md
 *
 * 用法：
 *   topic add    <key> [--title "…"] [--status open]
 *   topic link   <key> --thread <scope> [--kind group|direct] [--name "…"] [--role discuss]
 *   topic list   [--status …] [--limit N]
 *   topic show   <key>
 *   topic feed   <key> [--since 7d|ISO] [--limit N]
 *   topic reply  <key> "<正文>" [--thread <scope>] [--at <openId>] [--dry-run]
 *   topic recall <key> [--match "…"] [--last N] [--confirm <extId>] [--yes]
 *   topic status <key> [--refresh]
 *
 * 退出码：0 成功 / 1 业务失败 / 2 用法错误
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openStore } from '../hub/store.mjs';
import {
  addTopic,
  discoverTopics,
  feedTopic,
  getTopic,
  linkThread,
  listThreads,
  listTopics,
  markDelivery,
  normalizeTopicKey,
  recallCandidates,
  recordMessage,
  topicStats,
} from '../hub/topic.mjs';
import { pullThreadMessages, querySendStatus, recallMessage, sendToThread } from './topic-ops.mjs';
import { extractIssueUrls, extractMrUrls, issueKeyOf, mrKeyOf } from '../lib/extract.mjs';

function fail(msg, code = 2) {
  const e = new Error(msg);
  e.exitCode = code;
  throw e;
}

function parse(args) {
  const out = { _: [], at: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title') out.title = args[++i];
    else if (a === '--status') out.status = args[++i];
    else if (a === '--thread') out.thread = args[++i];
    else if (a === '--kind') out.kind = args[++i];
    else if (a === '--name') out.name = args[++i];
    else if (a === '--role') out.role = args[++i];
    else if (a === '--limit') out.limit = Number(args[++i]);
    else if (a === '--since') out.since = args[++i];
    else if (a === '--match') out.match = args[++i];
    else if (a === '--last') out.last = Number(args[++i]);
    else if (a === '--confirm') out.confirm = args[++i];
    else if (a === '--at') out.at.push(args[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--cmd') out.cmd = args[++i];
    else if (a === '--conversation-id') out.conversationId = args[++i];
    else if (a === '--off') out.off = true;
    else if (a === '--pull') out.pull = true;
    else if (a === '--yes') out.yes = true;
    else if (a.startsWith('--')) fail(`未知参数：${a}`);
    else out._.push(a);
  }
  return out;
}

function sinceIso(spec) {
  if (!spec) return null;
  const m = /^(\d+)([dh])$/.exec(spec);
  if (!m) return spec;
  const ms = Number(m[1]) * (m[2] === 'd' ? 86400_000 : 3600_000);
  return new Date(Date.now() - ms).toISOString();
}

function printTopic(t) {
  if (!t) return console.log('（无此主题）');
  console.log(`${t.key}  [${t.status}]  ${t.title || ''}`);
  console.log(`  kind=${t.kind}  会话=${listThreads(globalThis.__store, t.key).length}  消息=${t.count}  最近=${t.last_at || '-'}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const store = openStore();
  globalThis.__store = store;
  const a = parse(rest);

  try {
    switch (cmd) {
      case 'add': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic add <key> [--title …]'));
        const t = addTopic(store, { key, title: a.title, status: a.status || 'open' });
        printTopic(t);
        return 0;
      }
      case 'link': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic link <key> --thread <scope>'));
        if (!a.thread) fail('缺少 --thread <scope>（群 conversationId 或 dm:<openDingTalkId>）');
        const th = linkThread(store, {
          topicKey: key,
          scope: a.thread,
          kind: a.kind || (String(a.thread).startsWith('dm:') ? 'direct' : 'group'),
          name: a.name,
          role: a.role || 'discuss',
          extRef: a.conversationId || null,
        });
        console.log(`✓ ${key} ← ${th.scope}（${th.kind}/${th.role}）`);
        return 0;
      }
      case 'list': {
        const rows = listTopics(store, { status: a.status || null, limit: a.limit || 50 });
        if (!rows.length) {
          console.log('（无主题）新建：dws-hub topic add <key> [--title …]');
          return 0;
        }
        for (const t of rows) printTopic(t);
        return 0;
      }
      case 'show': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic show <key>'));
        const t = getTopic(store, key);
        printTopic(t);
        for (const th of listThreads(store, key)) {
          console.log(`  - ${th.scope}  ${th.kind}/${th.role}  ${th.name || ''}`);
        }
        return 0;
      }
      case 'feed': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic feed <key> [--since 7d]'));
        const rows = feedTopic(store, { topicKey: key, since: sinceIso(a.since), limit: a.limit || 50 });
        for (const m of rows) {
          const dir = m.direction === 'out' ? '→' : '←';
          const del = m.delivery ? ` [${m.delivery}]` : '';
          console.log(`${m.at}  ${dir} ${m.scope}  ${m.sender || ''}${del}\n    ${String(m.text || '').replace(/\n/g, ' ').slice(0, 160)}`);
        }
        return 0;
      }
      case 'reply': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic reply <key> "<正文>" [--thread <scope>]'));
        const text = a._[1] || fail('缺少回复正文');
        const threads = listThreads(store, key);
        if (!threads.length) fail(`主题 ${key} 还没有关联会话，先 topic link`);
        const target = a.thread
          ? threads.find((t) => t.scope === a.thread) || fail(`主题未关联该会话：${a.thread}`)
          : threads.length === 1
            ? threads[0]
            : fail(`主题有 ${threads.length} 个会话，请用 --thread 指定`);
        if (a.dryRun) {
          console.log(`(dry-run) → ${target.scope}（${target.kind}）\n${text}`);
          return 0;
        }
        const r = await sendToThread({ scope: target.scope, kind: target.kind, text, at: a.at, uuid: `hub-${key}-${Date.now()}` });
        if (!r.ok) fail('发送失败（见上）', 1);
        if (r.messageId) {
          recordMessage(store, {
            topicKey: key,
            scope: target.scope,
            extId: r.messageId,
            direction: 'out',
            text,
            delivery: 'sent',
            meta: r.openTaskId ? { taskId: r.openTaskId } : null,
          });
        } else {
          console.log('⚠️ 发送成功但未解析到 messageId，未记账（可用 topic feed 核对）');
        }
        console.log(`✓ 已发送并记账（${r.messageId || 'no-id'}）`);
        return 0;
      }
      case 'recall': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic recall <key> [--match …] [--confirm <extId>]'));
        const cands = recallCandidates(store, { topicKey: key, match: a.match, last: a.last || 5 });
        if (!cands.length) {
          console.log('没有可撤回的出站消息（本主题）');
          return 0;
        }
        if (!a.confirm) {
          console.log(`候选（${cands.length} 条，dry-run）：`);
          for (const c of cands) {
            console.log(`  ${c.ext_id}  ${c.at}  ${c.scope}  [${c.delivery || '-'}]`);
            console.log(`      ${String(c.text || '').replace(/\n/g, ' ').slice(0, 140)}`);
          }
          console.log('\n确认某一条后执行：topic recall <key> --confirm <extId> --yes');
          return 0;
        }
        const hit = cands.find((c) => c.ext_id === a.confirm);
        if (!hit) fail(`--confirm ${a.confirm} 不在本主题候选内（拒绝执行）`, 1);
        if (!a.yes) {
          console.log(`将撤回：${hit.ext_id}  ${hit.at}  ${String(hit.text || '').slice(0, 80)}`);
          console.log('加 --yes 执行');
          return 0;
        }
        const r = await recallMessage({ msgId: hit.ext_id, conversationId: hit.scope.startsWith('dm:') ? undefined : hit.scope });
        if (!r.ok) fail('撤回失败（见上）', 1);
        markDelivery(store, { extId: hit.ext_id, delivery: 'recalled' });
        console.log(`✓ 已撤回 ${hit.ext_id}`);
        return 0;
      }
      case 'auto': {
        const found = discoverTopics(store, {
          extractor: (text) => {
            const out = [];
            for (const m of extractMrUrls(text)) out.push({ key: mrKeyOf(m) });
            for (const x of extractIssueUrls(text)) out.push({ key: issueKeyOf(x) });
            return out;
          },
          since: sinceIso(a.since),
          limit: a.limit || 500,
          dryRun: Boolean(a.dryRun),
        });
        if (!found.length) {
          console.log('没有可归入主题的消息（先 topic watch --pull 拉取消息）');
          return 0;
        }
        for (const f of found) console.log(`${a.dryRun ? '(dry-run) ' : ''}${f.topicKey}  ← ${f.scope}  ${f.extId}`);
        console.log(`${a.dryRun ? '将' : '已'}归入 ${new Set(found.map((f) => f.topicKey)).size} 个主题 / ${found.length} 条消息`);
        return 0;
      }
      case 'watch': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic watch <key> [--cmd "<回调>"] [--pull [--since 7d]] [--off]'));
        const threads = listThreads(store, key);
        if (!threads.length) fail(`主题 ${key} 还没有关联会话，先 topic link`);
        const consumerName = `topic-${key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

        if (a.pull) {
          let n = 0;
          for (const th of threads) {
            try {
              const msgs = await pullThreadMessages({ scope: th.scope, kind: th.kind, extRef: th.ext_ref, since: sinceIso(a.since), limit: a.limit || 50 });
              for (const m of msgs) {
                recordMessage(store, {
                  topicKey: key, scope: th.scope, extId: m.messageId, direction: 'in',
                  text: m.text, sender: m.sender, at: m.createTime,
                });
                n++;
              }
            } catch (e) {
              console.error(`  ⚠️ ${th.scope} 拉取失败：${String(e.message || e).slice(0, 140)}`);
            }
          }
          console.log(`✓ 拉取并入库 ${n} 条（${threads.length} 个会话）`);
          if (!a.cmd) return 0;
        }

        if (a.off) {
          store.db.query('UPDATE hub_consumers SET enabled = 0 WHERE name = ?').run(consumerName);
          console.log(`✓ 已停用监听 ${consumerName}`);
          return 0;
        }
        if (a.cmd) {
          store.consumers.upsert({
            name: consumerName,
            targets: threads.map((t) => t.scope),
            batch_window: a.limit || 60,
            on_event: a.cmd,
            kind: 'task',
            enabled: true,
          });
          console.log(`✓ 已注册监听 ${consumerName} → ${threads.length} 个会话（回调：${a.cmd}）`);
          console.log('  常驻消费由 dws-hub listen / service 负责；也可 topic watch --pull 手动拉取');
          return 0;
        }
        const c = store.consumers.byName(consumerName);
        console.log(`${key} 的监听：${c ? (c.enabled ? '已启用' : '已停用') : '未注册'}`);
        console.log(`  会话 ${threads.length} 个；注册：topic watch ${key} --cmd "<回调>"；拉取：topic watch ${key} --pull --since 7d`);
        return 0;
      }
      case 'status': {
        const key = normalizeTopicKey(a._[0] || fail('用法：topic status <key>'));
        const st = topicStats(store, key);
        console.log(`主题 ${key}：会话 ${st.threads} / 消息 ${st.messages} / 出站 ${st.outbound} / 未投递 ${st.undelivered}`);
        const outs = feedTopic(store, { topicKey: key, limit: 200 }).filter((m) => m.direction === 'out');
        for (const m of outs) {
          if (a.refresh && m.meta?.taskId) {
            try {
              const r = await querySendStatus({ openTaskId: m.meta.taskId });
              markDelivery(store, { extId: m.ext_id, delivery: r.ok ? 'delivered' : 'unknown' });
              m.delivery = r.ok ? 'delivered' : 'unknown';
            } catch {
              markDelivery(store, { extId: m.ext_id, delivery: 'unknown' });
              m.delivery = 'unknown';
            }
          }
          console.log(`  ${m.ext_id}  ${m.at}  [${m.delivery || '-'}]  ${String(m.text || '').replace(/\n/g, ' ').slice(0, 100)}`);
        }
        return 0;
      }
      default:
        console.log(`用法：
  topic add    <key> [--title "…"] [--status open]
  topic link   <key> --thread <scope> [--kind group|direct] [--name "…"] [--role discuss]
  topic list   [--status …] [--limit N]
  topic show   <key>
  topic feed   <key> [--since 7d|ISO] [--limit N]
  topic reply  <key> "<正文>" [--thread <scope>] [--at <openId>] [--dry-run]
  topic recall <key> [--match "…"] [--last N] [--confirm <extId>] [--yes]
  topic status <key> [--refresh]
  topic auto   [--since 7d|ISO] [--limit N] [--dry-run]     自动识别链接建主题
  topic watch  <key> [--cmd "<回调>"] [--pull] [--off]      注册/取消监听

  key 形如：mr:group/repo!42 / issue:group/repo#123 / adhoc:topic`);
        return cmd ? 2 : 0;
    }
  } finally {
    store.close();
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(`✗ ${e?.message || e}`);
      process.exit(e?.exitCode || (e?.usage ? 2 : 1));
    });
}
