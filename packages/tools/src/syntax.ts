/**
 * Whether code parses, as soon as it is written: AI cannot see the picture, and code that does not
 * parse would only show as an error once the editor runs the scene again. JavaScript files whole,
 * the inline scripts of HTML files; other files are not checked. acorn loads only when needed.
 */

/** The scripts of a page with the line each starts on, from 1. */
function scriptsOf(
  html: string,
): readonly { readonly code: string; readonly line: number; readonly module: boolean }[] {
  const scripts: { code: string; line: number; module: boolean }[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = (match[1] ?? "").toLowerCase();
    if (/\bsrc\s*=/.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/.exec(attributes)?.[1];
    const isScript = type === undefined || type === "module" || type.includes("javascript");
    if (!isScript) continue;
    const start = (match.index ?? 0) + match[0].indexOf(">") + 1;
    const line = html.slice(0, start).split("\n").length;
    scripts.push({ code: match[2] ?? "", line, module: type === "module" });
  }
  return scripts;
}

/** The first syntax error of a file, as `line:column message`, or "ok", or why it is not checked. */
export async function syntaxOf(path: string, text: string): Promise<string> {
  const isScript = /\.m?js$/.test(path);
  const isPage = /\.html?$/.test(path);
  if (!isScript && !isPage) return "not checked (not JavaScript or HTML)";
  const { parse } = await import("acorn");
  const parts = isScript ? [{ code: text, line: 1, module: true }] : scriptsOf(text);
  for (const part of parts) {
    try {
      parse(part.code, {
        ecmaVersion: "latest",
        sourceType: part.module ? "module" : "script",
        allowHashBang: true,
      });
    } catch (error) {
      const { loc, message } = error as {
        loc?: { line: number; column: number };
        message?: string;
      };
      const line = (loc?.line ?? 1) + part.line - 1;
      const column = (loc?.column ?? 0) + 1;
      return `error at line ${line}, column ${column}: ${String(message ?? error).replace(/ \(\d+:\d+\)$/, "")}`;
    }
  }
  return "ok";
}
