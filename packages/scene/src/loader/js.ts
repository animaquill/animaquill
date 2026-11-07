import { init, parse, type Import } from "es-module-lexer";

/** The lexer is WebAssembly, which has to be compiled once before it can run. */
export const lexerReady = init();

export interface ScriptRewrite {
  /** The new specifier for one that is known now, or nothing to leave it as it is. */
  readonly specifier: (specifier: string, offset: number) => string | undefined;
  /** Goes around the expression of an `import()` that is only known when it runs. */
  readonly computed: readonly [before: string, after: string];
  /** Goes around every `import()`, which takes real time. */
  readonly dynamic: readonly [before: string, after: string];
  /** Goes in front of code that reads `import.meta`, which would otherwise describe a blob. */
  readonly meta: string;
}

export interface RewrittenScript {
  /** What has to run first. Nothing else moves a line, so errors keep their line numbers. */
  readonly prefix: string;
  readonly text: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** At the same place, the outer `import()` opens first and the inner one closes first. */
  readonly rank: number;
}

function editsOf(found: Import, rewrite: ScriptRewrite): readonly Edit[] {
  if (found.type === "import-meta") return [];
  const { specifier, start, end, importStart, importEnd } = found;
  const edits: Edit[] = [];
  const open = (at: number, text: string) =>
    edits.push({ start: at, end: at, text, rank: importStart });
  const close = (at: number, text: string) =>
    edits.push({ start: at, end: at, text, rank: -importStart });
  if (found.type === "dynamic") {
    open(importStart, rewrite.dynamic[0]);
    close(importEnd, rewrite.dynamic[1]);
  }
  if (specifier === undefined || (found.type === "dynamic" && found.glob)) {
    open(start, rewrite.computed[0]);
    close(end, rewrite.computed[1]);
    return edits;
  }
  const text = rewrite.specifier(specifier, start);
  // The lexer gives the inside of a static specifier, and all of the argument of an `import()`.
  // Either way the new one comes with quotes of its own, whatever it has in it.
  if (text !== undefined) {
    const isStatic = found.type !== "dynamic";
    edits.push({
      start: isStatic ? start - 1 : start,
      end: isStatic ? end + 1 : end,
      text: JSON.stringify(text),
      rank: 0,
    });
  }
  return edits;
}

/**
 * Rewrites what a script imports. The lexer knows strings, comments, templates and regular
 * expressions apart, so only real imports change. Classic scripts have no static imports and no
 * `import.meta`, so this is right for them too. Gives nothing when the code cannot be read: the
 * browser then says what is wrong with it, with a better message than this could give.
 */
export function rewriteScript(text: string, rewrite: ScriptRewrite): RewrittenScript | undefined {
  let imports: readonly Import[];
  try {
    [imports] = parse(text);
  } catch {
    return undefined;
  }
  // Only the very start of a file can have one, and something else may have to go in front of it.
  const hashbang: Edit[] = text.startsWith("#!") ? [{ start: 0, end: 2, text: "//", rank: 0 }] : [];
  const edits = [...hashbang, ...imports.flatMap((found) => editsOf(found, rewrite))].toSorted(
    (first, second) => first.start - second.start || first.rank - second.rank,
  );
  let result = "";
  let copied = 0;
  for (const { start, end, text: replacement } of edits) {
    result += text.slice(copied, start) + replacement;
    copied = end;
  }
  result += text.slice(copied);
  const usesMeta = imports.some(({ type }) => type === "import-meta");
  return { prefix: usesMeta ? rewrite.meta : "", text: result };
}
