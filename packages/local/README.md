# AnimaQuill

AI 时代的视频编辑器。这个包在你自己的电脑上启动编辑器：一条命令开一个只有这台电脑能访问的简易网页服务器，用 Chrome 或 Edge 打开就能用。

```bash
npx animaquill
```

需要 Node.js 22 或更新的版本。启动后会打印地址并打开浏览器：

```
AnimaQuill 0.1.0 已启动：http://animaquill.localhost:7651/
```

如果打开的不是 Chrome 或 Edge，把地址复制到 Chrome 或 Edge 里。按 Ctrl+C 停止服务器。

## 能做什么

不需要平台的功能全部可用：

- 文件夹项目：项目就是电脑上的一个文件夹，可以放进 Git，也可以把浏览器里的项目移到文件夹
- 编辑、预览、导出视频和当前帧，代理文件
- HTML 场景、效果和转场
- 浏览器里的 AI 助手：填你自己的 API key，浏览器直接连 AI 服务商，key 只存在这个浏览器里
- 可以安装成网页应用（Chrome 或 Edge 地址栏里的“安装”）

## 不能做什么

这个版本**不能登录，也不能用云服务**：没有云端同步、云端 AI、AI 服务的平台转发和平台转发的 MCP。AI 助手只能从浏览器直连服务商，不让浏览器读取回答的服务（比如月之暗面、智谱）在这里连不上。错误报告和运行情况报告不上传，可以在编辑器里查看、复制或保存成文件。

## 选项

```
animaquill [--port <端口>] [--no-open]
animaquill mcp|check|describe|guide [--project <项目文件夹>]
```

- `--port <端口>`：默认 7651。浏览器把项目、设置和 AI 的 key 按地址（包括端口）分开存，换了端口就看不到原来端口下存在浏览器里的项目（文件夹项目还在文件夹里，重新打开即可）。平时不要改。
- `--no-open`：不自动打开浏览器。

端口被占用时服务器不会自动换一个，而是报错退出：可能编辑器已经在运行，直接打开地址即可。

## 让电脑上的 AI 工具改项目（MCP）

Claude Code、Codex 这类在你电脑上运行的 AI 工具，可以通过 AnimaQuill 的工具读、改项目文件夹，用的是它们自己的订阅和额度。`animaquill mcp` 是一个 MCP 服务器，只经 stdio 和启动它的程序通信，不联网，只读写项目文件夹里的文件。

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

**别的 AI 工具：** 命令是 `npx -y animaquill@latest mcp`。在项目文件夹（或者它里面的文件夹）里启动时，它往上找有 `animaquill.json` 的文件夹；不在项目文件夹里启动的工具（比如 Claude 桌面版），加上 `--project <项目文件夹的路径>`。

要知道的：

- 编辑器开着同一个文件夹时，AI 的改动马上并入编辑器，可以整批撤销；你同时改了同一处，留下你的，AI 下一次调用工具时会知道你改了什么。
- 编辑器没开时，AI 照样改文件夹，下次打开项目时并入。
- 时间轴、片段和关键帧经 AnimaQuill 的工具改（它们检查格式和别人的改动），场景代码可以直接当文本改。新建的项目里有一份 `AGENTS.md`，Claude Code 和 Codex 打开文件夹时会读它。
- 看画面、听声音还要在编辑器里：这些工具现在出不了画面。
- 它在项目的 `.animaquill/` 里记下每批改动是哪个工具做的（`batches/`），以及现在连着的工具（`mcp/`）；这个文件夹不进 Git。

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

Chrome 和 Edge 把 `*.localhost` 当成这台电脑，并当作安全的地址，不需要改 hosts 文件。服务器只监听本机回环地址（127.0.0.1 和 ::1），只回答这几个名字，别的网站借不到它。

同一个端口上不要运行别的网页服务器：在这个端口回答 `animaquill.localhost` 的程序能读到编辑器在浏览器里存的东西。

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
