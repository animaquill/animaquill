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

- 命令：`pnpm dev`、`pnpm check`、`pnpm e2e`。量时间的单元测试放在 `*.perf.test.ts`，`pnpm check` 不跑，用 `pnpm test:perf`，CI 会跑。
- 浏览器测试跑在开发页的构建上（`vite build` 再 `vite preview`），不是开发服务器。已经开着 `pnpm dev` 时用它，改了代码不用重新构建。
- 测试里出现 `Yjs was already imported`，是依赖重新链接后 Vitest 还留着旧路径，删掉 `node_modules/.vitest-cache`。
- 包的依赖方向只能往下，比如 `ui` 依赖 `host`。
- import 写完整的扩展名，这样 Node.js 也能直接运行这些源码。
- dockview 只在 `packages/ui/src/dock` 里使用，这类关键依赖不进业务代码。
- 界面文字都放在 `packages/ui/src/i18n`，不写在组件里。
- 改动项目的操作走命令系统。界面上的操作是动作，两者不要混用。
- 设置是所有窗口共享的，只放偏好，不放这个窗口正在做什么。窗口显示哪个项目由 `Host.address` 决定，其他窗口自己的状态放 `Host.windowMemory`。整份写回的设置要用 `listen` 跟上其他窗口的改动。
- 宿主只提供存储，接口在 `packages/host`，不要让它依赖 Yjs。保存的逻辑在 `packages/ui/src/workbench/session.ts`，切换项目走 `Workbench`，它会先处理没保存的改动。
- 文件夹项目和文件夹对账在不碰 DOM 的 `packages/ui/src/folder/session.ts`（`FolderSession`）：改动先进本机日志，写文件夹前等日志写完，日志有了才记写入记录和基准（`LocalFolders.bases`，按轮次存，丢了轮次的窗口存不进）。日志写不进时照样写文件夹（文件夹是项目本身），但不记基准和写入记录，快照的 `unrecorded` 提示崩溃后可能要手动处理。写文件前先读一眼内容，再带 `expected` 写，不是上次看到的样子就先并入再写。一个浏览器里只有拿到 `LocalFolders.writer` 的窗口写文件夹、并入外面的改动；接手前先读完日志，读不了基准或日志就不对账，等下一轮；基准库里有这个本机编号的基准（不论哪个窗口、哪一轮记下的）就用它们，完全没有时才以当前项目为准，刚从文件夹建项目的窗口也一样。挡住的文件不写；要用编辑器的内容盖掉文件夹里的一版时（冲突、锁定挡下的、`useEditorContent`、崩溃写坏的），先把那一版存进 `.animaquill/recovered/`：并入后马上用读到的内容存，存好之前这个文件保留旧基准，存好后那一版才是基准，并且在盖掉之前记下。写入记录和被替换的那一版（也包括存好的写坏的那一版）留到下次对账，用来认出崩溃写坏的和被系统退回的文件。文件夹不见了或换成别的项目时这个窗口放手，`reconnect` 后再接。本机状态按本机编号（`FolderRecord.id`）存，不按项目 id。改这些规则要跑 `folder/fuzz-folder*.test.ts`。
- 对话框用 `Workbench.dialogs`，不要自己写弹窗。
- Monaco 只在 `packages/ui/src/code/monaco.ts` 里使用，这个文件只能用 `import()` 加载，静态引用它就进了首屏。加载走 `code/load.ts`，它先单独加载界面文字：构建后 Monaco 的共享代码是单独的 chunk，比 `monaco.ts` 里的 import 先运行，文字放在那里编辑器就是英文，开发服务器上看不出来。打开的文件和规则都在不碰 DOM 的 `CodeDocuments` 里：代码改动保存时才走 `file.write`，不走试改。文件在别处变了，没改动就跟上，有改动就提示，用户没说之前不动。改路径要走 `CodeDocuments.moving`，否则看起来是文件没了。没保存的代码由 `CodeDrafts` 存到 `Host.drafts`（浏览器版是单独的 `animaquill-drafts` 数据库，和试改一样一个窗口一个位置，写入用 `workbench/keeper.ts` 的 `PlaceKeeper`）。找回时只回到选项卡里，不写项目，文件变了或没了按冲突处理，所以项目照常能打开。
- 问题都进 `ProblemList`，每个来源只管自己的那部分：场景的问题跟着场景的 `revision` 走，新版本一接管就清掉旧的。通知只说一个版本的第一个问题，问题选项卡开着时不说。
- 动作的按键只属于一个选项卡时写 `scope`。
- 转场由合成器的 `render/src/compose.ts` 画：没有转场的图层照旧直接画；内置转场的代码在 `render/src/transitions`，写法和第三方代码一样（`aq.render`，拿到两边的画面和进度），在合成器里直接调用。淡入淡出和叠化有不经过代码的快路，结果要和按代码算的一致，改的时候两条路都要测。衔接转场让两边的图层在片段外多显示一段（`RenderLayer.shows`），视频、场景、预加载都要按这个范围算，不要只看片段的开头结尾。
- 时间轴在 `packages/ui/src/timeline`。缩放、播放头、选中是窗口的状态，不进项目。手势只改预览，松手才执行命令，一次拖动是一步撤销。手势和规则写在不碰 DOM 的 `TimelineEditor` 里，用单元测试盯住。
- 锁定轨道的片段可以点选（看属性、复制），框选和全选不选它。选中不等于能改：改片段的操作要走 `TimelineEditor` 的 `#changeable`，不要直接用选中集合。
- 控件改属性和关键帧都走 `PropertyWriter`，不要自己执行 `property.edit`：默认先进试改（`core/trial.ts` 的 `Trial`，界面这层是 `properties/trial.ts` 的 `TrialSession`）。试改是窗口自己的，不进 Yjs，别的窗口和 AI 看不到，保存时合成一条命令。预览拿 `PropertyWriter.getPreviewed`，新的渲染计划带着它发，不要发完计划再补，否则合成器会先画一帧旧值。
- 试改的撤销步骤只记自己改过的属性，撤销重做回到当时的样子，结构变化只改当前的试改，不改步骤。项目的撤销带走的试改，在同一步重做时回来，保存后也一样。命令做了文档看不出来的事（切割、时钟移动、移动片段）时用 `draft.note` 说明，`Trial` 从 `store.change` 读。别的窗口和文件导入来的改动只有结果，`Trial` 只做有把握的判断，判断不了就不动值并提示。片段的开头、时长和 offset 都没变时，关键帧的移动不算时钟移动。`movedFrom` 只给用户用，只能指向同一批里移走的片段。
- 用不上的试改（片段不在了，或者关键帧落到时钟开始之前）搁置，不丢，也不算进“试改 N 处”。片段回来就接着用。上限 200 个属性，超过时清掉最早的并提示；放了 30 天的在打开项目时清掉；放弃全部时一起清掉。
- 本地存放是 `Host.trials`，一个窗口一个位置，位置记在 `WindowMemory`。浏览器版用单独的数据库，不升主数据库的版本：那样开着的旧页面都写不了。保存时先等项目日志写完，再清本地记录。

## 命令系统

- 所有对项目的改动都走 `ProjectStore`：手动操作、MCP 和外部文件改动是同一条路。不要绕过它直接改 Yjs 文档。
- 新命令写在 `packages/core/src/commands.ts`。命令只规划改动，校验都在写入之前完成，因为 Yjs 不能回滚。
- 文档里哪些层是独立的 Map，定义在 `packages/core/src/structure.ts`，它决定了冲突的粒度。不是每个对象都有的层用 `flat`，没有自己的 Map，值存在最近的 Map 里，键是从那里往下的路径；扁平层可以嵌套，比如整个版本差异都存在时间轴的 `overrides` 里。空的也要在的层（语言）用 `standing`。旧文档里已有的嵌套 Map 照常读，写入时迁到扁平键。改成扁平的发布后要提醒用户刷新还开着的旧页面：旧页面仍写旧的 Map，新键已有的值它写了也不生效。
- 文件导入受轨道锁定保护：锁定轨道上的片段、转场、差异，以及它在用的场景、声音、共用代码、素材和库，文件里对它们的改动跳过，结果的 `kept` 和 `problems` 说明；只剩这些改动、或者跳过后其余部分会出错时，整份不导入。只有 `origin === USER` 的文件能解锁（会在 `problems` 里说明），`importFile` 必须明确传 `origin`。
- 项目文件夹里在外面改了的文件用 `mergeFiles` 并入（`core/src/merge-files.ts`），以基准做三方合并：基准是编辑器上次写出或读到的内容，从基准到新内容的差异才是外面的改动，只把它加到编辑器现在的内容上，编辑器还没写出去的改动不会被冲掉。文档按 `structure.ts` 的层合并，单个素材、批注、场景和声音清单按字段合并，代码按行合并（`merge-text.ts`），两边改了同一处保留编辑器的，列在 `conflicts`，带着外面那一侧（`theirs`）。一批文件是一次改动、一个来源（`folderBatch`，不算用户本人），用 `undoOrigin` 整批撤销，只留最近 `MAX_BATCHES` 批。锁定和 origin 规则同文件导入；外面删掉、项目还在用的东西留着，整份文件被删时这个文件挡住等用户决定；格式不对的文件挡住，它是时间轴时连带挡住它的版本文件和登记它的清单，其余照常并入；外面新用到编辑器刚删、还没写出去的东西，算对这条引用的冲突，保留编辑器的、丢掉外面这条引用，所以必须传 `baseOf`（批外文件的基准），文件夹里还有没有它由它说了算；合并后会出错的文件挡住，挡不住时才整批不并入；合并本身出错时整批拒绝（`merge-failed`），不抛异常。结果给出每个文件以后的基准，挡住的文件保留旧基准。
- 不用 `Y.UndoManager`：两边同时改一个字段再撤销时，它可能让这个字段没有值。撤销用命令记录的逆操作。
- 涉及并发的改动要跑随机测试 `packages/core/src/fuzz*.test.ts`，手写用例发现不了这类问题。分成几个文件是为了同时跑，共用的在 `fuzz-support.ts`。
- 命令要经得起一次处理几千个片段：不要在循环里再扫一遍全部片段，先按轨道排序。
- 浮点时间只用来画和找位置。切不切、有没有空位这类判断用精确时间，否则片段边缘会判断错。
- 判断属性是不是动画用 `isAnimation`：数组也有 `keys`。
- 会挪动片段边缘的命令（移动、修剪、改时长、覆盖着放下）开头用 `joinsTogether` 记下首尾相接的衔接转场，最后用 `followJoins`：两边还相接就跟着走（包括换轨道），分开了就同一步删掉，结果里写 `joinsRemoved`。文件导入和多人同时改造成的分开不删，留给问题列表。衔接转场在哪里生效、各占两边多少，都用 `core/src/joins.ts`，不要自己算。

## 项目格式

项目格式是公开的，用户的作品都存在里面，说明在 [docs/project-format.md](docs/project-format.md)。

- 任何格式改动都要提高 `CURRENT_FORMAT_VERSION`，加一条迁移，再加一份 `fixtures/v<版本>`。正式上线前的例外：不升版本、不写迁移、可以改 fixtures。去掉的字段记在 `core/src/structure.ts` 的 `RETIRED` 里，读 Yjs 文档时跳过；schema 用 `z.preprocess` 在校验前丢掉，读到不报错。
- `fixtures/` 里已有的版本永远不改（正式上线前的例外见上一条），它们保证旧项目还能打开。
- 改完运行 `pnpm --filter @animaquill/schema export-schema`，更新公开的 JSON Schema。
- 项目内容是不可信的。ID 和路径字段都要防止指向项目之外。
- 宿主里存的是 Yjs 文档，不是文件。第一次升级格式时，`ProjectSession` 也要迁移已保存的项目，现在只拒绝比编辑器新的格式。
- 读文件夹解析成项目在 `packages/core/src/read-folder.ts`（与平台无关，Node 用 `@animaquill/core/disk-folder`），界面层只做适配和翻译。项目进出文件夹的界面在 `packages/ui/src/transfer`，怎么读写文件夹由宿主决定（`Host.folders`）。导出时 `animaquill.json` 最后写，中途停下的文件夹就不会被当成项目。导入只产生新项目，走 `ProjectLibrary.receive`，完成前别人看不到，校验都在写入之前。清单之外的文档坏了可以跳过，但要用户在对话框里同意（`ProjectFolder.lost`），跳过后的内容重新走一遍 `readProject`，所以结果和健康的项目过同样的检查。读文件夹不要用 `FileSystemDirectoryHandle.values()`：Chrome 不允许的名字（比如 `aux.js`、`~草稿.html`）它不列出来，也不报错，文件就无声丢了。
