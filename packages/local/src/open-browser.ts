import { execFile } from "node:child_process";

/**
 * Opens an address in the browser people use, with the program the system has for it, and never
 * through a shell: an address is one argument, whatever is in it. Windows opens it with what
 * double-clicking a link does (`url.dll`), not with `start`, which only a command prompt knows and
 * which would take `&` in an address for the end of a command. In tests (`ANIMAQUILL_TEST=1`, or
 * `NODE_ENV=test`), `ANIMAQUILL_OPEN` names another program to give the address to.
 */

/** The program tests open addresses with, where this is a test. */
const testOpener = (): string | undefined =>
  process.env["ANIMAQUILL_TEST"] === "1" || process.env["NODE_ENV"] === "test"
    ? process.env["ANIMAQUILL_OPEN"]
    : undefined;

export interface OpenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Whether an address is one of a page: `http:`, or a `file:` of an `.html`. */
export function opensAsPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "http:") return true;
  return (
    parsed.protocol === "file:" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.pathname.endsWith(".html")
  );
}

/** The program and its arguments that open `url` on a system. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  instead: string | undefined = testOpener(),
): OpenCommand {
  if (instead) return { command: instead, args: [url] };
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Opens it. Resolves to whether that seems to have worked: false where there is no program for it,
 * or it gave up at once, as `xdg-open` without a desktop, so that whoever opens says the address.
 */
export function openBrowser(url: string): Promise<boolean> {
  // Only a page: what the system opens otherwise could be a program.
  if (!opensAsPage(url)) return Promise.resolve(false);
  const { command, args } = openCommand(url);
  return new Promise((done) => {
    let child;
    try {
      child = execFile(command, [...args], { windowsHide: true }, (error) => done(!error));
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    // Still opening after a while: it does, as some programs stay until the browser closes.
    const timer = setTimeout(() => done(true), 3000);
    timer.unref();
    child.unref();
  });
}
