const WIDTH = 100;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const isContainer = (value: Json): value is readonly Json[] | { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null;

/** Lists of plain values and objects made of them can share a line. */
function isCompact(value: Json): boolean {
  if (!isContainer(value)) return true;
  if (Array.isArray(value)) return value.every((item) => !isContainer(item));
  return Object.values(value as object).every(
    (item: Json) => !isContainer(item) || (Array.isArray(item) && isCompact(item)),
  );
}

function inline(value: Json): string {
  if (!isContainer(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`,
  );
  return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
}

function render(value: Json, indent: string, prefix: number): string {
  if (!isContainer(value)) return JSON.stringify(value);
  const flat = inline(value);
  if (isCompact(value) && indent.length + prefix + flat.length <= WIDTH) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => inner + render(item, inner, 1));
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([key, item]) => {
    const name = `${JSON.stringify(key)}: `;
    return inner + name + render(item, inner, name.length + 1);
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

/**
 * Writes a document the one way it is always written, so that saving twice changes nothing and a
 * Git diff shows real changes only. Small things such as a keyframe stay on one line.
 */
export function stringifyDocument(value: unknown): string {
  const plain = JSON.parse(JSON.stringify(value)) as Json;
  return `${render(plain, "", 0)}\n`;
}
