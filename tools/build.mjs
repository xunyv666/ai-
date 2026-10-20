/**
 * Cloudflare Pages 构建脚本。
 *
 * 背景：Pages 项目的 Build output directory 目前仍是仓库根（`.`），而站点文件
 * 都放在 public/ 下，于是根路径 `/` 没有 index.html → 线上 404。
 * 这个脚本把 public/ 的内容原样铺到仓库根，让 `.` 作为输出目录也能交付完整站点。
 *
 * 站内所有引用（assets/…、resume.html、daily.html）都是相对路径，铺平后依然成立。
 * 一旦 Dashboard 里把 Build output directory 改成 `public`，本脚本可以删掉，
 * package.json 的 build 改回 `exit 0` 即可。
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SRC = 'public';
const OUT = '.';
const SKIP = new Set(['_shots']); // 本地验收截图，不发布

let count = 0;

function walk(from, to) {
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
      walk(s, d);
    } else {
      const parent = dirname(d);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      copyFileSync(s, d);
      count++;
    }
  }
}

if (!existsSync(SRC)) {
  console.error(`[build] 找不到 ${SRC}/，跳过`);
  process.exit(1);
}

walk(SRC, OUT);
console.log(`[build] 已把 ${SRC}/ 铺平到仓库根，共 ${count} 个文件`);
