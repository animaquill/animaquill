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

这个版本**不能登录，也不能用云服务**：没有云端同步、云端 AI 和平台转发的 MCP。错误报告和运行情况报告不上传，可以在编辑器里查看、复制或保存成文件。

## 选项

```
animaquill [--port <端口>] [--no-open]
```

- `--port <端口>`：默认 7651。浏览器把项目、设置和 AI 的 key 按地址（包括端口）分开存，换了端口就看不到原来端口下存在浏览器里的项目（文件夹项目还在文件夹里，重新打开即可）。平时不要改。
- `--no-open`：不自动打开浏览器。

端口被占用时服务器不会自动换一个，而是报错退出：可能编辑器已经在运行，直接打开地址即可。

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
