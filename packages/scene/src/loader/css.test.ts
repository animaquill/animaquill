import { describe, expect, it } from "vitest";
import { findCssReferences, rewriteCss } from "./css.ts";

const urls = (css: string) => findCssReferences(css).map(({ url, kind }) => [url, kind]);

describe("findCssReferences", () => {
  it.each([
    ["no quotes", "a{background:url(x.png)}", "x.png"],
    ["double quotes", 'a{background:url("x.png")}', "x.png"],
    ["single quotes", "a{background:url('x.png')}", "x.png"],
    ["spaces around, no quotes", "a{background:url(  x.png  )}", "x.png"],
    ["spaces around, quotes", 'a{background:url(  "x.png"  )}', "x.png"],
    ["new lines around, quotes", 'a{background:url(\n  "x.png"\n)}', "x.png"],
    ["upper case", "a{background:URL(x.png)}", "x.png"],
    ["mixed case, quotes", 'a{background:uRl("x.png")}', "x.png"],
    ["escaped space", "a{background:url(my\\ logo.png)}", "my logo.png"],
    ["escaped quote in quotes", 'a{background:url("a\\"b.png")}', 'a"b.png'],
    ["other quote inside", 'a{background:url("a\'b.png")}', "a'b.png"],
    ["hex escape", "a{background:url(\\78.png)}", "x.png"],
    ["parentheses in a string", 'a{background:url("a(1).png")}', "a(1).png"],
    ["src()", 'a{background:src("x.png")}', "x.png"],
    ["custom property", "a{--logo:url(x.png)}", "x.png"],
    ["inside a function", "a{background:cross-fade(url(x.png),50%)}", "x.png"],
    ["declarations without a rule", "background: url(x.png)", "x.png"],
    ["after an emoji", 'a{content:"😀";background:url(x.png)}', "x.png"],
  ])("finds a url with %s", (_, css, url) => {
    expect(urls(css)).toEqual([[url, "url"]]);
  });

  it.each([
    ["a comment", "/* url(x.png) */a{color:red}"],
    ["a comment around a declaration", "a{/*background:url(x.png);*/color:red}"],
    ["a string", 'a{content:"url(x.png)"}'],
    ["an attribute selector", 'a[href="url(x.png)"]{color:red}'],
    ["a name that ends in url", "a{--x:my-url(x.png)}"],
    ["url-prefix", 'a{x:url-prefix("x.png")}'],
    ["format()", 'a{src:format("x.png")}'],
    ["local()", 'a{src:local("x.png")}'],
    ["@namespace with url()", '@namespace svg url("http://www.w3.org/2000/svg");'],
    ["@namespace with a string", '@namespace svg "http://www.w3.org/2000/svg";'],
    ["an empty url()", "a{background:url()}"],
    ["an empty string", 'a{background:url("")}'],
    ["a broken url()", "a{background:url(a b.png)}"],
    ["a comment in front of the string, which breaks a url()", 'a{b:url(/* c */"x.png")}'],
  ])("finds nothing in %s", (_, css) => {
    expect(urls(css)).toEqual([]);
  });

  it.each([
    ["a string", '@import "a.css";'],
    ["single quotes", "@import 'a.css';"],
    ["url()", "@import url(a.css);"],
    ["url() with quotes", '@import url("a.css");'],
    ["upper case", '@IMPORT URL("a.css");'],
    ["a comment", '@import /* c */ "a.css";'],
    ["a media query", '@import "a.css" screen and (min-width: 100px);'],
    ["a layer", "@import url(a.css) layer(base) supports(display: grid);"],
  ])("finds @import with %s", (_, css) => {
    expect(urls(css)).toEqual([["a.css", "import"]]);
  });

  it("finds every candidate of an image-set, and not the type of one", () => {
    const css = `a{background:image-set("a.png" 1x type("image/png"), url(b.png) 2x, 'c.png' 3x)}`;
    expect(urls(css).map(([url]) => url)).toEqual(["a.png", "b.png", "c.png"]);
    expect(urls(`a{mask:-webkit-image-set("a.png" 1x)}`)).toEqual([["a.png", "url"]]);
  });

  it("goes on after @namespace", () => {
    expect(urls('@namespace url("ns");a{background:url(x.png)}')).toEqual([["x.png", "url"]]);
  });

  it("gives offsets into the text, even after characters outside the first plane", () => {
    const css = 'a{content:"😀😀"}b{background:url(x.png)}';
    const [reference] = findCssReferences(css);
    expect(css.slice(reference?.start, reference?.end)).toBe("url(x.png)");
  });
});

describe("rewriteCss", () => {
  const blob = () => "blob:new";

  it.each([
    ["a{background:url(x.png)}", 'a{background:url("blob:new")}'],
    ['a{background:url("x.png")}', 'a{background:url("blob:new")}'],
    ["a{background:url( 'x.png' )}", 'a{background:url( "blob:new" )}'],
    ['@import "a.css" screen;', '@import "blob:new" screen;'],
    ["@import url(a.css);", '@import url("blob:new");'],
    ['a{b:image-set("a.png" 1x)}', 'a{b:image-set("blob:new" 1x)}'],
  ])("changes only the URL of %s", (css, expected) => {
    expect(rewriteCss(css, blob)).toBe(expected);
  });

  it("keeps everything around it, comments and all", () => {
    const css = `/* url(old.png) */\n.a { color: red; background: url(x.png) no-repeat; }\n/* end */`;
    expect(rewriteCss(css, blob)).toBe(
      `/* url(old.png) */\n.a { color: red; background: url("blob:new") no-repeat; }\n/* end */`,
    );
  });

  it("leaves what `replace` does not know", () => {
    const css = "a{b:url(keep.png);c:url(x.png)}";
    const rewritten = rewriteCss(css, ({ url }) => (url === "x.png" ? "y" : undefined));
    expect(rewritten).toBe('a{b:url(keep.png);c:url("y")}');
  });

  it("keeps a URL with a quote from ending the string", () => {
    expect(rewriteCss("a{b:url(x.png)}", () => 'a"b\\c\nd')).toBe('a{b:url("a\\"b\\\\c\\a d")}');
  });
});
