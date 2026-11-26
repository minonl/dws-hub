/**
 * check-generic —— 通用性门禁
 *
 * 目的：这个包只处理 **dws（钉钉 CLI）的调用**，不得含任何某家公司的业务逻辑。
 * 判据一句话：**换个公司、换个钉钉账号，这段逻辑还成立吗？** 不成立就不该在这里。
 *
 * 两类规则：
 *   1) 内置结构规则（与任何公司无关）：疑似真实会话 id、疑似个人数据根路径
 *   2) 外部 denylist（数据，不入库）：公司名 / 内网域名 / 部门名 / 人名 / 框架数据根
 *      - 本地：`scripts/denylist.txt`（.gitignore）
 *      - CI：环境变量 `DWS_HUB_DENYLIST`（GitHub secret 注入，仓库里不留真名）
 *      - 没配 denylist 时只跑结构规则，并明确提示「仅结构检查」
 *
 * 用法：
 *   bun scripts/check-generic.mjs [--root DIR] [--json]
 * 退出码：0 干净 / 1 命中 / 2 参数错
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'coverage']);

/** 门禁自身的规则字面量不参与扫描。 */
const SKIP_FILES = new Set([
  'scripts/check-generic.mjs',
  'scripts/check-generic.test.mjs',
  'scripts/denylist.txt',          // 规则数据本身含敏感词，不参与扫描
  'scripts/denylist.example.txt',
]);

const TEXT_EXT = /\.(mjs|cjs|js|ts|json|md|ya?ml|html|css|sh|txt|tmpl)$/i;

/** 内置结构规则：不含任何公司信息。 */
export const STRUCTURAL_RULES = [
  {
    id: 'conversation-id',
    re: /\bcid[A-Za-z0-9+/=_-]{20,}/,
    why: '疑似真实会话 id，请改用合成样本（如 grp-1）',
  },
  {
    id: 'display-name-3seg',
    re: /[\u4e00-\u9fa5]{1,4}[-－][\u4e00-\u9fa5]{1,8}[-－][\u4e00-\u9fa5]{1,8}/,
    why: '疑似真实钉钉展示名（姓名-部门-大区）；合成示例请带「示例」二字',
    matchUnless: (m) => /示例/.test(m),
  },
  {
    id: 'opaque-id-base62',
    re: /\b(?=[A-Za-z0-9]{24,}\b)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}\b/,
    why: '疑似真实账号/会话 id（长 base62 串）；请用 OPEN_ID_EXAMPLE 之类合成值',
    // 只对「命中的串本身」放行，避免整行里任意 example 字样让真实 id 溜过去
    matchUnless: (m) => /example/i.test(m),
  },
  {
    id: 'numeric-account-id',
    re: /(?<!\d)\d{17,}(?!\d)/,
    why: '疑似真实数字账号 id（17 位以上）；请用 uid_demo_0001 之类合成值',
  },
  {
    id: 'home-data-root',
    re: /(?:\/Users\/[A-Za-z0-9._-]+|~)\/\.(?!config\b|local\b|cache\b|npm\b|bun\b|dws-hub\b|agents\b|ssh\b)[a-z][a-z0-9-]{2,}(?=\/|["']|$)/,
    why: '疑似写死某个工具的私有数据根；默认根应由 DWS_HUB_HOME 决定',
  },
];

/** 允许例外：文件相对路径 → 允许命中的规则 id。 */
const ALLOW = new Map([
  // 示例文件本身用占位符，不需要放行任何规则
]);

function isTextFile(path) {
  return TEXT_EXT.test(path);
}

function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) yield* walk(root, abs);
    else if (st.isFile() && isTextFile(abs)) yield { abs, rel: relative(root, abs) };
  }
}

/**
 * 读取外部 denylist。
 * 优先级：env DWS_HUB_DENYLIST > scripts/denylist.txt > scripts/denylist.example.txt（占位符，仅演示）
 * @returns {{ patterns: Array<{id:string,re:RegExp,why:string}>, source: string|null }}
 */
export function loadDenylist(root = process.cwd(), env = process.env) {
  const parse = (text, source) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => ({ id: `denylist:${l}`, re: new RegExp(l, 'i'), why: `denylist 命中（${source}）` }));

  if (env.DWS_HUB_DENYLIST && env.DWS_HUB_DENYLIST.trim()) {
    return { patterns: parse(env.DWS_HUB_DENYLIST, 'env:DWS_HUB_DENYLIST'), source: 'env:DWS_HUB_DENYLIST' };
  }
  for (const rel of ['scripts/denylist.txt', 'scripts/denylist.example.txt']) {
    const abs = resolve(root, rel);
    if (existsSync(abs)) {
      return { patterns: parse(readFileSync(abs, 'utf8'), rel), source: rel };
    }
  }
  return { patterns: [], source: null };
}

/**
 * 扫描一个根目录。
 * @returns {{ findings: Array<{file:string,line:number,rule:string,why:string,text:string}>, scanned: number, denylistSource: string|null }}
 */
export function scan(root = process.cwd(), env = process.env) {
  const { patterns, source } = loadDenylist(root, env);
  const rules = [...STRUCTURAL_RULES, ...patterns];
  const findings = [];
  let scanned = 0;

  for (const { abs, rel } of walk(root)) {
    if (SKIP_FILES.has(rel)) continue;
    scanned += 1;
    const allowed = ALLOW.get(rel) ?? [];
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        for (const rule of rules) {
          if (allowed.includes(rule.id)) continue;
          if (typeof rule.unless === 'function' && rule.unless(text)) continue;
          rule.re.lastIndex = 0;
          if (rule.matchUnless) {
            const matches = text.match(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`)) || [];
            if (matches.length && matches.every((m) => rule.matchUnless(m))) continue;
          }
          if (rule.re.test(text)) {
            findings.push({ file: rel, line: i + 1, rule: rule.id, why: rule.why, text: text.trim().slice(0, 160) });
            break; // 一行只报一次
          }
        }
      });
  }
  return { findings, scanned, denylistSource: source };
}

function main(argv) {
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') root = argv[++i];
    else if (a === '--json') json = true;
    else {
      console.error(`未知参数：${a}`);
      return 2;
    }
  }
  if (!root) {
    console.error('--root 需要目录');
    return 2;
  }

  const { findings, scanned, denylistSource } = scan(root);
  if (json) {
    console.log(JSON.stringify({ ok: findings.length === 0, scanned, denylistSource, findings }, null, 2));
  } else if (findings.length === 0) {
    const scope = denylistSource ? `denylist=${denylistSource}` : '未配置 denylist（仅结构检查）';
    console.log(`✓ check-generic：${scanned} 个文件，0 命中；${scope}`);
  } else {
    console.error(`✗ check-generic：${findings.length} 处命中（${scanned} 个文件）`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.why}`);
      console.error(`    ${f.text}`);
    }
    console.error('\n修法：改通用示例，或把业务逻辑挪回调用方项目（本包只收「换个公司也成立」的逻辑）。');
  }
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
