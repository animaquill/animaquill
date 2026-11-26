import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The logs of the backend of `npx animaquill`: one file a start in `logs/` of the data folder,
 * JSON lines as the server writes them, the ten newest kept. The terminal says only what people
 * need to know (cli.ts); what the server says goes here.
 */

const KEEP = 10;

export interface LogFiles {
  /** The file of this start. */
  readonly path: string;
  readonly stream: WriteStream;
  /** The log of PostgreSQL, of every start. */
  readonly postgres: string;
  close(): Promise<void>;
}

export async function openLogs(dataDir: string, now = new Date()): Promise<LogFiles> {
  const dir = join(dataDir, "logs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ours = (await readdir(dir)).filter((name) => /^animaquill-.*\.log$/.test(name)).toSorted();
  for (const old of ours.slice(0, Math.max(0, ours.length - (KEEP - 1))))
    await rm(join(dir, old), { force: true });
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\..*$/, "");
  const path = join(dir, `animaquill-${stamp}-${process.pid}.log`);
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  return {
    path,
    stream,
    postgres: join(dir, "postgres.log"),
    close: () => new Promise<void>((done) => stream.end(() => done())),
  };
}

const LEVELS = { info: 30, warn: 40, error: 50 } as const;

/** A logger of the server's kind (`Logger` of `@animaquill/server`) into that file. */
export function fileLogger(stream: WriteStream, name: string) {
  const line = (level: keyof typeof LEVELS) => (object: object, message?: string) => {
    stream.write(
      `${JSON.stringify({ level: LEVELS[level], time: Date.now(), name, ...object, ...(message !== undefined && { msg: message }) })}\n`,
    );
  };
  return { info: line("info"), warn: line("warn"), error: line("error") };
}
