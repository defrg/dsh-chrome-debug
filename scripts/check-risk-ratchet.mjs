/**
 * 风险面棘轮 —— 移植自 dsh-tavern 的「转义棘轮」，判据换成本仓库真正有的风险面。
 *
 *   node scripts/check-risk-ratchet.mjs            比对（当前值 > 基线就红）
 *   node scripts/check-risk-ratchet.mjs --explain  打印每一处命中，便于确认判据没跑歪
 *   node scripts/check-risk-ratchet.mjs --lower    当前值 < 基线时把基线降下来
 *
 * ## 为什么不是照抄「转义棘轮」
 *
 * tavern 的棘轮数的是「裸拼 innerHTML 的地方，只许减不许增」。本插件的客户端全部用
 * React `h()` 渲染，**一处 innerHTML 都没有**（测出来是 0），所以照搬过来没有可棘轮的对象。
 * 于是保留**棘轮这个机制**（基线文件 + 只许降不许增 + 判据必须精确），
 * 把统计对象换成本仓库真实存在的三类风险面：
 *
 * | 类别 | 含义 | 基线 |
 * | --- | --- | --- |
 * | `htmlSinks` | `innerHTML` / `dangerouslySetInnerHTML` / `srcdoc` 等 HTML 注入面 | 0 |
 * | `shellExec` | `child_process` 的 **exec / execSync**（会把命令字符串交给 shell） | 0 |
 * | `silentCatch` | 空 catch 块（把错误吞掉，问题被藏起来） | 见基线 |
 *
 * ## 判据为什么要「精确」
 *
 * 开发这个脚本时先写了个宽松版 `\bexec\s*\(`，结果 git-plugin 报「走 shell 6 处」——
 * 全是 `正则.exec(...)` 的误报。**棘轮一旦误报就会被关掉**，所以这里先解析
 * `child_process` 的导入绑定，再按绑定名数调用；`execFile` / `execFileSync` / `spawn`
 * 走 argv 数组、不经过 shell，**不算**。
 *
 * ## 空跑判据 + 反向自检
 *
 * 扫了 0 个文件判失败；并内置**故意植入违规的样本**，确认判据真能抓到 ——
 * 一个永远返回 0 的检测器和没有检测器是一回事。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = join(ROOT, 'lib');
const BASELINE_FILE = join(HERE, 'risk-baseline.json');
const EXPLAIN = process.argv.includes('--explain');
const LOWER = process.argv.includes('--lower');

/** HTML 注入口。客户端用 React h() 时应当恒为 0。 */
const HTML_SINKS = [
  /\.innerHTML\s*=/g,
  /\.outerHTML\s*=/g,
  /\.insertAdjacentHTML\s*\(/g,
  /document\s*\.\s*write\s*\(/g,
  /dangerouslySetInnerHTML/g,
  /\.srcdoc\s*=/g,
];

/** 会把命令字符串交给 shell 的 child_process API —— 这两个必须为 0。 */
const SHELL_APIS = new Set(['exec', 'execSync']);

/** 空 catch：`catch {}`、`catch (e) {}`、以及块内只有空白/注释的情况。 */
const SILENT_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*\}/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 解析 `child_process` 的导入绑定名。
 * 只认识真正来自 child_process 的名字 —— 这是「判据精确」的关键。
 *
 * 返回 `{ named, namespace }`：
 *   - `named`     ← `import { exec }` / `const { exec } = require(…)` 这类解构绑定，
 *                   调用形如 `exec(...)`
 *   - `namespace` ← `import * as cp` / `const cp = require(…)` 这类命名空间，
 *                   调用形如 `cp.exec(...)`
 */
function childProcessBindings(source) {
  const named = new Set();
  const namespace = new Set();
  const collect = (list) => {
    for (const part of list.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const name = trimmed.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) named.add(name);
    }
  };
  // import { exec, execFile } from "node:child_process"
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g)) collect(match[1]);
  // const { exec } = require("node:child_process") / await import("node:child_process")
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require\(|import\()\s*["']node:child_process["']/g)) collect(match[1]);
  // import * as cp from "node:child_process" / const cp = require("node:child_process")
  for (const match of source.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']node:child_process["']/g)) namespace.add(match[1]);
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?require\(\s*["']node:child_process["']\s*\)/g)) namespace.add(match[1]);
  return { named, namespace };
}

/** 扫描一份源码，返回各类命中（带行号，便于 --explain）。 */
function scanSource(source) {
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  const hits = { htmlSinks: [], shellExec: [], silentCatch: [] };

  for (const pattern of HTML_SINKS) {
    for (const match of source.matchAll(pattern)) {
      hits.htmlSinks.push({ line: lineOf(match.index), text: match[0].trim() });
    }
  }

  const { named, namespace } = childProcessBindings(source);
  // 裸绑定：`exec(` —— 但必须排除 `re.exec(` 这种**方法调用**（正则的 exec 最常见）。
  // 用否定后顾：前面不能是 `.`，也不能是标识符字符（避免匹配到 `myexec(`）。
  for (const name of named) {
    if (!SHELL_APIS.has(name)) continue;
    for (const match of source.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g'))) {
      hits.shellExec.push({ line: lineOf(match.index), text: `${name}(` });
    }
  }
  // 命名空间绑定：`cp.exec(`
  for (const ns of namespace) {
    for (const name of SHELL_APIS) {
      for (const match of source.matchAll(new RegExp(`\\b${ns}\\s*\\.\\s*${name}\\s*\\(`, 'g'))) {
        hits.shellExec.push({ line: lineOf(match.index), text: `${ns}.${name}(` });
      }
    }
  }
  // spawn 带 shell:true 同样等于走 shell
  for (const match of source.matchAll(/\bshell\s*:\s*true\b/g)) {
    hits.shellExec.push({ line: lineOf(match.index), text: 'shell: true' });
  }

  for (const match of source.matchAll(SILENT_CATCH)) {
    hits.silentCatch.push({ line: lineOf(match.index), text: 'catch {…空…}' });
  }

  return { hits, bindings: { named: [...named], namespace: [...namespace] } };
}

// ---------------------------------------------------------------- 反向自检用的样本

const SELF_TEST_SOURCE = `
import { exec, execFile } from "node:child_process";
import { execSync } from 'node:child_process';
import * as cp from "node:child_process";
const re = /x/g;
re.exec("abc");                                  // 必须**不算** shellExec（正则的 exec）
myexec("nope");                                  // 必须**不算**（不是绑定名）
exec("rm -rf /");                                // 必须算
execSync("dir");                                 // 必须算
cp.exec("also bad");                             // 必须算（命名空间绑定）
execFile("git", ["status"]);                     // 必须**不算**（argv 数组，不走 shell）
el.innerHTML = model;                            // 必须算
try { a() } catch { }                            // 必须算 silentCatch
try { b() } catch (e) { /* 说明 */ }             // 必须算 silentCatch（只有注释）
try { c() } catch (e) { log(e); }                // 必须**不算**
`;

function selfTest() {
  const results = [];
  const { hits, bindings } = scanSource(SELF_TEST_SOURCE);
  const check = (condition, label, detail) => results.push({ condition, label, detail });
  // exec / execSync / cp.exec = 3；re.exec / myexec / execFile 都不该算
  check(hits.shellExec.length === 3, '植入的 exec / execSync / cp.exec 都被数到（re.exec、myexec、execFile 未误报）', `实际 ${hits.shellExec.length} 处：${hits.shellExec.map((h) => h.text).join(', ')}`);
  check(hits.htmlSinks.length === 1, '植入的 innerHTML 被数到', `实际 ${hits.htmlSinks.length} 处`);
  check(hits.silentCatch.length === 2, '两个空 catch 被数到（有正文的那个不算）', `实际 ${hits.silentCatch.length} 处`);
  check(bindings.named.includes('exec') && bindings.namespace.includes('cp'), '解构绑定与命名空间绑定都被解析出来', JSON.stringify(bindings));
  return results;
}

// ---------------------------------------------------------------- 主流程

let failed = 0;
let assertions = 0;
function assert(condition, label, detail) {
  assertions += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('风险面棘轮\n');

if (!existsSync(LIB)) {
  console.error(`✗ 找不到 lib/ 目录：${LIB}`);
  process.exit(1);
}

const files = walk(LIB);
console.log(`扫描：${relative(ROOT, LIB)} 下 ${files.length} 个 .js\n`);

const totals = { htmlSinks: 0, shellExec: 0, silentCatch: 0 };
const detail = { htmlSinks: [], shellExec: [], silentCatch: [] };
let importedChildProcess = false;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const { hits, bindings } = scanSource(source);
  if (bindings.named.length > 0 || bindings.namespace.length > 0) importedChildProcess = true;
  for (const key of Object.keys(totals)) {
    totals[key] += hits[key].length;
    for (const hit of hits[key]) detail[key].push({ file: relative(ROOT, file), ...hit });
  }
}

console.log('[1] 计数');
for (const [key, value] of Object.entries(totals)) console.log(`  ${key.padEnd(12)} ${value}`);
console.log('');

if (EXPLAIN) {
  console.log('[逐处命中]');
  for (const [key, list] of Object.entries(detail)) {
    if (list.length === 0) continue;
    console.log(`  ${key}:`);
    for (const hit of list) console.log(`    ${hit.file}:${hit.line}  ${hit.text}`);
  }
  console.log('');
}

console.log('[2] 反向自检（判据必须抓得到植入的违规）');
for (const result of selfTest()) assert(result.condition, result.label, result.detail);
// 本仓库确实引入了 child_process 才行 —— 否则「0 处 shellExec」可能只是没扫到东西
assert(importedChildProcess, '扫到了 child_process 的导入（证明判据真的看进去了）', '一个都没扫到，基线为 0 就失去意义');

console.log('\n[3] 与基线比对');
const hasBaseline = existsSync(BASELINE_FILE);
if (!hasBaseline && !LOWER) {
  console.error(`✗ 找不到基线：${BASELINE_FILE}`);
  console.error('  首次建立基线：node scripts/check-risk-ratchet.mjs --lower');
  process.exit(1);
}
// 没有基线而给了 --lower 时，视作「新建」—— 此时不做「当前 ≤ 基线」的比对
const baseline = hasBaseline ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {};

for (const key of Object.keys(totals)) {
  const limit = baseline[key];
  const current = totals[key];
  if (!hasBaseline) {
    console.log(`  ${key.padEnd(12)} ${current}（首次建立基线）`);
    continue;
  }
  assert(typeof limit === 'number', `基线里有 ${key} 的数值`, String(limit));
  // 棘轮核心：只能降，不能升
  assert(current <= limit, `${key} 未超过基线（当前 ${current} ≤ 基线 ${limit}）`, `涨了 ${current - limit} 处`);
  if (current < limit) console.log(`      ↳ ${key} 比基线少了 ${limit - current} 处，可以跑 --lower 把基线降下来`);
}

if (LOWER) {
  const next = { ...baseline };
  for (const key of Object.keys(totals)) {
    if (!hasBaseline || totals[key] < (baseline[key] ?? Infinity)) next[key] = totals[key];
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`\n已写入基线：${BASELINE_FILE}`);
  console.log(JSON.stringify(next, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败（通过 ${assertions - failed} 项）`);
  console.error('  风险面比基线多 ⇒ 要么改掉，要么在提交信息里说明为什么必须增加并更新基线。');
  process.exit(1);
}
if (assertions === 0) {
  console.error('✗ 空跑：一条断言都没执行 —— 判为失败（不是通过）');
  process.exit(1);
}
console.log(`✓ 风险面棘轮通过：HTML 注入面 ${totals.htmlSinks} / 走 shell ${totals.shellExec} / 空 catch ${totals.silentCatch}（${assertions} 项断言）`);
