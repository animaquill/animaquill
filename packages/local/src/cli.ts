import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LOCAL_PORT, localSites } from "@animaquill/web/sites";
import { openBrowser } from "./open-browser.ts";
import { NewerDatabase } from "@animaquill/server/database.ts";
import { PortInUse, startLocalServer } from "./server.ts";
import { DataDirRefused, defaultDataDir } from "./backend/data-dir.ts";
import { adminRequest, LockHeld, readBackend } from "./backend/lock.ts";
import { checkedOpening, type Opening } from "./backend/open-page.ts";
import {
  findPrograms,
  isAlive,
  LeftOverRunning,
  NoPostgres,
  PostgresFailed,
} from "./backend/postgres.ts";
import { startBackend } from "./backend/run.ts";
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
      animaquill open
      animaquill <命令> [--project <项目文件夹>]

在这台电脑上启动 AnimaQuill 编辑器和它的后端，用 Chrome 或 Edge 打开显示的地址。
在线模式的项目、设置存在这台电脑的数据目录里，不用登录，只有这台电脑能访问；
离线模式的项目存在浏览器里或文件夹里。

命令（项目默认是当前文件夹，或者往上最近的有 animaquill.json 的文件夹）：
  open             在浏览器里打开已经在运行的 AnimaQuill（带一次性的登录）
  mcp              给电脑上的 AI 工具（Claude Code、Codex 等）用的 MCP 服务器（stdio）：
                   工具在浏览器里打开的编辑器里执行，编辑器要开着这个项目、连着电脑上的 AI 工具。
                   --project 也可以是在线项目的地址；--allow-origin <网址> 让那个网站上的编辑器连接
  mcp allow-origin <网址>
                   记住一个网站（自己部署的；官方站点和 npx animaquill 的编辑器不用）上的编辑器，让它连接；已经开着的 AI 工具不用重启
  check [--json]   检查项目，有错误时退出码是 1
  describe         项目概要和时间轴
  guide [<主题>]   手册，比如 guide ops/clip.move；--query <词> 按关键词找

选项：
  --offline          只启动离线模式，不起后端和数据库
  --data-dir <目录>  数据目录，默认 ${defaultDataDir()}（也可以用环境变量 AQ_DATA_DIR）
  --database <网址>  用自己的 PostgreSQL，比如 postgres://用户@主机:5432/库名。带密码的网址
                     请用环境变量 AQ_DATABASE_URL 给：命令行里的密码同一台电脑的其他用户能看到
  --port <端口>      使用的端口，默认 ${LOCAL_PORT}。浏览器里的项目和设置跟着端口走，
                     换了端口就看不到原来端口下的项目，平时不要改。
  --no-open          不自动打开浏览器
  -v, --version      显示版本
  -h, --help         显示这段说明
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

/** What the backend could not start for, as people are told, with the way out. */
function sayRefused(error: unknown, logFile: string | undefined): void {
  const offline = "先用离线模式（项目存在浏览器里或文件夹里）：npx animaquill --offline";
  if (error instanceof DataDirRefused) {
    const mode =
      error.mode === undefined ? "" : `（权限 ${error.mode.toString(8).padStart(4, "0")}）`;
    const why = {
      owner: `不归当前用户${mode}`,
      writable: `别的用户能改${mode}`,
      link: "是一个链接",
      notFolder: "不是文件夹",
      name: '的路径里有 " 或 %（Windows 上数据库的启动程序读不对）',
    }[error.reason];
    console.error(`数据目录 ${error.path} ${why}，为了安全不启动。`);
    if (error.reason === "writable") console.error(`运行 chmod 700 "${error.path}" 后再试。`);
    if (error.reason === "owner" || error.reason === "link")
      console.error("用 --data-dir 换一个只有你能用的文件夹，或者改回来后再试。");
  } else if (error instanceof LockHeld) {
    console.error(
      `AnimaQuill 好像已经在运行（进程 ${error.pid}），但 10 秒没有回应。关掉它（或者结束进程 ${error.pid}）后再试。`,
    );
  } else if (error instanceof PortInUse) {
    console.error(
      `端口 ${error.port} 已经被别的程序占用：先关掉那个程序再试。换端口（--port）会看不到原来端口下浏览器里的项目。`,
    );
  } else if (error instanceof NewerDatabase) {
    console.error(
      `这个数据目录被更新版本的 AnimaQuill 用过，这个版本（${version}）打不开它。请运行 npx animaquill@latest。`,
    );
    return;
  } else if (error instanceof LeftOverRunning) {
    console.error(
      `数据目录里有一个数据库进程（进程 ${error.pid}）还在运行，但是没有回应：可能正在恢复，或者被暂停了，或者 pg18.password 被改过。` +
        `等一会儿再试；确定它不再需要时，结束进程 ${error.pid} 后再试。`,
    );
  } else if (error instanceof PostgresFailed && error.missingLibrary) {
    console.error(
      "数据库启动不了：这台电脑缺少 Microsoft Visual C++ 运行库。装上以后再试：https://aka.ms/vs/17/release/vc_redist.x64.exe",
    );
  } else if (error instanceof PostgresFailed) {
    console.error(`数据库没能启动。${logFile ? `详细原因在 ${logFile}。` : ""}`);
    console.error(error.message);
  } else {
    console.error(`后端没能启动：${(error as Error)?.message ?? String(error)}`);
  }
  console.error(offline);
}

/** Why there is no backend here at all, so that only the offline mode starts: undefined if there is. */
async function noBackendHere(database: string | undefined): Promise<string | undefined> {
  if (process.platform !== "win32" && process.getuid?.() === 0 && database === undefined)
    return "现在是 root 用户：只启动离线模式（项目存在浏览器里或文件夹里）。要用在线模式，请换普通用户运行，或者用 --database 接自己的 PostgreSQL，或者用 Docker 部署。";
  if (database !== undefined) return undefined;
  try {
    await findPrograms();
    return undefined;
  } catch (error) {
    if (!(error instanceof NoPostgres)) throw error;
    const where = `${process.platform}-${process.arch}`;
    return error.reason === "links"
      ? `随包的数据库用不了（${error.message}）：只启动离线模式。要用在线模式，用 --database 接自己的 PostgreSQL。`
      : `这台电脑（${where}${error.reason === "musl" ? "，musl" : ""}）没有随包的数据库：只启动离线模式。要用在线模式，用 --database 接自己的 PostgreSQL。`;
  }
}

/** `npx animaquill --offline`, and where there can be no backend: the editor alone, as before. */
async function startOffline(port: number, open: boolean): Promise<number> {
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
  console.log(`AnimaQuill ${version} 已启动（离线模式）：${address}`);
  console.log("请用 Chrome 或 Edge 打开。只有这台电脑能访问。按 Ctrl+C 停止。");
  if (open) void openBrowser(address);
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  return -1;
}

/**
 * Opens what signs in, by its page in the data folder (the token in no command line, see
 * open-page.ts), or says the address where no browser opened or none is to be.
 */
async function openOrSay(opening: Opening, open: boolean, opened?: string): Promise<void> {
  if (open && opening.page !== undefined && (await openBrowser(opening.page))) {
    console.log(opened ?? "浏览器没有打开时，运行 npx animaquill open。");
    return;
  }
  console.log(`用这个网址打开（10 分钟内有效，只能用一次）：${opening.url}`);
}

const NOT_RUNNING = "AnimaQuill 没有在运行（或者是离线模式）：先运行 npx animaquill。";
const WRONG_ANSWER =
  "在 AnimaQuill 的端口上回答的不像是 AnimaQuill，什么都没有打开。先关掉那个程序，再运行 npx animaquill。";

/** `animaquill open`: the editor of the backend that runs, signed in, in the browser. */
async function openRunning(argv: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { "data-dir": { type: "string" }, "no-open": { type: "boolean" } },
      strict: true,
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const dir = dataDirFrom(values["data-dir"]);
  const backend = await readBackend(dir);
  // A backend.json of a process that is gone says nothing: its port may be anyone's now.
  if (!backend || !Number.isInteger(backend.pid) || !isAlive(backend.pid)) {
    console.error(NOT_RUNNING);
    return 1;
  }
  const answer = await adminRequest(backend, "POST", "open");
  if (answer === "refused" || answer.status !== 200) {
    console.error(NOT_RUNNING);
    return 1;
  }
  const opening = await checkedOpening(backend, answer.body, dir);
  if (!opening) {
    console.error(WRONG_ANSWER);
    return 1;
  }
  await openOrSay(opening, values["no-open"] !== true, "已在浏览器里打开。");
  return 0;
}

/** The address of a database of people's own, from the environment, in place of `--database`. */
const DATABASE_VARIABLE = "AQ_DATABASE_URL";

const hasPassword = (address: string) => {
  try {
    return new URL(address).password !== "";
  } catch {
    return false;
  }
};

const dataDirFrom = (given: string | undefined): string =>
  resolve(given ?? (process.env["AQ_DATA_DIR"] || defaultDataDir()));

async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first !== undefined && COMMANDS.has(first)) return runCommand(first, rest);
  if (first === "open") return openRunning(rest);
  let options;
  try {
    ({ values: options } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string" },
        "no-open": { type: "boolean" },
        offline: { type: "boolean" },
        "data-dir": { type: "string" },
        database: { type: "string" },
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
  const open = !options["no-open"];
  if (options.offline) return startOffline(port, open);
  // The address of a database of people's own, with its password: better from the environment,
  // as what is in a command line others of the computer can read.
  const database = options.database ?? (process.env[DATABASE_VARIABLE] || undefined);
  delete process.env[DATABASE_VARIABLE];
  if (options.database !== undefined && hasPassword(options.database))
    console.error(
      `提醒：--database 里的密码，同一台电脑上的其他用户能看到（在进程列表里）。改用环境变量 ${DATABASE_VARIABLE} 给这个网址。`,
    );
  const why = await noBackendHere(database);
  if (why) {
    console.log(why);
    return startOffline(port, open);
  }

  console.log(`AnimaQuill ${version}`);
  let backend;
  try {
    backend = await startBackend({
      dataDir: dataDirFrom(options["data-dir"]),
      port,
      version,
      site: built("site"),
      scenePage: readFileSync(built("scene.html"), "utf8"),
      database,
      say: (line) => console.log(line),
    });
  } catch (error) {
    sayRefused(error, undefined);
    return 1;
  }
  if (backend.kind === "running") {
    if (!backend.opening) {
      console.error(WRONG_ANSWER);
      return 1;
    }
    console.log(`AnimaQuill 已经在运行：${backend.editor}/`);
    await openOrSay(backend.opening, open, "已在浏览器里打开。");
    return 0;
  }

  console.log(`已启动：${backend.server.sites.editor}/`);
  console.log("请用 Chrome 或 Edge 打开。只有这台电脑能访问。按 Ctrl+C 停止。");
  await openOrSay(await backend.addressToOpen(), open);

  let signals = 0;
  const stop = () => {
    signals += 1;
    if (signals > 1) {
      console.log("立刻停止。");
      void backend.stopNow().finally(() => process.exit(1));
      return;
    }
    console.log("正在停止…");
    void backend.stop().then(
      () => {
        console.log("已停止。");
        process.exit(0);
      },
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Windows says this as its console window is closed, and ends the process a few seconds later.
  process.on("SIGHUP", stop);
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
