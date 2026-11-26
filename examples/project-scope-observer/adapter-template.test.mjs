#!/usr/bin/env bun
/**
 * 采集器骨架的契约自测（不依赖 dws / 网络）
 *
 * 为什么要有它：这类适配器最常见的事故是「**字段名猜错 → 静默不落档**」，
 * 不报错、不失败、游标照常推进 ⇒ 消息永久丢失且无人发现。
 * 本测试用**真实契约字段**喂事件，断言「能落档 / 能把关」。
 *
 * 运行（随 dws-hub 全量单测一起跑）：
 *   bun test
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(HERE, 'adapter-template.mjs'), 'utf8');

/** 每个用例独立造一个最小项目结构，互不干扰 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'proj-observer-'));
  const itemsDir = join(root, 'items');
  const opsDir = join(itemsDir, 'ops');
  mkdirSync(opsDir, { recursive: true });

  // 把模板的 ITEMS_DIR 指向沙箱（模板默认是 `join(HERE, '..')`）
  const script = join(opsDir, 'adapter.mjs');
  writeFileSync(
    script,
    TEMPLATE.replace(
      /^const ITEMS_DIR = join\(HERE, '\.\.'\);$/m,
      `const ITEMS_DIR = ${JSON.stringify(itemsDir)};`,
    ),
  );

  // 同群两个事项：一个活跃、一个已关闭（用于验证「唯一活跃」判定）
  writeFileSync(
    join(itemsDir, 'RQ-001-demo.md'),
    `---\nrq: RQ-001\nstatus: blocked\ngroup: '#demo / cidDEMO=='\n---\n\n## 事件流\n\n| 时间 | 来源 | 类型 | 摘要 | 证据 |\n| --- | --- | --- | --- | --- |\n\n## 待确认项\n\n| # | 问题 |\n| --- | --- |\n`,
  );
  writeFileSync(
    join(itemsDir, 'RQ-002-closed.md'),
    `---\nrq: RQ-002\nstatus: closed\ngroup: '#demo / cidDEMO=='\n---\n\n## 事件流\n\n## 待确认项\n`,
  );

  return {
    root,
    itemsDir,
    /** 跑一次采集器；返回 stdout */
    run(events) {
      return execFileSync('bun', [script], {
        input: JSON.stringify({ consumer: 'demo', events }),
        encoding: 'utf8',
      });
    },
    itemText(name = 'RQ-001-demo.md') {
      return readFileSync(join(itemsDir, name), 'utf8');
    },
    unmatched() {
      const p = join(itemsDir, 'unmatched.md');
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    },
  };
}

/** 造一条符合**真实契约**的事件 */
function ev(over = {}) {
  return {
    ext_id: 'm1',
    scope: 'group:cidDEMO==',
    sender: '张三',
    text: '这个我们加一下',
    at: '2026-10-19T08:50:00.000Z',
    source: 'poll',
    reply_to: null,
    outbound: false,
    meta: { conversation_id: 'cidDEMO==' },
    ...over,
  };
}

describe('project-scope-observer 骨架契约', () => {
  it('真实契约字段（ext_id/text/meta.conversation_id）能落档', () => {
    const sb = makeSandbox();
    sb.run([ev()]);
    const f = sb.itemText();
    // 正文与发送人**都要**断言：只查 sender 抓不到「text 字段名猜错」
    expect(f).toContain('张三');
    expect(f).toContain('这个我们加一下');
  });

  it('outbound=true 被跳过（防自环）', () => {
    const sb = makeSandbox();
    const before = sb.itemText();
    sb.run([ev({ ext_id: 'm2', text: '我自己发的', outbound: true })]);
    expect(sb.itemText()).toBe(before);
  });

  it('跨群且无显式编号 → 写 unmatched，不硬塞', () => {
    const sb = makeSandbox();
    sb.run([ev({ ext_id: 'm3', text: '别的群随便说一句', meta: { conversation_id: 'cidOTHER==' } })]);
    expect(sb.unmatched()).toContain('别的群');
    expect(sb.itemText()).not.toContain('别的群');
  });

  it('显式编号跨群也能归属', () => {
    const sb = makeSandbox();
    sb.run([ev({ ext_id: 'm4', text: 'RQ-001 这个我们加好了', meta: { conversation_id: 'cidOTHER==' } })]);
    expect(sb.itemText()).toContain('RQ-001 这个我们加好了');
    expect(sb.unmatched()).toBe(''); // 不应进 unmatched
  });

  it('ext_id 去重（重复投递不重复写）', () => {
    const sb = makeSandbox();
    sb.run([ev()]);
    const once = sb.itemText();
    sb.run([ev()]); // 同 ext_id 再投一次
    expect(sb.itemText()).toBe(once);
  });

  it('有未匹配消息时退出码仍为 0（避免无限重试）', () => {
    const sb = makeSandbox();
    // 不抛异常即代表退出码 0
    expect(() =>
      sb.run([ev({ ext_id: 'm6', text: '无处归属', meta: { conversation_id: 'cidUNKNOWN==' } })]),
    ).not.toThrow();
  });
});
