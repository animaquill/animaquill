import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReadmeBody from "./ReadmeBody.tsx";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const place = { owner: "pipi", repo: "aq-opus", commit: COMMIT, path: "" };
const html = (text: string, where: typeof place | "none" = place) =>
  renderToStaticMarkup(<ReadmeBody text={text} place={where === "none" ? undefined : where} />);

describe("a README, as someone else wrote it", () => {
  it("[挡住] HTML in it shows as text: no element of its own, nothing runs, nothing in a frame", () => {
    const shown = html(
      [
        "<script>alert(1)</script>",
        "",
        '<img src=x onerror="alert(1)">',
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        "<details><summary>More</summary>Hidden</details>",
        "",
        '<a href="javascript:alert(1)">click</a>',
      ].join("\n"),
    );
    expect(shown).not.toMatch(/<(script|iframe|details|summary)\b/i);
    expect(shown).not.toMatch(/<img[^>]*onerror/i);
    expect(shown).not.toMatch(/href="javascript:/i);
  });

  it("[挡住] links: javascript:, data: and the like are their words; the web opens in a new tab and says where it goes", () => {
    const shown = html(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com/x) [https://example.com/y](https://evil.example/)",
    );
    expect(shown).not.toContain("javascript:");
    expect(shown).not.toContain("data:text");
    expect(shown).toContain(
      'href="https://example.com/x" target="_blank" rel="noopener noreferrer"',
    );
    expect(shown).toContain('title="https://evil.example/"');
  });

  it("[挡住] pictures from elsewhere wait to be asked for; those of the repository come from the commit installed", () => {
    const shown = html(
      "![a](https://i.imgur.com/x.png) ![b](shots/b.png) ![c](data:image/png;base64,AA)",
    );
    expect(shown).not.toContain('src="https://i.imgur.com');
    expect(shown).toContain("readme-image-elsewhere");
    expect(shown).toContain(
      `src="https://raw.githubusercontent.com/pipi/aq-opus/${COMMIT}/shots/b.png"`,
    );
    expect(shown).not.toContain("data:image");
    expect(shown).toContain('referrerPolicy="no-referrer"');
    // A pack from this computer: no picture of its folder shows.
    expect(html("![b](shots/b.png)", "none")).not.toContain("<img");
  });
});
