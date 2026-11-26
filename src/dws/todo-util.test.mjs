/**
 * todo 纯工具单测（覆盖 2026-11-25 评审发现的两个真实缺陷）
 *
 * 跑法：`bun test src/dws/todo-util.test.mjs`
 */
import { describe, expect, test } from 'bun:test';
import { findDuplicate, isDone, toIso } from './todo-util.mjs';

describe('toIso / 日期容错（原实现遇字符串会抛 RangeError）', () => {
  test('ms 数值', () => {
    expect(toIso(1796083200000)).toBe('2026-12-01T00:00:00.000Z');
  });

  test('秒级数值按秒解释', () => {
    expect(toIso(1796083200)).toBe('2026-12-01T00:00:00.000Z');
  });

  test('ms 数字字符串', () => {
    expect(toIso('1796083200000')).toBe('2026-12-01T00:00:00.000Z');
  });

  test('ISO 字符串（不抛）', () => {
    expect(toIso('2026-12-01T08:00:00+08:00')).toBe('2026-12-01T00:00:00.000Z');
  });

  test('纯日期字符串（不抛）', () => {
    expect(toIso('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
  });

  test('空值与非法值 → null（绝不抛）', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso('不是日期')).toBeNull();
  });
});

describe('isDone / 三种返回形态', () => {
  test('done / finished / finalStatusStage', () => {
    expect(isDone({ done: true })).toBe(true);
    expect(isDone({ finished: true })).toBe(true);
    expect(isDone({ finalStatusStage: '2' })).toBe(true);
    expect(isDone({ finalStatusStage: 1 })).toBe(false);
    expect(isDone({})).toBe(false);
    expect(isDone(null)).toBe(false);
  });
});

describe('findDuplicate / 只认未完成', () => {
  const todos = [
    { subject: '周报复核 2026-W47', done: true },
    { subject: '周报复核 2026-W48', done: false },
    { title: '另一条（title 字段）' },
  ];

  test('已完成同名不阻塞重建', () => {
    const dup = findDuplicate(todos, '周报复核 2026-W47');
    expect(dup).toBeNull();
  });

  test('未完成同名命中', () => {
    expect(findDuplicate(todos, '周报复核 2026-W48')).toMatchObject({ subject: '周报复核 2026-W48' });
  });

  test('兼容 title 字段', () => {
    expect(findDuplicate(todos, '另一条（title 字段）')).toMatchObject({ title: '另一条（title 字段）' });
  });

  test('空标题 → null（不去重）', () => {
    expect(findDuplicate(todos, '')).toBeNull();
  });
});
