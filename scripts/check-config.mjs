/**
 * dsh-chrome-debug 自检脚本（不依赖 DSH，也不启动 Chrome）。
 *
 *   node scripts/check-config.mjs
 *
 * 它验证两件事：
 *   1. 宿主模块能否被加载 —— 语法错误、缺依赖（例如 @deepseek-ai/schemastery 没装）都会在这里暴露；
 *   2. 导出的 Config schema 里是否有 DSH 设置表单需要的字段（chromePath / userDataDir），
 *      打印出的字段清单即「设置 → 插件 → dsh-chrome-debug」表单会渲染的输入框。
 *
 * 退出码：0 = 通过，1 = 失败。
 */
import { Config, inject, name } from "../lib/index.js";

/** schemastery 的 toJSON() 是带 refs 的引用图，这里只是原样打印供人工核对。 */
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

/** 从 schemastery 对象 schema 里取字段表：优先内部的 dict，其次 properties。 */
function fieldsOf(schema) {
  if (!schema) return [];
  for (const accessor of ["dict", "properties", "inner"]) {
    const value = schema[accessor];
    if (value && typeof value === "object" && Object.keys(value).length > 0) {
      return Object.keys(value);
    }
  }
  const json = schemaToJson(schema);
  if (json && typeof json === "object" && json.properties) return Object.keys(json.properties);
  return [];
}

/** 每个字段的说明与默认值（便于确认表单里显示什么）。 */
function describeField(schema, field) {
  const inner = schema?.dict?.[field] ?? schema?.properties?.[field] ?? schema?.[field];
  const meta = inner?.meta ?? {};
  return { description: meta.description ?? null, default: meta.default ?? null };
}

const fields = fieldsOf(Config);
const details = Object.fromEntries(fields.map((field) => [field, describeField(Config, field)]));

console.log(
  JSON.stringify(
    {
      name,
      inject,
      hasConfigSchema: Boolean(Config),
      fieldCount: fields.length,
      fields: details,
      rawSchema: schemaToJson(Config),
    },
    null,
    2,
  ),
);

if (!Config) {
  console.error("✗ 没有导出 Config schema —— 「设置 → 插件」不会出现可编辑表单");
  process.exit(1);
}
for (const required of ["chromePath", "userDataDir"]) {
  if (!fields.includes(required)) {
    console.error(`✗ schema 里缺少 ${required} 字段（实测字段：${fields.join(", ") || "无"}）`);
    process.exit(1);
  }
}
console.log(
  `✓ 模块可加载；schema 含 ${fields.length} 个字段，其中 chromePath / userDataDir 就位 —— 插件详情页会出现这两个输入框`,
);
