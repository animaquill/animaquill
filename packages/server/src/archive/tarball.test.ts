import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { FakeGitHub, tarballOf } from "../test/fake-github.ts";
import { readTarball, TarballBroken, TarballTooLarge } from "./tarball.ts";

/**
 * Reading the files out of a tarball of a repository as GitHub makes one (see `tarballOf` of the
 * fake GitHub, which writes them as GitHub does): what is asked for, by its path below the folder at
 * the top, long paths in pax headers included; nothing of a tarball that is cut short or too large.
 */

const chunks = async function* (data: Buffer, size = 1000) {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
};

const everything = { wanted: () => true, mostBytes: 1024 ** 3, mostKept: 1024 ** 3 };

describe("reading a tarball of a repository", () => {
  const github = new FakeGitHub();
  const person = { id: 4242, login: "ada" };
  const long = `scenes/${"很长的名字".repeat(12)}/index.html`;
  const repo = github.addRepo(person, {
    name: "film",
    files: {
      "animaquill.json": '{"id":"p"}\n',
      "scenes/intro/index.html": "<p>开场</p>\n",
      [long]: "<p>长</p>\n",
      "README.md": "# film\n",
      "empty.txt": "",
    },
  });
  github.commitAs(repo.id, person, { "scenes/link": { link: "intro" } });
  const sha = repo.refs.get("main")!;
  const tarball = tarballOf(repo, sha);

  test("has every file below the folder at the top, as the commit has it, a piece at a time", async () => {
    const files = await readTarball(chunks(tarball, 333), everything);
    const expected = github.filesAt(repo.id, sha);
    // Links are no files to read.
    expected.delete("scenes/link");
    expect([...files.keys()].toSorted()).toEqual([...expected.keys()].toSorted());
    for (const [path, text] of expected)
      expect(Buffer.from(files.get(path)!).toString("utf8"), path).toBe(text);
    expect(Buffer.from(files.get(long)!).toString("utf8")).toBe("<p>长</p>\n");
  });

  test("keeps only what is asked for", async () => {
    const files = await readTarball(chunks(tarball), {
      ...everything,
      wanted: (path) => path.startsWith("scenes/"),
    });
    expect([...files.keys()].toSorted()).toEqual([long, "scenes/intro/index.html"].toSorted());
  });

  test("turns away one that is cut short, or is no tarball, and one that is too large", async () => {
    await expect(
      readTarball(chunks(tarball.subarray(0, Math.floor(tarball.length / 2))), everything),
    ).rejects.toBeInstanceOf(TarballBroken);
    await expect(readTarball(chunks(Buffer.from("no tarball")), everything)).rejects.toBeInstanceOf(
      TarballBroken,
    );
    // Gzip that holds what is no tar.
    await expect(
      readTarball(chunks(gzipSync(Buffer.alloc(2048, 7))), everything),
    ).rejects.toBeInstanceOf(TarballBroken);
    await expect(
      readTarball(chunks(tarball), { ...everything, mostBytes: tarball.length - 1 }),
    ).rejects.toBeInstanceOf(TarballTooLarge);
    await expect(
      readTarball(chunks(tarball), { ...everything, mostKept: 10 }),
    ).rejects.toBeInstanceOf(TarballTooLarge);
  });
});
