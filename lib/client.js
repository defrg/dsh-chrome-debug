/**
 * dsh-chrome-debug — Client half：在「设置 → 插件 → dsh-chrome-debug」的页面里
 * 渲染一张配置卡片（chrome 路径 / user-data-dir / 截图目录）。
 *
 * 为什么必须有它：DSH **不会**为第三方 bundle 自动生成配置表单。官方 cookbook
 * （实践指南：即时配置表单）说明表单要"通过产品所属的设置卡片提供编辑入口"，
 * 承载槽位是 `plugins.bundle.config`（key = 包名，渲染在 bundle 页面的描述与行之间）。
 * 官方插件靠伴生客户端包，第三方就像本插件这样自带一张卡。
 *
 * 读写走插件自己的宿主路由 `/chrome-debug/api/config`（宿主用官方 `settings.update()`
 * 写进 profile 覆盖层），这样两端契约都是可核实的，不依赖未公开的表单 API。
 * 宿主写完 volatile 值即时更新，所以**保存后立刻生效、无需重启**。
 */
window.__ModuleLoader__.load({
  id: "dsh-chrome-debug",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useState } = React;
    const h = React.createElement;

    const API = "/chrome-debug/api/config";
    const CSS_ID = "dsh-chrome-debug-settings";
    const CSS = [
      ".dcd-card{display:flex;flex-direction:column;gap:10px;padding:10px 0 4px}",
      ".dcd-row{display:flex;flex-direction:column;gap:4px}",
      ".dcd-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".dcd-input{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);",
      "border-radius:6px;background:var(--dsw-alias-bg-elevated,transparent);color:inherit;",
      "font-family:inherit;font-size:12px;width:100%;box-sizing:border-box}",
      ".dcd-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);word-break:break-all}",
      ".dcd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dcd-btn{height:26px;padding:0 10px;border:0;border-radius:6px;cursor:pointer;font-family:inherit;",
      "font-size:12px;background:var(--dsw-alias-bg-accent,#3b82f6);color:#fff}",
      ".dcd-btn[disabled]{opacity:.5;cursor:default}",
      ".dcd-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,inherit);",
      "border:1px solid var(--dsw-alias-border-secondary,#d0d5dd)}",
      ".dcd-status{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
      ".dcd-status[data-tone=error]{color:#dc2626}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
      const style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const FIELDS = [
      { key: "chromePath", label: "Chrome 可执行文件路径", placeholder: "留空 = 自动探测：CHROME_PATH → 各标准安装位置" },
      { key: "userDataDir", label: "调试专用 user-data-dir", placeholder: "留空 = <DSH_HOME>/chrome-debug/profile" },
      { key: "screenshotDir", label: "截图落盘目录", placeholder: "留空 = <DSH_HOME>/chrome-debug/shots" },
    ];

    const emptyValues = () => ({ chromePath: "", userDataDir: "", screenshotDir: "" });

    function ChromeDebugSettingsCard() {
      const [values, setValues] = useState(null);
      const [effective, setEffective] = useState(null);
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState("加载中…");
      const [tone, setTone] = useState("info");

      const applyResult = useCallback((result) => {
        const raw = result?.values ?? {};
        setValues({
          chromePath: raw.chromePath ?? "",
          userDataDir: raw.userDataDir ?? "",
          screenshotDir: raw.screenshotDir ?? "",
        });
        setEffective(result?.effective ?? null);
      }, []);

      useEffect(() => {
        ensureCss();
        let alive = true;
        fetch(API, { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return;
            if (body && body.ok) { applyResult(body.result); setTone("info"); setStatus(""); }
            else { setTone("error"); setStatus((body && body.error) || "读取失败"); }
          })
          .catch((error) => {
            if (!alive) return;
            setTone("error");
            setStatus("读取失败：" + ((error && error.message) || String(error)));
          });
        return () => { alive = false; };
      }, [applyResult]);

      const onChange = useCallback((key) => (event) => {
        const next = event.target.value;
        setValues((prev) => ({ ...(prev ?? emptyValues()), [key]: next }));
      }, []);

      const save = useCallback(() => {
        setBusy(true);
        setTone("info");
        setStatus("保存中…");
        fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values ?? emptyValues()),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok) {
              applyResult(body.result);
              setTone("info");
              setStatus("已保存" + (body.result && body.result.writtenTo ? "（写入 " + body.result.writtenTo + "）" : "") + "，立即生效");
            } else {
              setTone("error");
              setStatus((body && body.error) || "保存失败");
            }
          })
          .catch((error) => {
            setTone("error");
            setStatus("保存失败：" + ((error && error.message) || String(error)));
          })
          .finally(() => setBusy(false));
      }, [values, applyResult]);

      if (values === null) return h("div", { className: "dcd-card" }, h("div", { className: "dcd-status", "data-tone": tone }, status));

      return h(
        "div",
        { className: "dcd-card" },
        FIELDS.map((field) => h(
          "label",
          { className: "dcd-row", key: field.key },
          h("span", { className: "dcd-label" }, field.label),
          h("input", {
            className: "dcd-input",
            value: values[field.key] ?? "",
            placeholder: field.placeholder,
            spellCheck: false,
            disabled: busy,
            onChange: onChange(field.key),
          }),
        )),
        h(
          "div",
          { className: "dcd-actions" },
          h("button", { className: "dcd-btn", type: "button", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
          h("button", {
            className: "dcd-btn dcd-btn-ghost",
            type: "button",
            disabled: busy,
            onClick: () => { setValues(emptyValues()); setTone("info"); setStatus("已清空，点保存后改为默认行为"); },
          }, "清空（改用默认值）"),
          h("span", { className: "dcd-status", "data-tone": tone }, status),
        ),
        effective
          ? h(
            "div",
            { className: "dcd-hint" },
            "当前生效的 chrome：", effective.chromePath || "(未探测到)",
            h("br"),
            "profile：", effective.userDataDir, "　截图：", effective.screenshotDir,
            "　端口：", String(effective.port ?? ""), effective.headless ? "（headless）" : "",
          )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        id: "dsh-chrome-debug-bundle-config",
        key: "dsh-chrome-debug",
      }, (ownerProps = {}) => (ownerProps && ownerProps.view === "summary" ? null : h(ChromeDebugSettingsCard, null))));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.ChromeDebugSettingsCard = ChromeDebugSettingsCard;
    return module.exports;
  },
});
