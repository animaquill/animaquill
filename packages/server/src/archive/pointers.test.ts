import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLfsPointer } from "@animaquill/schema";
import { describe, expect, test } from "vitest";
import {
  attributesLine,
  attributesPattern,
  isPointerPath,
  pathOfAttributesLine,
  planPointers,
  pointerText,
  spaced,
  type LfsAsset,
  type PointerInput,
} from "./pointers.ts";
import { blobShaOf, bytesOf, type TreeEntry } from "./repo-host.ts";

/**
 * The pointers of Git LFS that an archive writes, as rules on their own: what goes where, what is
 * never written, and what the section of .gitattributes says, which a real Git reads back.
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;
// CI has Git; there, a test that needs it must not quietly not run.
if (!hasGit && process.env["CI"]) throw new Error("git is needed for these tests");

const oidOf = (text: string) => createHash("sha256").update(text).digest("hex");
const VIDEO: LfsAsset = { path: "assets/video.mp4", oid: oidOf("video"), size: 5 };
const SOUND: LfsAsset = { path: "assets/sound.wav", oid: oidOf("sound"), size: 5 };

/** What the blobs of these tests have in them, by sha: what an archive reads of a repository. */
const texts = new Map<string, string>();

const blob = (path: string, text: string): TreeEntry => {
  const sha = blobShaOf(bytesOf(text));
  texts.set(sha, text);
  return { path, mode: "100644", type: "blob", sha, size: bytesOf(text).length };
};

const pointerOf = (asset: LfsAsset) => pointerText(asset.oid, asset.size) as string;

/**
 * What an archive gives the rules: with what the files at the paths that could be the platform's
 * point at, read from them as the archive does (archiver.ts), unless a test says otherwise.
 */
const input = (more: Partial<PointerInput> = {}): PointerInput => {
  const given = {
    assets: [VIDEO],
    stored: new Map([
      [VIDEO.oid, VIDEO.size],
      [SOUND.oid, SOUND.size],
    ]),
    ours: new Set<string>(),
    files: new Map<string, TreeEntry>(),
    folders: new Set<string>(),
    projectFiles: new Set(["animaquill.json", "assets.json"]),
    ...more,
  };
  const pointers = new Map<string, { oid: string; size: number }>();
  for (const path of given.ours) {
    const entry = given.files.get(path);
    const pointer =
      entry?.type === "blob" && entry.mode !== "120000"
        ? readLfsPointer(texts.get(entry.sha) ?? "")
        : undefined;
    if (pointer) pointers.set(path, pointer);
  }
  return { pointers, ...given };
};

describe("the pointers of Git LFS in an archive", () => {
  test("a pointer is what Git LFS writes, for the object of the asset", () => {
    const text = pointerOf(VIDEO);
    expect(text).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${VIDEO.oid}\nsize 5\n`,
    );
    expect(readLfsPointer(text)).toEqual({ oid: VIDEO.oid, size: VIDEO.size });
  });

  test("writes the pointer of an asset whose object the storage has, with its line", () => {
    const plan = planPointers(input());
    expect(plan.changes).toEqual([{ path: VIDEO.path, text: pointerOf(VIDEO) }]);
    expect(plan).toMatchObject({ written: 1, removed: 0, kept: [], paths: [VIDEO.path] });
    expect(plan.section).toEqual(["/assets/video.mp4 filter=lfs diff=lfs merge=lfs -text"]);
  });

  test("never writes a pointer to an object the storage is not known to have, and says so", () => {
    for (const stored of [
      new Map<string, number>(),
      // The object of that oid, but of another size: what the asset says is not what is there.
      new Map([[VIDEO.oid, VIDEO.size + 1]]),
    ]) {
      const plan = planPointers(input({ stored }));
      expect(plan.changes).toEqual([]);
      expect(plan.kept).toEqual([VIDEO.path]);
      expect(plan.paths).toEqual([]);
      expect(plan.section).toEqual([]);
    }
  });

  test("never writes one where a file of the format, of Git or of a tool is", () => {
    const at = (path: string): LfsAsset => ({ ...VIDEO, path });
    const paths = [
      "animaquill.json",
      "timelines/main/timeline.json",
      "scenes/intro/index.html",
      // Whatever is in the folder of a scene or a sound, or in code/, is code to the editor: a
      // pointer there would come back as a file of code.
      "scenes/intro/背景.mp4",
      "sounds/rain/rain.wav",
      "code/shared.js",
      ".gitattributes",
      ".gitignore",
      ".github/workflows/build.yml",
      ".git/config",
      ".animaquill/cloud.json",
      "node_modules/a/b.mp4",
      "assets/.DS_Store",
      // What Git LFS reads its settings from: a pointer there would be read as them.
      ".lfsconfig",
      ".LFSConfig",
      // Whatever the case of the letters: some disks take them for the same file.
      ".GitAttributes",
      ".GIT/config",
      // No line of .gitattributes is for such a name alone: to Git, the `[[:space:]]` that
      // stands for a space is a tab, a line feed or a carriage return as well.
      "assets/line\nbreak.mp4",
      "assets/tab\there.mp4",
      "assets/return\rhere.mp4",
    ];
    for (const path of paths) expect(isPointerPath(path), path).toBe(false);
    const plan = planPointers(input({ assets: paths.map(at) }));
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual(paths.toSorted((a, b) => (a < b ? -1 : 1)));
    for (const path of [
      "top.mp4",
      "assets/中文.mp4",
      "素材/片头 1.mp4",
      "timelines/main/参考.mp4",
      // Only at the top does Git LFS read it.
      "assets/.lfsconfig",
      "assets/vertical\u000btab.mp4",
      "assets/form\ffeed.mp4",
    ])
      expect(isPointerPath(path), path).toBe(true);
  });

  test("writes no pointer whose line would take another file of the repository along", () => {
    // To Git the line of "a b.mp4" is for "a<tab>b.mp4" too: with both there, that one would be
    // given to Git LFS as well, so the pointer is not written, and named.
    const asset = { ...VIDEO, path: "素材/片头 1.mp4" };
    for (const other of ["素材/片头\t1.mp4", "素材/片头\n1.mp4", "素材/片头\r1.mp4"]) {
      expect(spaced(other), other).toBe(asset.path);
      const plan = planPointers(
        input({ assets: [asset], files: new Map([[other, blob(other, "people's own")]]) }),
      );
      expect(plan.changes, other).toEqual([]);
      expect(plan.kept, other).toEqual([asset.path]);
      expect(plan.section, other).toEqual([]);
    }
    // A name that only looks alike is another name to Git, and nothing in the way.
    for (const other of [
      "素材/片头\u000b1.mp4",
      "素材/片头\f1.mp4",
      "素材/片头　1.mp4",
      "素材/片头  1.mp4",
    ]) {
      const plan = planPointers(
        input({ assets: [asset], files: new Map([[other, blob(other, "people's own")]]) }),
      );
      expect(plan.written, other).toBe(1);
    }
    // A pointer of the platform's that is there stays, with its line, and is named.
    const ours = new Set([asset.path]);
    const files = new Map([
      [asset.path, blob(asset.path, pointerOf(asset))],
      ["素材/片头\t1.mp4", blob("素材/片头\t1.mp4", "people's own")],
    ]);
    expect(planPointers(input({ assets: [asset], ours, files }))).toMatchObject({
      changes: [],
      kept: [asset.path],
      paths: [asset.path],
    });
  });

  test("takes nobody's place: not a file of people's, a folder, a link, or a file where its folder would be", () => {
    const cases: [string, Partial<PointerInput>][] = [
      ["a file of people's", { files: new Map([[VIDEO.path, blob(VIDEO.path, "their own")]]) }],
      ["a folder", { folders: new Set([VIDEO.path]) }],
      [
        "a link",
        {
          files: new Map([[VIDEO.path, { ...blob(VIDEO.path, "x"), mode: "120000" }]]),
        },
      ],
      [
        "a submodule",
        { files: new Map([[VIDEO.path, { ...blob(VIDEO.path, "x"), type: "commit" }]]) },
      ],
      ["a file where its folder is", { files: new Map([["assets", blob("assets", "a file")]]) }],
      [
        "a file of the project in a folder of its name",
        {
          assets: [{ ...VIDEO, path: "timelines" }],
          projectFiles: new Set(["timelines/main/timeline.json"]),
        },
      ],
      [
        "another pointer in a folder of its name",
        { assets: [VIDEO, { ...SOUND, path: `${VIDEO.path}/inner.wav` }] },
      ],
    ];
    for (const [what, more] of cases) {
      const plan = planPointers(input(more));
      expect(
        plan.changes.filter((change) => change.path === (more.assets ?? [VIDEO])[0]!.path),
        what,
      ).toEqual([]);
      expect(plan.kept, what).toContain((more.assets ?? [VIDEO])[0]!.path);
    }
    // The very pointer it would write, to an object the storage has, without its line, as after
    // the database came back from a backup: it is claimed, and gets its line again.
    const same = planPointers(
      input({ files: new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]) }),
    );
    expect(same).toMatchObject({
      changes: [],
      kept: [],
      paths: [VIDEO.path],
      section: ["/assets/video.mp4 filter=lfs diff=lfs merge=lfs -text"],
    });
    // Where the section cannot be written, it is named rather than left without a word.
    const frozen = planPointers(
      input({ frozen: true, files: new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]) }),
    );
    expect(frozen).toMatchObject({ changes: [], kept: [VIDEO.path], paths: [] });
  });

  test("a path whose line Git would not read, as one of 2048 bytes or more, gets no pointer", () => {
    const line = (path: string) => Buffer.byteLength(attributesLine(path) ?? "", "utf8");
    // "/" and " filter=lfs diff=lfs merge=lfs -text": 37 bytes besides the path.
    const longest = `assets/${"a".repeat(2047 - 37 - 7)}`;
    expect(line(longest)).toBe(2047);
    expect(isPointerPath(longest)).toBe(true);
    const tooLong = `${longest}b`;
    expect(attributesLine(tooLong)).toBeUndefined();
    expect(isPointerPath(tooLong)).toBe(false);
    // Bytes, not letters: Chinese takes three each.
    const chinese = `assets/${"视".repeat(700)}`;
    expect(attributesLine(chinese)).toBeUndefined();
    const plan = planPointers(input({ assets: [{ ...VIDEO, path: tooLong }] }));
    expect(plan).toMatchObject({ changes: [], kept: [tooLong], paths: [] });
  });

  test("two assets at one path with different files leave it as it is", () => {
    const plan = planPointers(input({ assets: [VIDEO, { ...SOUND, path: VIDEO.path }] }));
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual([VIDEO.path]);
    // The same file twice is one pointer.
    expect(planPointers(input({ assets: [VIDEO, { ...VIDEO }] })).written).toBe(1);
  });

  test("its own pointers it writes over, and takes away once their asset went elsewhere, moved, or is gone", () => {
    const ours = new Set([VIDEO.path]);
    const there = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]);
    // As it is: nothing to do.
    expect(planPointers(input({ ours, files: there }))).toMatchObject({
      changes: [],
      paths: [VIDEO.path],
      section: ["/assets/video.mp4 filter=lfs diff=lfs merge=lfs -text"],
    });
    // Another file of the asset, in the storage too.
    const changed = { ...VIDEO, oid: SOUND.oid, size: SOUND.size };
    expect(planPointers(input({ assets: [changed], ours, files: there })).changes).toEqual([
      { path: VIDEO.path, text: pointerOf(changed) },
    ]);
    // Moved: the old one goes, the new one comes.
    const moved = { ...VIDEO, path: "素材/片头 1.mp4" };
    const plan = planPointers(input({ assets: [moved], ours, files: there }));
    expect(plan.changes).toEqual([
      { path: moved.path, text: pointerOf(VIDEO) },
      { path: VIDEO.path, remove: true },
    ]);
    expect(plan).toMatchObject({ written: 1, removed: 1, paths: [moved.path] });
    expect(plan.section).toEqual([
      "/素材/片头[[:space:]]1.mp4 filter=lfs diff=lfs merge=lfs -text",
    ]);
    // Back to only here, or gone: the pointer goes, and its line.
    expect(planPointers(input({ assets: [], ours, files: there }))).toMatchObject({
      changes: [{ path: VIDEO.path, remove: true }],
      paths: [],
      section: [],
    });
    // Gone already, or a folder of people's now: not the platform's any more, and nothing to take.
    for (const files of [new Map<string, TreeEntry>(), new Map([["x", blob("x", "x")]])])
      expect(planPointers(input({ assets: [], ours, files }))).toMatchObject({
        changes: [],
        paths: [],
      });
  });

  test("keeps its own pointer where the asset's new file is not in the storage yet: the repository has the one before", () => {
    const ours = new Set([VIDEO.path]);
    const there = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]);
    const unstored = { ...VIDEO, oid: oidOf("not there"), size: 9 };
    const plan = planPointers(input({ assets: [unstored], ours, files: there }));
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toEqual([VIDEO.path]);
    expect(plan.paths).toEqual([VIDEO.path]);
  });

  test("leaves its pointers as they are where assets.json could not be written", () => {
    const ours = new Set([VIDEO.path, SOUND.path]);
    const files = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]);
    expect(planPointers(input({ assets: undefined, ours, files }))).toMatchObject({
      changes: [],
      paths: [VIDEO.path],
      section: ["/assets/video.mp4 filter=lfs diff=lfs merge=lfs -text"],
    });
  });

  test("a file of people's where the platform noted a pointer of its own is neither written over nor taken away, and named", () => {
    // What the database says is its own can be older than the repository, as after it came back
    // from a backup: only a pointer to an object the storage is known to have is the platform's.
    const ours = new Set([VIDEO.path]);
    const large = "x".repeat(2000);
    const cases: [string, string][] = [
      ["a file that is no pointer", "my own file, not a pointer"],
      ["a file too large to be one", large],
      // A pointer the platform never wrote: to an object the storage is not known to have.
      ["a pointer to nothing known", pointerText(oidOf("elsewhere"), 7) as string],
      ["a pointer of another size", pointerText(VIDEO.oid, VIDEO.size + 1) as string],
    ];
    for (const [what, text] of cases) {
      const files = new Map([[VIDEO.path, blob(VIDEO.path, text)]]);
      // The asset is in Git LFS: its pointer is not written over what is there.
      const wanted = planPointers(input({ ours, files }));
      expect(wanted.changes, what).toEqual([]);
      expect(wanted.kept, what).toEqual([VIDEO.path]);
      // The asset is back to only here, or gone: what is there is not taken away.
      const gone = planPointers(input({ assets: [], ours, files }));
      expect(gone.changes, what).toEqual([]);
      expect(gone.kept, what).toEqual([VIDEO.path]);
      // Either way the path is not the platform's any more, and has no line.
      for (const plan of [wanted, gone]) {
        expect(plan.paths, what).toEqual([]);
        expect(plan.section, what).toEqual([]);
      }
      // Nor where assets.json could not be written.
      expect(planPointers(input({ assets: undefined, ours, files })).paths, what).toEqual([]);
    }
    // A pointer to an object the storage has is the platform's, whichever asset it was for.
    const files = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(SOUND))]]);
    expect(planPointers(input({ ours, files })).changes).toEqual([
      { path: VIDEO.path, text: pointerOf(VIDEO) },
    ]);
    expect(planPointers(input({ assets: [], ours, files })).changes).toEqual([
      { path: VIDEO.path, remove: true },
    ]);
  });

  test("what points at an object the storage could not be asked about stays as it is, with its line", () => {
    const ours = new Set([VIDEO.path]);
    const before = { ...VIDEO, oid: oidOf("before"), size: 6 };
    const files = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(before))]]);
    const unknown = new Set([before.oid]);
    // Neither written over (the asset has another file now, named), nor taken away.
    expect(planPointers(input({ ours, files, unknown }))).toMatchObject({
      changes: [],
      kept: [VIDEO.path],
      paths: [VIDEO.path],
      section: ["/assets/video.mp4 filter=lfs diff=lfs merge=lfs -text"],
    });
    expect(planPointers(input({ assets: [], ours, files, unknown }))).toMatchObject({
      changes: [],
      kept: [],
      paths: [VIDEO.path],
    });
    // And no pointer is written to an object that could not be asked about.
    const asked = planPointers(input({ stored: new Map(), unknown: new Set([VIDEO.oid]) }));
    expect(asked).toMatchObject({ changes: [], kept: [VIDEO.path], paths: [] });
  });

  test("where the section of .gitattributes cannot be written, no pointer comes or goes: one without its line is the file itself to Git", () => {
    // A new pointer is not written, and named.
    expect(planPointers(input({ frozen: true }))).toMatchObject({
      changes: [],
      kept: [VIDEO.path],
      paths: [],
    });
    const ours = new Set([VIDEO.path]);
    const there = new Map([[VIDEO.path, blob(VIDEO.path, pointerOf(VIDEO))]]);
    // One that is there as it is to be stays the platform's, and nothing is to say about it.
    expect(planPointers(input({ ours, files: there, frozen: true }))).toMatchObject({
      changes: [],
      kept: [],
      paths: [VIDEO.path],
    });
    // Another file of the asset: the pointer there stays, and the asset is named.
    const changed = { ...VIDEO, oid: SOUND.oid, size: SOUND.size };
    expect(
      planPointers(input({ assets: [changed], ours, files: there, frozen: true })),
    ).toMatchObject({
      changes: [],
      kept: [VIDEO.path],
      paths: [VIDEO.path],
    });
    // Its asset gone: it waits until its line can go too.
    expect(planPointers(input({ assets: [], ours, files: there, frozen: true }))).toMatchObject({
      changes: [],
      kept: [],
      paths: [VIDEO.path],
    });
    // Moved: neither the new one comes nor the old one goes.
    const moved = { ...VIDEO, path: "素材/片头.mp4" };
    expect(
      planPointers(input({ assets: [moved], ours, files: there, frozen: true })),
    ).toMatchObject({
      changes: [],
      kept: [moved.path],
      paths: [VIDEO.path],
    });
  });

  test("lines are by path, in order, one for each", () => {
    const assets = ["b/2.mp4", "a/1.mp4", "a/0 0.mp4"].map((path) => ({ ...VIDEO, path }));
    expect(planPointers(input({ assets })).section).toEqual([
      "/a/0[[:space:]]0.mp4 filter=lfs diff=lfs merge=lfs -text",
      "/a/1.mp4 filter=lfs diff=lfs merge=lfs -text",
      "/b/2.mp4 filter=lfs diff=lfs merge=lfs -text",
    ]);
  });
});

describe("the section of .gitattributes, as Git reads it", () => {
  /** Paths to give a line, and paths that their lines must not take along. */
  const PATHS = [
    "top.mp4",
    "assets/with space.mp4",
    "assets/vertical\u000btab.mp4",
    "assets/form\ffeed.mp4",
    "assets/#hash.mp4",
    "assets/a#b.mp4",
    "assets/!bang.mp4",
    "assets/[x].mp4",
    "assets/a*b.mp4",
    "assets/a?b.mp4",
    'assets/"quoted".mp4',
    "assets/中文 视频.mp4",
    "assets/全角　空格.mp4",
    "assets/trailing .mp4",
  ];
  const OTHERS = [
    "scenes/intro/top.mp4",
    "assets/x.mp4",
    "assets/aXb.mp4",
    "assets/aZb.mp4",
    "assets/with  space.mp4",
    "assets/全角 空格.mp4",
    "other/assets/with space.mp4",
    // No space to Git, so not what the line of the name with a space takes.
    "assets/with\u000bspace.mp4",
    "assets/with\fspace.mp4",
    "assets/vertical tab.mp4",
    "assets/form feed.mp4",
  ];
  /** What the line of "assets/with space.mp4" takes along, as `[[:space:]]` is to Git. */
  const ALIKE = ["assets/with\tspace.mp4", "assets/with\nspace.mp4", "assets/with\rspace.mp4"];

  test("escapes what Git would read otherwise", () => {
    expect(attributesPattern('assets/a b#c!d[e]*?"f.mp4')).toBe(
      '/assets/a[[:space:]]b\\#c\\!d\\[e]\\*\\?\\"f.mp4',
    );
    expect(attributesPattern("assets/中文.mp4")).toBe("/assets/中文.mp4");
    // A vertical tab and a form feed are no space to Git: as they are.
    expect(attributesPattern("a\u000bb\fc")).toBe("/a\u000bb\fc");
    for (const path of ["a\nb", "a\rb", "a\tb"]) {
      expect(attributesPattern(path), JSON.stringify(path)).toBeUndefined();
      expect(attributesLine(path), JSON.stringify(path)).toBeUndefined();
    }
    expect(attributesLine("a.mp4")).toBe("/a.mp4 filter=lfs diff=lfs merge=lfs -text");
  });

  test("a line says which path it is for, and only a line the platform writes does", () => {
    for (const path of [...PATHS, 'assets/a b#c!d[e]*?"f\\g.mp4', "assets/[[:space:]].mp4"])
      expect(pathOfAttributesLine(attributesLine(path) as string), path).toBe(path);
    for (const line of [
      "*.psd filter=lfs diff=lfs merge=lfs -text",
      "/assets/*.mp4 filter=lfs diff=lfs merge=lfs -text",
      "/assets/a.mp4 filter=lfs",
      "/assets/a.mp4 binary",
      "assets/a.mp4 filter=lfs diff=lfs merge=lfs -text",
      "/assets/a b.mp4 filter=lfs diff=lfs merge=lfs -text",
      "/assets/a\\ filter=lfs diff=lfs merge=lfs -text",
      "/ filter=lfs diff=lfs merge=lfs -text",
      "# a note",
    ])
      expect(pathOfAttributesLine(line), line).toBeUndefined();
  });

  test.skipIf(!hasGit)("gives Git LFS each path, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "aq-attributes-"));
    try {
      const git = (args: string[], stdin?: string) => {
        const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", input: stdin });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
        return result.stdout;
      };
      git(["init", "--quiet", "."]);
      const lines = PATHS.map((path) => attributesLine(path) as string);
      writeFileSync(join(dir, ".gitattributes"), `${lines.join("\n")}\n`);
      const out = git(
        ["check-attr", "-z", "--stdin", "filter"],
        [...PATHS, ...OTHERS, ...ALIKE].join("\0"),
      );
      const fields = out.split("\0");
      const filter = new Map<string, string>();
      for (let at = 0; at + 2 < fields.length; at += 3) filter.set(fields[at]!, fields[at + 2]!);
      for (const path of PATHS) expect(filter.get(path), JSON.stringify(path)).toBe("lfs");
      for (const path of OTHERS) expect(filter.get(path), JSON.stringify(path)).toBe("unspecified");
      // Why a pointer is not written next to a file of such a name, see `spaced`.
      for (const path of ALIKE) expect(filter.get(path), JSON.stringify(path)).toBe("lfs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
