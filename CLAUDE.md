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
- 测试里出现 `Yjs was already imported`，是依赖重新链接后 Vitest 还留着旧路径，删掉 `node_modules/.vitest-cache`。
- 包的依赖方向只能往下，比如 `ui` 依赖 `host`。
- import 写完整的扩展名，这样 Node.js 也能直接运行这些源码。
- dockview 只在 `packages/ui/src/dock` 里使用，这类关键依赖不进业务代码。
- 界面文字都放在 `packages/ui/src/i18n`，不写在组件里。
- 改动项目的操作走命令系统。界面上的操作是动作，两者不要混用。
- 设置是所有窗口共享的，只放偏好，不放这个窗口正在做什么。窗口显示哪个项目由 `Host.address` 决定，其他窗口自己的状态放 `Host.windowMemory`。整份写回的设置要用 `listen` 跟上其他窗口的改动。
- 宿主只提供存储，接口在 `packages/host`，不要让它依赖 Yjs。保存的逻辑在 `packages/ui/src/workbench/session.ts`，切换项目走 `Workbench`，它会先处理没保存的改动。
- 对话框用 `Workbench.dialogs`，不要自己写弹窗。
- 动作的按键只属于一个选项卡时写 `scope`。
- 时间轴在 `packages/ui/src/timeline`。缩放、播放头、选中是窗口的状态，不进项目。手势只改预览，松手才执行命令，一次拖动是一步撤销。手势和规则写在不碰 DOM 的 `TimelineEditor` 里，用单元测试盯住。
- 控件改属性和关键帧都走 `PropertyWriter`，不要自己执行 `property.edit`：默认先进试改（`core/trial.ts` 的 `Trial`，界面这层是 `properties/trial.ts` 的 `TrialSession`）。试改是窗口自己的，不进 Yjs，别的窗口和 AI 看不到，保存时合成一条命令。预览拿 `PropertyWriter.getPreviewed`，新的渲染计划带着它发，不要发完计划再补，否则合成器会先画一帧旧值。
- 试改的撤销步骤只记自己改过的属性，撤销重做回到当时的样子，结构变化只改当前的试改，不改步骤。项目的撤销带走的试改，在同一步重做时回来，保存后也一样。命令做了文档看不出来的事（切割、时钟移动、移动片段）时用 `draft.note` 说明，`Trial` 从 `store.change` 读。别的窗口和文件导入来的改动只有结果，`Trial` 只做有把握的判断，判断不了就不动值并提示。片段的开头、时长和 offset 都没变时，关键帧的移动不算时钟移动。`movedFrom` 只给用户用，只能指向同一批里移走的片段。
- 用不上的试改（片段不在了，或者关键帧落到时钟开始之前）搁置，不丢，也不算进“试改 N 处”。片段回来就接着用。上限 200 个属性，超过时清掉最早的并提示；放了 30 天的在打开项目时清掉；放弃全部时一起清掉。
- 本地存放是 `Host.trials`，一个窗口一个位置，位置记在 `WindowMemory`。浏览器版用单独的数据库，不升主数据库的版本：那样开着的旧页面都写不了。保存时先等项目日志写完，再清本地记录。

## 命令系统

- 所有对项目的改动都走 `ProjectStore`：手动操作、MCP 和外部文件改动是同一条路。不要绕过它直接改 Yjs 文档。
- 新命令写在 `packages/core/src/commands.ts`。命令只规划改动，校验都在写入之前完成，因为 Yjs 不能回滚。
- 文档里哪些层是独立的 Map，定义在 `packages/core/src/structure.ts`，它决定了冲突的粒度。
- 不用 `Y.UndoManager`：两边同时改一个字段再撤销时，它可能让这个字段没有值。撤销用命令记录的逆操作。
- 涉及并发的改动要跑随机测试 `packages/core/src/fuzz.test.ts`，手写用例发现不了这类问题。
- 命令要经得起一次处理几千个片段：不要在循环里再扫一遍全部片段，先按轨道排序。
- 浮点时间只用来画和找位置。切不切、有没有空位这类判断用精确时间，否则片段边缘会判断错。
- 判断属性是不是动画用 `isAnimation`：数组也有 `keys`。

## 项目格式

项目格式是公开的，用户的作品都存在里面，说明在 [docs/project-format.md](docs/project-format.md)。

- 任何格式改动都要提高 `CURRENT_FORMAT_VERSION`，加一条迁移，再加一份 `fixtures/v<版本>`。
- `fixtures/` 里已有的版本永远不改，它们保证旧项目还能打开。
- 改完运行 `pnpm --filter @animaquill/schema export-schema`，更新公开的 JSON Schema。
- 项目内容是不可信的。ID 和路径字段都要防止指向项目之外。
- 宿主里存的是 Yjs 文档，不是文件。第一次升级格式时，`ProjectSession` 也要迁移已保存的项目，现在只拒绝比编辑器新的格式。
- 项目进出文件夹在 `packages/ui/src/transfer`，怎么读写文件夹由宿主决定（`Host.folders`）。导出时 `animaquill.json` 最后写，中途停下的文件夹就不会被当成项目。导入只产生新项目，走 `ProjectLibrary.receive`，完成前别人看不到，校验都在写入之前。读文件夹不要用 `FileSystemDirectoryHandle.values()`：Chrome 不允许的名字（比如 `aux.js`、`~草稿.html`）它不列出来，也不报错，文件就无声丢了。
