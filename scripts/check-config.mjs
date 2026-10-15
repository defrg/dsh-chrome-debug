/**
 * dsh-chrome-debug 自检脚本（不依赖 DSH，也不启动 Chrome）。
 *
 *   node scripts/check-config.mjs
 *
 * 它验证三件事：
 *   1. 宿主模块能否被加载 —— 语法错误、缺依赖（例如 @deepseek-ai/schemastery 没装）都会在这里暴露；
 *   2. 导出的 Config schema 里是否有 DSH 设置表单需要的字段；
 *   3. 每个字段是否标了 .volatile() —— 按官方 cookbook「实践指南：即时配置表单」，
 *      **只有 volatile 字段才会进入设置 schema**，漏标就会导致插件详情页没有任何输入框。
 *
 * 退出码：0 = 通过，1 = 失败。
 */
import { Config, inject, name } from "../lib/index.js";

/** schemastery 的 toJSON() 是带 refs 的引用图，这里原样打印供人工核对。 */
function schemaToJson(schema) {
  if (!schema) return null;
  try {
    if (typeof schema.toJSON === "function") return schema.toJSON();
  } catch { /* 落到下面的兜底 */ }
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return { keys: Object.keys(schema) };
  }
}

function dictOf(schema) {
  for (const accessor of ["dict", "properties", "inner"]) {
    const value = schema?.[accessor];
    if (value && typeof value === "object" && Object.keys(value).length > 0) return value;
  }
  return {};
}

const dict = dictOf(Config);
const fields = Object.keys(dict);

/** volatile 标记在不同版本里可能落在 meta.volatile / meta['x-cordis'].volatile。 */
function volatileOf(inner) {
  const meta = inner?.meta ?? {};
  if (typeof meta.volatile === "boolean") return meta.volatile;
  const ext = meta["x-cordis"];
  if (ext && typeof ext.volatile === "boolean") return ext.volatile;
  return undefined;
}

const details = Object.fromEntries(
  fields.map((field) => {
    const inner = dict[field];
    const meta = inner?.meta ?? {};
    return [field, {
      description: meta.description ?? null,
      default: meta.default ?? null,
      volatile: volatileOf(inner) ?? null,
      metaKeys: Object.keys(meta),
    }];
  }),
);

console.log(JSON.stringify({ name, inject, hasConfigSchema: Boolean(Config), fieldCount: fields.length, fields: details }, null, 2));

let failed = false;
if (!Config) {
  console.error("✗ 没有导出 Config schema —— 「设置 → 插件」不会出现可编辑表单");
  failed = true;
} else {
  for (const required of ["chromePath", "userDataDir"]) {
    if (!fields.includes(required)) {
      console.error(`✗ schema 里缺少 ${required} 字段（实测字段：${fields.join(", ") || "无"}）`);
      failed = true;
    }
  }
  const notVolatile = fields.filter((field) => volatileOf(dict[field]) !== true);
  if (notVolatile.length > 0) {
    console.error(`✗ 这些字段没标 .volatile()，不会出现在设置表单里：${notVolatile.join(", ")}`);
    console.error("  （官方 cookbook：普通字段不进入设置 schema）");
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`✓ 模块可加载；schema 含 ${fields.length} 个 volatile 字段，chromePath / userDataDir 就位 —— 插件详情页会出现输入框`);
