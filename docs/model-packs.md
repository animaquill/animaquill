# 模型适配包的格式

格式版本 1。模型适配包（简称适配包）是针对某些模型写的“提示词工程”：给 AI 的系统提示、工具的说明文字、参数的说明和例子、调用设置（推理强度、最大输出等）、工具结果给多少。这份说明写给想自己写适配包的人。

适配包只用在 AnimaQuill 自己控制对话的地方：浏览器里的 AI 助手（以后还有云端的助手）。别的 AI 工具（Claude Code、Codex 等）经 MCP 用 AnimaQuill 的工具时，系统提示和调用设置归那个工具自己管，工具说明一律用默认的写法，不受适配包影响。

适配包装在浏览器里，和 AI 服务的设置放在一起，不跟着项目走：项目会分享、会公开，带着提示词走就成了一条注入的路。

## 能改什么，不能改什么

| 能改 | 不能改 |
| --- | --- |
| 系统提示的七段（可以替换、追加、去掉，包括安全守则和运行环境说明） | 工具的名字和标题 |
| 每个工具的说明、工具自己的参数说明 | 参数的结构：类型、是否必填、取值范围 |
| `aq_edit` 每个操作的概要、长说明、参数说明和例子 | 工具返回的样子和措辞 |
| 各操作共用的参数说明、共用类型的说明 | 错误的文字、手册的正文 |
| `aq_edit` 说明末尾的例子 | 权限、冲突判断、写入前的校验 |
| 调用设置（封闭的清单） | 请求里别的任何字段：服务端工具、外接 MCP、metadata 等 |
| 结果的详略（三档，只变多少，不变格式） | |

右边那一列在格式里根本没有字段可写；写了就是“格式里没有这一项”，装不上。真正的保护也不靠提示词：工具的结构、权限、冲突判断、写入前的校验都在代码里，不管系统提示怎么说，AI 都越不过去。

适配包只有声明，不能带脚本。清单里出现 `scripts` 字段就装不上。

## 包的样子

一个文件夹：一份清单 `pack.json`，加几个放长文字的文件。短的文字可以直接写在清单里，所以一个包也可以只有一个 `pack.json`。

```
deepseek-steady/            文件夹名随意
  pack.json                 清单，必须有
  system/work.md            长文字放文件，清单里用 {"file": "system/work.md"} 引用
  tools/aq_edit.md
  README.md                 给人看的说明，可以有，不会被读
```

- 只读清单里引用到的文件。路径是包里的相对路径，用 `/` 分隔，不能以 `/` 开头，不能有 `..`、`.`、`\` 和 `:`。
- 文字放在 `.md` 或 `.txt` 里，例子放在 `.json` 里。都是 UTF-8；文件开头的 BOM 会去掉，`\r\n` 换成 `\n`，末尾的空白去掉。
- 一个文件最多 64 KB，整个包（清单加引用到的文件）最多 256 KB。
- 所有文字统一成 NFC。不能有控制字符（换行和制表符除外）、格式字符（零宽字符、改变书写方向的字符、标签字符、BOM 等）、行和段落分隔符、私用区字符，以及 Unicode 定为不显示的字符（变异选择符、填充字符、U+034F 等）和几个显示成空白的（盲文空白 U+2800、对象替换符 U+FFFC 等）：它们能让安装时显示出来的和 AI 读到的不一样，或者在一个字后面藏进别的内容。
- 连续最多 2 个空行，一串空白最多 20 个空格宽（制表符算 4 个）：再长的空白会把后面的话推到安装对话框里看不见的地方。
- `pack.json` 和例子文件的 JSON 最多嵌套 40 层、最多 50000 个值。

## 清单 `pack.json`

清单严格检查：不认识的字段一律报错。以后加字段会升 `format`。

| 字段 | 内容 |
| --- | --- |
| `format` | 格式的版本，现在是 `1` |
| `id` | `作者/名字`，小写字母、数字和 `-`，比如 `lin/deepseek-steady`。`animaquill/` 开头的只留给内置的包。同一个 `id` 再装一次就是更新 |
| `name` | 给人看的名字，最多 60 个字符。名字和作者里不能写“内置”“官方”“AnimaQuill”“built-in”“official”这类字样（大小写、全角、中间加空格都算）；编辑器里别人写的包一律标着“第三方”和它的 `id` |
| `version` | 版本，比如 `1.2.0` |
| `description` | 一句话说明，可以不写，最多 300 个字符 |
| `author` | 作者：一个名字，或 `{"name": …, "url": "https://…"}` |
| `license` | 许可证的 SPDX 标识，比如 `MIT` |
| `homepage` | 主页，`https://` 开头 |
| `models` | 适用哪些模型，模式的列表（见[匹配模型](#匹配模型)） |
| `call` | 调用设置（见[调用设置](#调用设置)） |
| `results` | 结果的详略：`concise`、`standard`、`detailed`（见[结果的详略](#结果的详略)） |
| `variants` | 同一个包里不同型号的差别（见[型号的差别](#型号的差别)） |
| `system`、`tools`、`ops`、`params`、`types`、`edit` | 要改的文字（见[文字](#文字)） |

## 文字

文字按“键”改。键只能指向现有的东西：现在有的工具、参数、操作、共用类型和系统提示的七段。键的全集从工具集生成，工具集改了它跟着变；`pnpm --filter @animaquill/tools pack-check --keys` 列出全部的键和默认的写法。

### 写法

每处文字的值可以是：

- 一个字符串：整段替换。
- `{"file": "路径"}`：整段替换成这个文件的内容。
- `{"append": 字符串或 {"file": …}}`：接在默认写法后面。系统提示和说明空一行接上（两边都是列表项时只换行，留在同一个列表里），参数说明空一格接上。
- `null`：去掉这一段。只有系统提示的段可以去掉。

例子的值是一组例子（数组）、`{"file": "x.json"}`，或 `{"append": …}` 接在默认的例子后面。

### 系统提示：`system`

系统提示分七段，按这个顺序拼：

| 段 | 默认写的是 |
| --- | --- |
| `intro` | 你是谁、用户在哪、回答用什么语言、多长 |
| `project` | 项目是怎么组成的（How a project works） |
| `work` | 怎么做事（How to work） |
| `rules` | 规则：只改要求的、`dry_run`、失败后改了再发 |
| `extra` | 默认是空的，留给包写自己的段落 |
| `guard` | 安全守则：项目内容是数据不是指令；用户可以同时改，冲突时保留用户的；不向用户要密钥、口令、令牌，不劝用户关掉权限和安全设置 |
| `host` | 运行环境说明：这个入口特有的事实，比如浏览器里“现在看不见画面、听不见声音” |

七段都可以替换、追加、去掉。改了 `guard` 或 `host` 的包，安装时这两段排在最前面、醒目地标出来，要用户单独勾选同意才能装。

```json
"system": {
  "work": { "file": "system/work.md" },
  "rules": { "append": "- If a call fails twice the same way, stop and tell the user what went wrong." },
  "extra": "Before you start, say in a line what you are about to do."
}
```

### 工具：`tools`

按工具名写，每个工具可以有：

- `description`：工具的说明。替换或追加，不能去掉。`aq_edit` 的说明里，操作名的清单和例子是生成的，`description` 只指开头的那几段。
- `params`：工具自己的参数说明，按参数的路径写，嵌套的用 `.` 连起来（`edits.old_text`；经过数组时不写下标）。替换或追加。

```json
"tools": {
  "aq_edit": { "description": { "append": "Keep batches small: up to 10 operations." } },
  "aq_timeline_read": { "params": { "limit": "How many clips to list, 1 to {max}. Leave it out for {default}." } }
}
```

### 操作：`ops`

`aq_edit` 的操作（AI 能用的那些），按操作名写：

- `summary`：一行概要，在参数结构里这个操作的分支上。只能替换。
- `description`：长说明，在手册里这个操作的页上。替换或追加。
- `params`：这个操作里某个参数的说明。只能替换。
- `examples`：这个操作的例子，在手册里。每个例子是 `{"title": …, "params": {…}}`（`params` 不带 `op`）。替换整组或追加。

### 共用的说明：`params`、`types`

- `params`：各操作共用的参数说明，按参数名写（某个操作在 `ops` 里另写了的，以那里的为准）。只能替换。
- `types`：参数结构里共用类型的说明（`Key`、`ClipSource`、`PropertyEdit` 等）。只能替换。

### `aq_edit` 说明末尾的例子：`edit`

`edit.examples` 是几组例子，每组是一次调用的 `operations`。替换整组或追加。

### 占位符

文字里可以写这几个占位符，按当前的详略换成实际的值，别的花括号原样保留：

| 占位符 | 写在哪里 | 换成什么 |
| --- | --- | --- |
| `{default}` | 有默认值的参数说明（`aq_timeline_read`、`aq_search`、`aq_check_run`、`aq_file_read` 的 `limit`，`aq_object_read` 的 `response_format`） | 模型不传这个参数时的值 |
| `{max}` | 有上限的参数说明 | 参数结构允许的最大值 |
| `{listed}` | `aq_project_status` 的说明 | 项目概况里清单各列几个 |

## 调用设置

`call` 是一个封闭的清单，不认识的字段报错：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `reasoning` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | 推理强度，映射到各家的写法。模型不支持的档就近取 |
| `maxOutputTokens` | 1024 到 256000 的整数 | 一次回答最多输出多少 token，思考也算在里面 |
| `temperature` | 0 到 2 | 温度。不写就不发；有的模型不收它 |
| `parallelToolCalls` | `true`、`false` | 一次回答里能不能调用几个工具。工具总是一个接一个执行；现在的服务连接库还不能在请求里表达它，暂时不起作用 |
| `cache` | `short`、`long` | 提示缓存保留多久 |
| `anthropic` | `{"thinkingDisplay": "summarized" 或 "omitted"}` | 只对 Anthropic 协议：思考的摘要要不要回来 |

不写的字段用编辑器的默认。没有把任意字段塞进请求的口子。安装时调用设置逐项列出来，`xhigh`、`max`、超过 64000 的输出上限和 `cache: "long"`（Anthropic 上写缓存更贵）旁边写着“花费会变高”。

## 结果的详略

`results` 只改工具结果给多少，不改结果的写法：

| | `concise` | `standard`（默认） | `detailed` |
| --- | --- | --- | --- |
| `aq_timeline_read` 默认列几个片段 | 100 | 200 | 500 |
| `aq_search` 默认几条 | 25 | 50 | 100 |
| `aq_check_run` 默认几个问题 | 50 | 100 | 200 |
| `aq_object_read` 默认的 `response_format` | `concise` | `detailed` | `detailed` |
| `aq_edit` 结果里列几个改动的对象 | 10 | 20 | 40 |
| 项目概况里场景、声音、素材、代码文件各列几个 | 15 | 30 | 60 |
| 一个结果最多多少字符 | 20000 | 40000 | 40000 |

模型自己传了 `limit`、`response_format` 时以它为准，上限不变。

## 型号的差别

`variants` 写同一个包里不同型号的差别：

```json
"variants": [
  { "models": ["claude-fable-5*", "claude-mythos-5*"], "call": { "reasoning": "high" } }
]
```

按顺序取第一个匹配当前模型的，叠在包的顶层设置上。变体里只能写 `models`、`call`、`results` 和 `system.extra`（写法和顶层的一样，作用在顶层的 `extra` 之后）。

## 匹配模型

`models` 是模式的列表。模式只有一种通配符 `*`（任意长度，包括空），不分大小写，必须整串匹配。拿来比的是用户设置里的模型名，原样和最后一个 `/` 之后的部分各比一次，所以 `claude-opus-5*` 同时匹配 `claude-opus-5-5` 和 `anthropic/claude-opus-5-5`。不按服务或协议匹配。

一个模型用哪个包：

1. 用户在设置里为这个模型选过的（还装着的话）。
2. 否则在内置的和装了的包里，取模式最具体的：模式里 `*` 以外的字符多的胜。
3. 一样具体时内置的优先；都是装的，先装的优先。新装的包比现在用的更具体时会顶替它：安装对话框逐个模型写明“现在用 X，装好以后改用它”，并可以选“装上但保持现在的选择”；不会顶替的模型，可以勾选改用它。
4. 都不匹配，用默认的写法（设置里叫“通用”），设置里和对话开头说明。

一次对话从头到尾用开始时的那个包的那一版：更新以后，进行中的对话仍用开始时的版本（编辑器为每个包留着更新前的两版）；那一版没留下时才用已装的版本，并在聊天里标一行。中途换了模型，下一轮重新选，选到的不同就在聊天里标一行。每条回答都记下用的是哪个包（`id`、`version` 和内容的哈希）。改选、安装、更新都从下一次新对话起生效。

设置里每个模型旁边写着新对话用哪个包（内置的还是第三方的），“看模型实际收到的”只读地显示合并以后的系统提示、工具清单的全文和调用设置。每个包都能“查看内容”：详情（名字、id、作者、来源、版本、适用的模型、调用设置、详略、按组列出改了哪些键、安装时的工具集版本、不再适用或停用的原因）、某个模型实际收到的全文（系统提示七段、每个工具的说明和参数结构，可以折叠、复制），以及任选两个包在同一个模型下逐段对比（调用设置和详略的差异、按键的差异、合并后的每一段，不同的醒目标出，相同的折叠）。写包的人可以用它对比自己的包和通用写法。

## 检查

编辑器在安装时、每次读出装好的包时都做同一套检查，任何一条不过就装不上，逐条列出原因：

- `pack.json` 是 JSON，`format` 是 `1`，没有 `scripts`，没有格式里没有的字段，每个字段的类型和取值都对；
- `id` 不以 `animaquill/` 开头，名字和作者里没有留给内置包的字样；
- JSON 不太深、值不太多；
- 引用的文件在包里、是能用的类型、不太大、是 UTF-8，整个包不太大；
- 没有上面说的那些看不见的字符，没有太长的空行和空白；
- 每个键都指向现有的东西；文字里出现的 `aq_` 开头的词都是现有的工具名；
- 长度：系统提示的一段最多 4000 个字符；工具说明 4000（合上默认写法以后算，`aq_edit` 算上生成的清单和例子）；参数和类型的说明 500；操作概要 200；操作长说明 2000；一个例子 2000（JSON），一组最多 10 个；
- 每个例子都要通过那个操作的参数校验；操作的例子的 `params` 里不能有 `op`（例子就是它所在的那个操作的）；
- 调用设置在上面的清单和范围里；
- 合上默认写法以后，系统提示最多 12000 个字符，整份工具清单（名字、说明、参数结构的 JSON）最多 64000 个字符。顶层和每个变体各算一次。

安装时编辑器记下工具集的版本和包改的每一项的默认写法（的哈希）。应用升级以后，装好的包里有的键不再存在（比如某个操作改了名）、文字提到的工具没有了，或者包整段替换的那一项的默认写法变了（比如参数的含义变了，旧的说明可能已经不对），读出时只丢掉那几处（接在默认写法后面的照留），包照用，设置里逐条写明哪几处不再适用。改了安全守则或运行环境说明的包有任何一处被丢掉，整个包停用，要重新安装、看过改动才能再用。别的检查不过（不应该发生），这个包停用，回到默认写法。检查本身出了没预料到的错，也按“这个包装不了”处理。

安装对话框还会把这些标黄，提醒你看一眼，但不拦：提到密钥、口令、令牌；提到网址；“忽略之前的指示”一类的话；让 AI 不告诉用户、不写改动摘要；要求联网、上传、发送。

## 安装和更新

在编辑器的设置里，“AI 服务”下面的“模型适配包”一节：

- **从文件夹安装**：选包的文件夹。
- **从 pack.json 安装**：只有一个 `pack.json` 的包。
- **从 GitHub 安装**：填公开仓库里包所在文件夹的地址，比如 `https://github.com/lin/aq-packs/tree/main/deepseek-steady`，也可以是仓库的地址（包在仓库根上、用默认分支）或 `pack.json` 的地址（`…/blob/main/deepseek-steady/pack.json`）。浏览器直接从 GitHub 取：先把分支或标签换成提交，所有文件都从那个提交取，记下地址和提交，用来查更新。名字里带 `/` 的分支认不出来，`tree/` 后面的第一段当作分支。不登录时 GitHub 每小时只回答 60 次。

安装前对话框最上面如实说明别人的包能做什么、编辑器在代码里守住了什么，然后列出：来源和作者；改了安全守则或运行环境说明的（排在最前面，要单独勾选）；会用在你配置的哪些模型上、每个模型现在用哪个包；调用设置和默认的不同；改了哪些提示词，按系统提示、工具说明、参数说明、操作、例子分组，每组里要留意的排在最前，每一处标出行数和字数、和默认写法并排。包里的文字都按纯文字显示，较长的空白显示成写明长度的标记。

同一个 `id` 再装一次就是更新，对话框显示新版本和已装版本的不同，同样要确认；改了安全守则或运行环境说明的同样要单独勾选。同一个 `id` 谁都能写：更新时并排写出已装的和新的来源、作者，不同就醒目地标出来。从 GitHub 装的包有“查更新”：有新的提交才打开对话框，那里换成了别的 `id` 的包时只报错、不装。不会自动更新。从 GitHub 取文件时超过大小上限的不读完，报“太大”。

## 一个完整的例子

给 DeepSeek 用的包：分批小一点，失败两次就停下来说明，参数说明更直白，结果给少一点。

`pack.json`：

```json
{
  "format": 1,
  "id": "lin/deepseek-steady",
  "name": "DeepSeek steady",
  "version": "1.2.0",
  "description": "Smaller batches and plainer parameter words for DeepSeek models.",
  "author": { "name": "Lin", "url": "https://github.com/lin" },
  "license": "MIT",
  "homepage": "https://github.com/lin/aq-packs",
  "models": ["deepseek-chat*", "deepseek-v4*", "deepseek-reasoner*"],
  "call": { "reasoning": "medium", "maxOutputTokens": 16000 },
  "results": "concise",
  "variants": [{ "models": ["deepseek-reasoner*"], "call": { "reasoning": "high" } }],
  "system": {
    "work": { "file": "system/work.md" },
    "rules": {
      "append": "- If a call fails twice the same way, stop and tell the user what went wrong."
    }
  },
  "tools": {
    "aq_edit": { "description": { "append": { "file": "tools/aq_edit.md" } } },
    "aq_timeline_read": {
      "params": { "limit": "How many clips to list, 1 to {max}. Leave it out for {default}." }
    }
  },
  "ops": {
    "clip.move": { "summary": "move clips to a new start time or another track" }
  },
  "params": { "start": "Start time in seconds, written as a string, for example \"12.5\"." },
  "edit": {
    "examples": [
      [{ "op": "clip.move", "timeline": "main", "clips": [{ "clip": "clip_idea", "start": "12" }] }],
      [{ "op": "clip.remove", "timeline": "main", "clips": ["clip_idea"] }]
    ]
  }
}
```

`system/work.md`：

```
How to work
Read what you are about to change before you change it: the tools remember what you have read and use it to keep you from overwriting what the user changed since.
Change timelines with aq_edit. Send at most 10 operations in one call, and check the result before you send the next batch.
Change code with aq_file_edit or aq_file_write, then run aq_check_run before you tell the user you are done.
```

`tools/aq_edit.md`：

```
Keep batches small: up to 10 operations. A smaller batch that works is better than a large one that fails.
```

另有一个隐藏的内置包 `animaquill/eval-directive`：工具集 2026.1 的旧写法，用来在真模型上和现在的写法比较。它是代码里做的包（要改排版，`aq_edit` 的说明也超过 4000），不参与自动匹配，在设置里勾了“显示对照用的旧写法”才列出来，只有为某个模型选它才用。`pack.json` 没有“隐藏”这个字段，别人的包也不能用 `animaquill/` 开头的 id，所以没有包能冒充它。

内置的 `animaquill/claude-5` 也是一个这样的包，只有调用设置：

```json
{
  "format": 1,
  "id": "animaquill/claude-5",
  "name": "Claude 5",
  "version": "1.0.0",
  "models": ["claude-fable-5*", "claude-mythos-5*", "claude-opus-5*", "claude-sonnet-5*", "claude-haiku-5*"],
  "call": { "reasoning": "medium", "maxOutputTokens": 32000, "anthropic": { "thinkingDisplay": "summarized" } },
  "variants": [{ "models": ["claude-fable-5*", "claude-mythos-5*"], "call": { "reasoning": "high" } }]
}
```

## 怎么测试自己的包

1. 在这个仓库里检查：

   ```
   pnpm --filter @animaquill/tools pack-check path/to/your-pack
   ```

   它做和编辑器安装时一样的检查，另外把每个例子在示例项目（`packages/schema/fixtures/v1`，例子里的 ID 用它的）上试运行一遍，再列出要留意的字句，以及合上默认写法以后系统提示和工具清单各有多长、每个模型用什么调用设置。`--keys` 列出全部能写的键和默认的写法。

2. 在编辑器里装上，看安装对话框里每一处改动是不是你想的那样；装好后在设置里为你的模型选它，新开一个对话试。对话开头写着这次用的是哪个包。

3. 比较两个包好不好，要在真模型上用同一套任务各跑几次，比成功率、花费和出错次数，不能只看一两次对话。
