import { INSTRUCTIONS_START } from "@animaquill/core";
import { describe, expect, test } from "vitest";
import {
  ATTRIBUTES_END,
  ATTRIBUTES_START,
  INITIAL_ATTRIBUTES,
  NOT_TEXT,
  attributesSection,
  blobsToLookAt,
  commitMessage,
  differingFiles,
  isEditorsFile,
  isText,
  managedEntries,
  planArchive,
  trailersOf,
  withAttributesSection,
  type ExportedFile,
} from "./plan.ts";
import { blobShaOf, bytesOf, type TreeEntry } from "./repo-host.ts";

/** The rules of what an archive writes, on their own. */

const blob = (path: string, text: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  sha: blobShaOf(bytesOf(text)),
  size: bytesOf(text).length,
  ...extra,
});
const tree = (...entries: TreeEntry[]) => new Map(entries.map((entry) => [entry.path, entry]));
const file = (text: string): ExportedFile => ({ text, sha: blobShaOf(bytesOf(text)) });
const exported = (files: Record<string, string>, invalid: string[] = []) => ({
  files: new Map(Object.entries(files).map(([path, text]) => [path, file(text)])),
  invalid: new Set(invalid),
});
const MANIFEST = '{"id":"p1"}\n';

describe("the section of .gitattributes that is the platform's", () => {
  test("is what is between our two lines, and nothing where they are not both there", () => {
    expect(attributesSection(INITIAL_ATTRIBUTES)).toEqual([]);
    expect(attributesSection(undefined)).toEqual([]);
    expect(attributesSection("*.psd binary\n")).toEqual([]);
    expect(
      attributesSection(
        `x\r\n${ATTRIBUTES_START}\r\na.mov filter=lfs\r\n\r\n${ATTRIBUTES_END}\r\ny\r\n`,
      ),
    ).toEqual(["a.mov filter=lfs"]);
  });

  test("changes only between our lines, and adds them at the end where they are not there", () => {
    const theirs = `*.psd binary\n${ATTRIBUTES_START}\nold\n${ATTRIBUTES_END}\n*.ai binary\n`;
    expect(withAttributesSection(theirs, ["new"])).toBe(
      `*.psd binary\n${ATTRIBUTES_START}\nnew\n${ATTRIBUTES_END}\n*.ai binary\n`,
    );
    expect(withAttributesSection("*.psd binary\n", ["a"])).toBe(
      `*.psd binary\n${ATTRIBUTES_START}\na\n${ATTRIBUTES_END}\n`,
    );
    expect(withAttributesSection(undefined, [])).toBe(`${ATTRIBUTES_START}\n${ATTRIBUTES_END}\n`);
    expect(attributesSection(withAttributesSection(INITIAL_ATTRIBUTES, ["x y"]))).toEqual(["x y"]);
  });

  test("is ours only as one pair in order: otherwise there is nothing of ours to read or write", () => {
    // Only the line that starts it, as after people took the other away: their lines after it
    // would go with the next write.
    const orphan = `*.psd binary\n${ATTRIBUTES_START}\n*.ai binary\n`;
    expect(attributesSection(orphan)).toBeUndefined();
    expect(withAttributesSection(orphan, ["a.mov filter=lfs"])).toBeUndefined();
    const reversed = `${ATTRIBUTES_END}\nmine\n${ATTRIBUTES_START}\n`;
    expect(attributesSection(reversed)).toBeUndefined();
    expect(withAttributesSection(reversed, [])).toBeUndefined();
    const twice = `${ATTRIBUTES_START}\n${ATTRIBUTES_END}\nmine\n${ATTRIBUTES_START}\n${ATTRIBUTES_END}\n`;
    expect(attributesSection(twice)).toBeUndefined();
    expect(withAttributesSection(twice, ["x"])).toBeUndefined();
    expect(attributesSection(`x\n${ATTRIBUTES_END}\n`)).toBeUndefined();
  });

  test("is not ours to read or write either where .gitattributes is no file of text: a link, a submodule, a folder", () => {
    expect(attributesSection(NOT_TEXT)).toBeUndefined();
    expect(withAttributesSection(NOT_TEXT, [])).toBeUndefined();
    expect(
      withAttributesSection(NOT_TEXT, ["/a.mp4 filter=lfs diff=lfs merge=lfs -text"]),
    ).toBeUndefined();
  });

  test("keeps the line endings the file has", () => {
    const crlf = `*.psd binary\r\n${ATTRIBUTES_START}\r\nold\r\n${ATTRIBUTES_END}\r\n*.ai binary\r\n`;
    expect(withAttributesSection(crlf, ["new"])).toBe(
      `*.psd binary\r\n${ATTRIBUTES_START}\r\nnew\r\n${ATTRIBUTES_END}\r\n*.ai binary\r\n`,
    );
    expect(withAttributesSection("*.psd binary\r\n", ["a"])).toBe(
      `*.psd binary\r\n${ATTRIBUTES_START}\r\na\r\n${ATTRIBUTES_END}\r\n`,
    );
    // Mixed: the lines that stay keep theirs.
    const mixed = `a\r\nb\n${ATTRIBUTES_START}\nold\n${ATTRIBUTES_END}\nc\r\n`;
    expect(withAttributesSection(mixed, [])).toBe(
      `a\r\nb\n${ATTRIBUTES_START}\n${ATTRIBUTES_END}\nc\r\n`,
    );
    // Without an end of line at its end, ours goes on a line of its own.
    expect(withAttributesSection("*.psd binary", [])).toBe(
      `*.psd binary\n${ATTRIBUTES_START}\n${ATTRIBUTES_END}\n`,
    );
  });
});

describe("the files of a tree that could be the platform's", () => {
  test("are those at paths of the project, and .gitattributes, files only", () => {
    const managed = managedEntries([
      blob("README.md", "r"),
      blob(".gitattributes", ""),
      blob("animaquill.json", MANIFEST),
      blob("scenes/a/index.html", "<p>"),
      blob("assets/video.mp4", "v"),
      blob(".animaquill/cloud.json", "{}"),
      { path: "scenes", mode: "040000", type: "tree", sha: "f".repeat(40) },
      { path: "code/lib", mode: "160000", type: "commit", sha: "e".repeat(40) },
    ]);
    expect([...managed.keys()].toSorted()).toEqual([
      ".gitattributes",
      "animaquill.json",
      "code/lib",
      "scenes/a/index.html",
    ]);
  });

  test("are the editor's only where the editor could have had them", () => {
    const text = new Map([
      [blobShaOf(bytesOf("<p>")), true],
      ["b".repeat(40), false],
    ]);
    expect(isEditorsFile("scenes/a/index.html", blob("scenes/a/index.html", "<p>"), text)).toBe(
      true,
    );
    // Not UTF-8, as a picture.
    expect(
      isEditorsFile("scenes/a/p.png", blob("scenes/a/p.png", "", { sha: "b".repeat(40) }), text),
    ).toBe(false);
    // Larger than code may be.
    expect(
      isEditorsFile("code/big.js", blob("code/big.js", "x", { size: 8 * 1024 * 1024 + 1 }), text),
    ).toBe(false);
    // A document always is, whatever it holds.
    expect(
      isEditorsFile("assets.json", blob("assets.json", "", { sha: "b".repeat(40) }), text),
    ).toBe(true);
    // Not known yet: it needs a look.
    expect(isEditorsFile("code/x.js", blob("code/x.js", "?"), text)).toBeUndefined();
    expect(
      blobsToLookAt(
        ["code/x.js", "assets.json"],
        tree(blob("code/x.js", "?"), blob("assets.json", "{}")),
      ),
    ).toEqual(new Set([blobShaOf(bytesOf("?"))]));
    // A link, a submodule, a folder.
    expect(isEditorsFile("code/l.js", blob("code/l.js", "t", { mode: "120000" }), text)).toBe(
      false,
    );
    expect(
      isEditorsFile(
        "code/lib",
        { path: "code/lib", mode: "160000", type: "commit", sha: "e".repeat(40) },
        text,
      ),
    ).toBe(false);
    expect(isText(bytesOf("中文"))).toBe(true);
    expect(isText(Buffer.from([0xff, 0xfe, 0x00]))).toBe(false);
  });
});

describe("an archive", () => {
  const parent = tree(
    blob("animaquill.json", MANIFEST),
    blob("timelines/main/timeline.json", "{}"),
    blob("code/a.js", "a"),
    blob("code/gone.js", "g"),
    blob("scenes/s/pic.png", "", { sha: "b".repeat(40), size: 10 }),
    blob(".gitattributes", INITIAL_ATTRIBUTES),
  );
  const text = new Map([
    [blobShaOf(bytesOf("g")), true],
    ["b".repeat(40), false],
  ]);

  test("writes what differs, takes away what is gone, and keeps what is not the editor's", () => {
    const plan = planArchive(
      exported({
        "animaquill.json": MANIFEST,
        "timelines/main/timeline.json": '{"x":1}',
        "code/a.js": "a",
        "code/new.js": "n",
      }),
      parent,
      text,
      { text: INITIAL_ATTRIBUTES, section: [] },
    );
    expect(plan.changes).toEqual([
      { path: "code/new.js", text: "n" },
      { path: "timelines/main/timeline.json", text: '{"x":1}' },
      { path: "code/gone.js", remove: true },
    ]);
    expect(plan).toMatchObject({ changed: 2, removed: 1, kept: [], manifestInvalid: false });
  });

  test("leaves a document that cannot be written as the parent has it, and names it", () => {
    const plan = planArchive(
      exported({ "animaquill.json": MANIFEST, "code/a.js": "a", "code/gone.js": "g" }, [
        "timelines/main/timeline.json",
        "scenes/new/scene.json",
      ]),
      parent,
      text,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual(["scenes/new/scene.json", "timelines/main/timeline.json"]);
  });

  test("never takes AGENTS.md away, nor writes the opening of a new project over one there", () => {
    const theirs = tree(blob("animaquill.json", MANIFEST), blob("AGENTS.md", "我们的规则\n"));
    const agents = new Map([[blobShaOf(bytesOf("我们的规则\n")), true]]);
    // The project has none: theirs stays.
    expect(planArchive(exported({ "animaquill.json": MANIFEST }), theirs, agents).changes).toEqual(
      [],
    );
    // The project has only what every new project starts with: theirs stays.
    const opening = { "animaquill.json": MANIFEST, "AGENTS.md": INSTRUCTIONS_START };
    expect(planArchive(exported(opening), theirs, agents).changes).toEqual([]);
    // What people wrote in the project is the project's, as any file of it.
    const own = { "animaquill.json": MANIFEST, "AGENTS.md": "新的规则\n" };
    expect(planArchive(exported(own), theirs, agents).changes).toEqual([
      { path: "AGENTS.md", text: "新的规则\n" },
    ]);
    // Where there is none, the opening goes in.
    const bare = tree(blob("animaquill.json", MANIFEST));
    expect(planArchive(exported(opening), bare, new Map()).changes).toEqual([
      { path: "AGENTS.md", text: INSTRUCTIONS_START },
    ]);
  });

  test("writes nothing at all where animaquill.json is not right", () => {
    expect(
      planArchive(exported({ "animaquill.json": "{}" }, ["animaquill.json"]), parent, text)
        .manifestInvalid,
    ).toBe(true);
  });

  test("never writes over a submodule or a link where the project has a file", () => {
    const plan = planArchive(
      exported({ "animaquill.json": MANIFEST, "code/lib": "x", "code/l.js": "y" }),
      tree(
        blob("animaquill.json", MANIFEST),
        { path: "code/lib", mode: "160000", type: "commit", sha: "e".repeat(40) },
        blob("code/l.js", "t", { mode: "120000" }),
      ),
      new Map(),
    );
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual(["code/l.js", "code/lib"]);
  });

  test("writes nothing into a .gitattributes whose lines of ours are not one pair, and says so", () => {
    const broken = `*.psd binary\n${ATTRIBUTES_START}\n*.ai binary\n`;
    const plan = planArchive(
      exported({ "animaquill.json": MANIFEST }),
      tree(blob("animaquill.json", MANIFEST), blob(".gitattributes", broken)),
      new Map(),
      { text: broken, section: [] },
    );
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual([".gitattributes"]);
  });

  test("never makes a file where the tree keeps a folder, nor a folder where it keeps a file", () => {
    // Pictures people put there stay, and so does what is not the project's at all: the project's
    // files cannot be where they are then.
    const kept = tree(
      blob("animaquill.json", MANIFEST),
      blob("code/lib/pic.png", "", { sha: "b".repeat(40), size: 9 }),
      blob("code/x", "", { sha: "c".repeat(40), size: 9 }),
    );
    const seen = new Map([
      ["b".repeat(40), false],
      ["c".repeat(40), false],
    ]);
    const plan = planArchive(
      exported({
        "animaquill.json": MANIFEST,
        "code/lib": "x",
        "code/x/a.js": "y",
        "code/tools": "z",
        "code/ok.js": "fine",
      }),
      kept,
      seen,
      { section: [] },
      new Set(["code/tools/node_modules/pkg/index.js"]),
    );
    expect(plan.changes).toEqual([{ path: "code/ok.js", text: "fine" }]);
    expect(plan.kept).toEqual(["code/lib", "code/tools", "code/x/a.js"]);
    // A folder at the top that was not listed is there all the same.
    const top = planArchive(
      exported({ "animaquill.json": MANIFEST, "notes.json": "{}" }),
      tree(blob("animaquill.json", MANIFEST)),
      new Map(),
      { section: [] },
      new Set(["notes.json/"]),
    );
    expect(top.changes).toEqual([]);
    expect(top.kept).toEqual(["notes.json"]);
  });

  test("a file that becomes a folder of the same name: the file goes, and the folder comes", () => {
    const code = "export const x = 1;\n";
    const plan = planArchive(
      exported({ "animaquill.json": MANIFEST, "code/lib/index.js": code }),
      tree(blob("animaquill.json", MANIFEST), blob("code/lib", code)),
      new Map([[blobShaOf(bytesOf(code)), true]]),
    );
    expect(plan.changes).toEqual([
      { path: "code/lib/index.js", text: code },
      { path: "code/lib", remove: true },
    ]);
    expect(plan.kept).toEqual([]);
  });

  test("keeps our section of .gitattributes as it should be, and never makes the file for nothing", () => {
    const plan = planArchive(
      exported({ "animaquill.json": MANIFEST }),
      tree(blob("animaquill.json", MANIFEST)),
      new Map(),
      {
        section: [],
      },
    );
    expect(plan.changes).toEqual([]);
    const fixed = planArchive(
      exported({ "animaquill.json": MANIFEST }),
      tree(blob("animaquill.json", MANIFEST), blob(".gitattributes", "x")),
      new Map(),
      { text: `${ATTRIBUTES_START}\nstray\n${ATTRIBUTES_END}\n`, section: [] },
    );
    expect(fixed.changes).toEqual([
      { path: ".gitattributes", text: `${ATTRIBUTES_START}\n${ATTRIBUTES_END}\n` },
    ]);
  });

  test("leaves a .gitattributes that is a link as people have it, and names it, whatever our section is to have", () => {
    const link: TreeEntry = { ...blob(".gitattributes", "shared/attributes"), mode: "120000" };
    for (const section of [[], ["/assets/a.mp4 filter=lfs diff=lfs merge=lfs -text"]]) {
      const plan = planArchive(
        exported({ "animaquill.json": MANIFEST }),
        tree(blob("animaquill.json", MANIFEST), link),
        new Map(),
        { text: NOT_TEXT, section },
      );
      expect(plan.changes).toEqual([]);
      expect(plan.kept).toEqual([".gitattributes"]);
    }
  });
});

describe("files that changed on GitHub", () => {
  test("are only the platform's: a README or a picture may change, a timeline may not", () => {
    const before = tree(blob("animaquill.json", MANIFEST), blob("code/a.js", "a"));
    const text = new Map([["b".repeat(40), false]]);
    const readme = tree(blob("animaquill.json", MANIFEST), blob("code/a.js", "a"));
    expect(differingFiles(before, readme, text)).toEqual([]);
    const picture = tree(
      blob("animaquill.json", MANIFEST),
      blob("code/a.js", "a"),
      blob("scenes/s/p.png", "", { sha: "b".repeat(40) }),
    );
    expect(differingFiles(before, picture, text)).toEqual([]);
    const edited = tree(blob("animaquill.json", '{"id":"p2"}'), blob("code/b.js", "b"));
    expect(differingFiles(before, edited, text)).toEqual([
      "animaquill.json",
      "code/a.js",
      "code/b.js",
    ]);
  });

  test("count where it cannot be told, rather than be written over", () => {
    const before = tree(blob("code/a.js", "a"));
    expect(differingFiles(before, tree(blob("code/a.js", "b")), new Map())).toEqual(["code/a.js"]);
  });

  test("in .gitattributes are only those in our section", () => {
    const old = tree(blob(".gitattributes", "1"));
    const changed = tree(blob(".gitattributes", "2"));
    expect(
      differingFiles(old, changed, new Map(), {
        before: INITIAL_ATTRIBUTES,
        after: `*.psd binary\n${INITIAL_ATTRIBUTES}`,
      }),
    ).toEqual([]);
    expect(
      differingFiles(old, changed, new Map(), {
        before: INITIAL_ATTRIBUTES,
        after: INITIAL_ATTRIBUTES.replace(ATTRIBUTES_END, `x\n${ATTRIBUTES_END}`),
      }),
    ).toEqual([".gitattributes"]);
    // Gone altogether, with nothing in our section: nothing of ours changed.
    expect(differingFiles(old, tree(), new Map(), { before: INITIAL_ATTRIBUTES })).toEqual([]);
    // Our lines not one pair any more: not ours to read, so not ours to say changed. The archive
    // leaves the file alone and says so, see planArchive.
    expect(
      differingFiles(old, changed, new Map(), {
        before: INITIAL_ATTRIBUTES,
        after: `${ATTRIBUTES_START}\nx\n`,
      }),
    ).toEqual([]);
    // The same where a link took its place, or the file took the place of a link.
    const link = tree({ ...blob(".gitattributes", "shared/attributes"), mode: "120000" });
    expect(
      differingFiles(old, link, new Map(), { before: INITIAL_ATTRIBUTES, after: NOT_TEXT }),
    ).toEqual([]);
    expect(
      differingFiles(link, old, new Map(), { before: NOT_TEXT, after: INITIAL_ATTRIBUTES }),
    ).toEqual([]);
  });
});

describe("the message of an archive", () => {
  test("says what it is and what it changed, and ends with the two lines that tell our commits apart", () => {
    const message = commitMessage({
      kind: "auto",
      changed: 3,
      removed: 1,
      kept: ["timelines/main/timeline.json"],
      project: "pAbC_1",
      seq: 42,
    });
    expect(message).toBe(
      [
        "自动存档",
        "",
        "改了 3 个文件，删了 1 个文件。",
        "这些文件这次没存进去，仓库里还是上一版：timelines/main/timeline.json。",
        "",
        "AnimaQuill-Project: pAbC_1",
        "AnimaQuill-Seq: 42",
        "",
      ].join("\n"),
    );
    expect(trailersOf(message)).toEqual({ project: "pAbC_1", seq: 42 });
    expect(
      commitMessage({ kind: "manual", changed: 1, removed: 0, kept: [], project: "p", seq: 1 }),
    ).toMatch(/^存档\n\n改了 1 个文件。\n\nAnimaQuill-Project: p\nAnimaQuill-Seq: 1\n$/);
  });

  test("lines like ours anywhere but at the end are not ours", () => {
    expect(
      trailersOf("Edit\n\nAnimaQuill-Project: p\nAnimaQuill-Seq: 1\n\nSigned-off-by: x"),
    ).toBeUndefined();
    expect(trailersOf("README")).toBeUndefined();
    expect(trailersOf("x\n\nAnimaQuill-Project: p\n")).toBeUndefined();
  });
});
