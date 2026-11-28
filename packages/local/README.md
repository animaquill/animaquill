# AnimaQuill

AI 时代的视频编辑器。这个包在你自己的电脑上启动编辑器和它的后端：一条命令开一个只有这台电脑能访问的网页服务器，用 Chrome 或 Edge 打开就能用，不用登录。

```bash
npx animaquill
```

需要 Node.js 22 或更新的版本。第一次会顺带下载这台电脑用的数据库（PostgreSQL，Windows 约 40 MB，macOS 约 130 MB，Linux 约 25 MB）。启动后会打开浏览器：

```
AnimaQuill 0.4.0
第一次准备数据库（几秒）…
启动数据库…
更新数据库结构…
已启动：http://animaquill.localhost:7651/
请用 Chrome 或 Edge 打开。只有这台电脑能访问。按 Ctrl+C 停止。
浏览器没有自动打开时，运行 npx animaquill open。
```

打开的网址带一次性的登录（`#aq-token=…`，10 分钟内有效、只能用一次，页面一打开就把它从地址栏去掉）。浏览器没有打开、或者以后想再打开时，运行 `npx animaquill open`。如果打开的不是 Chrome 或 Edge，在 Chrome 或 Edge 里运行一次 `npx animaquill open`。按 Ctrl+C 停止。

## 两种模式

- **在线模式**（默认）：项目存在这台电脑的数据目录里，每个项目自动存进数据目录里的 Git 仓库；AI 的设置和 key 也跟着这个“本机”账号。只有启动它的这个用户、在这台电脑上能用。
- **离线模式**：项目存在浏览器里或电脑上的文件夹里，不连后端。在编辑器里随时可以切换；`npx animaquill --offline` 只启动离线模式（以前的版本就是这样）。

以 root 运行、或者这台电脑没有随包的数据库（比如 Alpine、32 位系统）时，只启动离线模式，并说明原因；可以用 `--database` 接自己的 PostgreSQL。

## 数据目录

默认 Windows 是 `%LOCALAPPDATA%\AnimaQuill\server\`，macOS 和 Linux 是 `~/.animaquill/server/`，可以用 `--data-dir` 或环境变量 `AQ_DATA_DIR` 换。里面有数据库（`pg18/`）、项目的仓库（`repos/`）、大文件、对话里的图片（`chat-images/`）、日志（`logs/`）和主密钥 `master.key`。主密钥加密存着的 AI key：**请另存一份**（编辑器的“设置 › 服务器”里可以另存），丢了以后 AI 模型的设置里会标“要重新填”。

在 macOS 和 Linux 上，这个目录只有你能访问（700，文件 600）；别的用户能改它时 AnimaQuill 不启动，并告诉你怎么改回来。在 Windows 上，每次启动都把它设成只有你能访问（去掉继承的权限）；数据目录不在你的用户目录里、或者设不成时会提醒。

打开浏览器时，带一次性登录的网址不会出现在任何命令行里：AnimaQuill 在数据目录里写一个只有你能读的跳转页（`open-….html`），让浏览器打开它；登录用掉或者 10 分钟后就删掉。

## 能做什么

不需要平台的功能全部可用：

- 文件夹项目：项目就是电脑上的一个文件夹，可以放进 Git，也可以把浏览器里的项目移到文件夹
- 编辑、预览、导出视频和当前帧，代理文件
- HTML 场景、效果和转场
- 浏览器里的 AI 助手：填你自己的 API key，浏览器直接连 AI 服务商，key 只存在这个浏览器里
- 可以安装成网页应用（Chrome 或 Edge 地址栏里的“安装”）

## 不能做什么

还不能连 GitHub、不能多人用、没有云端 AI。错误报告和运行情况报告不上传，可以在编辑器里查看、复制或保存成文件。

## 选项

```
animaquill [--offline] [--data-dir <目录>] [--database <网址>] [--port <端口>] [--no-open]
animaquill open
animaquill server export <文件夹>
animaquill server import <文件夹> [--master-key <主密钥文件>]
animaquill mcp|check|describe|guide [--project <项目文件夹>]
```

- `--offline`：只启动离线模式，不起后端和数据库。
- `--data-dir <目录>`：数据目录，见上。
- `--database <网址>`：用自己的 PostgreSQL，比如 `postgres://用户@主机:5432/库名`，不起随包的数据库。带密码的网址请放在环境变量 `AQ_DATABASE_URL` 里（比如 `AQ_DATABASE_URL=postgres://用户:密码@主机:5432/库名 npx animaquill`）：命令行里的密码，同一台电脑上的其他用户能在进程列表里看到。
- `open`：在浏览器里打开已经在运行的 AnimaQuill。再运行一次 `npx animaquill` 也一样。
- `server export <文件夹>`：把在线模式的数据（账号、AI 设置和加密的 key、对话和对话里的图片、项目清单和项目的实时副本、本机仓库）导出到一个新文件夹，只有你能读。AnimaQuill 开着时也可以：导出期间编辑器连不上服务器、同步暂停，按项目多少可能要几分钟，导完自动恢复，这期间没传上去的改动重连后会补上。导出里没有主密钥。
- `server import <文件夹>`：把导出的数据导入到一个空的数据目录（换电脑、恢复备份），导完逐表核对。`--master-key` 给原来的 `master.key`，存的 AI key 才打得开；不给的话，key 之后要重新填。
- `--port <端口>`：默认 7651。浏览器把项目、设置和 AI 的 key 按地址（包括端口）分开存，换了端口就看不到原来端口下存在浏览器里的项目（文件夹项目还在文件夹里，重新打开即可）。平时不要改。
- `--no-open`：不自动打开浏览器。

端口被占用时服务器不会自动换一个，而是报错退出。

数据目录被更新版本的 AnimaQuill 用过时，旧版本不会打开它，会提示运行 `npx animaquill@latest`。

以后 AnimaQuill 换随包的 PostgreSQL 大版本时，第一次启动会自动升级数据库：先导出、在旁边建新的数据库导入、逐表核对，都对上才换过去；旧的留在数据目录里（比如 `pg18.old/`），确认没问题后在“设置 › 服务器”里删。中途出了问题就照旧用原来的数据库，数据不动，下次启动再试。

## 让电脑上的 AI 工具改项目（MCP）

Claude Code、Codex 这类在你电脑上运行的 AI 工具，可以通过 AnimaQuill 的工具读、改浏览器里打开的项目，用的是它们自己的订阅和额度。`animaquill mcp` 是一个 MCP 服务器，经 stdio 和启动它的程序通信；工具在浏览器里开着这个项目的编辑器里执行，看画面、听声音也在那里。它只在本机地址 `127.0.0.1`（端口 47300 起）上等编辑器连过来，不联网。

编辑器第一次要连接时，在编辑器的“帮助 › 连接电脑上的 AI 工具”里点“连接”（浏览器会问能不能访问这台设备上的应用，选允许）；以后可以让它自动连接。只有 Chrome 和 Edge 能连。

**Claude Code：** 装一次插件，工具和“怎么做”的说明（技能）一起装好：

```bash
claude plugin marketplace add animaquill/animaquill
claude plugin install animaquill@animaquill
```

只装工具：

```bash
claude mcp add --scope user animaquill -- npx -y animaquill@latest mcp
```

以后在项目文件夹里打开终端，输入 `claude` 就能用。

**Codex：**

```bash
codex mcp add animaquill -- npx -y animaquill@latest mcp
```

Codex 默认只等服务器启动 10 秒，第一次要下载时可能来不及：先运行一次 `npm install -g animaquill`，再把命令里的 `npx -y animaquill@latest` 换成 `animaquill`。以后在项目文件夹里输入 `codex`。

**别的 AI 工具：** 命令是 `npx -y animaquill@latest mcp`。在离线项目的文件夹（或者它里面的文件夹）里启动时，它改的就是编辑器里开着的这个文件夹；在线项目可以加 `--project <项目的网址>`；都没有时，它改编辑器里最近一次在前台的项目。

要知道的：

- 编辑器要开着这个项目、连着电脑上的 AI 工具；没开时工具回一个错误，说要打开哪个项目。
- AI 的改动马上出现在编辑器里，一个工具连续改的算一批，可以整批撤销。
- 官方站点和 `npx animaquill` 的编辑器不用先做什么；自己部署的编辑器要先让 AI 工具认它：`npx -y animaquill@latest mcp allow-origin <编辑器的网址>`（记在 `~/.animaquill/mcp.json`）。
- 时间轴、片段和关键帧经 AnimaQuill 的工具改（它们检查格式和别人的改动）。离线项目的场景代码也可以直接用 AI 工具自己的文件工具改，编辑器会并入。新建的项目里有一份 `AGENTS.md`，Claude Code 和 Codex 打开文件夹时会读它。
- 编辑器在后台标签页时读和改照常，看画面要把它切到前台。
- `~/.animaquill/mcp-key` 是这台电脑上 `animaquill mcp` 的身份，编辑器靠它认出连过来的是你允许过的那个；只有你自己能读。

## 命令行

在项目文件夹里，或者加 `--project <项目文件夹>`：

- `npx animaquill check`：检查项目，列出问题；有错误时退出码是 1，没有项目时是 2，适合放进脚本。`--json` 输出 JSON。
- `npx animaquill describe`：项目概要和每条时间轴。
- `npx animaquill guide [<主题>]`：手册，比如 `guide ops/clip.move`、`guide howto/keyframes`；`--query <词>` 按关键词找。

## 它是怎么工作的

编辑器、合成器和每个场景各在一个单独的地址上运行，彼此是不同的来源，项目里的代码碰不到编辑器存的项目和 key：

| 地址 | 内容 |
| --- | --- |
| `http://animaquill.localhost:7651` | 编辑器 |
| `http://animaquill-sandbox.localhost:7651` | 合成器（沙箱） |
| `http://animaquill-scene-0.localhost:7651` … `scene-7` | 场景（沙箱） |

Chrome 和 Edge 把 `*.localhost` 当成这台电脑，并当作安全的地址，不需要改 hosts 文件。服务器只监听本机回环地址（127.0.0.1 和 ::1），只回答这几个名字，别的网站借不到它。后端（`/api`）只在编辑器的地址上回答，场景和合成器的地址碰不到它；会话要 cookie 加上只存在这个端口的页面里的绑定密钥两样都对，同一台电脑上别的用户、别的程序拿不到。数据库只听 127.0.0.1、要密码，不开 Unix socket。

同一个端口上不要运行别的网页服务器：AnimaQuill 没在运行时，在这个端口回答 `animaquill.localhost` 的程序能读到编辑器在浏览器里存的东西。这一点防不住。

## 从源码运行

```bash
git clone https://github.com/animaquill/animaquill.git
cd animaquill
pnpm install
pnpm start
```

`pnpm start` 先构建再启动，参数同上，比如 `pnpm start --port 7652`。

## 许可证

AGPL-3.0-only。

## 名称和图标

“AnimaQuill”这个名称和图标是项目的商标。代码按 AGPL-3.0 许可证可以自由使用、修改和分发；二次发布修改后的版本时，请换掉名称和图标，不要让人误以为是官方版本。
