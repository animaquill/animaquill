import {
  isTokenAtKeyword,
  isTokenCloseParen,
  isTokenComment,
  isTokenFunction,
  isTokenOpenParen,
  isTokenSemicolon,
  isTokenString,
  isTokenURL,
  isTokenWhitespace,
  tokenize,
  type CSSToken,
} from "@csstools/css-tokenizer";

/** A place in a stylesheet that names another file. */
export interface CssReference {
  /** What the stylesheet names, with its escapes undone. */
  readonly url: string;
  /** Whether it is another stylesheet. */
  readonly kind: "url" | "import";
  /** Where it is written, the end not included. */
  readonly start: number;
  readonly end: number;
  /** Whether that covers all of an unquoted `url(…)`, and not only a string. */
  readonly whole: boolean;
}

const IMAGE_SETS = new Set(["image-set", "-webkit-image-set"]);

/** The end of `token` as an offset that is not part of it. */
const endOf = (token: CSSToken) => token[3] + 1;

/** Comments and white space between tokens never change what they mean here. */
const significant = (css: string) =>
  tokenize({ css }).filter((token) => !isTokenComment(token) && !isTokenWhitespace(token));

/** The strings right inside an `image-set(…)`. They are URLs, unlike those in `type("…")`. */
function stringsOfImageSet(tokens: readonly CSSToken[], open: number): CSSToken[] {
  const strings: CSSToken[] = [];
  let depth = 1;
  for (let index = open + 1; index < tokens.length && depth > 0; index += 1) {
    const token = tokens[index];
    if (isTokenFunction(token) || isTokenOpenParen(token)) depth += 1;
    else if (isTokenCloseParen(token)) depth -= 1;
    else if (depth === 1 && isTokenString(token)) strings.push(token);
  }
  return strings;
}

/**
 * Finds what a stylesheet refers to. It works on tokens, so text in comments and strings stays text,
 * and `@namespace` URLs, which only name something, stay out of it.
 */
export function findCssReferences(css: string): CssReference[] {
  const tokens = significant(css);
  const found: CssReference[] = [];
  const add = (token: CSSToken, url: string, kind: CssReference["kind"], whole: boolean) => {
    if (url !== "") found.push({ url, kind, start: token[2], end: endOf(token), whole });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const kind =
      isTokenAtKeyword(previous) && previous[4].value.toLowerCase() === "import" ? "import" : "url";
    if (isTokenAtKeyword(token)) {
      const name = token[4].value.toLowerCase();
      if (name === "import" && isTokenString(next)) add(next, next[4].value, "import", false);
      if (name === "namespace") {
        while (index < tokens.length && !isTokenSemicolon(tokens[index])) index += 1;
      }
    } else if (isTokenURL(token)) {
      add(token, token[4].value, kind, true);
    } else if (isTokenFunction(token)) {
      const name = token[4].value.toLowerCase();
      if ((name === "url" || name === "src") && isTokenString(next)) {
        add(next, next[4].value, kind, false);
      } else if (IMAGE_SETS.has(name)) {
        for (const string of stringsOfImageSet(tokens, index)) {
          if (isTokenString(string)) add(string, string[4].value, "url", false);
        }
      }
    }
  }
  return found.toSorted((first, second) => first.start - second.start);
}

const quoted = (url: string) =>
  `"${url.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\a ")}"`;

/** Writes new URLs into a stylesheet. `replace` gives nothing for what stays as it is. */
export function rewriteCss(css: string, replace: (reference: CssReference) => string | undefined) {
  let result = "";
  let copied = 0;
  for (const reference of findCssReferences(css)) {
    const url = replace(reference);
    if (url === undefined) continue;
    result += css.slice(copied, reference.start);
    result += reference.whole ? `url(${quoted(url)})` : quoted(url);
    copied = reference.end;
  }
  return result + css.slice(copied);
}
