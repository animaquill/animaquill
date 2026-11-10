# AnimaQuill

AI 时代的视频编辑器：AI 为主、人工为辅，手动编辑能力同样齐全。用于制作 CSS 动画、2D 动画和 3D 动画，同时支持音频编辑和视频剪辑。

An AI-first video editor for CSS, 2D and 3D animation.

这个仓库是 AnimaQuill 的开源版。安装到自己的电脑上就能编辑项目，使用完整功能。开源版不内置 AI 引擎，通过 MCP 接入你自己的 AI 工具。

## 当前状态

开发中，还没有可用版本。

## 在自己的电脑上使用

一条命令在这台电脑上启动编辑器，用 Chrome 或 Edge 打开：

```bash
npx animaquill
```

文件夹项目、编辑、预览、导出、场景和转场、用自己 key 的浏览器 AI 助手都能用；不能登录，也不能用云服务。见 [packages/local](packages/local/README.md)。

## 开发

需要 Node.js 26 和 pnpm。

```bash
pnpm install
pnpm dev     # 在浏览器里运行编辑器（开发页）
pnpm start   # 构建并启动本机网页服务器，和 npx animaquill 一样
pnpm check   # 类型检查、lint、格式和单元测试
pnpm e2e     # 浏览器测试
```

## 项目格式

项目就是一个普通文件夹，可以放进 Git，也可以直接用工具读写。见[项目格式说明](docs/project-format.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[GNU Affero General Public License v3.0](LICENSE)
