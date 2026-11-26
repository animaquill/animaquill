import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrograms } from "../src/backend/postgres.ts";

/**
 * `npx animaquill` with its backend, for the browser tests: the built package (dist/, which the
 * web server of playwright.config.ts builds), on a port and a data folder of its own. PostgreSQL
 * does not run as root, and the containers of the tests are root: there it runs as `pwuser` of the
 * Playwright image, as the user who started it would be, after the links of its libraries were made
 * (as root, as the package is root's there).
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Someone who is not root, by the image's /etc/passwd. */
function notRoot(): { uid: number; gid: number; home: string } | undefined {
  if (process.getuid?.() !== 0) return undefined;
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [name, , uid, gid, , home] = line.split(":");
    if (name === "pwuser") return { uid: Number(uid), gid: Number(gid), home: home ?? "/tmp" };
  }
  throw new Error("these tests run PostgreSQL, which needs a user that is not root: none is here");
}

export class Backend {
  readonly port: number;
  readonly dataDir: string;
  readonly editor: string;
  #child: ChildProcess | undefined;
  output = "";

  constructor(port: number) {
    this.port = port;
    this.dataDir = join(tmpdir(), `animaquill-e2e-backend-${port}`);
    this.editor = `http://animaquill.localhost:${port}`;
  }

  /** Starts it, and waits until its API is ready. */
  async start(): Promise<void> {
    this.output = "";
    const user = notRoot();
    if (user) await findPrograms();
    mkdirSync(join(tmpdir()), { recursive: true });
    const child = spawn(
      process.execPath,
      [CLI, "--no-open", "--port", String(this.port), "--data-dir", this.dataDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(user && { HOME: user.home }), AQ_DATA_DIR: "" },
        ...(user && { uid: user.uid, gid: user.gid }),
      },
    );
    this.#child = child;
    child.stdout?.on("data", (part: Buffer) => (this.output += part.toString()));
    child.stderr?.on("data", (part: Buffer) => (this.output += part.toString()));
    const until = Date.now() + 120_000;
    while (!/已启动：/.test(this.output)) {
      if (child.exitCode !== null || Date.now() > until)
        throw new Error(`the backend did not start:\n${this.output}`);
      await new Promise((done) => setTimeout(done, 200));
    }
  }

  /** Stops it as Ctrl+C does, and waits for it. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    const ended = new Promise((done) => child.once("exit", done));
    child.kill("SIGINT");
    await ended;
  }

  /** Stops it and takes its data folder away. */
  async remove(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  /** A new address that signs in, as `npx animaquill open` gets it. */
  async addressToOpen(): Promise<string> {
    const backend = JSON.parse(readFileSync(join(this.dataDir, "backend.json"), "utf8")) as {
      adminKey: string;
    };
    const answer = await this.call("POST", "/api/local/admin/open", {
      authorization: `Bearer ${backend.adminKey}`,
      "content-length": "0",
    });
    return (JSON.parse(answer.body) as { url: string }).url;
  }

  /** A request to it, as from the command line. */
  call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    host = `animaquill.localhost:${this.port}`,
  ) {
    return new Promise<{ status: number; body: string }>((done, fail) => {
      const sent = request(
        { host: "127.0.0.1", port: this.port, method, path, headers: { host, ...headers } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (part: string) => (body += part));
          response.on("end", () => done({ status: response.statusCode ?? 0, body }));
        },
      );
      sent.on("error", fail);
      sent.end();
    });
  }
}
