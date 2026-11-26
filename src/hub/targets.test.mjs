/**
 * consumers --targets 白名单（docs/design.md）
 */
import { describe, expect, test } from 'bun:test';
import { parseTargets } from './targets.mjs';

describe('parseTargets 白名单', () => {
  test('合法：self / group:<cid> / direct:<uid> / atme:* / atme:chat:<cid> / atme:user:<uid>', () => {
    expect(parseTargets(['self'])).toEqual(['self']);
    expect(parseTargets(['group:cid1'])).toEqual(['group:cid1']);
    expect(parseTargets(['direct:u1'])).toEqual(['direct:u1']);
    expect(parseTargets(['atme:*'])).toEqual(['atme:*']);
    expect(parseTargets(['atme:chat:cid1'])).toEqual(['atme:chat:cid1']);
    expect(parseTargets(['atme:user:u1'])).toEqual(['atme:user:u1']);
  });

  test('通配 dispatch：group:* / direct:* / * 接受但不参与轮询', () => {
    expect(parseTargets(['group:*'])).toEqual(['group:*']);
    expect(parseTargets(['*'])).toEqual(['*']);
  });

  test('非法：裸 atme / chat:<cid> / 空', () => {
    expect(() => parseTargets(['atme'])).toThrow();
    expect(() => parseTargets(['chat:cid1'])).toThrow();
    expect(() => parseTargets([''])).toThrow();
  });
});
