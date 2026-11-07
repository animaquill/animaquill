import { beforeAll, describe, expect, it } from "vitest";
import { lexerReady, rewriteScript } from "./js.ts";

beforeAll(() => lexerReady);

const options = {
  specifier: (specifier: string) => `NEW:${specifier}`,
  computed: ["WRAP(", ",FROM)"] as const,
  dynamic: ["", ""] as const,
  meta: "META;",
};

const rewritten = (text: string) => {
  const script = rewriteScript(text, options);
  return script && script.prefix + script.text;
};

describe("rewriteScript", () => {
  it.each([
    ["a default import", `import a from "./a.js";`, `import a from "NEW:./a.js";`],
    [
      "named imports",
      `import { a, b as c } from './a.js';`,
      `import { a, b as c } from "NEW:./a.js";`,
    ],
    ["a namespace", `import * as a from "./a.js";`, `import * as a from "NEW:./a.js";`],
    ["a bare import", `import "./a.js";`, `import "NEW:./a.js";`],
    ["no spaces", `import a from"./a.js"`, `import a from"NEW:./a.js"`],
    ["several lines", `import {\n  a,\n} from "./a.js";`, `import {\n  a,\n} from "NEW:./a.js";`],
    ["export from", `export { a } from "./a.js";`, `export { a } from "NEW:./a.js";`],
    ["export star", `export * from "./a.js";`, `export * from "NEW:./a.js";`],
    ["export star as", `export * as a from "./a.js";`, `export * as a from "NEW:./a.js";`],
    [
      "a comment inside",
      `import /* x */ a /* y */ from /* z */ "./a.js";`,
      `import /* x */ a /* y */ from /* z */ "NEW:./a.js";`,
    ],
    [
      "import attributes",
      `import a from "./a.json" with { type: "json" };`,
      `import a from "NEW:./a.json" with { type: "json" };`,
    ],
  ])("rewrites %s", (_, text, expected) => {
    expect(rewritten(text)).toBe(expected);
  });

  it.each([
    ["double quotes", `import("./a.js");`, `import("NEW:./a.js");`],
    ["single quotes", `import('./a.js');`, `import("NEW:./a.js");`],
    ["a template", "import(`./a.js`);", `import("NEW:./a.js");`],
    ["spaces", `import ( "./a.js" );`, `import ( "NEW:./a.js" );`],
    ["await", `const a = await import("./a.js");`, `const a = await import("NEW:./a.js");`],
    ["then", `import("./a.js").then(f);`, `import("NEW:./a.js").then(f);`],
    ["inside a template", "`${await import('./a.js')}`", '`${await import("NEW:./a.js")}`'],
    [
      "an options argument",
      `import("./a.json", { with: { type: "json" } });`,
      `import("NEW:./a.json", { with: { type: "json" } });`,
    ],
  ])("rewrites a dynamic import with %s", (_, text, expected) => {
    expect(rewritten(text)).toBe(expected);
  });

  it.each([
    ["a variable", `import(name);`, `import(WRAP(name,FROM));`],
    ["an expression", `import("./" + name + ".js");`, `import(WRAP("./" + name + ".js",FROM));`],
    ["a template with a hole", "import(`./${name}.js`);", "import(WRAP(`./${name}.js`,FROM));"],
    ["a call", `import(pick(a, b));`, `import(WRAP(pick(a, b),FROM));`],
    [
      "an options argument",
      `import(name, { with: { type: "json" } });`,
      `import(WRAP(name,FROM), { with: { type: "json" } });`,
    ],
    [
      "another import inside",
      `import(await import("./a.js").then((a) => a.name));`,
      `import(WRAP(await import("NEW:./a.js").then((a) => a.name),FROM));`,
    ],
  ])("leaves %s to run time", (_, text, expected) => {
    expect(rewritten(text)).toBe(expected);
  });

  describe("what goes around an import()", () => {
    const wrapped = (text: string) =>
      rewriteScript(text, { ...options, dynamic: ["LOAD(", ")"] })?.text;

    it.each([
      [`import("./a.js");`, `LOAD(import("NEW:./a.js"));`],
      [`await import(name);`, `await LOAD(import(WRAP(name,FROM)));`],
      [`import("./a.js").then(f);`, `LOAD(import("NEW:./a.js")).then(f);`],
      [`import("./a.json", { with: {} });`, `LOAD(import("NEW:./a.json", { with: {} }));`],
      [`import(import("./a.js"));`, `LOAD(import(WRAP(LOAD(import("NEW:./a.js")),FROM)));`],
    ])("%s", (text, expected) => {
      expect(wrapped(text)).toBe(expected);
    });

    it("leaves static imports out of it", () => {
      expect(wrapped(`import "./a.js";`)).toBe(`import "NEW:./a.js";`);
    });
  });

  it.each([
    ["a line comment", `// import a from "./a.js";\nf();`],
    ["a block comment", `/* import a from "./a.js"; import("./b.js"); */ f();`],
    ["a double-quoted string", `const a = 'import b from "./a.js"';`],
    ["a single-quoted string", `const a = "import('./a.js')";`],
    ["a template", "const a = `import b from './a.js'; import('./c.js')`;"],
    ["a regular expression", `const a = /import\\("\\.\\/a\\.js"\\)/;`],
    ["a method called import", `a.import("./a.js");`],
    ["an object key", `const a = { import: "./a.js" };`],
    ["a property", `const a = b.import;`],
  ])("does not touch %s", (_, text) => {
    expect(rewritten(text)).toBe(text);
  });

  it("writes what a specifier really says, whatever that takes", () => {
    const script = rewriteScript(`import "./it\\'s.js";`, {
      ...options,
      specifier: (specifier) => `aq:/${specifier}`,
    });
    expect(script?.text).toBe(`import "aq:/./it's.js";`);
    const quoted = rewriteScript(`import './it\\'s.js'; import("./a\\"b.js");`, {
      ...options,
      specifier: (specifier) => `aq:/${specifier}`,
    });
    expect(quoted?.text).toBe(`import "aq:/./it's.js"; import("aq:/./a\\"b.js");`);
  });

  it("keeps a hashbang from getting in the way of what goes in front", () => {
    const script = rewriteScript(`#!/usr/bin/env node\nimport.meta.url;`, options);
    expect(script?.prefix).toBe("META;");
    expect(script?.text).toBe(`///usr/bin/env node\nimport.meta.url;`);
  });

  it("stops being confused by a division that looks like a regular expression", () => {
    const text = `const a = b / 2; import("./a.js"); const c = d / 2;`;
    expect(rewritten(text)).toBe(`const a = b / 2; import("NEW:./a.js"); const c = d / 2;`);
  });

  it("leaves a specifier that `specifier` does not know", () => {
    const script = rewriteScript(`import a from "./a.js"; import("./b.js");`, {
      ...options,
      specifier: () => undefined,
    });
    expect(script?.text).toBe(`import a from "./a.js"; import("./b.js");`);
  });

  it("decodes what a specifier really says", () => {
    const seen: string[] = [];
    rewriteScript(`import a from "./\\u0061.js";`, {
      ...options,
      specifier: (specifier) => {
        seen.push(specifier);
        return undefined;
      },
    });
    expect(seen).toEqual(["./a.js"]);
  });

  it("gives the place of each specifier", () => {
    const text = `\n\nimport a from "./a.js";\n  import("./b.js");`;
    const places: string[] = [];
    rewriteScript(text, {
      ...options,
      specifier: (specifier, offset) => {
        places.push(`${specifier}@${text.slice(offset, offset + 4)}`);
        return undefined;
      },
    });
    expect(places).toEqual([`./a.js@./a.`, `./b.js@"./b`]);
  });

  describe("import.meta", () => {
    it("puts something in front of a script that reads it, without moving a line", () => {
      const script = rewriteScript(`\nconst a = import.meta.url;\n`, options);
      expect(script?.prefix).toBe("META;");
      expect(script?.text).toBe(`\nconst a = import.meta.url;\n`);
    });

    it("sees it in any form", () => {
      for (const text of [
        "import.meta.resolve('./a.js');",
        "const { url } = import.meta;",
        "f(import.meta);",
        "import(import.meta.url);",
      ]) {
        expect(rewriteScript(text, options)?.prefix).toBe("META;");
      }
    });

    it.each([
      ["a comment", "// import.meta.url\nf();"],
      ["a string", `const a = "import.meta.url";`],
      ["a template", "const a = `import.meta.url`;"],
    ])("sees through %s", (_, text) => {
      expect(rewriteScript(text, options)?.prefix).toBe("");
    });
  });

  it("works on a classic script too", () => {
    const text = `var a = 1; if (a < 2) { import("./a.js"); } with_ = a;`;
    expect(rewritten(text)).toBe(`var a = 1; if (a < 2) { import("NEW:./a.js"); } with_ = a;`);
  });

  it("gives up on code it cannot read, and leaves that for the browser to explain", () => {
    expect(rewriteScript(`const a = "never closed`, options)).toBeUndefined();
  });

  it("keeps every line where it was", () => {
    const text = `import a from "./a.js";\n\nimport("./b.js");\nimport(c);\nlast();`;
    expect(rewritten(text)?.split("\n")).toHaveLength(text.split("\n").length);
  });
});
