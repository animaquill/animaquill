import { describe, expect, it } from "vitest";
import { rewriteHtml, rewriteSrcset, type HtmlRewrite } from "./html.ts";

const scriptUrls = (scripts: string[]) => (text: string) => {
  scripts.push(text);
  return `blob:script-${scripts.length}`;
};

function rewritten(source: string, overrides: Partial<HtmlRewrite> = {}): string {
  return rewriteHtml(source, {
    url: (value) => `NEW:${value}`,
    css: (css) => css.replaceAll("OLD", "NEW"),
    script: () => "blob:script",
    importMap: () => {},
    problem: () => {},
    head: () => "<!--head-->",
    body: "<!--body-->",
    ...overrides,
  });
}

/** Without the two things that always go in. */
const only = (source: string) => rewritten(source, { head: () => "", body: "" });

describe("rewriteHtml", () => {
  it.each([
    [`<img src="a.png">`, `<img src="NEW:a.png">`],
    [`<img src='a.png'>`, `<img src="NEW:a.png">`],
    [`<img src=a.png>`, `<img src="NEW:a.png">`],
    [`<IMG SRC="a.png">`, `<IMG SRC="NEW:a.png">`],
    [`<img\n  src = "a.png"\n  alt="x">`, `<img\n  src ="NEW:a.png"\n  alt="x">`],
    [
      `<video src="a.mp4" poster="a.png"></video>`,
      `<video src="NEW:a.mp4" poster="NEW:a.png"></video>`,
    ],
    [`<audio src="a.mp3"></audio>`, `<audio src="NEW:a.mp3"></audio>`],
    [`<source src="a.mp4">`, `<source src="NEW:a.mp4">`],
    [`<track src="a.vtt">`, `<track src="NEW:a.vtt">`],
    [`<embed src="a.pdf">`, `<embed src="NEW:a.pdf">`],
    [`<object data="a.pdf"></object>`, `<object data="NEW:a.pdf"></object>`],
    [`<input type="image" src="a.png">`, `<input type="image" src="NEW:a.png">`],
    [`<script src="a.js"></script>`, `<script src="NEW:a.js"></script>`],
    [
      `<script type="module" src="a.js"></script>`,
      `<script type="module" src="NEW:a.js"></script>`,
    ],
    [`<svg><image href="a.png"/></svg>`, `<svg><image href="NEW:a.png"/></svg>`],
    [`<svg><image xlink:href="a.png"/></svg>`, `<svg><image xlink:href="NEW:a.png"/></svg>`],
    [`<svg><feImage href="a.png"/></svg>`, `<svg><feImage href="NEW:a.png"/></svg>`],
    [`<svg><use href="a.svg#b"/></svg>`, `<svg><use href="NEW:a.svg#b"/></svg>`],
    [`<link rel="stylesheet" href="a.css">`, `<link rel="stylesheet" href="NEW:a.css">`],
    [
      `<link rel="preload" as="image" href="a.png">`,
      `<link rel="preload" as="image" href="NEW:a.png">`,
    ],
    [`<link rel="modulepreload" href="a.js">`, `<link rel="modulepreload" href="NEW:a.js">`],
    [`<link rel="ICON shortcut" href="a.png">`, `<link rel="ICON shortcut" href="NEW:a.png">`],
    [`<template><img src="a.png"></template>`, `<template><img src="NEW:a.png"></template>`],
  ])("rewrites %s", (source, expected) => {
    expect(only(source)).toBe(expected);
  });

  it.each([
    [`<a href="a.html">a</a>`],
    [`<link rel="preconnect" href="https://example.com">`],
    [`<div data-src="a.png"></div>`],
    [`<img alt="src=a.png">`],
    [`<!-- <img src="a.png"> -->`],
    [`<script type="text/template"><img src="a.png"></script>`],
    [`<script type="application/json">{"src":"a.png"}</script>`],
    [`<noscript><img src="a.png"></noscript>`],
    [`<textarea><img src="a.png"></textarea>`],
    [`<title><img src="a.png"></title>`],
  ])("leaves %s alone", (source) => {
    expect(only(source)).toBe(source);
  });

  it("escapes what it writes into an attribute", () => {
    expect(only(`<img src="a.png">`).length).toBeGreaterThan(0);
    const output = rewritten(`<img src="a.png">`, {
      url: () => `a"b&c<d`,
      head: () => "",
      body: "",
    });
    expect(output).toBe(`<img src="a&quot;b&amp;c&lt;d">`);
  });

  it("decodes an attribute before asking about it", () => {
    const seen: string[] = [];
    rewritten(`<img src="a&amp;b.png">`, {
      url: (value) => {
        seen.push(value);
        return undefined;
      },
    });
    expect(seen).toEqual(["a&b.png"]);
  });

  it("gives the place of each reference", () => {
    const places: unknown[] = [];
    rewritten(`<!doctype html>\n<p>\n  <img src="a.png">\n`, {
      url: (_, at) => {
        places.push(at);
        return undefined;
      },
    });
    expect(places).toEqual([{ line: 3, column: 8 }]);
  });

  it("rewrites stylesheets in the page and in attributes", () => {
    expect(only(`<style>a{b:OLD}</style>`)).toBe(`<style>a{b:NEW}</style>`);
    expect(only(`<p style="b:OLD">`)).toBe(`<p style="b:NEW">`);
    expect(only(`<svg><style>a{b:OLD}</style></svg>`)).toBe(`<svg><style>a{b:NEW}</style></svg>`);
    expect(only(`<p style="b:same">`)).toBe(`<p style="b:same">`);
  });

  it("gives a stylesheet in an attribute its value, without the entities", () => {
    const seen: string[] = [];
    const output = rewritten(`<p style="b:url(&quot;OLD&quot;)">`, {
      css: (css) => {
        seen.push(css);
        return css.replace("OLD", "NEW");
      },
      head: () => "",
      body: "",
    });
    expect(seen).toEqual([`b:url("OLD")`]);
    expect(output).toBe(`<p style="b:url(&quot;NEW&quot;)">`);
  });

  it("does not trust an integrity hash, because the file changed", () => {
    expect(only(`<script src="a.js" integrity="sha256-x"></script>`)).toBe(
      `<script src="NEW:a.js" ></script>`,
    );
    expect(only(`<link rel="stylesheet" href="a.css" integrity="sha256-x">`)).toBe(
      `<link rel="stylesheet" href="NEW:a.css" >`,
    );
  });

  describe("scripts in the page", () => {
    it("makes them files, with their attributes", () => {
      const scripts: string[] = [];
      const output = rewritten(
        `<script>one()</script><script type="module" data-x="1">two()</script>`,
        { script: scriptUrls(scripts), head: () => "", body: "" },
      );
      expect(scripts).toEqual(["one()", "two()"]);
      expect(output).toBe(
        `<script src="blob:script-1"></script><script type="module" data-x="1" src="blob:script-2"></script>`,
      );
    });

    it("says where the code starts", () => {
      const places: unknown[] = [];
      rewritten(`<!doctype html>\n<body>\n<script>\n  a();\n</script>`, {
        script: (_, at) => {
          places.push(at);
          return "blob:x";
        },
      });
      expect(places).toEqual([{ line: 3, column: 9 }]);
    });

    it("drops what a classic script in the page never meant", () => {
      expect(only(`<script defer async>a()</script>`)).toBe(`<script src="blob:script"></script>`);
    });

    it("keeps async on a module, where it means something", () => {
      expect(only(`<script type="module" async>a()</script>`)).toBe(
        `<script type="module" async="" src="blob:script"></script>`,
      );
    });

    it("takes the hash of a script off, which no script in a page has to pass", () => {
      expect(only(`<script integrity="sha256-x">a()</script>`)).toBe(
        `<script src="blob:script"></script>`,
      );
      expect(only(`<script type="module" integrity="sha256-x">a()</script>`)).toBe(
        `<script type="module" src="blob:script"></script>`,
      );
    });

    it("does not run what never closes, like a browser, and leaves nothing swallowed", () => {
      const problems: unknown[] = [];
      const output = rewritten(`<!doctype html><p>a</p>\n<script>fail()`, {
        problem: (code, at) => {
          problems.push([code, at]);
        },
      });
      expect(output).toBe(`<!doctype html><!--head--><body><!--body--><p>a</p>\n`);
      expect(problems).toEqual([["unclosed-script", { line: 2, column: 1 }]]);
    });

    it("keeps what goes in first from ending up in an open script", () => {
      expect(rewritten(`<script>a()`)).toBe(`<!--head--><body><!--body-->`);
      expect(rewritten(`<!doctype html><script>a()</script><script src="b.js">`)).toBe(
        `<!doctype html><!--head--><script src="blob:script"></script><body><!--body-->`,
      );
    });

    it("sees every way of saying JavaScript", () => {
      expect(only(`<script type="text/javascript">a()</script>`)).toContain("blob:script");
      expect(only(`<script type=" Text/JavaScript ">a()</script>`)).toContain("blob:script");
    });

    it("leaves an empty script", () => {
      expect(only(`<script>  </script>`)).toBe(`<script>  </script>`);
    });

    it("keeps a script in an SVG where it is", () => {
      expect(only(`<svg><script>a()</script></svg>`)).toBe(`<svg><script>a()</script></svg>`);
    });

    it("takes an import map in any case, as a browser does", () => {
      const maps: string[] = [];
      const output = rewritten(`<script type="ImportMap">{"imports":{}}</script>`, {
        importMap: (text) => {
          maps.push(text);
        },
        head: () => "",
        body: "",
      });
      expect(maps).toEqual([`{"imports":{}}`]);
      expect(output).toBe("");
    });

    it("takes what a browser takes for a module, and leaves what it takes for data", () => {
      expect(only(`<script type="MODULE">a()</script>`)).toContain("blob:script");
      expect(only(`<script type=" module ">a()</script>`)).toBe(
        `<script type=" module ">a()</script>`,
      );
      expect(only(`<script type=" importmap ">{}</script>`)).toBe(
        `<script type=" importmap ">{}</script>`,
      );
    });

    it("reads import maps first and takes them out", () => {
      const order: string[] = [];
      const output = rewritten(
        `<script type="module">a()</script><script type="importmap">{"imports":{}}</script>`,
        {
          script: () => {
            order.push("script");
            return "blob:x";
          },
          importMap: (text) => {
            order.push(text);
          },
          head: () => "",
          body: "",
        },
      );
      expect(order).toEqual([`{"imports":{}}`, "script"]);
      expect(output).toBe(`<script type="module" src="blob:x"></script>`);
    });
  });

  it("opens a closed shadow tree, because what is in it has to follow the clock", () => {
    expect(only(`<div><template shadowrootmode="closed"><img src="a.png"></template></div>`)).toBe(
      `<div><template shadowrootmode="open"><img src="NEW:a.png"></template></div>`,
    );
    expect(only(`<template shadowrootmode="open"><b></b></template>`)).toBe(
      `<template shadowrootmode="open"><b></b></template>`,
    );
  });

  it("takes out a <base>, which the sandbox forbids, and says so", () => {
    const problems: unknown[] = [];
    const output = rewritten(`<head><base href="x/"></head>`, {
      problem: (code, at) => {
        problems.push([code, at]);
      },
      head: () => "",
      body: "",
    });
    expect(output).toBe(`<head></head>`);
    expect(problems).toEqual([["base-tag", { line: 1, column: 7 }]]);
  });

  it("says when a page has no body to work with", () => {
    const problems: string[] = [];
    rewritten(`<frameset></frameset>`, {
      problem: (code) => {
        problems.push(code);
      },
    });
    expect(problems).toEqual(["frameset"]);
  });

  describe("what goes in first", () => {
    it.each([
      [
        "a full page",
        `<!doctype html><html><head><title>a</title></head><body class="b"><p>c</p></body></html>`,
        `<!doctype html><html><head><!--head--><title>a</title></head><body class="b"><!--body--><p>c</p></body></html>`,
      ],
      [
        "no head",
        `<!doctype html><html><body><p>c</p></body></html>`,
        `<!doctype html><html><!--head--><body><!--body--><p>c</p></body></html>`,
      ],
      [
        "no html, no head, no body",
        `<!doctype html><title>a</title><p>c</p>`,
        `<!doctype html><!--head--><title>a</title><body><!--body--><p>c</p>`,
      ],
      ["only text", `hello`, `<!--head--><body><!--body-->hello`],
      ["nothing", ``, `<!--head--><body><!--body-->`],
      [
        "a head and no body",
        `<head><title>a</title></head>`,
        `<head><!--head--><title>a</title></head><body><!--body-->`,
      ],
      [
        "an empty html",
        `<!doctype html><html></html>`,
        `<!doctype html><html><!--head--></html><body><!--body-->`,
      ],
      [
        "a script first in the head",
        `<head><script>a()</script></head><body></body>`,
        `<head><!--head--><script src="blob:script"></script></head><body><!--body--></body>`,
      ],
    ])("finds the places in %s", (_, source, expected) => {
      expect(rewritten(source)).toBe(expected);
    });

    it("stays behind the doctype, or the page would turn into quirks mode", () => {
      const output = rewritten(`<!-- a --><!doctype html><p>b</p>`);
      expect(output.indexOf("<!doctype")).toBeLessThan(output.indexOf("<!--head-->"));
    });

    it("asks for the head after everything else", () => {
      const order: string[] = [];
      rewritten(`<script>a()</script>`, {
        script: () => {
          order.push("script");
          return "blob:x";
        },
        head: () => {
          order.push("head");
          return "";
        },
      });
      expect(order).toEqual(["script", "head"]);
    });
  });
});

describe("rewriteSrcset", () => {
  const rewrite = (url: string) => `NEW:${url}`;

  it.each([
    ["a.png", "NEW:a.png"],
    ["a.png 2x", "NEW:a.png 2x"],
    ["a.png 1x, b.png 2x", "NEW:a.png 1x, NEW:b.png 2x"],
    ["a.png 100w,b.png 200w", "NEW:a.png 100w, NEW:b.png 200w"],
    ["  a.png  ,  b.png  2x  ", "NEW:a.png, NEW:b.png 2x"],
    ["a,b.png 2x", "NEW:a,b.png 2x"],
    ["a.png, b.png", "NEW:a.png, NEW:b.png"],
    ["a.png,, b.png", "NEW:a.png, NEW:b.png"],
    ["", ""],
  ])("reads %j", (value, expected) => {
    expect(rewriteSrcset(value, rewrite)).toBe(expected);
  });

  it("keeps a candidate that `rewrite` does not know", () => {
    expect(rewriteSrcset("a.png 1x", () => undefined)).toBe("a.png 1x");
  });
});
