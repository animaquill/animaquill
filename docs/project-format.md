# 项目格式

版本 1。这份说明和 [JSON Schema](../packages/schema/json-schema/) 都是公开的，其他工具和 AI 工具可以直接读写项目。完整的示例在 [packages/schema/fixtures/v1](../packages/schema/fixtures/v1/)。

## 目录结构

项目是一个普通文件夹。有 `animaquill.json` 的文件夹就是项目。

```
animaquill.json                    项目信息：语言、画幅、时间轴、字体、标签
assets.json                        项目用到的所有素材文件
libraries.json                     关联的素材库和经验库
libraries.lock.json                每个库固定的存档
notes.json                         批注
timelines/<id>/timeline.json       时间轴的母版
timelines/<id>/overrides/          语言和画幅的差异
scenes/<id>/scene.json             场景：真实的 HTML、CSS、SVG 和 JavaScript
sounds/<id>/sound.json             声音：用代码生成的音效和音乐
music/<id>.json                    音符形式的音乐，格式待定
code/                              场景和声音共用的代码
locales/<语言>.json                字符串表
assets/                            素材文件
.animaquill/                       本机内容，不进 Git
```

其他文件编辑器不管，也不会改动，比如 `AGENTS.md`、`README.md` 和制作笔记。

## 通用规则

**规范写法。** 同样的内容总是写成同样的文本：字段顺序固定，映射按键排序，片段按时间排序，小对象写在一行。所以保存不会改动没变的内容，Git 差异只显示真实的改动。

**严格校验。** 文件里出现未定义的字段、写错的属性名或不可能的值，这个文件就不能进入项目，错误里写明位置。这样手写或 AI 写的错误能马上发现。

**ID。** 所有对象都有稳定的 ID，只能用英文字母、数字、下划线和连字符。时间轴、场景和声音的 ID 就是文件夹名。

**时间。** 单位是秒，写成字符串，这样是精确值。能在九位小数内精确表示时写小数，否则写分数：

```json
{ "start": "12.5", "duration": "1001/30000" }
```

帧率同样写成字符串，比如 `"30"` 或 `"30000/1001"`。

**位置和大小。** 用画面的比例，不用像素，所以同一个值在所有画幅下都成立。

**路径和地址。** 路径是项目内的相对路径，不能用 `..`。网络地址只能用 https。

**插件。** 内置名称不带点。插件提供的内容类型、效果和转场带点，比如 `plugin.lottie`。没有安装插件时内容原样保留。

## animaquill.json

```json
{
  "formatVersion": 1,
  "id": "atoms-demo",
  "name": "原子是什么",
  "languages": [{ "id": "zh-CN", "name": "中文" }, { "id": "en", "name": "English" }],
  "formats": [{ "id": "landscape", "name": "横屏", "width": 1920, "height": 1080, "fps": "30" }],
  "timelines": ["main"]
}
```

`languages` 和 `formats` 的第一项是母版。`timelines` 的第一项默认打开。此外还有 `description`、`fonts`、`tags`、`cover` 和 `credits`。

带 `locked` 的标签表示项目不可编辑，用户和 AI 都不能改，直到标签被移除。

## 时间轴

```json
{
  "name": "主线",
  "sections": [{ "id": "section_intro", "name": "片头", "duration": "5" }],
  "markers": [{ "id": "marker_hook", "time": "0.342", "name": "钩子", "note": "第一句话抓住观众" }],
  "tracks": []
}
```

时间轴的长度是所有段落时长的和，没有单独的字段。段落的时长可以按语言变化，后面的段落自动后移，所以至少要有一个段落。

`beatGrid` 是节拍线，`mix` 是总线和主输出。

### 轨道

`kind` 是 `video`、`audio` 或 `caption`。第一条轨道在画面最下层。

音频轨道可以写 `role`（`voice`、`music`、`effects`）、`properties`、`effects`、`sends` 和 `output`。片段在音频轨道上可以重叠，声音会混在一起。在其他轨道上重叠会列入问题。

### 片段

```json
{
  "id": "clip_title",
  "name": "标题",
  "start": "0",
  "duration": "5",
  "source": { "kind": "scene", "scene": "title" },
  "properties": { "opacity": 1 }
}
```

`start` 是母版时间轴上的时刻。时间都是精确值，不依赖帧率。

项目的 `fps` 是剪辑帧率：标尺按它计数，拖动的落点在它的帧上，不写时用第一个画幅的帧率。每个画幅的 `fps` 是导出帧率，可以和项目不同，导出时按时间取样。

片段有自己的时钟：第一帧时读数是 `offset`（默认 0），之后和时间轴同速走。关键帧和字幕里每个词的时间都是这个时钟的读数，所以移动、裁剪和切割片段都不用改它们，裁掉的部分裁回来时关键帧还在。切割后两半都保留全部关键帧。

没有 `time.speed` 时，时钟的读数就是素材里的时间，`offset` 就是从素材的哪里开始。有 `time.speed` 时，素材里的时间是速度从时钟 0 到当前读数的累积。

同一条轨道上的片段不重叠。命令默认拒绝重叠，也可以要求覆盖，这时被盖住的部分会被裁掉或删除。多人同时修改时仍然可能产生重叠，这不算文件错误，开始得晚的片段显示在上面。

时间轴的长度是所有段落时长之和。片段放到结尾之后时，最后一个段落会自动变长。

其他字段：

| 字段 | 含义 |
| --- | --- |
| `loop` | 素材放完后重复，直到片段结束 |
| `fadeIn`、`fadeOut` | 淡入淡出的时长 |
| `hidden` | 不显示。版本可以单独改变它 |
| `draft` | 样片，只用来看想法，不进成片 |
| `link` | `link` 相同的片段一起移动，比如视频的画面和声音 |
| `sectionFit` | 段落变长时：`stretch` 按比例伸缩，`hold` 末尾定格，`span` 跨段落连续 |
| `effects` | 效果，每个效果有自己的 `properties` |

### 片段的来源

| `kind` | 字段 | 内容 |
| --- | --- | --- |
| `video`、`image`、`audio` | `media` | 素材文件 |
| `scene` | `scene`，或 `library` 加 `resource` | 项目或库里的场景 |
| `sound` | `sound`，或 `library` 加 `resource`，可选 `output` | 代码生成的声音 |
| `music` | `music` | 音符形式的音乐 |
| `timeline` | `timeline` | 嵌套的时间轴，跟随外层的语言和画幅 |
| `color` | `color` | 纯色 |
| `caption` | `text`，可选 `words` | 字幕。`words` 给每个词一个时刻，用于逐字歌词 |

`media` 是 `{ "asset": "<id>" }`，或者库里的文件 `{ "library": "<id>", "path": "…" }`。文字可以直接写，也可以是字符串表的引用 `{ "string": "<键>" }`。

### 属性和关键帧

所有能动的东西都是属性，放在 `properties` 里。一个属性是一个值，或者一组关键帧：

```json
{
  "properties": {
    "param.size": 64,
    "opacity": {
      "keys": [
        { "time": "0", "value": 0, "interp": "bezier", "out": [0.42, 0] },
        { "time": "1/3", "value": 1, "in": [0.58, 1] }
      ],
      "after": "hold"
    }
  }
}
```

关键帧的时间是片段时钟的读数，见上一节。`interp` 是 `linear`、`bezier`、`hold`、`spring` 或 `preset`，描述到下一个关键帧的变化。`before` 和 `after` 是前后的延伸方式：`hold`、`loop`、`pingpong`、`continue`。`modifiers` 目前有带种子的 `noise`，种子是必填的，这样渲染结果可以重复。

内置属性：

| 属性 | 含义 |
| --- | --- |
| `transform.x`、`transform.y`、`transform.width`、`transform.height` | 位置和大小，画面的比例 |
| `transform.anchorX`、`transform.anchorY`、`transform.scale`、`transform.rotation` | 锚点、缩放、旋转（度） |
| `opacity` | 不透明度，0 到 1 |
| `fit` | `cover`、`contain`、`fixed` |
| `blend` | 混合模式 |
| `crop.left`、`crop.top`、`crop.right`、`crop.bottom` | 裁切，比例 |
| `time.speed` | 播放速度。打关键帧就是变速 |
| `audio.volume` | 音量，分贝，0 是原音量 |
| `audio.pan` | 声像，-1 到 1 |
| `audio.pitch`、`audio.preservePitch` | 移调（半音）、变速时保持音高 |

其他属性来自片段的内容：`param.<名称>` 是场景参数，`object.<名称>.<值>` 是代码登记的对象，`element.<ID>.<属性>` 是 HTML 和 SVG 元素，`caption.<名称>` 是字幕样式。

## 差异

版本不是副本，而是母版加差异。差异文件放在 `timelines/<id>/overrides/`，文件名由范围决定：

| 文件 | 范围 |
| --- | --- |
| `language.en.json` | 一种语言 |
| `format.vertical.json` | 一种画幅 |
| `version.en.vertical.json` | 一个版本 |

```json
{
  "scope": { "language": "en" },
  "sections": { "section_body": { "duration": { "value": "26", "base": "20" } } },
  "clips": {
    "clip_title": { "properties": { "param.size": { "value": 48, "base": 64 } } }
  }
}
```

`value` 是这个范围的值，`base` 是记录差异时母版的值。母版后来变了，就能发现这个差异要确认。

取值顺序是：版本、画幅、语言、母版，找到就停。

差异只能改已有的对象，不能增加。只在某个版本出现的片段，在母版里设 `hidden`，再在差异里取消。

## 场景和声音

```json
{
  "name": "标题卡",
  "entry": "index.html",
  "runtime": 1,
  "params": [{ "id": "size", "name": "字号", "type": "number", "default": 64, "min": 12, "max": 200 }]
}
```

场景的文件夹里是真实的代码，`entry` 是入口，要是 `.html`、`.js` 或 `.mjs` 文件。代码直接运行，不经过编译，所以用 JavaScript，不用 TypeScript。`runtime` 是这段代码面向的运行时接口版本，新版编辑器会继续支持旧接口，所以旧项目的渲染结果不变。

参数的 `type` 是 `text`、`number`、`color`、`boolean`、`choice` 或 `asset`。片段用 `param.<id>` 赋值，版本差异只能覆盖这些参数，不直接改场景代码。

声音和场景一样，放在 `sounds/`，代码生成音频。`outputs` 列出一段程序能产生的多个声音。

场景和声音的代码可以共用 `code/` 里的模块。场景在沙箱里运行，不能联网。

## 素材

```json
{
  "assets": {
    "interview": {
      "kind": "video",
      "path": "assets/interview.mp4",
      "storage": "lfs",
      "hash": "sha256-…",
      "info": { "duration": "12.5", "width": 1920, "height": 1080 }
    }
  }
}
```

片段通过 ID 引用素材，所以文件改名不会断。`storage` 说明文件在哪：`git` 和 `lfs` 随仓库走，`local` 只在一台电脑上，`remote` 在用户的对象存储里（要写 `url`）。`license` 和 `credit` 用来导出署名清单。

## 字符串表

```json
{
  "strings": {
    "intro.title": { "text": "What is an atom", "base": "原子是什么" }
  }
}
```

`base` 是翻译时母版的文字。它和现在的母版不同时，这条翻译要更新。

## 库

`libraries.json` 声明依赖，`libraries.lock.json` 固定具体存档，这样库更新不会悄悄改变已有的成片。

## 批注

`notes.json` 保存批注，跟项目一起存档，不进成片。

## 校验和问题

校验分两层：

- **错误：** 文件不符合格式，这个文件不能用。其他文件不受影响。没有可用的 `animaquill.json` 时项目打不开。
- **问题：** 引用的东西不存在，比如素材没了、库没关联、翻译缺失、差异指向已删除的片段。项目照常打开，问题列出来等人处理。

读不出来的文件不会被写回，所以不会用空内容覆盖还能修的文件。

## 版本和迁移

`formatVersion` 是整个项目的格式版本。任何格式改动都会提高版本号，并提供迁移：

- 打开旧版本项目时先升级，升级不改原文件，由用户确认后才写入。
- 新格式的项目不能用旧版编辑器打开，避免丢掉旧版不认识的内容。

`packages/schema/fixtures/` 保留了每个版本的示例项目，从不修改，自动测试保证它们一直能打开。
