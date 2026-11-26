import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DataDirRefused,
  defaultDataDir,
  masterKeyOf,
  passwordOf,
  prepareDataDir,
  writePrivate,
} from "./data-dir.ts";

/** The data folder of the backend: where it is, and that only its user gets at it. */

const posix = process.platform !== "win32";
const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-data-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the data folder", () => {
  test("is in the user's folder for programs on Windows, and in ~/.animaquill elsewhere", () => {
    expect(
      defaultDataDir(
        { LOCALAPPDATA: "C:\\Users\\张 三\\AppData\\Local" },
        "win32",
        "C:\\Users\\张 三",
      ),
    ).toBe(join("C:\\Users\\张 三\\AppData\\Local", "AnimaQuill", "server"));
    expect(defaultDataDir({}, "linux", "/home/ada")).toBe(
      join("/home/ada", ".animaquill", "server"),
    );
    expect(defaultDataDir({}, "darwin", "/Users/ada")).toBe(
      join("/Users/ada", ".animaquill", "server"),
    );
  });

  test.skipIf(!posix)("is made the user's alone, with what is in it", async () => {
    const dir = join(folder(), "deep", "server");
    await prepareDataDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "backend.json"), "{}", { mode: 0o644 });
    chmodSync(join(dir, "backend.json"), 0o644);
    mkdirSync(join(dir, "logs"), { mode: 0o755 });
    chmodSync(join(dir, "logs"), 0o755);
    chmodSync(dir, 0o750);
    const { tightened } = await prepareDataDir(dir);
    expect(tightened.toSorted()).toEqual(
      [dir, join(dir, "backend.json"), join(dir, "logs")].toSorted(),
    );
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "backend.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
  });

  test.skipIf(!posix)("is refused where others may write it, or it is a link", async () => {
    const dir = join(folder(), "server");
    mkdirSync(dir);
    chmodSync(dir, 0o775);
    await expect(prepareDataDir(dir)).rejects.toMatchObject({ reason: "writable", mode: 0o775 });
    chmodSync(dir, 0o700);
    const link = join(folder(), "link");
    symlinkSync(dir, link);
    await expect(prepareDataDir(link)).rejects.toBeInstanceOf(DataDirRefused);
    writeFileSync(join(dir, "evil"), "");
    rmSync(join(dir, "evil"));
    symlinkSync("/etc/passwd", join(dir, "master.key"));
    await expect(prepareDataDir(dir)).rejects.toMatchObject({ reason: "link" });
  });

  test.skipIf(!posix || process.getuid?.() !== 0)(
    "is refused where it is another user's",
    async () => {
      const dir = join(folder(), "server");
      mkdirSync(dir, { mode: 0o700 });
      const { chownSync } = await import("node:fs");
      chownSync(dir, 65534, 65534);
      await expect(prepareDataDir(dir)).rejects.toMatchObject({ reason: "owner" });
    },
  );
});

describe("its secrets", () => {
  test("the master key is made once, 600; made again, it says what was sealed is lost", async () => {
    const dir = folder();
    const first = await masterKeyOf(dir, false);
    expect(first).toMatchObject({ made: true, lost: false });
    if (posix) expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(await masterKeyOf(dir, true)).toMatchObject({ made: false, lost: false });
    rmSync(first.path);
    expect(await masterKeyOf(dir, true)).toMatchObject({ made: true, lost: true });
  });

  test("the password of the database is made once, and files are written whole, 600", async () => {
    const dir = folder();
    const password = await passwordOf(dir);
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await passwordOf(dir)).toBe(password);
    await writePrivate(join(dir, "backend.json"), "one");
    await writePrivate(join(dir, "backend.json"), "two");
    if (posix) expect(statSync(join(dir, "backend.json")).mode & 0o777).toBe(0o600);
  });
});
