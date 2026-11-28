import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BrokenFile,
  DataDirRefused,
  isInside,
  restrictOnWindows,
  samePath,
  unsafeDataDir,
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

  test("a master key that is empty or cut short is never taken away nor written over", async () => {
    for (const broken of ["", "1:c2hvcnQ=\n"]) {
      const dir = folder();
      writeFileSync(join(dir, "master.key"), broken, { mode: 0o600 });
      await expect(masterKeyOf(dir, true)).rejects.toBeInstanceOf(BrokenFile);
      expect(readFileSync(join(dir, "master.key"), "utf8")).toBe(broken);
      // Nothing of the write that was not taken is left beside it.
      expect(readdirSync(dir)).toEqual(["master.key"]);
    }
    const dir = folder();
    writeFileSync(join(dir, "pg18.password"), "\n", { mode: 0o600 });
    await expect(passwordOf(dir)).rejects.toBeInstanceOf(BrokenFile);
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

describe("on Windows", () => {
  test("a data folder with what cmd reads in double quotes is refused there, and only there", () => {
    expect(unsafeDataDir('C:\\Users\\ada\\a"b', "win32")).toBe(true);
    expect(unsafeDataDir("C:\\Users\\ada\\100%", "win32")).toBe(true);
    expect(unsafeDataDir("C:\\Users\\张 三\\AppData\\Local\\AnimaQuill\\server", "win32")).toBe(
      false,
    );
    expect(unsafeDataDir('/home/ada/a"b$(x)', "linux")).toBe(false);
  });

  test("the folder is made the user's alone by its SID, without what it inherits", () => {
    const ran: string[][] = [];
    const run = (program: string, args: readonly string[]) => {
      ran.push([program, ...args]);
      return program === "whoami" ? '"desktop-1\\ada","S-1-5-21-1-2-3-1001"\r\n' : "";
    };
    const dir = "C:\\Users\\ada\\AppData\\Local\\AnimaQuill\\server";
    expect(restrictOnWindows(dir, { USERPROFILE: "C:\\Users\\ada" }, run)).toEqual([]);
    expect(ran).toEqual([
      ["whoami", "/user", "/fo", "csv", "/nh"],
      [
        "icacls",
        dir,
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
        "/Q",
      ],
    ]);
  });

  test("says where the folder is not in the user's folder, or could not be made theirs alone", () => {
    const failing = () => {
      throw new Error("拒绝访问。\r\nmore");
    };
    const warnings = restrictOnWindows("D:\\aq", { USERPROFILE: "C:\\Users\\ada" }, failing);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^数据目录 D:\\aq 不在你的用户目录里/);
    expect(warnings[1]).toMatch(/没能把数据目录 D:\\aq 设成只有你能访问（拒绝访问。/);
  });

  test("paths are the same whatever their case, and a folder named ..foo is inside", () => {
    expect(samePath("C:\\Users\\Ada\\AQ", "c:\\users\\ada\\aq\\", "win32")).toBe(true);
    expect(samePath("C:\\Users\\Ada", "C:\\Users\\Bob", "win32")).toBe(false);
    expect(samePath("/home/Ada", "/home/ada", "linux")).toBe(false);
    expect(samePath("/home/ada/", "/home/ada", "linux")).toBe(true);
    expect(isInside("C:\\Users\\ada\\..foo\\data", "C:\\Users\\ada")).toBe(true);
    expect(isInside("C:\\USERS\\ADA\\x", "c:\\users\\ada")).toBe(true);
    expect(isInside("C:\\Users\\other", "C:\\Users\\ada")).toBe(false);
    expect(isInside("C:\\Users\\ada", "C:\\Users\\ada")).toBe(false);
    expect(isInside("D:\\x", "C:\\Users\\ada")).toBe(false);
  });
});
