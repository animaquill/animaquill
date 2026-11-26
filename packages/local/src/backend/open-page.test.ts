import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { opensAsPage } from "../open-browser.ts";
import type { BackendNote } from "./lock.ts";
import { checkedOpening, OpenPages, pageFor } from "./open-page.ts";

/**
 * The browser is opened without the token in any command line, by a page of the data folder; and
 * nothing a backend answers is opened unless it is that backend's address with a token, or its
 * page, as a program in its place on its port could answer anything.
 */

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aq-open-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "t".repeat(43);
const ORIGIN = "http://animaquill.localhost:7651";
const ADDRESS = `${ORIGIN}/#aq-token=${TOKEN}`;
const backend = (changes: Partial<BackendNote> = {}): BackendNote => ({
  format: 1,
  instance: "i",
  pid: process.pid,
  version: "test",
  port: 7651,
  origin: ORIGIN,
  adminKey: "k",
  startedAt: 0,
  ...changes,
});

describe("the page that opens the browser", () => {
  test("is the user's alone, goes on at once without a place in the history, and goes", async () => {
    const dir = folder();
    const pages = new OpenPages(dir);
    const page = await pages.write(ADDRESS);
    if (process.platform !== "win32") expect(statSync(page).mode & 0o777).toBe(0o600);
    expect(pageFor(ADDRESS)).toContain(`location.replace("${ADDRESS}")`);
    expect(pageFor(ADDRESS)).toContain('<meta name="referrer" content="no-referrer">');
    writeFileSync(join(dir, "open-left-by-a-start-before.html"), "x");
    writeFileSync(join(dir, "master.key"), "k");
    await pages.remove(page);
    expect(readdirSync(dir).toSorted()).toEqual(["master.key", "open-left-by-a-start-before.html"]);
    await pages.removeAll();
    expect(readdirSync(dir)).toEqual(["master.key"]);
  });
});

describe("what the command line opens of a backend", () => {
  test("is its address with a token, and its page as it wrote it", async () => {
    const dir = folder();
    const page = await new OpenPages(dir).write(ADDRESS);
    expect(await checkedOpening(backend(), { url: ADDRESS }, dir)).toEqual({ url: ADDRESS });
    const opening = await checkedOpening(backend(), { url: ADDRESS, page }, dir);
    expect(opening?.url).toBe(ADDRESS);
    expect(fileURLToPath(opening!.page!)).toBe(page);
  });

  test("is nothing of a backend whose process is gone, nor of a program in its place", async () => {
    const dir = folder();
    const page = await new OpenPages(dir).write(ADDRESS);
    expect(
      await checkedOpening(backend({ pid: 2 ** 22 + 17 }), { url: ADDRESS, page }, dir),
    ).toBeUndefined();
    for (const url of [
      "C:\\Users\\ada\\evil.exe",
      "file:///tmp/evil.html",
      "javascript:alert(1)",
      `http://evil.example/#aq-token=${TOKEN}`,
      `${ORIGIN}/#aq-token=${TOKEN}&x=1`,
      `${ORIGIN}/#aq-token=short`,
      `${ORIGIN}/elsewhere#aq-token=${TOKEN}`,
      `http://animaquill.localhost:7652/#aq-token=${TOKEN}`,
      42,
    ])
      expect(await checkedOpening(backend(), { url }, dir), String(url)).toBeUndefined();
    expect(
      await checkedOpening(backend({ origin: "http://evil.example" }), { url: ADDRESS }, dir),
    ).toBeUndefined();
    // Pages that are not its own: elsewhere, by another name, a link, another content.
    const elsewhere = await new OpenPages(folder()).write(ADDRESS);
    expect(await checkedOpening(backend(), { url: ADDRESS, page: elsewhere }, dir)).toBeUndefined();
    const named = join(dir, "evil.html");
    writeFileSync(named, pageFor(ADDRESS));
    expect(await checkedOpening(backend(), { url: ADDRESS, page: named }, dir)).toBeUndefined();
    const other = await new OpenPages(dir).write(`${ORIGIN}/#aq-token=${"u".repeat(43)}`);
    expect(await checkedOpening(backend(), { url: ADDRESS, page: other }, dir)).toBeUndefined();
    if (process.platform !== "win32") {
      const link = join(dir, `open-${"l".repeat(22)}.html`);
      symlinkSync(page, link);
      expect(await checkedOpening(backend(), { url: ADDRESS, page: link }, dir)).toBeUndefined();
    }
  });

  test("and the browser is only ever given a page", () => {
    expect(opensAsPage(ADDRESS)).toBe(true);
    expect(opensAsPage("file:///home/ada/.animaquill/server/open-x.html")).toBe(true);
    for (const url of [
      "C:\\evil.exe",
      "file:///tmp/evil.exe",
      "file:///tmp/a.html?x",
      "https://x",
      "smb://x/y",
      "ms-settings:",
    ])
      expect(opensAsPage(url), url).toBe(false);
  });
});
