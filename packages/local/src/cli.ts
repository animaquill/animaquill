import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LOCAL_PORT, localSites } from "@animaquill/web/sites";
import { PortInUse, startLocalServer } from "./server.ts";

/**
 * `npx animaquill`: the editor on this computer. Everything that needs no platform works, in Chrome
 * or Edge: project folders, editing, preview, export, scenes, and the browser agent with people's
 * own keys. There is nothing to sign in to and no cloud.
 */

// Next to this file once built, and the same place from the sources.
const built = (path: string) => fileURLToPath(new URL(`../dist/${path}`, import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const HELP = `用法：animaquill [选项]

在这台电脑上启动 AnimaQuill 编辑器，用 Chrome 或 Edge 打开显示的地址。

选项：
  --port <端口>  使用的端口，默认 ${LOCAL_PORT}。浏览器里的项目和设置跟着端口走，
                 换了端口就看不到原来端口下的项目，平时不要改。
  --no-open      不自动打开浏览器
  -v, --version  显示版本
  -h, --help     显示这段说明

这个版本不能登录，也不能用云服务（云端同步、云端 AI）。
`;

/** Opens the address in the browser people use. Not finding one is fine: the address is printed. */
function openBrowser(url: string) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', `"${url}"`]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed anyway.
  }
}

function portFrom(value: string | undefined): number {
  if (value === undefined) return LOCAL_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error(`--port 要是 1 到 65535 之间的数字，收到的是：${value}`);
  }
  return port;
}

async function main(argv: readonly string[]): Promise<number> {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string" },
        "no-open": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(version);
    return 0;
  }
  let port: number;
  try {
    port = portFrom(options.port);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  let server;
  try {
    server = await startLocalServer({
      site: built("site"),
      scenePage: readFileSync(built("scene.html"), "utf8"),
      port,
    });
  } catch (error) {
    if (error instanceof PortInUse) {
      console.error(
        `端口 ${port} 已经被占用：可能 AnimaQuill 已经在运行，直接打开 ${localSites(port).editor}/ 即可。` +
          `\n如果是别的程序占用了它，先关掉那个程序。换端口（--port）会看不到原来端口下浏览器里的项目。`,
      );
      return 1;
    }
    throw error;
  }

  const address = `${server.sites.editor}/`;
  console.log(`AnimaQuill ${version} 已启动：${address}`);
  console.log("请用 Chrome 或 Edge 打开。只有这台电脑能访问。按 Ctrl+C 停止。");
  if (!options["no-open"]) openBrowser(address);

  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
