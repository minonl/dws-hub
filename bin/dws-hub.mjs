#!/usr/bin/env bun
/**
 * dws-hub CLI 入口
 *
 * 只做两件很薄的事：`--version` / `--help` 的快速通道，其余交给 `src/cli.mjs`。
 * 真正的子命令都实现于 src/cli.mjs（发送 / 读取 / 监听 / 分派 / 服务）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
  console.log(pkg.version);
  process.exit(0);
}

await import('../src/cli.mjs');
