import { execFile } from "node:child_process";

/**
 * Opens an address in the browser people use, with the program the system has for it, and never
 * through a shell: an address is one argument, whatever is in it. Windows opens it with what
 * double-clicking a link does (`url.dll`), not with `start`, which only a command prompt knows and
 * which would take `&` in an address for the end of a command. `ANIMAQUILL_OPEN` names another
 * program to give the address to, as tests do.
 */

export interface OpenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The program and its arguments that open `url` on a system. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  instead: string | undefined = process.env["ANIMAQUILL_OPEN"],
): OpenCommand {
  if (instead) return { command: instead, args: [url] };
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Opens it. Not finding a program is fine: whoever opens says the address otherwise. */
export function openBrowser(url: string): void {
  const { command, args } = openCommand(url);
  try {
    const child = execFile(command, [...args], { windowsHide: true }, () => {});
    child.on("error", () => {});
    child.unref();
  } catch {
    // Nothing opens: the address is said anyway.
  }
}
