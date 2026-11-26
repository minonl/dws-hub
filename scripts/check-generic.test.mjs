/**
 * check-generic 自测：门禁必须抓得到脏样本，也不能误伤干净样本。
 * 注意：本文件在门禁的 SKIP_FILES 里，所以这里可以写合成脏词。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './check-generic.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dws-hub-generic-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const clean = (root) => {
  try {
    return scan(root, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('check-generic', () => {
  test('干净样本：默认数据根 / 合成会话 id 不误伤', () => {
    const root = fixture({
      'src/a.mjs': 'const home = "~/.dws-hub";\nconst cid = "grp-1";\nconst x = "~/." + "config/x";\n',
      'src/b.mjs': 'const p1 = "/Users/alice/.dws-hub/db";\n',
      'README.md': '# dws-hub\n\nGeneric tool for the dws CLI.\n',
    });
    const { findings } = clean(root);
    expect(findings).toEqual([]);
  });

  test('结构规则：真实会话 id / 私有数据根 → 命中', () => {
    const root = fixture({
      'src/c.mjs': 'const cid = "cidAbCdEfGhIjKlMnOpQrStUvWxYz012345";\n',
      'src/d.mjs': 'const root = "~/.acme-agent";\n',
    });
    const { findings } = clean(root);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toContain('conversation-id');
    expect(rules).toContain('home-data-root');
  });

  test('结构规则：三段式展示名（姓名-部门-大区）→ 命中；带「示例」放行', () => {
    const root = fixture({
      'src/g.mjs': 'const s = "@{{某甲}}-{{某部门}}-{{某大区}}";\n'.replaceAll('{{','').replaceAll('}}',''),
      'src/h.mjs': 'const s = "@示例-张三-示例部门";\n',
    });
    try {
      const { findings } = scan(root, {});
      expect(findings.map((f) => f.rule)).toEqual(['display-name-3seg']);
      expect(findings[0].file).toBe('src/g.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('结构规则：长 base62 混合串 → 命中；含 example 的合成值放行', () => {
    const dirty = 'const rid = "' + 'Ab3'.repeat(8) + '";\n';           // 24 位混合
    const cleanLine = 'const rid = "ExampleOpenId0123456789ABCDEF";\n';
    const sneaky = 'const rid = "' + 'Ab3'.repeat(8) + '"; // example\n'; // 行内出现 example 不能放行
    const root = fixture({ 'src/k.mjs': dirty, 'src/l.mjs': cleanLine, 'src/m.mjs': sneaky });
    try {
      const { findings } = scan(root, {});
      const files = findings.map((f) => f.file);
      expect(files).toContain('src/k.mjs');
      expect(files).toContain('src/m.mjs');
      expect(files).not.toContain('src/l.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('结构规则：17 位以上纯数字 → 命中（疑似真实账号 id）', () => {
    const dirty = 'const uid = "' + '1'.repeat(17) + '";\n';
    const root = fixture({ 'src/i.mjs': dirty, 'src/j.mjs': 'const ts = 1730000000000; // 13 位时间戳\n' });
    try {
      const { findings } = scan(root, {});
      expect(findings.map((f) => f.rule)).toEqual(['numeric-account-id']);
      expect(findings[0].file).toBe('src/i.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('denylist（本地文件）：组织名 / 内网域名 → 命中', () => {
    const root = fixture({
      'scripts/denylist.txt': 'acme-corp\ngit\\.acme\\.internal\n',
      'src/e.mjs': 'const host = "git.acme.internal";\nconst name = "acme-corp";\n',
    });
    const { findings } = clean(root);
    const ruleIds = findings.map((f) => f.rule);
    expect(ruleIds.filter((r) => r.startsWith('denylist:')).length).toBeGreaterThanOrEqual(2);
  });

  test('denylist（环境变量）优先于文件，且文件不参与扫描', () => {
    const root = fixture({
      'scripts/denylist.txt': 'file-only-pattern\n',
      'src/f.mjs': 'const x = "file-only-pattern";\n',
    });
    try {
      const withEnv = scan(root, { DWS_HUB_DENYLIST: 'env-only-pattern' });
      expect(withEnv.denylistSource).toBe('env:DWS_HUB_DENYLIST');
      expect(withEnv.findings).toEqual([]); // file 规则未启用
      const withFile = scan(root, {});
      // denylist.txt 自身被跳过；命中只来自 src/f.mjs
      expect(withFile.findings.map((f) => f.file)).toEqual(['src/f.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('本仓自身必须干净（含 denylist.example）', () => {
    const root = process.cwd();
    const { findings } = scan(root, {});
    expect(findings).toEqual([]);
  });
});
