# dsh-chrome-debug

DSH（DeepSeek Harness）插件：**把 Chrome 的调试能力接成工具，并且自己会启动调试模式的 Chrome。**

装好之后，Agent 直接就能列标签页、导航、跑 JS、截图、发任意 CDP 命令——不用你手动开 Chrome，也不用记端口。

## 零第三方依赖

只用 Node 内置能力，所以没有原生模块、没有构建步骤、装完即用：

| 用途 | 用什么 |
| --- | --- |
| 控制端点 `/json/version`、`/json/list`、`/json/new` | 全局 `fetch` |
| CDP 命令（`Page.navigate`、`Runtime.evaluate`、`Page.captureScreenshot`…） | 全局 `WebSocket`（Node ≥22 自带 WHATWG WebSocket） |
| 启动 Chrome | `node:child_process` |

**为什么走 Node 的 WebSocket 很关键**：Chrome 会拒绝带 `Origin` 头的 WebSocket 升级（除非加 `--remote-allow-origins`）。浏览器里跑的调试工具因此必须放开那个参数；Node 的 WebSocket **不发 Origin**，所以插件不需要给 Chrome 加任何放宽参数。

## 工具

| 工具 | 用途 |
| --- | --- |
| `chrome_status` | 探活：端点是否在线、Chrome 版本、页面列表（**不启动** Chrome） |
| `chrome_launch` | **确保调试模式 Chrome 在跑**：在线就复用，不在线则按配置启动并等端点就绪 |
| `chrome_tabs` | 列出可调试页面（id / 标题 / URL） |
| `chrome_tab` | 管理标签页：`new` / `close` / `activate` |
| `chrome_navigate` | 导航到 URL，默认等 `document.readyState === 'complete'` |
| `chrome_eval` | 页面里执行 JS（`awaitPromise` + `returnByValue`）—— 驱动页面的主力 |
| `chrome_screenshot` | 截图存 PNG（可整页），落盘后可用 `read_image` 查看 |
| `chrome_cdp` | **任意 CDP 命令**（逃生口）；`browser: true` 发到浏览器级端点 |
| `chrome_stop` | 关闭这个调试实例（`Browser.close`），不影响你日常的 Chrome |

`chrome_status` / `chrome_tabs` 是只读的，允许并发；其余工具**有意串行**（`isConcurrencySafe=false`）：同一个页面上的导航/求值/截图并发会互相打架。

## 配置

**默认值全部是可移植的，不写死任何本机路径**：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `chromePath` | 自动探测 | 顺序：本字段 → `CHROME_PATH` 环境变量 → 各标准安装位置（`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%` 下的 `Google\Chrome\Application\chrome.exe`） |
| `port` | `9222` | 调试端口 |
| `userDataDir` | `<DSH_HOME>/chrome-debug/profile` | 调试专用 profile。`DSH_HOME` 默认 `~/.dsh`。**不要指向你日常的 profile** |
| `screenshotDir` | `<DSH_HOME>/chrome-debug/shots` | 截图落盘目录 |
| `extraArgs` | `[]` | 追加启动参数，如 `["--headless=new"]`、`["--remote-allow-origins=*"]` |
| `headless` | `false` | `true` 则加 `--headless=new` |
| `startTimeoutMs` | `20000` | 启动后等端点就绪的上限 |
| `timeoutMs` | `15000` | 单条 CDP 命令超时 |
| `maxTextChars` | `8000` | 工具返回文本截断上限 |

### 在 GUI 里改（推荐）

插件导出了 schemastery 的 `Config` schema，所以 **设置 → 插件 → `dsh-chrome-debug`** 会直接渲染出表单：
**chrome 路径**与 **user-data-dir** 各一个输入框（此外还有端口、截图目录、headless、追加参数等共 9 项），
每项都带说明与默认值。改动会写入本 profile 的覆盖层，**不需要重启**即可生效。

留空即走下面的可移植默认值 —— 也就是说"自动探测 Chrome"和"profile 落在 DSH 数据根下"都是默认行为。

> **改代码时的硬性要求**：表单字段必须在 schema 里标 **`.volatile()`**。按官方 cookbook
> [实践指南：即时配置表单](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)，
> **普通字段不进入设置 schema** —— 漏标的表现就是"插件详情页里一个输入框都没有"（宿主侧的 `Config` 状态会停在 `absent`）。
> 相应地，运行时这些字段拿到的是 `Volatile<T>` 包装，要用 `.get()` 取值：本插件在每个工具调用前重新快照配置，
> 并在 `loader/volatile-update` 时刷新，所以**界面改完即时生效、无需重启**。
> `node scripts/check-config.mjs` 会替你检查这两点。

### 在配置文件里改

也可以写插件行 `config`（`cordis.patch.yml`）：

```yaml
config:
  chromePath: '<chrome.exe 路径>'          # 留空 = 自动探测
  userDataDir: '<调试专用 profile 目录>'   # 留空 = <DSH_HOME>/chrome-debug/profile
  screenshotDir: '<截图目录>'              # 留空 = <DSH_HOME>/chrome-debug/shots
```

改配置**不需要重启**（`apply(ctx, config)` 会用新 config 重新执行）；改代码才需要重启（宿主插件走 ESM 模块缓存）。

### 自检（不依赖 DSH、不启动 Chrome）

```powershell
node scripts/check-config.mjs
```

验证宿主模块能否加载（语法/依赖问题会在这里暴露），并打印表单会渲染的字段清单。退出码 `0` = 通过。

## 安装（desktop profile）

```powershell
dsh plugin --profile desktop add <本仓库路径>\dsh-chrome-debug
```

或在 GUI：设置 → 插件 → 安装，填本地路径。新增宿主插件需要重启 DSH 才加载。

## 验证顺序

1. `chrome_status` → 端点在线吗？（不在线是正常的，下一步负责起）
2. `chrome_launch` → 启动或复用；返回版本、启动参数、页面列表
3. `chrome_tab action=new url=https://example.com` → 新建页面
4. `chrome_eval expression="document.title"` → 拿到标题
5. `chrome_screenshot` → 落盘 PNG，再用 `read_image` 看
6. `chrome_stop` → 关闭调试实例

## 已知边界与坑

- **同一个 `user-data-dir` 已有一个"没开调试端口"的 Chrome 在跑** → Chrome 会把新命令转交给既有实例，端口永远不开。插件的处理是：轮询超时后**明确报错**并给出提示（附当前 `chrome.exe` 进程数），让你先关掉那个实例或换目录。
- 端口只绑 `127.0.0.1`（插件不传 `--remote-debugging-address`）。调试端口等于浏览器完全控制权，**不要对外暴露**。
- `userDataDir` 默认落在 DSH 数据根下、而不是你日常的 Chrome profile —— 这是刻意的：把主 profile 交给调试端口等于交出所有登录态。
- `chrome_eval` 能执行任意 JS（包括读该 profile 的 cookie / localStorage）——这是调试能力的本质，所以务必用**独立的调试 profile**。
- 返回值必须可 JSON 序列化；DOM 节点这类只能拿到 `description`。要更细的能力（`DOM.*`、`Input.*`、`Network.*`、`Emulation.*`）走 `chrome_cdp`。
- 截图只写 `screenshotDir` 下，文件名由插件生成（`fileName` 参数会被消毒，不允许路径穿越）。

## 许可

MIT
