import { describe, expect, it } from "vitest";
import { virtualUrl } from "./paths.ts";
import { loadProject, typeOf, type LoadProblem, type ProjectInput } from "./project.ts";

const HEAD = "<!--head-->";
const BODY = "<!--body-->";

/** A project in memory, with URLs that say what they stand for. */
async function load(
  sources: Record<string, string>,
  entry = "scenes/a/index.html",
  overrides: Partial<ProjectInput> = {},
) {
  const made = new Map<string, { content: Blob | string; type: string }>();
  const problems: LoadProblem[] = [];
  const project = await loadProject({
    entry,
    files: new Map(Object.entries(sources).map(([path, text]) => [path, new Blob([text])])),
    makeUrl: (content, type) => {
      const url = `blob:test/${made.size}`;
      made.set(url, { content, type });
      return url;
    },
    head: HEAD,
    body: BODY,
    global: "__aq",
    report: (problem) => problems.push(problem),
    ...overrides,
  });
  const textOf = async (url: string | undefined) => {
    const content = url === undefined ? undefined : made.get(url)?.content;
    return typeof content === "string" ? content : await content?.text();
  };
  /** The URL of a path, with its content. */
  const urlIn = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
  const importMap = () => {
    const map = /<script type="importmap">(.*?)<\/script>/s.exec(project.html)?.[1] ?? "{}";
    return (JSON.parse(map) as { imports: Record<string, string> }).imports;
  };
  const moduleText = (path: string) => textOf(importMap()[virtualUrl(path)]);
  return { project, made, problems, textOf, urlIn, importMap, moduleText };
}

describe("loadProject", () => {
  it("rewrites a page and what it names, relative to each file", async () => {
    const { project, textOf, urlIn } = await load({
      "scenes/a/index.html": `<link rel="stylesheet" href="css/main.css"><img src="images/a.png">`,
      "scenes/a/css/main.css": `@import "theme.css";a{background:url(../images/a.png)}`,
      "scenes/a/css/theme.css": `b{background:url("../images/a.png#x")}`,
      "scenes/a/images/a.png": "png",
    });
    const stylesheet = urlIn(project.html, /href="(blob:[^"]+)"/);
    const image = urlIn(project.html, /src="(blob:[^"]+)"/);
    const main = await textOf(stylesheet);
    expect(main).toContain(`url("${image}")`);
    const theme = await textOf(urlIn(main ?? "", /@import "(blob:[^"]+)"/));
    expect(theme).toBe(`b{background:url("${image}#x")}`);
    expect(await textOf(image)).toBe("png");
  });

  it("gives modules addresses that an import map knows, so that cycles work", async () => {
    const { moduleText, importMap } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `import { b } from "./b.js"; export const a = () => b;`,
      "scenes/a/b.js": `import { a } from "./a.js"; export const b = () => a;`,
    });
    expect(await moduleText("scenes/a/a.js")).toContain(`from "aq:/scenes/a/b.js"`);
    expect(await moduleText("scenes/a/b.js")).toContain(`from "aq:/scenes/a/a.js"`);
    expect(Object.keys(importMap()).toSorted()).toEqual(["aq:/scenes/a/a.js", "aq:/scenes/a/b.js"]);
  });

  it("reaches shared code outside the folder of the scene", async () => {
    const { moduleText, problems } = await load({
      "scenes/a/index.html": `<script type="module" src="main.js"></script>`,
      "scenes/a/main.js": `import "../../code/shared.js";`,
      "code/shared.js": `export {};`,
    });
    expect(await moduleText("scenes/a/main.js")).toBe(`import "aq:/code/shared.js";`);
    expect(problems).toEqual([]);
  });

  it("uses one URL for a module, however it gets loaded", async () => {
    const { project, importMap } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script><script type="module">import "./a.js";</script>`,
      "scenes/a/a.js": `export {};`,
    });
    expect(project.html).toContain(`src="${importMap()["aq:/scenes/a/a.js"]}"`);
  });

  it("corrects import.meta, in front of the first line", async () => {
    const { moduleText, project, importMap } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `const a = new URL("./b.png", import.meta.url);`,
    });
    const text = await moduleText("scenes/a/a.js");
    expect(text).toContain(`import.meta.url="aq:/scenes/a/a.js";`);
    expect(text?.split("\n")).toHaveLength(1);
    const source = project.sources.get(importMap()["aq:/scenes/a/a.js"] ?? "");
    expect(source?.path).toBe("scenes/a/a.js");
    expect(text?.indexOf("const a")).toBe(source?.shift);
  });

  it("keeps a script in the page on its lines", async () => {
    const { project, textOf, urlIn } = await load({
      "scenes/a/index.html": `<!doctype html>\n<body>\n  <script>\n    fail();\n  </script>`,
    });
    const url = urlIn(project.html, /src="(blob:[^"]+)"/);
    const lines = (await textOf(url))?.split("\n");
    expect(lines?.[3]).toBe("    fail();");
    expect(project.sources.get(url ?? "")).toEqual({ path: "scenes/a/index.html", shift: 0 });
  });

  it("keeps import.meta out of the way of a script in the page", async () => {
    const { project, textOf, urlIn } = await load({
      "scenes/a/index.html": `<script type="module">a(import.meta.url);</script>`,
    });
    const url = urlIn(project.html, /src="(blob:[^"]+)"/);
    const source = project.sources.get(url ?? "");
    const text = await textOf(url);
    expect(text?.slice((source?.shift ?? 0) + `<script type="module">`.length)).toBe(
      "a(import.meta.url);",
    );
  });

  it("names bare modules through the project's import map", async () => {
    const { moduleText, problems } = await load({
      "scenes/a/index.html": `<script type="importmap">{"imports":{"lib":"../../code/lib.js","parts/":"../../code/parts/"}}</script><script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `import "lib"; import "parts/x.js"; import "nothing";`,
      "code/lib.js": ``,
      "code/parts/x.js": ``,
    });
    expect(await moduleText("scenes/a/a.js")).toBe(
      `import "aq:/code/lib.js"; import "aq:/code/parts/x.js"; import "nothing";`,
    );
    expect(problems).toEqual([
      { code: "bare-import", file: "scenes/a/a.js", line: 1, column: 44, target: "nothing" },
    ]);
  });

  it("wraps an import that is only known at run time, and can answer it then", async () => {
    const { project, moduleText } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `import(name);`,
      "scenes/a/parts/b.js": ``,
    });
    expect(await moduleText("scenes/a/a.js")).toBe(
      `__aq.load(import(__aq.spec(name,"aq:/scenes/a/a.js")));`,
    );
    expect(project.specifier("./parts/b.js", "scenes/a/a.js")).toBe("aq:/scenes/a/parts/b.js");
    expect(project.specifier("./nothing.js", "scenes/a/a.js")).toBe("./nothing.js");
  });

  describe("what a project should hear about", () => {
    it.each([
      ["an image", `<img src="https://example.com/a.png">`, "https://example.com/a.png", 1, 6],
      ["a script", `\n<script src="//example.com/a.js"></script>`, "//example.com/a.js", 2, 9],
      [
        "a stylesheet",
        `<link rel="stylesheet" href="http://example.com/a.css">`,
        "http://example.com/a.css",
        1,
        24,
      ],
      ["a style", `<style>\n  a{b:url(https://e.com/a.png)}</style>`, "https://e.com/a.png", 2, 7],
    ])("finds %s somewhere else", async (_, page, target, line, column) => {
      const { problems } = await load({ "scenes/a/index.html": page });
      expect(problems).toEqual([
        { code: "external-url", file: "scenes/a/index.html", line, column, target },
      ]);
    });

    it("finds imports from somewhere else, with their place", async () => {
      const { problems } = await load({
        "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
        "scenes/a/a.js": `\n  import x from "https://example.com/a.js";`,
      });
      expect(problems).toEqual([
        {
          code: "external-url",
          file: "scenes/a/a.js",
          line: 2,
          column: 18,
          target: "https://example.com/a.js",
        },
      ]);
    });

    it("finds what is not there", async () => {
      const { problems } = await load({
        "scenes/a/index.html": `<img src="a.png"><script type="module">import "./b.js";</script>`,
      });
      expect(problems.map(({ code, target }) => [code, target])).toEqual([
        ["missing-file", "a.png"],
        ["missing-file", "./b.js"],
      ]);
    });

    it.each([
      [`<img src="../../../a.png">`, "above-root", "../../../a.png"],
      [`<img src="..%2f..%2fa.png">`, "bad-path", "..%2f..%2fa.png"],
      [
        `<script src="%2e%2e/%2e%2e/%2e%2e/a.js"></script>`,
        "above-root",
        "%2e%2e/%2e%2e/%2e%2e/a.js",
      ],
      [`<style>a{b:url("..\\\\..\\\\..\\\\a.png")}</style>`, "above-root", "..\\..\\..\\a.png"],
    ])("refuses %s, whatever is in the project", async (page, code, target) => {
      const { problems, project } = await load({ "scenes/a/index.html": page, "a.png": "secret" });
      expect(problems.map((problem) => [problem.code, problem.target])).toEqual([[code, target]]);
      expect(project.html).not.toContain("blob:");
    });

    it("refuses a module that climbs out of the project", async () => {
      const { problems, moduleText } = await load({
        "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
        "scenes/a/a.js": `import "../../../b.js";`,
        "b.js": ``,
      });
      expect(problems.map(({ code }) => code)).toEqual(["above-root"]);
      expect(await moduleText("scenes/a/a.js")).toBe(`import "../../../b.js";`);
    });

    it("takes out stylesheets that import each other", async () => {
      const { problems, project, textOf, urlIn } = await load({
        "scenes/a/index.html": `<link rel="stylesheet" href="a.css">`,
        "scenes/a/a.css": `@import "b.css";a{}`,
        "scenes/a/b.css": `@import "a.css";b{}`,
      });
      expect(problems.map(({ code, file }) => [code, file])).toEqual([
        ["css-import-cycle", "scenes/a/b.css"],
      ]);
      const main = await textOf(urlIn(project.html, /href="(blob:[^"]+)"/));
      expect(await textOf(urlIn(main ?? "", /@import "(blob:[^"]+)"/))).toBe(
        `@import "data:text/css,";b{}`,
      );
    });

    it("does not care about files nothing uses, which may belong to another scene", async () => {
      const { problems } = await load({
        "scenes/a/index.html": `<p>nothing here</p>`,
        "code/other.js": `import "../scenes/b/gone.js";`,
        "code/other.css": `a{background:url(https://example.com/a.png)}`,
      });
      expect(problems).toEqual([]);
    });

    it("cares about what an imported module brings along", async () => {
      const { problems } = await load({
        "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
        "scenes/a/a.js": `import "./b.js";`,
        "scenes/a/b.js": `import "./gone.js";`,
      });
      expect(problems.map(({ code, file }) => [code, file])).toEqual([
        ["missing-file", "scenes/a/b.js"],
      ]);
    });

    it("says when there is nothing to start with", async () => {
      const { problems, project } = await load({}, "scenes/a/index.html");
      expect(problems).toEqual([{ code: "missing-entry", file: "scenes/a/index.html" }]);
      expect(project.html).toBe("");
    });

    it("reads a broken import map as a problem and goes on", async () => {
      const { problems, project } = await load({
        "scenes/a/index.html": `<script type="importmap">{ nope</script><p>a</p>`,
      });
      expect(problems.map(({ code }) => code)).toEqual(["bad-import-map"]);
      expect(project.html).toContain("<p>a</p>");
    });

    it("says that scopes in an import map do nothing", async () => {
      const { problems } = await load({
        "scenes/a/index.html": `<script type="importmap">{"imports":{},"scopes":{"a/":{}}}</script>`,
      });
      expect(problems.map(({ code }) => code)).toEqual(["import-map-scopes"]);
    });
  });

  it("says which script never closes", async () => {
    const { problems } = await load({ "scenes/a/index.html": `<p>a</p>\n\n<script>b()` });
    expect(problems).toEqual([
      { code: "unclosed-script", file: "scenes/a/index.html", line: 3, column: 1 },
    ]);
  });

  it("gets a hashbang out of the way of import.meta, on the same line", async () => {
    const { moduleText, project, importMap } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `#!/usr/bin/env node\nconst a = import.meta.url;`,
    });
    const text = await moduleText("scenes/a/a.js");
    const source = project.sources.get(importMap()["aq:/scenes/a/a.js"] ?? "");
    expect(text?.slice(source?.shift)).toBe(`///usr/bin/env node\nconst a = import.meta.url;`);
  });

  it("names files with quotes in them, in a way that still is a string", async () => {
    const { moduleText } = await load({
      "scenes/a/index.html": `<script type="module" src="a.js"></script>`,
      "scenes/a/a.js": `import './it\\'s.js';`,
      "scenes/a/it's.js": ``,
    });
    expect(await moduleText("scenes/a/a.js")).toBe(`import "aq:/scenes/a/it's.js";`);
  });

  it("starts from a script as well", async () => {
    const { project, importMap } = await load(
      { "scenes/a/main.mjs": `import "./b.js";`, "scenes/a/b.js": `` },
      "scenes/a/main.mjs",
    );
    expect(project.html).toContain(`type="module" src="${importMap()["aq:/scenes/a/main.mjs"]}"`);
    expect(project.html).toContain(HEAD);
    expect(project.html).toContain(BODY);
  });

  it("puts what the scene needs first, and nothing can end the import map early", async () => {
    const { project } = await load({
      "scenes/a/index.html": `<title>a</title>`,
      "scenes/a/</script><img src=x>.js": ``,
    });
    expect(project.html.indexOf(HEAD)).toBeLessThan(project.html.indexOf("importmap"));
    expect(project.html.indexOf("importmap")).toBeLessThan(project.html.indexOf("<title>"));
    expect(project.html).not.toContain("<img");
  });

  it("gives a rewritten file again at run time, the same one", async () => {
    const { project } = await load({
      "scenes/a/index.html": `<link rel="stylesheet" href="a.css">`,
      "scenes/a/a.css": ``,
      "scenes/a/b.css": `a{background:url(c.png)}`,
      "scenes/a/c.png": "png",
    });
    expect(project.html).toContain(project.urlOf("scenes/a/a.css"));
    expect(project.urlOf("scenes/a/c.png")).toBe(project.urlOf("scenes/a/c.png"));
  });

  it("says what a file is, for a browser that goes by that", async () => {
    const { made, project } = await load({
      "scenes/a/index.html": `<script src="a.js"></script><link rel="stylesheet" href="a.css">`,
      "scenes/a/a.js": ``,
      "scenes/a/a.css": ``,
      "scenes/a/a.svg": `<svg/>`,
    });
    expect(made.get(project.urlOf("scenes/a/a.js"))?.type).toBe("text/javascript");
    expect(made.get(project.urlOf("scenes/a/a.css"))?.type).toBe("text/css");
    expect(made.get(project.urlOf("scenes/a/a.svg"))?.type).toBe("image/svg+xml");
    expect(typeOf("a.UNKNOWN")).toBe("application/octet-stream");
  });

  describe("workers", () => {
    const files = {
      "scenes/a/index.html": ``,
      "scenes/a/w.js": `import { b } from "./b.js"; import("./c.js"); import(name);`,
      "scenes/a/b.js": `export const b = 1;`,
      "scenes/a/c.js": ``,
      "scenes/a/data.json": `{}`,
    };

    it("names other scripts by what they are, because workers have no import maps", async () => {
      const { project, textOf } = await load(files);
      const url = project.workerUrl("scenes/a/w.js", true, () => "blob:prelude");
      const start = await textOf(url);
      const [, main] =
        /^importScripts\("blob:prelude"\);__aq\.start\("(.+?)"\);$/.exec(start ?? "") ?? [];
      const text = await textOf(main);
      expect(text).toMatch(
        /^import \{ b \} from "blob:test\/\d+"; __aq\.load\(import\("blob:test\/\d+"\)\);/,
      );
      expect(text).toContain(`__aq.load(import(__aq.spec(name,"aq:/scenes/a/w.js")));`);
      expect(text).not.toContain(`"aq:/scenes/a/b.js"`);
    });

    it("runs the prelude first in a classic worker, on the same line", async () => {
      const { project, textOf } = await load({
        "scenes/a/index.html": ``,
        "scenes/a/w.js": `postMessage(1);\nfail();`,
      });
      const url = project.workerUrl("scenes/a/w.js", false, () => "blob:p");
      const first = `importScripts("blob:p");`;
      expect(await textOf(url)).toBe(`${first}postMessage(1);\nfail();`);
      expect(project.sources.get(url)).toEqual({ path: "scenes/a/w.js", shift: first.length });
    });

    it("gives a worker everything it may ask for at run time", async () => {
      const { project } = await load(files);
      const known = project.workerFiles();
      expect([...known.keys()].toSorted()).toEqual(Object.keys(files).toSorted());
      expect(known.get("scenes/a/data.json")).toBe(project.urlOf("scenes/a/data.json"));
    });

    it("says that modules which import each other cannot run in a worker", async () => {
      const { project, problems } = await load({
        "scenes/a/index.html": ``,
        "scenes/a/w.js": `import "./x.js";`,
        "scenes/a/x.js": `import "./w.js";`,
      });
      project.workerUrl("scenes/a/w.js", true, () => "");
      expect(problems.map(({ code, file }) => [code, file])).toEqual([
        ["worker-import-cycle", "scenes/a/x.js"],
      ]);
    });

    it("does not care about modules that no worker uses", async () => {
      const { project, problems } = await load({
        "scenes/a/index.html": ``,
        "scenes/a/w.js": ``,
        "scenes/a/x.js": `import "./y.js";`,
        "scenes/a/y.js": `import "./x.js";`,
      });
      project.workerFiles();
      project.workerUrl("scenes/a/w.js", true, () => "");
      expect(problems).toEqual([]);
    });
  });
});
