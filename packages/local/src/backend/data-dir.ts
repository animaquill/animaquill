import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, win32 } from "node:path";

/**
 * The data folder of the backend of `npx animaquill` (design O4 of AnimaQuill Cloud, section 1):
 * `--data-dir`, `AQ_DATA_DIR`, else `%LOCALAPPDATA%\AnimaQuill\server\` on Windows and
 * `~/.animaquill/server/` elsewhere. Only the user who started it may get at it: on POSIX the
 * folder is 700 and what is in it 600. One that is not that user's, or that others may write, is
 * refused, as anyone who can change it can change what the backend does; one others may only read
 * is made the user's alone. Windows has the user's folder for that.
 *
 * In it: `lock` and `backend.json` (lock.ts), `master.key`, `pg18/` and `pg18.password`
 * (postgres.ts), `repos/`, `lfs/`, `staging/` (the server's), `logs/` (logs.ts).
 */

export const defaultDataDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string =>
  platform === "win32"
    ? join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "AnimaQuill", "server")
    : join(home, ".animaquill", "server");

/** Why the data folder is not one to start with, for what people are told. */
export class DataDirRefused extends Error {
  override name = "DataDirRefused";
  readonly reason: "notFolder" | "link" | "owner" | "writable" | "name";
  readonly path: string;
  readonly mode: number | undefined;
  constructor(reason: DataDirRefused["reason"], path: string, mode?: number) {
    super(`${path}: ${reason}`);
    this.reason = reason;
    this.path = path;
    this.mode = mode;
  }
}

const posix = process.platform !== "win32";

/**
 * A path PostgreSQL's own programs would hand to a shell wrong: on Windows `pg_ctl` puts the data
 * folder into a command of `cmd` in double quotes, where `"` ends them and `%` expands. Elsewhere
 * nothing here goes through a shell (postgres.ts), so any name is fine.
 */
export const unsafeDataDir = (dir: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === "win32" && /["%\r\n]/.test(dir);
/** The user of this process, on POSIX. */
const me = () => process.getuid?.();

/** Runs a program of Windows to its end: its output. */
export type RunProgram = (program: string, args: readonly string[]) => string;

const runProgram: RunProgram = (program, args) =>
  execFileSync(program, [...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Windows: the folder is made this user's alone, as 700 is elsewhere: what it inherits goes
 * (`icacls /inheritance:r`), and only this user, by its SID, gets everything, for what is in it too.
 * Resolves to what people are to be told: where that could not be done, and where the folder is
 * not in the user's own folder (`%USERPROFILE%`), which others of the computer often may read.
 */
export function restrictOnWindows(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: RunProgram = runProgram,
): string[] {
  const warnings: string[] = [];
  const profile = env["USERPROFILE"];
  if (!profile || !isInside(dir, profile))
    warnings.push(
      `数据目录 ${dir} 不在你的用户目录里：同一台电脑的其他用户可能读得到它，AnimaQuill 已经尽量只留给你自己。`,
    );
  try {
    const line = run("whoami", ["/user", "/fo", "csv", "/nh"]).trim();
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(line)?.[1];
    if (!sid) throw new Error(`whoami said ${line}`);
    run("icacls", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/Q"]);
  } catch (error) {
    warnings.push(
      `没能把数据目录 ${dir} 设成只有你能访问（${(error as Error).message.split("\n")[0]}）：同一台电脑的其他用户可能读得到里面的密钥。`,
    );
  }
  return warnings;
}

/** Whether a path of Windows is inside a folder, by Windows' rules (no matter the case). */
const isInside = (path: string, folder: string) => {
  const inside = win32.relative(win32.resolve(folder), win32.resolve(path));
  return inside !== "" && !inside.startsWith("..") && !win32.isAbsolute(inside);
};

/**
 * Makes the folder where it is not there, and sees that only this user may get at it. Resolves
 * to the modes it made tighter, for the log, and what people are to be told (Windows).
 */
export async function prepareDataDir(
  dir: string,
  windows: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly run?: RunProgram;
  } = {},
): Promise<{ readonly tightened: string[]; readonly warnings: string[] }> {
  if (unsafeDataDir(dir)) throw new DataDirRefused("name", dir);
  // The folders above are made the user's alone too, where they are made now: ~/.animaquill holds
  // the key of the relay of AI tools as well.
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const found = await lstat(dir);
  if (found.isSymbolicLink()) throw new DataDirRefused("link", dir);
  if (!found.isDirectory()) throw new DataDirRefused("notFolder", dir);
  const tightened: string[] = [];
  if (!posix) return { tightened, warnings: restrictOnWindows(dir, windows.env, windows.run) };
  if (found.uid !== me()) throw new DataDirRefused("owner", dir, found.mode & 0o777);
  if ((found.mode & 0o022) !== 0) throw new DataDirRefused("writable", dir, found.mode & 0o777);
  if ((found.mode & 0o077) !== 0) {
    await chmod(dir, 0o700);
    tightened.push(dir);
  }
  // What is right in it: nothing others may read, nothing of another user.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new DataDirRefused("link", path);
    if (stat.uid !== me()) throw new DataDirRefused("owner", path, stat.mode & 0o777);
    const wanted = stat.isDirectory() ? 0o700 : 0o600;
    if ((stat.mode & 0o077) !== 0) {
      await chmod(path, wanted);
      tightened.push(path);
    }
  }
  return { tightened, warnings: [] };
}

/** Writes a file that only this user may read, all of it or nothing, in place of what was there. */
export async function writePrivate(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes a file that only this user may read, where there is none yet: false where there is. */
export async function writeNew(path: string, text: string): Promise<boolean> {
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}

export const MASTER_KEY_FILE = "master.key";

/**
 * The master key, which seals what the server keeps (seal.ts of `@animaquill/server`): made the
 * first time. Resolves to `made` where it was made now, and `lost` where it was made now though
 * the database was there already: what was sealed with the one before cannot be opened.
 */
export async function masterKeyOf(
  dir: string,
  databaseThere: boolean,
): Promise<{ readonly path: string; readonly made: boolean; readonly lost: boolean }> {
  const path = join(dir, MASTER_KEY_FILE);
  const made = await writeNew(path, `1:${randomBytes(32).toString("base64")}\n`);
  return { path, made, lost: made && databaseThere };
}

/** The password of the database here, made the first time; only for its own PostgreSQL. */
export async function passwordOf(dir: string): Promise<string> {
  const path = join(dir, "pg18.password");
  await writeNew(path, `${randomBytes(24).toString("base64url")}\n`);
  return (await readFile(path, "utf8")).trim();
}
