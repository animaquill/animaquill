import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { ProblemSet, ProjectStore, aiTask, readFolder } from "@animaquill/core";
import { diskFolder } from "@animaquill/core/disk-folder";
import {
  CallerState,
  createToolset,
  proofText,
  readMessage,
  toPage,
  type FromPage,
  type ToPage,
  type PageProject,
  type Tool,
} from "@animaquill/tools";
import { WebSocket } from "ws";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadFixture } from "../../../schema/scripts/fixture.ts";

const made: string[] = [];

/** A new folder of its own, taken away by `cleanUp`. */
export function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "animaquill-mcp-"));
  made.push(folder);
  return folder;
}

/**
 * The sample project in a folder of its own, without the tag that locks it, so that it can be
 * changed. Resolves to the folder.
 */
export function sampleFolder(inside: string = tempFolder()): string {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string) as Record<string, unknown>;
  delete manifest.tags;
  files.set("animaquill.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of files) {
    const place = join(inside, path);
    mkdirSync(dirname(place), { recursive: true });
    writeFileSync(place, text);
  }
  return inside;
}

export function cleanUp(): void {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
}

/** The project in a folder, read as the editor reads it. */
export async function storeOf(folder: string): Promise<ProjectStore> {
  const reading = await readFolder(await diskFolder(folder));
  return ProjectStore.create(reading.project, reading.sources);
}

export interface FakePageOptions {
  readonly port: number;
  readonly origin: string;
  readonly store: ProjectStore;
  readonly project: PageProject;
  /** Offline: the folder the page has, which probes look in. */
  readonly folder?: string;
  readonly serving?: boolean;
  readonly frontAt?: number;
  readonly page?: string;
  /** The key the page trusts; any where not given. */
  readonly trusts?: string;
}

/**
 * A page of the editor as the relay meets it, in Node: it checks the relay's signature, says what it
 * has open, and runs calls with the tools of the browser on a store, one session one caller. What
 * the page of the editor does (`ui/src/local-ai/bridge`) without the editor.
 */
export class FakePage {
  readonly calls: Extract<FromPage, { t: "page" }>[] = [];
  readonly received: string[] = [];
  readonly #options: FakePageOptions;
  readonly #tools = new Map<string, readonly Tool[]>();
  readonly #done = new Map<string, unknown>();
  #ws: WebSocket | undefined;
  /** The relay's key, once it proved it. */
  key: string | undefined;

  constructor(options: FakePageOptions) {
    this.#options = options;
  }

  get id(): string {
    return this.#options.page ?? `page-${this.#options.project.key}`;
  }

  /** Connects: resolves once the relay proved its key, and rejects where it did not. */
  connect(): Promise<void> {
    const { port, origin } = this.#options;
    const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(18))).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/page?nonce=${nonce}`, { origin });
    this.#ws = ws;
    return new Promise((resolve, reject) => {
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
      ws.on("message", (data) => {
        const raw = String(data);
        this.received.push(raw);
        const message = readMessage(toPage, raw);
        if (!message) return;
        if (message.t === "hello") {
          void verify(message.key, message.signature, proofText(nonce, origin, port)).then((ok) => {
            if (!ok || (this.#options.trusts && this.#options.trusts !== message.key)) {
              ws.close();
              reject(new Error("not the relay trusted"));
              return;
            }
            this.key = message.key;
            this.#say();
            resolve();
          });
        } else if (message.t === "ping") {
          this.#send({ t: "pong" });
        } else if (message.t === "call") {
          void this.#run(message);
        } else if (message.t === "probe") {
          void this.#probe(message.probe, message.path, message.nonce);
        }
      });
    });
  }

  #send(message: FromPage): void {
    this.#ws?.send(JSON.stringify(message));
  }

  #say(): void {
    const { project, serving = true, frontAt = Date.now() } = this.#options;
    this.#send({
      t: "page",
      page: this.id,
      browser: "Test",
      toolset: "",
      list: "",
      project,
      serving,
      hidden: false,
      frontAt,
    });
  }

  async #probe(probe: string, path: string, nonce: string): Promise<void> {
    let found = false;
    if (this.#options.folder) {
      try {
        const text = await readFile(`${this.#options.folder}/${path}`, "utf8");
        found = (JSON.parse(text) as { nonce?: unknown }).nonce === nonce;
      } catch {
        found = false;
      }
    }
    this.#send({ t: "probed", probe, found });
  }

  async #run(call: Extract<ToPage, { t: "call" }>): Promise<void> {
    const done = this.#done.get(call.call);
    if (done) {
      this.#send(done as FromPage);
      return;
    }
    const { store } = this.#options;
    let tools = this.#tools.get(call.session);
    if (!tools) {
      const problems = new ProblemSet();
      const answer = { now: call.answer };
      tools = createToolset(
        {
          store: () => store,
          origin: () => aiTask(`mcp-${call.session}`),
          answer: () => answer.now,
          problems: () => {
            problems.update(store.getState());
            return problems;
          },
        },
        new CallerState(),
      );
      this.#tools.set(call.session, tools);
    }
    const tool = tools.find(({ name }) => name === call.tool);
    const result = tool
      ? await tool.run(call.args)
      : { text: `error unknown-tool: ${call.tool}`, isError: true };
    const message: FromPage = {
      t: "result",
      call: call.call,
      result: { text: result.text, isError: result.isError },
    };
    this.#done.set(call.call, message);
    this.#send(message);
  }

  close(): void {
    this.#ws?.close();
  }
}

/** Whether a signature is the key's, as the page checks it with WebCrypto. */
async function verify(key: string, signature: string, text: string): Promise<boolean> {
  const imported = await webcrypto.subtle.importKey(
    "spki",
    Buffer.from(key, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    imported,
    Buffer.from(signature, "base64"),
    new TextEncoder().encode(text),
  );
}
