# AnimaQuill 开源版

编辑器的全部功能都在这个仓库里，包括项目格式、Git 集成、MCP 和桌面应用。闭源版依赖这个仓库。

## 核心准则

1. 跑得稳。
2. 能接住用户。
3. 功能好用。
4. 从长远角度，按可持续发展和可扩展的最佳技术方案打基座，而不是功能实现就行、能用就行。

## 规则

- 这个仓库是公开的。不要提交服务器信息、密钥、账号数据或闭源代码。
- 第三方依赖只用 MIT、Apache、BSD、MPL 这类许可证。
- 用户的决定不符合核心准则时，先提醒用户，用户确认后再继续。

## 开发

- 命令：`pnpm dev`、`pnpm check`、`pnpm e2e`。
- 包的依赖方向只能往下，比如 `ui` 依赖 `host`。
- import 写完整的扩展名，这样 Node.js 也能直接运行这些源码。
- dockview 只在 `packages/ui/src/dock` 里使用，这类关键依赖不进业务代码。
- 界面文字都放在 `packages/ui/src/i18n`，不写在组件里。
- 改动项目的操作走命令系统。界面上的操作是动作，两者不要混用。
- 设置是所有窗口共享的，只放偏好，不放这个窗口正在做什么。窗口显示哪个项目由 `Host.address` 决定。
- 宿主只提供存储，接口在 `packages/host`，不要让它依赖 Yjs。保存的逻辑在 `packages/ui/src/workbench/session.ts`，切换项目走 `Workbench`，它会先处理没保存的改动。
- 对话框用 `Workbench.dialogs`，不要自己写弹窗。

## 命令系统

- 所有对项目的改动都走 `ProjectStore`：手动操作、MCP 和外部文件改动是同一条路。不要绕过它直接改 Yjs 文档。
- 新命令写在 `packages/core/src/commands.ts`。命令只规划改动，校验都在写入之前完成，因为 Yjs 不能回滚。
- 文档里哪些层是独立的 Map，定义在 `packages/core/src/structure.ts`，它决定了冲突的粒度。
- 不用 `Y.UndoManager`：两边同时改一个字段再撤销时，它可能让这个字段没有值。撤销用命令记录的逆操作。
- 涉及并发的改动要跑随机测试 `packages/core/src/fuzz.test.ts`，手写用例发现不了这类问题。

## 项目格式

项目格式是公开的，用户的作品都存在里面，说明在 [docs/project-format.md](docs/project-format.md)。

- 任何格式改动都要提高 `CURRENT_FORMAT_VERSION`，加一条迁移，再加一份 `fixtures/v<版本>`。
- `fixtures/` 里已有的版本永远不改，它们保证旧项目还能打开。
- 改完运行 `pnpm --filter @animaquill/schema export-schema`，更新公开的 JSON Schema。
- 项目内容是不可信的。ID 和路径字段都要防止指向项目之外。
- 宿主里存的是 Yjs 文档，不是文件。第一次升级格式时，`ProjectSession` 也要迁移已保存的项目，现在只拒绝比编辑器新的格式。
