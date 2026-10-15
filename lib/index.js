/**
 * dsh-chrome-debug — Host half.
 *
 * 把 Chrome 的调试能力（CDP）接成 DSH 工具：插件自己负责**启动/复用**调试模式的 Chrome，
 * 之后 Agent 就能列标签页、导航、跑 JS、截图、以及发任意 CDP 命令。
 *
 * 启动参数（端口与 profile 目录都可配置，默认 9222 与 <DSH_HOME>/chrome-debug/profile）：
 *   chrome.exe --remote-debugging-port=<port> --user-data-dir=<调试专用 profile 目录>
 *
 * 安全边界：
 *   - 只连 127.0.0.1；不设置 --remote-debugging-address，端口不对外。
 *   - 强制要求 user-data-dir（不复用你日常的 Chrome profile），避免把主 profile 暴露给调试端口。
 *   - 写文件只发生在 screenshotDir 下，文件名由插件生成。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import {
  DEFAULTS,
  cdpSend,
  debugBase,
  ensureChrome,
  httpJson,
  listTargets,
  resolveConfig,
  resolveTarget,
  sleep,
  versionOf,
} from "./cdp.js";

export const name = "dsh-chrome-debug";

/** 只需要工具注册表。 */
export const inject = ["tools"];

/**
 * 配置 schema：导出后 DSH 会把它投影成「设置 → 插件 → dsh-chrome-debug」里的表单，
 * 于是 chrome 路径与 user-data-dir 可以直接在界面上改（写入本 profile 的覆盖层）。
 *
 * ⚠️ 每个字段都必须标 `.volatile()`：按官方 cookbook（实践指南：即时配置表单），
 * **只有 volatile 字段才会进入设置 schema**，普通字段会被忽略、表单里看不到。
 * 代价是运行时拿到的值是 Volatile 包装，需要用 .get() 取值（见下方 snapshot()）。
 */
export const Config = Schema.object({
  chromePath: Schema.string()
    .description("chrome.exe 路径。留空 = 自动探测：CHROME_PATH 环境变量 → %ProgramFiles% / %ProgramFiles(x86)% / %LOCALAPPDATA% 下的标准位置")
    .default("")
    .volatile(),
  userDataDir: Schema.string()
    .description("调试专用 profile 目录（--user-data-dir）。留空 = <DSH_HOME>/chrome-debug/profile。不要指向你日常使用的 Chrome profile")
    .default("")
    .volatile(),
  screenshotDir: Schema.string()
    .description("截图落盘目录。留空 = <DSH_HOME>/chrome-debug/shots")
    .default("")
    .volatile(),
  port: Schema.number()
    .description("调试端口（--remote-debugging-port）")
    .default(9222)
    .volatile(),
  headless: Schema.boolean()
    .description("以 --headless=new 启动（无窗口）")
    .default(false)
    .volatile(),
  extraArgs: Schema.array(Schema.string())
    .description("追加的 Chrome 启动参数，例如 --remote-allow-origins=*")
    .default([])
    .volatile(),
  startTimeoutMs: Schema.number()
    .description("启动后等待调试端点就绪的上限（毫秒）")
    .default(20000)
    .volatile(),
  timeoutMs: Schema.number()
    .description("单条 CDP 命令超时（毫秒）")
    .default(15000)
    .volatile(),
  maxTextChars: Schema.number()
    .description("工具返回文本的截断上限（字符）")
    .default(8000)
    .volatile(),
});

const READ_ONLY = new Set(["chrome_status", "chrome_tabs"]);

function truncate(text, limit) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}…（已截断，共 ${text.length} 字符；可用 maxTextChars 调大）` : text;
}

function asText(value, limit) {
  if (typeof value === "string") return truncate(value, limit);
  try {
    return truncate(JSON.stringify(value, null, 2), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

/** 截图目录里的时间戳文件名。 */
function shotName() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `chrome-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.png`;
}

/** 轮询 readyState，等页面加载完（比订阅 Page.loadEventFired 简单且不怕导航竞态）。 */
async function waitForLoad(cfg, target, waitMs) {
  const deadline = Date.now() + waitMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const { result } = await cdpSend(
        target.webSocketDebuggerUrl,
        "Runtime.evaluate",
        { expression: "({ state: document.readyState, title: document.title, url: location.href })", returnByValue: true },
        Math.max(2000, Math.min(cfg.timeoutMs, 5000)),
      );
      last = result?.value;
      if (last && last.state === "complete") return last;
    } catch {
      // 导航中途会短暂失败，继续轮询
    }
    await sleep(200);
  }
  return last;
}

/** volatile 字段在运行时是 Volatile 包装（用 .get() 取值）；普通字段直接就是值。 */
function unwrapVolatile(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}

export function apply(ctx, config) {
  /** 把当前配置快照成普通对象再解析（快照是纯函数，便于在 volatile 更新后重算）。 */
  const snapshot = () => {
    const raw = config && typeof config === "object" ? config : {};
    const plain = {};
    for (const [key, value] of Object.entries(raw)) plain[key] = unwrapVolatile(value);
    return resolveConfig(plain);
  };

  // 在界面上改配置**不会**重新 apply 插件，只会发这个事件：
  // 重新快照一次，后续工具调用就会用上新值（否则要重启才生效）。
  let cfg = snapshot();
  ctx.on("loader/volatile-update", () => {
    cfg = snapshot();
  });

  const seenAt = () => new Date().toISOString();

  const output = {
    schema: { type: "object", additionalProperties: true },
    render(_args, value) {
      const text = value && typeof value === "object" && typeof value.text === "string"
        ? value.text
        : asText(value, cfg.maxTextChars);
      return [{ type: "text", text }];
    },
  };

  const define = (spec) => ctx.tools.register({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output,
    isConcurrencySafe: () => READ_ONLY.has(spec.name),
    timeoutMs: spec.timeoutMs ?? 120000,
    async execute(args) {
      const value = await spec.execute(args ?? {});
      return { ...value, text: value.text ?? asText(value, cfg.maxTextChars) };
    },
  });

  // ---------------------------------------------------------------- status
  define({
    name: "chrome_status",
    description:
      "探活：调试端点（默认 127.0.0.1:9222）是否在线、Chrome 版本、当前可调试页面列表。" +
      "**不会**启动 Chrome。想确保 Chrome 在调试模式下运行请用 chrome_launch。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const version = await versionOf(cfg, 3000);
      if (!version) {
        return {
          online: false,
          endpoint: debugBase(cfg),
          chromePath: cfg.chromePath,
          userDataDir: cfg.userDataDir,
          text: `调试端点不在线：${debugBase(cfg)}（chrome_launch 可以启动它）`,
        };
      }
      let tabs = [];
      let tabsError;
      try { tabs = await listTargets(cfg); } catch (error) { tabsError = error?.message ?? String(error); }
      return {
        online: true,
        endpoint: debugBase(cfg),
        browser: version.Browser ?? null,
        protocolVersion: version["Protocol-Version"] ?? null,
        userAgent: version["User-Agent"] ?? null,
        tabs: tabs.map(({ id, title, url }) => ({ id, title, url })),
        ...(tabsError ? { tabsError } : {}),
        text:
          `调试端点在线：${version.Browser ?? "Chrome"}（${debugBase(cfg)}）\n` +
          (tabsError
            ? `页面列表获取失败：${tabsError}`
            : `可调试页面 ${tabs.length} 个：\n` + (tabs.length === 0
              ? "（无；用 chrome_tab action=new 新建）"
              : tabs.map((t, i) => `${i + 1}. ${t.title || "(无标题)"} — ${t.url}\n   id=${t.id}`).join("\n"))),
      };
    },
  });

  // ---------------------------------------------------------------- launch
  define({
    name: "chrome_launch",
    description:
      "确保 Chrome 以**调试模式**在跑：端点已在线就直接复用（不会重复启动）；否则按 " +
      "`--remote-debugging-port=<port> --user-data-dir=<dir>` 启动并等端点就绪。" +
      "返回 Chrome 版本与页面列表。user-data-dir 已有一个未开调试端口的实例时，Chrome 会把新命令转交旧实例导致端口永远不开——" +
      "此时会明确报错并提示先关掉那个实例。",
    parameters: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "端点已在线时也强行再启动一次（默认 false，通常不需要）" },
        url: { type: "string", description: "启动后顺带打开的网址（可选）" },
      },
      additionalProperties: false,
    },
    timeoutMs: 90000,
    async execute({ force = false, url }) {
      const result = await ensureChrome(cfg, { force: force === true });
      let opened;
      if (typeof url === "string" && url !== "") opened = await openTab(cfg, url);
      let tabs = [];
      try { tabs = await listTargets(cfg); } catch { /* ignore */ }
      return {
        launched: result.launched,
        reused: result.reused,
        pid: result.pid ?? null,
        endpoint: debugBase(cfg),
        browser: result.version?.Browser ?? null,
        userDataDir: cfg.userDataDir,
        args: result.args,
        tabs: tabs.map(({ id, title, url: tabUrl }) => ({ id, title, url: tabUrl })),
        ...(opened ? { opened } : {}),
        text:
          (result.reused
            ? `调试端点已在线，直接复用：${result.version?.Browser ?? "Chrome"} @ ${debugBase(cfg)}`
            : `已启动调试模式 Chrome：${result.version?.Browser ?? "Chrome"} @ ${debugBase(cfg)}（pid=${result.pid ?? "?"}）\n启动参数：${result.args.join(" ")}`) +
          `\nuser-data-dir：${cfg.userDataDir}` +
          (opened ? `\n已打开：${opened.url}（id=${opened.id}）` : "") +
          `\n可调试页面 ${tabs.length} 个` +
          (tabs.length > 0 ? "：\n" + tabs.map((t) => `- ${t.title || "(无标题)"} — ${t.url}\n  id=${t.id}`).join("\n") : ""),
      };
    },
  });

  // ---------------------------------------------------------------- tabs
  define({
    name: "chrome_tabs",
    description: "列出当前可调试的页面（标签页）及其 id / 标题 / URL。所有需要 tabId 的工具都用这里的 id。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const tabs = await listTargets(cfg);
      return {
        count: tabs.length,
        tabs,
        text: tabs.length === 0
          ? "当前没有可调试页面（用 chrome_tab action=new 打开一个）"
          : `${tabs.length} 个页面：\n` + tabs.map((t, i) => `${i + 1}. ${t.title || "(无标题)"}\n   ${t.url}\n   id=${t.id}`).join("\n"),
      };
    },
  });

  define({
    name: "chrome_tab",
    description: "管理标签页：action=new 打开新标签页（可带 url）；action=close 关闭；action=activate 置前。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["new", "close", "activate"] },
        url: { type: "string", description: "action=new 时要打开的网址（默认 about:blank）" },
        tabId: { type: "string", description: "action=close / activate 的目标 tabId" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async execute({ action, url, tabId }) {
      if (action === "new") {
        const target = await openTab(cfg, typeof url === "string" && url !== "" ? url : "about:blank");
        return { action, ...target, text: `已新建标签页：${target.url}\nid=${target.id}` };
      }
      let id = tabId;
      if (typeof id !== "string" || id === "") {
        const resolved = await resolveTarget(cfg, {});
        id = resolved.target.id;
      }
      if (action === "close") {
        const result = await httpJson(`${debugBase(cfg)}/json/close/${encodeURIComponent(id)}`, { timeoutMs: cfg.timeoutMs });
        return { action, tabId: id, result, text: `已请求关闭 id=${id}（${asText(result, 200)}）` };
      }
      if (action === "activate") {
        const result = await httpJson(`${debugBase(cfg)}/json/activate/${encodeURIComponent(id)}`, { timeoutMs: cfg.timeoutMs });
        return { action, tabId: id, result, text: `已置前 id=${id}（${asText(result, 200)}）` };
      }
      throw new Error(`未知 action：${action}（可用 new / close / activate）`);
    },
  });

  // ---------------------------------------------------------------- navigate
  define({
    name: "chrome_navigate",
    description:
      "在指定标签页导航到 URL，并默认等页面加载完（document.readyState === 'complete'）。" +
      "不传 tabId 时用第一个非 devtools 页面。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId: { type: "string" },
        urlIncludes: { type: "string", description: "按 URL 子串挑页面（tabId 的替代）" },
        waitMs: { type: "number", description: "等加载的上限毫秒数，默认 8000；0 表示只发起导航不等" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    timeoutMs: 90000,
    async execute({ url, tabId, urlIncludes, waitMs }) {
      const { target } = await resolveTarget(cfg, { tabId, urlIncludes });
      const nav = await cdpSend(target.webSocketDebuggerUrl, "Page.navigate", { url }, cfg.timeoutMs);
      const budget = Number.isFinite(Number(waitMs)) ? Number(waitMs) : 8000;
      const state = budget > 0 ? await waitForLoad(cfg, target, budget) : undefined;
      return {
        tabId: target.id,
        requestedUrl: url,
        frameId: nav?.frameId ?? null,
        errorText: nav?.errorText ?? null,
        url: state?.url ?? url,
        title: state?.title ?? target.title,
        readyState: state?.state ?? null,
        text:
          `已在 id=${target.id} 导航到 ${url}` +
          (nav?.errorText ? `\n导航报错：${nav.errorText}` : "") +
          (state ? `\n当前：${state.title || "(无标题)"} — ${state.url}（readyState=${state.state}）` : "\n（未等待加载）"),
      };
    },
  });

  // ---------------------------------------------------------------- eval
  define({
    name: "chrome_eval",
    description:
      "在页面里执行 JavaScript 并取回结果（awaitPromise + returnByValue）。" +
      "这是驱动页面的主力工具：查 DOM、点击元素、填表单、读全局变量都靠它。" +
      "返回值为 JSON 可序列化的对象/原始值；不可序列化的只回 description。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "要执行的 JS 表达式（支持 await / Promise）" },
        tabId: { type: "string" },
        urlIncludes: { type: "string" },
        awaitPromise: { type: "boolean", description: "默认 true：表达式返回 Promise 时等它 resolve" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async execute({ expression, tabId, urlIncludes, awaitPromise }) {
      const { target } = await resolveTarget(cfg, { tabId, urlIncludes });
      const { result, exceptionDetails } = await cdpSend(
        target.webSocketDebuggerUrl,
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: awaitPromise !== false,
          returnByValue: true,
          userGesture: true,
        },
        cfg.timeoutMs,
      );
      if (exceptionDetails) {
        const detail = exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown";
        throw new Error(`页面内 JS 抛异常：${truncate(detail, 2000)}`);
      }
      const value = result?.value;
      const description = result?.description;
      return {
        tabId: target.id,
        type: result?.type ?? null,
        value: value === undefined ? null : value,
        description: description ?? null,
        text: asText(value === undefined ? description ?? "(无返回值)" : value, cfg.maxTextChars),
      };
    },
  });

  // ---------------------------------------------------------------- screenshot
  define({
    name: "chrome_screenshot",
    description:
      "截图当前页面并保存为 PNG（默认写到配置的 screenshotDir），返回文件路径。" +
      "fullPage=true 时截取整页（captureBeyondViewport）。落盘后的 PNG 可以用 read_image 直接查看。",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        urlIncludes: { type: "string" },
        fullPage: { type: "boolean", description: "默认 false（只截视口）" },
        fileName: { type: "string", description: "自定义文件名（不含目录）；默认按时间戳生成" },
      },
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async execute({ tabId, urlIncludes, fullPage, fileName }) {
      const { target } = await resolveTarget(cfg, { tabId, urlIncludes });
      const shot = await cdpSend(
        target.webSocketDebuggerUrl,
        "Page.captureScreenshot",
        { format: "png", ...(fullPage === true ? { captureBeyondViewport: true } : {}) },
        cfg.timeoutMs,
      );
      if (!shot?.data) throw new Error("截图失败：CDP 没有返回 data");
      const bytes = Buffer.from(shot.data, "base64");
      await mkdir(cfg.screenshotDir, { recursive: true });
      const safeName = typeof fileName === "string" && fileName !== ""
        ? fileName.replace(/[\\/:*?"<>|]/g, "_")
        : shotName();
      const path = join(cfg.screenshotDir, safeName.endsWith(".png") ? safeName : `${safeName}.png`);
      await writeFile(path, bytes);
      return {
        tabId: target.id,
        url: target.url,
        title: target.title,
        path,
        bytes: bytes.byteLength,
        fullPage: fullPage === true,
        capturedAt: seenAt(),
        text: `截图已保存：${path}（${bytes.byteLength} 字节，${fullPage === true ? "整页" : "视口"}）\n页面：${target.title || "(无标题)"} — ${target.url}\n可用 read_image 读取该文件查看。`,
      };
    },
  });

  // ---------------------------------------------------------------- raw CDP
  define({
    name: "chrome_cdp",
    description:
      "发送任意 CDP 命令（逃生口）。默认发到选中的页面 target；browser=true 时发到浏览器级端点" +
      "（Target.createTarget / Target.closeTarget / Browser.close 等）。" +
      "常用：DOM.getDocument、Input.dispatchMouseEvent、Network.enable、Emulation.setDeviceMetricsOverride、Performance.getMetrics。",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "CDP 方法名，如 Page.reload" },
        params: { type: "object", description: "CDP 参数对象", additionalProperties: true },
        tabId: { type: "string" },
        urlIncludes: { type: "string" },
        browser: { type: "boolean", description: "true = 发到浏览器级端点而不是页面" },
      },
      required: ["method"],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async execute({ method, params, tabId, urlIncludes, browser }) {
      let wsUrl;
      let where;
      if (browser === true) {
        const version = await versionOf(cfg, 3000);
        if (!version?.webSocketDebuggerUrl) throw new Error(`浏览器级端点不可用（${debugBase(cfg)}/json/version 没有 webSocketDebuggerUrl）`);
        wsUrl = version.webSocketDebuggerUrl;
        where = "browser";
      } else {
        const { target } = await resolveTarget(cfg, { tabId, urlIncludes });
        wsUrl = target.webSocketDebuggerUrl;
        where = `tab:${target.id}`;
      }
      const result = await cdpSend(wsUrl, method, params ?? {}, cfg.timeoutMs);
      return {
        method,
        where,
        result,
        text: `CDP ${method} @ ${where} 完成：\n${asText(result, cfg.maxTextChars)}`,
      };
    },
  });

  // ---------------------------------------------------------------- stop
  define({
    name: "chrome_stop",
    description: "关闭调试模式下的 Chrome（浏览器级 Browser.close）。只影响这个调试实例，不动你日常的 Chrome。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    timeoutMs: 30000,
    async execute() {
      const version = await versionOf(cfg, 3000);
      if (!version?.webSocketDebuggerUrl) {
        return { stopped: false, text: `调试端点本来就不在线（${debugBase(cfg)}）` };
      }
      try {
        await cdpSend(version.webSocketDebuggerUrl, "Browser.close", {}, 8000);
      } catch (error) {
        // Browser.close 会让连接立刻断开，客户端侧报"提前关闭"是正常的
        const message = error?.message ?? String(error);
        if (!/提前关闭|超时/.test(message)) throw error;
      }
      for (let i = 0; i < 20; i += 1) {
        await sleep(250);
        if (!(await versionOf(cfg, 1000))) return { stopped: true, text: `已关闭调试实例（${debugBase(cfg)} 已下线）` };
      }
      return { stopped: false, text: `已发送 Browser.close，但端点仍在响应（${debugBase(cfg)}）` };
    },
  });
}

/** 新建标签页：新 Chrome 要求 PUT /json/new?url=…，旧版接受 GET，两个都试。 */
async function openTab(cfg, url) {
  const endpoint = `${debugBase(cfg)}/json/new?${encodeURIComponent(url)}`;
  let data = await httpJson(endpoint, { method: "PUT", timeoutMs: cfg.timeoutMs });
  if (!data || data.error !== undefined || data.raw !== undefined) {
    const fallback = await httpJson(endpoint, { method: "GET", timeoutMs: cfg.timeoutMs });
    if (fallback && fallback.error === undefined && fallback.raw === undefined) data = fallback;
  }
  if (!data || data.error !== undefined) {
    throw new Error(`新建标签页失败：${data?.error ?? "无响应"}（${endpoint}）`);
  }
  return { id: data.id ?? null, url: data.url ?? url, title: data.title ?? "", webSocketDebuggerUrl: data.webSocketDebuggerUrl ?? "" };
}

export { DEFAULTS };
