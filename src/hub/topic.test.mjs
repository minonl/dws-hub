import { describe, expect, test } from 'bun:test';

import { openStore } from './store.mjs';
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
  setTopicStatus,
  topicStats,
} from './topic.mjs';

const MR = 'mr:group/repo!42';

function fresh() {
  return openStore(':memory:');
}

describe('topic 基础模型', () => {
  test('normalizeTopicKey：URI 风格通过，自由字符串拒绝', () => {
    expect(normalizeTopicKey(MR)).toBe(MR);
    expect(() => normalizeTopicKey('随便一个名字')).toThrow(/URI 风格/);
  });

  test('add/get/list + 状态流转', () => {
    const s = fresh();
    addTopic(s, { key: MR, title: '示例修复' });
    const t = getTopic(s, MR);
    expect(t.title).toBe('示例修复');
    expect(t.kind).toBe('mr');
    expect(t.status).toBe('open');
    setTopicStatus(s, MR, 'done');
    expect(getTopic(s, MR).status).toBe('done');
    expect(listTopics(s, { status: 'done' }).length).toBe(1);
    expect(listTopics(s, { status: 'open' }).length).toBe(0);
    s.close();
  });

  test('linkThread 幂等 + 多会话', () => {
    const s = fresh();
    addTopic(s, { key: MR });
    linkThread(s, { topicKey: MR, scope: 'cid-group-1', name: '示例群' });
    linkThread(s, { topicKey: MR, scope: 'cid-group-1', name: '示例群', role: 'notify' });
    linkThread(s, { topicKey: MR, scope: 'dm:open-1', kind: 'direct', name: '示例乙' });
    const th = listThreads(s, MR);
    expect(th.length).toBe(2);
    expect(th.find((x) => x.scope === 'cid-group-1').role).toBe('notify');
    s.close();
  });
});

describe('消息账本与时间线', () => {
  test('recordMessage：入站/出站、计数、跨会话 feed', () => {
    const s = fresh();
    addTopic(s, { key: MR });
    linkThread(s, { topicKey: MR, scope: 'cid-g' });
    recordMessage(s, { topicKey: MR, scope: 'cid-g', extId: 'm1', text: '看下这个 MR', sender: '张三', at: '2026-11-06T10:00:00Z' });
    recordMessage(s, { topicKey: MR, scope: 'cid-g', extId: 'm2', direction: 'out', text: '收到，我评一下', at: '2026-11-06T10:05:00Z', delivery: 'sent' });
    expect(getTopic(s, MR).count).toBe(2);
    const feed = feedTopic(s, { topicKey: MR });
    expect(feed.map((m) => m.ext_id)).toEqual(['m1', 'm2']);
    expect(feed[1].direction).toBe('out');
    expect(feed[1].delivery).toBe('sent');
    s.close();
  });

  test('feedTopic since 过滤', () => {
    const s = fresh();
    addTopic(s, { key: MR });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'old', at: '2026-10-01T00:00:00Z' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'new', at: '2026-11-06T00:00:00Z' });
    expect(feedTopic(s, { topicKey: MR, since: '2026-11-01T00:00:00Z' }).map((m) => m.ext_id)).toEqual(['new']);
    s.close();
  });
});

describe('撤回候选（只返回候选，不执行）', () => {
  test('只含本主题出站消息；match 过滤；last 截断', () => {
    const s = fresh();
    addTopic(s, { key: MR });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'in1', text: '客户说不行' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'out1', direction: 'out', text: '抱歉，是参数问题', at: '2026-11-06T10:00:00Z' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'out2', direction: 'out', text: '已修复，请复验', at: '2026-11-06T10:10:00Z' });
    // 其它主题的消息不得出现
    addTopic(s, { key: 'issue:1' });
    recordMessage(s, { topicKey: 'issue:1', scope: 'c', extId: 'out-other', direction: 'out', text: '别的主题' });

    const all = recallCandidates(s, { topicKey: MR });
    expect(all.map((c) => c.ext_id)).toEqual(['out2', 'out1']);
    const filtered = recallCandidates(s, { topicKey: MR, match: '参数' });
    expect(filtered.map((c) => c.ext_id)).toEqual(['out1']);
    expect(recallCandidates(s, { topicKey: MR, last: 1 }).length).toBe(1);
    s.close();
  });
});

describe('投递状态与统计', () => {
  test('markDelivery + topicStats', () => {
    const s = fresh();
    addTopic(s, { key: MR });
    linkThread(s, { topicKey: MR, scope: 'c' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'o1', direction: 'out', delivery: 'sent' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'o2', direction: 'out', delivery: 'failed' });
    recordMessage(s, { topicKey: MR, scope: 'c', extId: 'i1' });
    expect(topicStats(s, MR)).toEqual({ threads: 1, messages: 3, outbound: 2, undelivered: 1 });
    markDelivery(s, { extId: 'o2', delivery: 'delivered' });
    expect(topicStats(s, MR).undelivered).toBe(0);
    s.close();
  });
});


describe('自动发现（discoverTopics）', () => {
  test('未归属消息按 extractor 建主题/会话/关联；已归属不重复', () => {
    const s = fresh();
    s.db
      .query('INSERT INTO hub_events (ext_id, scope, sender, text, at, source, outbound) VALUES (?,?,?,?,?,?,0)')
      .run('auto1', 'cid-g', '张三', '看下 https://code.example.com/group/repo/-/merge_requests/42', '2026-11-06T10:00:00Z', 'test');
    const extractor = (t) => (t.includes('merge_requests/42') ? [{ key: 'mr:group/repo!42' }] : []);
    const found = discoverTopics(s, { extractor });
    expect(found.map((f) => f.topicKey)).toEqual(['mr:group/repo!42']);
    expect(getTopic(s, 'mr:group/repo!42').count).toBe(1);
    expect(listThreads(s, 'mr:group/repo!42')[0].scope).toBe('cid-g');
    // 再跑一次：已归属 → 不再重复
    expect(discoverTopics(s, { extractor }).length).toBe(0);
    s.close();
  });

  test('dry-run 不落库', () => {
    const s = fresh();
    s.db
      .query('INSERT INTO hub_events (ext_id, scope, text, at, source, outbound) VALUES (?,?,?,?,?,0)')
      .run('auto2', 'cid-g', 'issue 768510', '2026-11-06T10:00:00Z', 'test');
    const found = discoverTopics(s, { extractor: () => [{ key: 'issue:768510' }], dryRun: true });
    expect(found.length).toBe(1);
    expect(getTopic(s, 'issue:768510')).toBeNull();
    s.close();
  });
});
