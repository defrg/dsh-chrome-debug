/**
 * dsh-chrome-debug 路由鉴权自检（不依赖 DSH，也不启动 Chrome）。
 *
 *   node scripts/check-route-auth.mjs
 *
 * 背景：`/chrome-debug/api/config` 由 `ctx.webServer` 提供，而 webServer 载体本身
 * **不拥有认证或 Origin 策略**（见官方文档「Web Server 子系统」）。因此这条路由必须
 * 自己套用 `ctx.connection.requestRejection()` —— 否则任何能访问该端口的页面都能
 * 盲发 POST 改写 chromePath / userDataDir，下一次 chrome_launch 就会用攻击者指定的
 * 可执行文件或浏览器 profile 启动。
 *
 * 本脚本用假 ctx 捕获路由并逐条验证：
 *   1. `inject` 里声明了 "connection"；
 *   2. 鉴权不通过时，GET 被拒且**不返回配置内容**；
 *   3. 鉴权不通过时，POST 被拒且**不发生任何写入**（这是最关键的断言）；
 *   4. 鉴权通过时，GET 正常返回配置；
 *   5. 鉴权通过时，POST 正常走 settings.update 写入。
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { apply, inject } from "../lib/index.js";

let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
}

function bad(label, detail) {
  failed += 1;
  console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
}

function assert(condition, label, detail) {
  if (condition) ok(label);
  else bad(label, detail);
}

// ---------------------------------------------------------------- 假 req / res

/** 极简 IncomingMessage 替身：够 readJson() 用即可。 */
function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const handlers = {};
  const req = {
    method,
    url,
    headers,
    // 无 body 时让 readJson() 走「已结束」短路分支
    complete: body === undefined,
    readableEnded: body === undefined,
    on(event, callback) {
      handlers[event] = callback;
      // 注册顺序是 data 先于 end，用微任务保持同样的先后
      if (event === "data" && body !== undefined) queueMicrotask(() => callback(Buffer.from(body, "utf8")));
      if (event === "end") queueMicrotask(() => handlers.end?.());
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

// ---------------------------------------------------------------- 假 ctx

const routes = [];
const toolSpecs = [];
const writes = [];
/** 由每个用例设置：模拟 ctx.connection.requestRejection() 的返回（401 / 403 / undefined）。 */
let rejection = undefined;

const ctx = {
  on() {
    return () => {};
  },
  tools: {
    register(spec) {
      toolSpecs.push(spec);
      return () => {};
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  settings: {
    async update(entryId, patch) {
      writes.push({ entryId, patch });
      return { layer: "profile", entryId };
    },
  },
  connection: {
    requestRejection() {
      return rejection;
    },
  },
};

apply(ctx, { screenshotDir: "E:/tmp/shots", userDataDir: "E:/tmp/profile" });

const route = routes.find((item) => item.path === "/chrome-debug/api");
const URL_CONFIG = "/chrome-debug/api/config";

console.log("dsh-chrome-debug 路由鉴权自检\n");

// ---------------------------------------------------------------- 1. inject
console.log("[1] inject 声明");
assert(
  Array.isArray(inject) && inject.includes("connection"),
  'inject 里含 "connection"',
  `实际 inject = ${JSON.stringify(inject)}`,
);
assert(Boolean(route) && typeof route.handler === "function", "已注册 /chrome-debug/api 路由");

if (!route) {
  console.error("\n路由未注册，后续断言无法进行。");
  process.exit(1);
}

// ---------------------------------------------------------------- 2. 未鉴权 GET
console.log("\n[2] 未鉴权 GET（期望被拒且不泄露配置）");
rejection = 403;
let res = makeRes();
await route.handler(makeReq({ method: "GET", url: URL_CONFIG }), res);
assert(res.statusCode === 403, "返回 403", `实际 ${res.statusCode}`);
assert(
  !res.body || !String(res.body).includes("userDataDir"),
  "响应体不含配置内容",
  `实际响应体：${String(res.body).slice(0, 120)}`,
);

// ---------------------------------------------------------------- 3. 未鉴权 POST
console.log("\n[3] 未鉴权 POST（期望被拒且**不写入**）");
rejection = 401;
const writesBefore = writes.length;
res = makeRes();
await route.handler(
  makeReq({
    method: "POST",
    url: URL_CONFIG,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userDataDir: "E:/attacker/profile", chromePath: "E:/attacker/evil.exe" }),
  }),
  res,
);
assert(res.statusCode === 401, "返回 401", `实际 ${res.statusCode}`);
assert(writes.length === writesBefore, "没有发生任何写入", `写入了 ${writes.length - writesBefore} 次`);

// ---------------------------------------------------------------- 4. 鉴权通过 GET
console.log("\n[4] 鉴权通过 GET（期望 200）");
rejection = undefined;
res = makeRes();
await route.handler(makeReq({ method: "GET", url: URL_CONFIG }), res);
let parsed = null;
try {
  parsed = JSON.parse(String(res.body));
} catch {
  /* 下面的断言会报出来 */
}
assert(res.statusCode === 200, "返回 200", `实际 ${res.statusCode}`);
assert(parsed?.ok === true, "响应体是合法配置 JSON", `实际：${String(res.body).slice(0, 120)}`);
assert(
  parsed?.result?.effective?.userDataDir === "E:/tmp/profile",
  "生效值取自传入配置",
  `实际：${parsed?.result?.effective?.userDataDir}`,
);

// ---------------------------------------------------------------- 5. 鉴权通过 POST
console.log("\n[5] 鉴权通过 POST（期望写入 settings）");
res = makeRes();
await route.handler(
  makeReq({
    method: "POST",
    url: URL_CONFIG,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ screenshotDir: "E:/tmp/other-shots" }),
  }),
  res,
);
assert(res.statusCode === 200, "返回 200", `实际 ${res.statusCode}`);
assert(writes.length === writesBefore + 1, "发生了一次 settings.update", `实际 ${writes.length - writesBefore} 次`);
assert(
  writes[writes.length - 1]?.patch?.screenshotDir === "E:/tmp/other-shots",
  "写入内容正确",
  JSON.stringify(writes[writes.length - 1]?.patch),
);

// ---------------------------------------------------------------- 汇总
console.log("");
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败 —— 这条路由的鉴权门有问题`);
  process.exit(1);
}
console.log("✓ 路由鉴权门工作正常：未鉴权请求既拿不到配置，也写不进配置");
