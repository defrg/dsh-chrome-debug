/**
 * dsh-chrome-debug 启动参数校验自检（不依赖 DSH，也不启动 Chrome）。
 *
 *   node scripts/check-launch-args.mjs
 *
 * 背景：`extraArgs` 是用户可写的配置，而插件自己也要注入
 * `--remote-debugging-port` / `--user-data-dir` / `--headless`。
 * Chrome 对**重复开关**的取舍按开关而异，实测（Chromium 155）：
 *
 *   --remote-debugging-port=9333 --remote-debugging-port=9444  → 9444 生效（取后者）
 *   --user-data-dir=A --user-data-dir=B                        → A 生效（取前者）
 *
 * 所以「调换追加顺序」并不能保证插件注入的值权威 —— 放前面端口会被顶掉，
 * 放后面 profile 会被顶掉。唯一可靠的做法是**拒绝重复**。本脚本锁住这个行为。
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { buildChromeArgs, validateExtraArgs, resolveConfig } from "../lib/cdp.js";

let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

const cfgOf = (extraArgs, overrides = {}) =>
  resolveConfig({ port: 9222, userDataDir: "E:/tmp/profile", extraArgs, ...overrides });

/** 取「是否被拒」以及被拒时的问题条数。 */
function rejects(extraArgs) {
  const problems = validateExtraArgs(extraArgs);
  return { rejected: problems.length > 0, problems };
}

console.log("dsh-chrome-debug 启动参数校验自检\n");

// ---------------------------------------------------------------- 1. 合法参数放行
console.log("[1] 合法 extraArgs 必须放行");
for (const safe of [
  "--disable-gpu",
  "--window-size=800,600",
  "--remote-allow-origins=*",          // 插件 README 明确举的例子
  "--proxy-server=http://127.0.0.1:7897",
  "--lang=zh-CN",
]) {
  const { rejected, problems } = rejects([safe]);
  assert(!rejected, `放行 ${safe}`, problems.join("；"));
}

// ---------------------------------------------------------------- 2. 插件掌管的开关被拒
console.log("\n[2] 与插件注入的开关重复 —— 必须拒绝");
const ownedCases = [
  ["--user-data-dir=E:/real/profile", "覆盖 profile 目录"],
  ["--user-data-dir", "无值形式也要认出开关名"],
  ["--USER-DATA-DIR=E:/real/profile", "开关名大小写不敏感"],
  ["--remote-debugging-port=9999", "覆盖调试端口"],
  ["--headless=new", "headless 由 config 决定"],
  ["--no-first-run", "插件固定注入"],
];
for (const [arg, why] of ownedCases) {
  const { rejected } = rejects([arg]);
  assert(rejected, `拒绝 ${arg}（${why}）`);
}

// ---------------------------------------------------------------- 3. 破坏不变量的开关被拒
console.log("\n[3] 破坏「只监听回环」不变量的开关 —— 必须拒绝");
const { rejected: addrRejected } = rejects(["--remote-debugging-address=0.0.0.0"]);
assert(addrRejected, "拒绝 --remote-debugging-address=0.0.0.0");

// ---------------------------------------------------------------- 4. 畸形输入
console.log("\n[4] 畸形输入");
assert(rejects([""]).rejected, "拒绝空字符串");
assert(rejects(["   "]).rejected, "拒绝纯空白字符串");
assert(rejects(["--user-data-dir=A", "--disable-gpu"]).rejected, "混合时只要有一条非法就整体拒绝");

// ---------------------------------------------------------------- 5. buildChromeArgs 行为
console.log("\n[5] buildChromeArgs 的产出");
const args = buildChromeArgs(cfgOf(["--disable-gpu"]));
assert(args.includes("--remote-debugging-port=9222"), "含插件注入的端口");
assert(args.includes("--user-data-dir=E:/tmp/profile"), "含插件注入的 profile");
assert(args.includes("--disable-gpu"), "含合法 extraArgs");
assert(args.indexOf("--disable-gpu") > args.findIndex((a) => a.startsWith("--user-data-dir=")),
  "extraArgs 追加在插件开关之后（顺序保持不变）");
assert(!args.includes("--headless=new"), "headless=false 时不注入 --headless=new");

const headlessArgs = buildChromeArgs(cfgOf([], { headless: true }));
assert(headlessArgs.includes("--headless=new"), "headless=true 时注入 --headless=new");

let threw = null;
try {
  buildChromeArgs(cfgOf(["--user-data-dir=E:/real/profile"]));
} catch (error) {
  threw = error;
}
assert(threw !== null, "非法 extraArgs 时 buildChromeArgs 抛错（不会 spawn）");
assert(threw?.code === "INVALID_EXTRA_ARGS", "错误码为 INVALID_EXTRA_ARGS", `实际 ${threw?.code}`);
assert(
  typeof threw?.message === "string" && threw.message.includes("--user-data-dir"),
  "错误信息点明了具体是哪个参数",
);

// ---------------------------------------------------------------- 汇总
console.log("");
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败 —— extraArgs 校验有问题`);
  process.exit(1);
}
console.log("✓ extraArgs 校验正常：插件掌管的开关无法被重复指定，回环不变量无法被破坏");
