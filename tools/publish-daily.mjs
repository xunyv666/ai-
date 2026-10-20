/**
 * 把 AI 行业日报（public/daily.html）发布到独立站点 https://daily.ai-6f8.pages.dev
 *
 * 原理：同一个 Cloudflare Pages 项目（ai-6f8）对非生产分支会给一个独立的
 * Branch Preview URL。所以这里把日报做成 `daily` 分支的根页面，push 上去后
 * Cloudflare 自动重新构建，链接保持不变。
 *
 * 用法：npm run publish:daily   （或 node tools/publish-daily.mjs）
 * 前置：public/daily.html 已是要发布的最新版本；本机 SSH 能推 GitHub。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const SRC = 'public/daily.html';
const HOMEPAGE = 'https://ai-6f8.pages.dev/'; // 日报里的「返回主页」指向主站
const WORK = '.workbuddy/tmp/daily-branch';   // 分支工作区（已 gitignore）
const REMOTE = 'git@github.com:xunyv666/ai-.git';
const BRANCH = 'daily';

if (!existsSync(SRC)) {
  console.error(`[publish:daily] 找不到 ${SRC}`);
  process.exit(1);
}

// 1) 处理 HTML：去掉编辑器内部属性，「返回主页」改为绝对地址
let html = readFileSync(SRC, 'utf8');
html = html.replace(/\s*data-page-node-id="[^"]*"/g, '');
html = html.replace(/href="index\.html"/g, `href="${HOMEPAGE}"`);

// 2) 准备分支工作区
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'index.html'), html, 'utf8');
if (existsSync('public/_headers')) copyFileSync('public/_headers', join(WORK, '_headers'));
writeFileSync(
  join(WORK, 'package.json'),
  JSON.stringify(
    {
      name: 'ai-daily-brief',
      version: '1.0.0',
      private: true,
      description: 'AI 行业日报独立站点。纯静态单页，无构建步骤；Build command 只需 exit 0，Build output directory = .',
      scripts: { build: "node -e \"console.log('static site, nothing to build')\"" },
    },
    null,
    2
  ) + '\n',
  'utf8'
);

// 3) 提交并强推 daily 分支（该分支只承载这一份产物，无需保留历史）
const run = (cmd) => execSync(cmd, { cwd: WORK, stdio: 'inherit' });
const quiet = (cmd) => execSync(cmd, { cwd: WORK, stdio: 'pipe' }).toString().trim();

if (!existsSync(join(WORK, '.git'))) {
  run('git init -q -b daily');
  run(`git remote add origin ${REMOTE}`);
}

run('git add -A');
const status = quiet('git status --porcelain');
if (!status) {
  console.log('[publish:daily] 内容与线上一致，无需重推');
  process.exit(0);
}
run(`git -c user.name="xunyv666" -c user.email="603327998@qq.com" commit -q -m "AI 行业日报更新：${new Date().toISOString().slice(0, 10)}"`);
run(`git push -f origin ${BRANCH}`);

console.log(`\n[publish:daily] 已推送 ${BRANCH} 分支，约 20~40 秒后生效：https://daily.ai-6f8.pages.dev`);
