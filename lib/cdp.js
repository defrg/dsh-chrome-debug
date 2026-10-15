/**
 * dsh-chrome-debug — Chrome / CDP 传输层（无第三方依赖）。
 *
 * 只用 Node 内置能力：
 *   - HTTP 控制端点（/json/version、/json/list、/json/new…）→ 全局 fetch
 *   - CDP 命令（Page.navigate、Runtime.evaluate、Page.captureScreenshot…）→ 全局 WebSocket
 *     （Node ≥22 自带 WHATWG WebSocket；它不发 Origin 头，所以不需要给 Chrome 加
 *      --remote-allow-origins —— 浏览器端工具才需要那个）
 *   - 启动 Chrome → node:child_process
 *
 * 每次 CDP 调用单独建连、用完即关：本地握手只有几毫秒，换来的是不会踩"陈旧 socket"
 * 那类难查的问题（页面导航/崩溃后旧连接会静默失效）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** DSH 数据根：优先 DSH_HOME 环境变量，否则 ~/.dsh（与其他 DSH 插件同一约定）。 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return typeof env === "string" && env.trim() !== "" ? env : join(homedir(), ".dsh");
}

/**
 * 解析 chrome.exe 路径——**不写死任何本机路径**。
 * 顺序：显式配置 → CHROME_PATH 环境变量 → 各标准安装位置（由环境变量拼出，跨机器有效）。
 */
export function resolveChromePath(configured) {
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const env = process.env.CHROME_PATH;
  if (typeof env === "string" && env.trim() !== "") return env;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((root) => typeof root === "string" && root.trim() !== "");
  const candidates = roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* 权限等异常忽略，继续探测 */ }
  }
  return candidates[0] ?? "chrome.exe";   // 兜底交给 PATH；启动失败时报错会带上这个值
}

/** 配置默认值。路径类留空 = 自动解析（见 resolveChromePath / dshHome），因此可移植。 */
export const DEFAULTS = {
  port: 9222,
  extraArgs: [],
  headless: false,
  startTimeoutMs: 20000,
  timeoutMs: 15000,
  maxTextChars: 8000,
  chromePath: "",
  userDataDir: "",
  screenshotDir: "",
};

export function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const port = Number(cfg.port);
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const text = (value, fallback) => (typeof value === "string" && value.trim() !== "" ? value : fallback);
  const home = dshHome();
  return {
    chromePath: resolveChromePath(cfg.chromePath ?? DEFAULTS.chromePath),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    // 调试专用 profile：默认落在 DSH 数据根下，绝不指向用户日常的 Chrome profile
    userDataDir: text(cfg.userDataDir, join(home, "chrome-debug", "profile")),
    extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : DEFAULTS.extraArgs.slice(),
    headless: cfg.headless === true,
    startTimeoutMs: num(cfg.startTimeoutMs, DEFAULTS.startTimeoutMs),
    timeoutMs: num(cfg.timeoutMs, DEFAULTS.timeoutMs),
    screenshotDir: text(cfg.screenshotDir, join(home, "chrome-debug", "shots")),
    maxTextChars: num(cfg.maxTextChars, DEFAULTS.maxTextChars),
  };
}

export const debugBase = (cfg) => `http://127.0.0.1:${cfg.port}`;

/** 带超时的 JSON GET/PUT；失败返回 undefined（探活场景不抛异常）。 */
export async function httpJson(url, { method = "GET", timeoutMs = 4000 } = {}) {
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch { signal = undefined; }
  try {
    const response = await fetch(url, { method, signal });
    const text = await response.text();
    if (!response.ok) return { error: `HTTP ${response.status}`, body: text.slice(0, 400) };
    if (text.trim() === "") return {};
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
  } catch (error) {
    return undefined;   // 连不上 = 端点没起
  }
}

/** 调试端点是否在线；在线则返回 /json/version 的内容。 */
export async function versionOf(cfg, timeoutMs = 3000) {
  const data = await httpJson(`${debugBase(cfg)}/json/version`, { timeoutMs });
  if (!data || data.error !== undefined || data.raw !== undefined) return undefined;
  return data;
}

/** 页面类型的 target 列表（过滤掉 devtools / service worker 等）。 */
export async function listTargets(cfg) {
  const data = await httpJson(`${debugBase(cfg)}/json/list`, { timeoutMs: cfg.timeoutMs });
  if (!Array.isArray(data)) {
    const reason = data && data.error ? data.error : "调试端点无响应";
    const error = new Error(`${reason}（${debugBase(cfg)}/json/list）`);
    error.code = "CHROME_OFFLINE";
    throw error;
  }
  return data
    .filter((item) => item && item.type === "page")
    .map((item) => ({
      id: item.id,
      title: item.title ?? "",
      url: item.url ?? "",
      webSocketDebuggerUrl: item.webSocketDebuggerUrl ?? "",
      devtoolsFrontendUrl: item.devtoolsFrontendUrl ?? "",
    }));
}

/** 挑一个 target：显式 tabId > urlIncludes > 配置默认 > 第一个非 devtools 页面。 */
export async function resolveTarget(cfg, { tabId, urlIncludes } = {}) {
  const targets = await listTargets(cfg);
  if (targets.length === 0) {
    const error = new Error("没有任何可调试的页面（target 为空）：先 chrome_tab 新建一个，或 chrome_navigate 打开网址");
    error.code = "NO_TARGET";
    throw error;
  }
  if (typeof tabId === "string" && tabId !== "") {
    const hit = targets.find((t) => t.id === tabId);
    if (!hit) {
      const error = new Error(`找不到 tabId=${tabId}；当前页面：${targets.map((t) => `${t.id}(${t.url})`).join("、")}`);
      error.code = "TAB_NOT_FOUND";
      throw error;
    }
    return { target: hit, targets };
  }
  if (typeof urlIncludes === "string" && urlIncludes !== "") {
    const hit = targets.find((t) => t.url.includes(urlIncludes));
    if (!hit) {
      const error = new Error(`没有页面 URL 含「${urlIncludes}」；当前：${targets.map((t) => t.url).join("、")}`);
      error.code = "TAB_NOT_FOUND";
      throw error;
    }
    return { target: hit, targets };
  }
  const normal = targets.find((t) => !t.url.startsWith("devtools://")) ?? targets[0];
  return { target: normal, targets };
}

let messageSeq = 0;

/**
 * 发一条 CDP 命令（每次一条独立 WebSocket）。
 * @returns 该命令的 result；失败抛 Error（带 Chrome 返回的 message/data）。
 */
export function cdpSend(webSocketDebuggerUrl, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof webSocketDebuggerUrl !== "string" || webSocketDebuggerUrl === "") {
      reject(new Error("该 target 没有 webSocketDebuggerUrl"));
      return;
    }
    if (typeof WebSocket !== "function") {
      reject(new Error("当前 Node 运行时没有全局 WebSocket（需要 Node ≥22），无法走 CDP"));
      return;
    }
    let socket;
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch (error) {
      reject(new Error(`CDP WebSocket 创建失败：${error?.message ?? String(error)}`));
      return;
    }
    const id = ++messageSeq;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`CDP ${method} 超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    socket.addEventListener("open", () => {
      const message = { id, method, params: params ?? {} };
      try { socket.send(JSON.stringify(message)); }
      catch (error) { finish(reject, new Error(`CDP 发送失败：${error?.message ?? String(error)}`)); }
    });
    socket.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
      catch { return; }
      if (!data || data.id !== id) return;   // 事件帧（无 id 或 id 不匹配）直接忽略
      if (data.error) {
        const detail = data.error.data === undefined ? "" : ` — ${typeof data.error.data === "string" ? data.error.data : JSON.stringify(data.error.data)}`;
        finish(reject, new Error(`CDP ${method} 失败：${data.error.message ?? "unknown"}${detail}`));
        return;
      }
      finish(resolve, data.result);
    });
    socket.addEventListener("error", () => finish(reject, new Error(`CDP WebSocket 连接失败：${webSocketDebuggerUrl}`)));
    socket.addEventListener("close", () => finish(reject, new Error(`CDP WebSocket 提前关闭（${method}）`)));
  });
}

/** 数一下机器上有多少 chrome.exe（超时时用来判断"是不是同 profile 已有实例"）。 */
function countChromeProcesses() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(undefined); }, 5000);
    child.stdout?.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("\""));
      resolve(lines.length);
    });
  });
}

/**
 * 插件自己注入的 Chrome 开关 —— extraArgs 里出现同名项一律拒绝。
 *
 * 为什么是「拒绝」而不是「调换顺序」：Chrome 对重复开关的取舍**按开关而异**，实测（Chromium 155）：
 *   · `--remote-debugging-port=9333 --remote-debugging-port=9444` → **9444** 生效（取后者）
 *   · `--user-data-dir=A --user-data-dir=B`                      → **A** 生效（取前者）
 * 因此任何基于顺序的假设都靠不住：插件开关放前面，端口会被 extraArgs 顶掉；
 * 挪到后面，user-data-dir 又会被顶掉。唯一可靠的做法是不让重复出现。
 */
const PLUGIN_OWNED_SWITCHES = new Map([
  ["--remote-debugging-port", "端口来自 config.port"],
  ["--user-data-dir", "profile 目录来自 config.userDataDir —— 这是隔离日常 profile 的关键"],
  ["--headless", "由 config.headless 决定"],
  ["--no-first-run", "由插件固定注入"],
  ["--no-default-browser-check", "由插件固定注入"],
]);

/** 插件从不注入、但会破坏其不变量的开关 —— 即使不构成重复也必须挡掉。 */
const FORBIDDEN_SWITCHES = new Map([
  ["--remote-debugging-address", "会把调试端口暴露到局域网；插件保证只监听 127.0.0.1"],
]);

/** 取开关名：`--foo=bar` 与 `--foo` 都归一成 `--foo`（Chrome 开关名不区分大小写）。 */
function switchNameOf(value) {
  const text = String(value).trim();
  const eq = text.indexOf("=");
  return (eq === -1 ? text : text.slice(0, eq)).toLowerCase();
}

/** 校验 extraArgs；返回问题清单，空数组表示通过。 */
export function validateExtraArgs(extraArgs) {
  const problems = [];
  const list = Array.isArray(extraArgs) ? extraArgs : [];
  for (const raw of list) {
    const text = String(raw).trim();
    if (text === "") {
      problems.push("空字符串不是合法的启动参数");
      continue;
    }
    const name = switchNameOf(text);
    if (PLUGIN_OWNED_SWITCHES.has(name)) {
      problems.push(`${text} —— ${name} 由插件掌管（${PLUGIN_OWNED_SWITCHES.get(name)}），不能重复指定`);
      continue;
    }
    if (FORBIDDEN_SWITCHES.has(name)) {
      problems.push(`${text} —— ${name} 被禁止（${FORBIDDEN_SWITCHES.get(name)}）`);
    }
  }
  return problems;
}

/**
 * 组装 Chrome 启动参数；校验不通过时抛 `INVALID_EXTRA_ARGS`（不会 spawn 任何进程）。
 */
export function buildChromeArgs(cfg) {
  const problems = validateExtraArgs(cfg.extraArgs);
  if (problems.length > 0) {
    const error = new Error(
      "extraArgs 里有插件不允许的参数，已拒绝启动 Chrome：\n  - " + problems.join("\n  - ") +
      "\n这些开关由插件按 config 注入。Chrome 对重复开关的取舍按开关而异" +
      "（实测端口取后者、profile 取前者），重复指定会让生效值变得不确定。" +
      "要改端口 / profile / headless，请用 chrome_config 工具或设置表单，而不是 extraArgs。",
    );
    error.code = "INVALID_EXTRA_ARGS";
    throw error;
  }

  const args = [
    `--remote-debugging-port=${cfg.port}`,
    `--user-data-dir=${cfg.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (cfg.headless) args.push("--headless=new");
  // 顺序维持「插件开关在前、extraArgs 在后」不变：重复已被上面拒绝，顺序不再影响正确性；
  // 贸然调换反而会把 user-data-dir 交到 extraArgs 手里（见 PLUGIN_OWNED_SWITCHES 的实测说明）。
  for (const extra of cfg.extraArgs) args.push(String(extra));
  return args;
}

/**
 * 确保调试模式的 Chrome 在跑：
 *   1) 端点已在线 → 直接复用，不再启动（避免第二个实例抢同一个 user-data-dir）
 *   2) 否则按 --remote-debugging-port / --user-data-dir 启动，轮询等端点起来
 */
export async function ensureChrome(cfg, { force = false } = {}) {
  const existing = await versionOf(cfg, 2500);
  if (existing && !force) {
    return { launched: false, reused: true, version: existing, args: [] };
  }

  // 参数校验在 spawn 之前完成：非法 extraArgs 直接抛错，不会留下半启动的进程
  const args = buildChromeArgs(cfg);

  let child;
  try {
    child = spawn(cfg.chromePath, args, { detached: true, stdio: "ignore", windowsHide: false });
  } catch (error) {
    const failure = new Error(`启动 Chrome 失败：${error?.message ?? String(error)}（chromePath=${cfg.chromePath}）`);
    failure.code = "LAUNCH_FAILED";
    throw failure;
  }
  child.unref();

  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const version = await versionOf(cfg, 1500);
    if (version) return { launched: true, reused: false, version, args, pid: child.pid };
  }

  const chromeCount = await countChromeProcesses();
  const error = new Error(
    `启动后 ${cfg.startTimeoutMs}ms 内没等到调试端点 ${debugBase(cfg)}/json/version。` +
    (typeof chromeCount === "number" ? `当前 chrome.exe 进程数：${chromeCount}。` : "") +
    `常见原因：该 user-data-dir（${cfg.userDataDir}）已有一个**没有开调试端口**的 Chrome 实例在跑——` +
    `Chrome 会把新命令转交给既有实例，于是端口永远不开。请先关掉那个实例（或换一个 user-data-dir）再试。`,
  );
  error.code = "START_TIMEOUT";
  throw error;
}
