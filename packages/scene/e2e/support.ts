import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { LEAKS } from "./hosts.ts";
import type { OpenScene, SceneInfo } from "./harness/messages.ts";

/** Each project of `playwright.config.ts` has a stage of its own. */
const stage = () => test.info().project.metadata.stage as OpenScene["stage"];

/** Text as text, and everything else in a form that survives the trip into the page. */
export function fixture(directory: string, prefix = ""): OpenScene["files"] {
  const root = new URL(`./fixtures/${directory}/`, import.meta.url).pathname;
  const files: Record<string, string | { base64: string }> = {};
  const add = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) add(join(path, name));
      return;
    }
    const name = prefix + relative(root, path);
    const content = readFileSync(path);
    const isText = /\.(html|css|js|json|svg)$/.test(path);
    files[name] = isText ? content.toString("utf8") : { base64: content.toString("base64") };
  };
  add(root);
  return files;
}

export const binary = (path: string) => ({
  base64: readFileSync(new URL(`./fixtures/${path}`, import.meta.url)).toString("base64"),
});

declare global {
  interface Window {
    lab: {
      call(method: string, ...args: unknown[]): Promise<unknown>;
      foreign(): number;
      foreignReads(): number;
    };
  }
}

/** A running scene, from where the test stands. */
export class TestScene {
  readonly #page: Page;
  readonly id: number;

  constructor(page: Page, id: number) {
    this.#page = page;
    this.id = id;
  }

  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const value = await this.#page.evaluate(
      ([name, id, rest]) => window.lab.call(name as string, id, ...(rest as unknown[])),
      [method, this.id, args] as const,
    );
    return value as T;
  }

  info() {
    return this.call<SceneInfo>("info");
  }

  /** Goes to a frame and says whether it got there. */
  seek(frame: number) {
    return this.call<boolean>("seek", frame);
  }

  /** The frame on the page that the scene runs in right now. */
  async frame(): Promise<Frame> {
    const { origin } = await this.info();
    const frame = this.#page.frames().find((candidate) => candidate.url().startsWith(`${origin}/`));
    if (!frame) throw new Error(`No frame on ${origin}`);
    return frame;
  }

  /** Runs in the scene, from outside of it, to see what is really there. */
  async read<T>(run: () => T | Promise<T>): Promise<T> {
    return (await this.frame()).evaluate(run);
  }

  async problems() {
    return (await this.info()).problems;
  }
}

export async function openLab(page: Page): Promise<void> {
  await page.goto("/");
}

export async function openScene(
  page: Page,
  options: Omit<OpenScene, "stage"> & { readonly stage?: OpenScene["stage"] | undefined },
): Promise<TestScene> {
  const id = await page.evaluate((scene) => window.lab.call("open", scene), {
    stage: stage(),
    ...options,
  } as OpenScene);
  return new TestScene(page, id as number);
}

/** A scene from a page and nothing else. */
export const pageScene = (
  page: Page,
  html: string,
  more: Partial<Omit<OpenScene, "stage">> & {
    readonly stage?: OpenScene["stage"] | undefined;
  } = {},
) =>
  openScene(page, {
    entry: "scenes/test/index.html",
    ...more,
    files: { "scenes/test/index.html": html, ...more.files },
  });

export const leaks = async () => (await (await fetch(LEAKS)).json()) as string[];

export { expect };

/** Everything around the scene still has to work, right after it went. */
export async function expectAllWell(page: Page, victim: TestScene) {
  const started = Date.now();
  expect(await page.evaluate(() => window.lab.call("alive"))).toBe(true);
  expect(await victim.seek(60)).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect((await victim.info()).failures).toEqual([]);
}

export async function expectGone(scene: TestScene, reason: string, timeout = 10000) {
  await expect.poll(async () => (await scene.info()).failures.length, { timeout }).toBe(1);
  const info = await scene.info();
  expect(info.state).toBe("stopped");
  expect(info.failures[0]).toMatchObject({ reason, retrying: false });
  expect(info.origin).toBeUndefined();
}
