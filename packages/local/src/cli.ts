import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LOCAL_PORT, localSites } from "@animaquill/web/sites";
import { openBrowser } from "./open-browser.ts";
import { PortInUse, startLocalServer } from "./server.ts";
import { check, describe, guide } from "./mcp/commands.ts";
import { findProject } from "./mcp/find.ts";
import { animaquillHome } from "./mcp/home.ts";
import { IdentityRefused, loadIdentity } from "./mcp/identity.ts";
import { ElectedLink } from "./mcp/link.ts";
import { allowOrigin, allowedOrigins } from "./mcp/origins.ts";
import { listedTools, serveMcp } from "./mcp/server.ts";
import { McpSession } from "./mcp/session.ts";
import { findTarget } from "./mcp/target.ts";
import { TOOLSET_VERSION, mcpListHash } from "@animaquill/tools";

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
      animaquill <命令> [--project <项目文件夹>]

在这台电脑上启动 AnimaQuill 编辑器，用 Chrome 或 Edge 打开显示的地址。

命令（项目默认是当前文件夹，或者往上最近的有 animaquill.json 的文件夹）：
  mcp              给电脑上的 AI 工具（Claude Code、Codex 等）用的 MCP 服务器（stdio）：
                   工具在浏览器里打开的编辑器里执行，编辑器要开着这个项目、连着电脑上的 AI 工具。
                   --project 也可以是在线项目的地址；--allow-origin <网址> 让那个网站上的编辑器连接
  mcp allow-origin <网址>
                   记住一个网站（自己部署的；官方站点和 npx animaquill 的编辑器不用）上的编辑器，让它连接；已经开着的 AI 工具不用重启
  check [--json]   检查项目，有错误时退出码是 1
  describe         项目概要和时间轴
  guide [<主题>]   手册，比如 guide ops/clip.move；--query <词> 按关键词找

选项：
  --port <端口>  使用的端口，默认 ${LOCAL_PORT}。浏览器里的项目和设置跟着端口走，
                 换了端口就看不到原来端口下的项目，平时不要改。
  --no-open      不自动打开浏览器
  -v, --version  显示版本
  -h, --help     显示这段说明

这个版本不能登录，也不能用云服务（云端同步、云端 AI）。
`;

function portFrom(value: string | undefined): number {
  if (value === undefined) return LOCAL_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error(`--port 要是 1 到 65535 之间的数字，收到的是：${value}`);
  }
  return port;
}

const COMMANDS = new Set(["mcp", "check", "describe", "guide"]);

/** `animaquill <command>`: the tools on a project folder, without the editor. */
async function runCommand(name: string, argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        project: { type: "string" },
        "allow-origin": { type: "string", multiple: true },
        json: { type: "boolean" },
        query: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: name === "guide" || name === "mcp",
      strict: true,
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const output = {
    out: (text: string) => console.log(text),
    err: (text: string) => console.error(text),
  };
  if (name === "guide") return guide(positionals[0], values.query, output);
  if (name === "mcp" && positionals.length > 0) {
    const [what, address] = positionals;
    if (what !== "allow-origin" || address === undefined || positionals.length !== 2) {
      console.error(HELP);
      return 2;
    }
    try {
      const origin = await allowOrigin(animaquillHome(), address);
      console.log(
        `电脑上的 AI 工具现在也连接 ${origin} 上的编辑器，已经开着的不用重启：回到编辑器再点一次“连接”。`,
      );
      return 0;
    } catch (error) {
      console.error((error as Error).message);
      return 2;
    }
  }
  if (name === "check")
    return check(await findProject(values.project), values.json === true, output);
  if (name === "describe") return describe(await findProject(values.project), output);

  // mcp: stdout is the protocol from here on, and what is said to people goes to stderr.
  console.log = console.error;
  const home = animaquillHome();
  let identity;
  try {
    identity = await loadIdentity(home);
  } catch (error) {
    if (!(error instanceof IdentityRefused)) throw error;
    console.error(error.message);
    return 1;
  }
  const allowed = await allowedOrigins(home, values["allow-origin"] ?? []);
  const link = new ElectedLink({
    identity,
    allowed,
    // An editor opens in the browser for a call that finds none (design 5.5 of AnimaQuill Cloud).
    home,
    toolset: TOOLSET_VERSION,
    list: mcpListHash(listedTools()),
    ...portsFromEnvironment(),
    log: (text) => console.error(text),
  });
  void link.start().catch((error: unknown) => console.error(error));
  const session = new McpSession({
    link,
    find: (id) => findTarget(values.project, id),
  });
  const handle = serveMcp({ session, version });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    session.close();
    void session
      .open()
      .then((found) => (found.kind === "target" ? found.cleanup() : undefined))
      .catch(() => {})
      .then(() => Promise.allSettled([handle.close(), link.close()]))
      .then(() => process.exit(0));
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return -1;
}

/** The ports of the relay, where `ANIMAQUILL_RELAY_PORTS` (`<first>:<count>`) moves them: for tests. */
function portsFromEnvironment(): { ports?: { first: number; count: number } } {
  const given = /^(\d+):(\d+)$/.exec(process.env["ANIMAQUILL_RELAY_PORTS"] ?? "");
  return given ? { ports: { first: Number(given[1]), count: Number(given[2]) } } : {};
}

async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first !== undefined && COMMANDS.has(first)) return runCommand(first, rest);
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
