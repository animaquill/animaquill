# 场景运行时

版本 1，也就是 `scene.json` 里的 `"runtime": 1`。这份说明写场景代码能依赖什么，不能依赖什么。场景的文件怎么放，见[项目格式](project-format.md)。

## 场景在哪里跑

每个场景是一个独立的页面，放在沙箱里：没有存储，碰不到外面的页面，普通的网络请求全部被挡，被挡的请求会列进问题选项卡。

场景的视口就是片段框，1 世界单位是 1 CSS 像素。成片分辨率场景看不到：页面按片段框排版，画面按成片的像素绘制，所以文字在任何分辨率下都清晰。片段的移动、缩放、旋转和不透明度都在画面之外完成，场景不用管。

片段框的大小在片段开始时定下。宽高打了关键帧时，画面按开始时的大小排版，再拉伸到每一刻的框里。改了宽高的值，保存后场景会重新打开。拖动和试改时画面只是拉伸，排版还按保存的大小，这样对比和放弃都不用重开场景。

播放时场景按时间轴自己往前走，每走到一帧就绘制一次。绘制跟不上时跳过中间的帧，但 `requestAnimationFrame`、定时器这些有状态的代码仍然逐帧执行，所以结果和不跳帧时相同。

## `aq`

| 接口 | 含义 |
| --- | --- |
| `aq.runtime` | 运行时接口版本 |
| `aq.view` | `width`、`height`、`pixelRatio`、`format`、`language` |
| `aq.asset(id)` | 素材的地址。只有这个场景用到的素材才有，没有时返回空地址，并列进问题选项卡。编辑器从代码里找用到的素材，所以 `id` 要写成字面量，比如 `aq.asset("logo")`。`asset` 类型参数的默认值也算用到。这样用到的素材不能删除，要先改掉代码 |
| `aq.frame(callback)` | 注册帧回调，返回取消注册的函数 |
| `aq.object(id, options)` | 登记一个能打关键帧的对象，见下面[可以打关键帧的对象](#可以打关键帧的对象) |
| `aq.param(id, seconds?)` | 参数在这一刻的值：片段的值或关键帧，没有时是 `scene.json` 里的 `default`。不写 `seconds` 是现在 |

页面上同时有 `lang`、`data-format`，以及 CSS 变量 `--aq-width`、`--aq-height`、`--aq-pixel-ratio`。

## 可以打关键帧的对象

场景里能动的东西有三种来源，都进编辑器的属性树，用同一套关键帧。关键帧存在片段上，不写进代码，所以改关键帧不用改场景代码，同一个场景放两次，两个片段有各自的关键帧。

| 来源 | 属性路径 | 怎么进属性树 |
| --- | --- | --- |
| 参数 | `param.<id>` | `scene.json` 里声明 |
| 页面元素 | `element.<id>.<属性>` | 有 `id` 的元素自动列出 |
| 代码对象 | `object.<对象>.<属性>` | 代码用 `aq.object` 登记 |

值都是这一帧的：编辑器把曲线一次交给场景，场景自己在每一帧求值，不用每帧传值。拖动和试改的值也会到场景里。场景停着的时候值变了，运行时会重新走到这一帧，`aq.frame` 的回调再跑一次，然后重新画。用 `requestAnimationFrame` 画的内容要等播放头动了才更新。

### 代码对象

```js
const arm = aq.object("arm", {
  name: "手臂",
  properties: {
    x: { type: "number", unit: "world", default: 0, group: "position" },
    y: { type: "number", unit: "world", default: 0, group: "position" },
    rotation: { type: "angle", default: 0, min: -180, max: 180 },
    tint: { type: "color", default: "#ffffff" },
    visible: true,
  },
});

aq.frame((seconds) => {
  const { x, y, rotation, tint } = arm.at(seconds);
  draw(x, y, rotation, tint);
});
```

- 第一个参数是稳定 ID，只能用英文字母、数字、下划线和连字符，可以用点分出层级，比如 `rig.arm_l`。中文名字写在 `name` 里。属性路径是 `object.<ID>.<属性>`，所以改了 ID，旧的关键帧就没有对象认领了，见下面[改名](#改名)。
- 属性的名字只能是一段 ID，不能有点。
- `type` 是 `number`、`angle`、`boolean`、`choice`、`text`、`asset`、`color`、`vec2`、`vec3`、`vec4` 或 `numbers`。`choice` 要写 `options`。只写一个值是简写：`visible: true` 等于 `{ type: "boolean", default: true }`，类型按值推断，`"#ff0000"` 这样的字符串是颜色，两到四个数字的数组是向量。
- 其他字段：`default`、`min`、`max`、`softMin`、`softMax`（拖动时的建议范围）、`unit`（`world`、`deg`、`ratio` 这类）、`name`、`group`（一层分组）、`components`（向量每个分量的名字，默认 `x`、`y`、`z`、`w`）、`animatable: false`（不能打关键帧）、`aliases`（改名前的名字）。
- 对象的字段：`name`、`parent`（属性树里的父对象，只决定显示位置，换父级不改路径）、`spans`（在片段时钟上存在的时间段，比如 `[[0, 2], [5, 8]]`，单位秒）、`presence`（对象自己的一个开关或数字属性，为真或大于 0 时才算存在）、`aliases`（改名前的 ID）。`spans` 和 `presence` 只影响属性树默认列出什么。
- `arm.at(seconds)` 返回这一刻全部属性的值，关键帧已经算进去。不写 `seconds` 是现在。每次返回同一个对象，下次调用会改它的值。
- 同一个 ID 再登记一次，描述一样时什么都不变，可以在 `aq.frame` 里调用；描述不一样时换成新的。
- 坐标用场景坐标：原点在片段框中心，y 向下，单位是世界单位，所以横屏竖屏用同一份关键帧。
- 登记的内容是普通数据，编辑器会检查：ID 和属性名不合规、类型写错、默认值和类型对不上的，那一项不生效，并列进问题选项卡，能定位到调用 `aq.object` 的那一行。值的类型和登记的不一样时用默认值，也列进问题选项卡。最多 2000 个对象、一共 10000 个属性、每个对象 256 个属性。

### 参数

```js
aq.frame((seconds) => {
  title.textContent = aq.param("title", seconds);
  title.style.fontSize = `${aq.param("size", seconds)}px`;
});
```

参数在 `scene.json` 里声明，片段用 `param.<id>` 赋值或打关键帧。ID 只能用英文字母、数字、下划线和连字符，否则片段不能给它赋值，问题选项卡里有提示。场景打开时就能读到片段的值。只在打开时读一次的参数，之后的修改和关键帧不会显示，问题选项卡里会提示，要在 `aq.frame` 里读。`asset` 参数的值是 `{ "asset": "<id>" }`，文字参数可能是字符串表的引用 `{ "string": "<键>" }`，都原样返回。

### 页面元素

有 `id` 的元素自动进属性树，`id` 要是一段 ID：英文字母、数字、下划线和连字符，不能有点。

| 属性 | HTML 元素 | SVG 元素 | 写到哪里 |
| --- | --- | --- | --- |
| `x`、`y` | 有 | 有 | CSS `translate`，相对元素原来的位置，世界单位 |
| `scale` | 有 | 有 | CSS `scale` |
| `rotation` | 有 | 有 | CSS `rotate`，度 |
| `opacity` | 有 | 有 | CSS `opacity` |
| `blur` | 有 | 没有 | CSS `filter: blur()`，世界单位 |
| `color`、`background` | 有 | 没有 | CSS `color`、`background-color` |
| `fill`、`stroke` | 没有 | 有 | CSS `fill`、`stroke` |

- 没有值时元素保持页面里的样子。有值时写成元素自己的样式，带 `!important`，所以压过样式表、CSS 动画和代码里不带 `!important` 的写法。值都在 `aq.frame` 的回调之后写上去。
- `translate`、`rotate`、`scale` 是单独的 CSS 属性，和元素自己的 `transform` 叠加，不会替换它。但会替换元素自己的 `translate`、`rotate`、`scale`，`blur` 会替换元素自己的 `filter`。
- 旋转和缩放绕元素中心。SVG 元素默认绕画布原点，所以运行时给它加上 `transform-box: fill-box` 和 `transform-origin: center`，元素自己写了的不动。
- 行内元素（比如 `<span>`）不能移动、旋转和缩放，问题选项卡里有提示，给它加上 `display: inline-block`。
- 编辑器列出场景打开时页面上的元素，最多 1000 个。代码后来加的元素，片段给它设了值以后也会列出。

### 改名

改了对象或属性的 ID，旧的关键帧还在片段上，但没有对象认领，不起作用。它们放在关键帧编辑器的“未连接”组里，也列进问题选项卡，可以连接到别的属性，也可以删除。任何时候编辑器都不会自己删除或改写它们。

在代码里写 `aliases`，旧的关键帧就照样生效：

```js
aq.object("arm_l", {
  aliases: ["arm"],
  properties: { angle: { type: "angle", aliases: ["rotation"] } },
});
```

`object.arm.rotation` 上的关键帧会给 `arm_l` 的 `angle` 用。这时问题选项卡里有“迁移”，点了把关键帧移到新路径上，是一步，可以撤销。AI 用 `property.rename` 命令做同样的事，可以一次改整个对象，比如 `object.arm.*` 换成 `object.arm_l.*`，还可以带单位换算。

场景报错没有跑完时，编辑器不知道它还会登记什么，这时代码对象和元素上没人认领的关键帧放在“未运行”组里，不算没有对象认领。

## 时间

场景里的时间由时间轴决定，按帧走，不走真实时钟。场景打开时停在 0 时刻。同一个项目、同一帧，结果总是相同。

这些都跟着时间轴：

- CSS 动画、CSS 过渡、Web Animations，包括 `finished`、`finish` 事件和 `play`、`pause` 这些操作。shadow DOM 里的一样，不管是代码建的还是页面里写的，`adoptedStyleSheets` 里的也一样
- SMIL
- `requestAnimationFrame`、`setTimeout`、`setInterval`、`requestIdleCallback`、`AbortSignal.timeout`、`scheduler.postTask`
- `Date`、`performance.now`、`performance.timeOrigin`、`performance.mark`、`performance.measure`、`performance.timing`、`document.lastModified`、`document.timeline`、`Event.timeStamp`、`Temporal.Now`、`Intl.DateTimeFormat` 的默认时刻
- `Math.random`、`crypto.getRandomValues`、`crypto.randomUUID`，种子固定

### 定位快不快

往后走时，用到定时器和 `requestAnimationFrame` 的代码逐帧执行，所以结果和实际播放时一样。

往前走时分两种：

| 代码 | 往前走 |
| --- | --- |
| 只有 CSS、Web Animations、SMIL、`aq.frame` | 直接到位，任意顺序 |
| 目标帧之后跑过定时器或 `requestAnimationFrame` | 重开场景，从头走到目标帧，这段时间先留着旧画面 |

运行时看不出 `requestAnimationFrame` 里的代码是不是只看时刻，所以都按第二种处理。结果是对的，只是往回拖时慢一些。只依赖时刻的绘制写进 `aq.frame`，就能任意定位：

```js
aq.frame((seconds) => {
  draw(seconds);
});
```

回调必须是同步的，只能依赖传进来的时刻。它可能跳着执行、重复执行。里面的 `Math.random()` 每帧结果固定，同一帧重复执行时得到同样的数字。

### 图片和字体

到达一帧之前，运行时等这一帧的图片和字体就绪，图片还要解码完。最多等三秒，超时后继续，并提示 `content-timeout`。

`loading="lazy"` 不起作用，所有图片都立即加载：场景里没有人滚动，懒加载的图片可能永远不会出现。

## 做不到确定的事

下面这些运行时管不到。用了它们的场景，结果可能因机器或每次运行而不同。

| 内容 | 情况 |
| --- | --- |
| 本地时间和语言 | 场景的“现在”是固定的时刻，但 `getHours()`、`toLocaleString()`、`navigator.language`、`Intl` 的默认语言跟着这台机器走。要固定就写明时区和语言，比如 `{ timeZone: "UTC" }` |
| `<video>`、`<audio>`、Web Audio | 按真实时间走，不跟时间轴 |
| GIF、APNG、作为图片引入的动画 SVG | 按真实时间走 |
| 运行中改 `animation-play-state` | 不起作用。一开始就是 `paused` 的动画保持不动 |
| `PerformanceObserver` | 给的是真实时间 |
| `crypto.subtle` 生成的密钥 | 每次不同 |
| 项目自己开的 `<iframe>` | 里面有自己真实的时钟 |
| Paint Worklet、Audio Worklet | 运行时进不去，里面的 `Date`、`Math.random` 都是真实的。用了时问题选项卡里有提示 `worklet` |
| 主线程上等时间的循环 | 比如 `while (Date.now() < end)`：时钟不走，循环不结束，场景会被当成卡死 |

**Worker 只有一部分确定。** Worker 里的 `Date`、`performance`、`Event.timeStamp`、`Math.random`、`crypto`、定时器和 `requestAnimationFrame` 有自己的一套时钟，所以 Worker 内部每次做的事相同，不管是文件 Worker、代码生成的 Blob Worker，还是 Worker 里再开的 Worker。但它的消息什么时候到达场景，是真实时间，运行时控制不了，这个时钟也和时间轴无关。靠 Worker 的结果决定画面的场景，每次运行可能不同。用了 Worker 时问题选项卡里有提示 `worker-timing`。`SharedWorker` 不能用，沙箱里的页面没有来源。

同样，时间往前走时，运行时等读文件、动态导入这类事最多等一秒，超时后不再等，同时提示 `slow-work`。

## 改了代码之后

保存后场景换新：新场景在旁边打开，走到当前时刻，有画面后才接管，播放头不动，这段时间旧画面一直在。

新代码解析不了（`SyntaxError`）时不接管：画面停在上一个能用的版本，错误列进问题选项卡，能跳到那一行。代码跑起来才报错的场景照常接管，因为它可能只坏了一小部分。第一次打开就解析不了的场景没有上一版可用，能跑多少跑多少。

## 限制

- 场景不能给外面的页面写消息。写得太多、单条太大时，场景会被移除，不会重试。
- 场景收不到键盘和鼠标，编辑器的键盘也不能拿走。`focus()` 不起作用，并列进问题选项卡。其他方式抢走焦点时，编辑器会拿回来，反复抢的场景会被移除，不会重试。
- 卡死的场景会被重开，连续三次后不再运行，等用户手动重试。
- 卡死的进程可能在框架移除后还留很久，所以卡死过、被移除过的站点这次打开不再使用。全部用完后场景不再运行，要刷新页面。
- 定位时一直没有进展的场景按卡死处理。一直在走、只是走得慢的场景不算。
- 没有闭合的 `<script>` 不运行，并列进问题选项卡。
- `showModal`、popover 和全屏捕获不到，会列进问题选项卡。
- 页面里的 `<canvas>`，包括 WebGL，单独合成：按它的位置、大小和不透明度画在 HTML 上面，所以它上面的 HTML 会被盖住，作用在它身上的 CSS 滤镜、混合模式和 3D 变换不起作用，旋转也不算。用了时列进问题选项卡。WebGL 的 `preserveDrawingBuffer` 总是打开。
- 发给合成器的画面大小不对，或者多到屏幕来不及显示，场景会被移除，不会重试。
- 场景的文件夹只放文本，图片、字体这些放进素材，用 `aq.asset(id)`。
- 场景拿到的是它自己的文件夹、`code/` 和它用到的素材。别的场景的文件它拿不到。
- 写给比这个编辑器更新的运行时版本的场景不运行，预览里显示占位。
- 地址要在页面、样式表和脚本里写成项目里的路径。代码拼出来的 CSS `url()`、`innerHTML` 里的相对路径改写不到，会被挡，并列进问题选项卡。素材用 `aq.asset(id)`。
- `history.pushState` 不生效，`history.back` 这类操作也不做事。`location.hash` 改了会进标签页的历史记录，不要用。

## 声音

声音的代码和场景用同一个运行时版本（`sound.json` 里的 `runtime`），也在沙箱里，但没有页面：入口是一个 ES 模块，跑在 Worker 里，没有 `document`，也不会给时间轴的每一帧运行。它只运行一次，算出整段声音。

```js
aq.sound(({ duration, frames, sampleRate, seed, params, output }) => {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    samples[at] = 0.5 * Math.sin((2 * Math.PI * 440 * at) / sampleRate);
  }
  return samples;
});
```

| 接口 | 含义 |
| --- | --- |
| `aq.runtime` | 运行时接口版本 |
| `aq.sound(callback)` | 登记生成声音的函数，模块运行完后调用一次。多次调用时用最后一个。回调可以是 `async` |

回调拿到的内容：

| 字段 | 含义 |
| --- | --- |
| `duration` | 要多长，秒 |
| `frames` | 每个声道多少个样本，就是 `duration × sampleRate` 取整 |
| `sampleRate` | 每秒多少个样本。现在总是 48000，代码不要写死 |
| `seed` | `param.seed`，整数 |
| `params` | 全部 `param.<id>` 的值，`duration` 和 `seed` 也在里面 |
| `output` | 片段选的输出，没有时是 `undefined` |

返回一个 `Float32Array` 是单声道，返回两个一样长的 `Float32Array` 组成的数组是立体声，第一个是左声道。比 `frames` 短没关系，后面是静音。比 `frames` 长、声道多于两个、数组类型不对都算失败。样本在 -1 到 1 之间，超出的部分被削掉，不是数字的样本算 0。

### 确定性

同样的代码、参数、种子、采样率和时长，算出来的样本相同。`Math.random`、`crypto.getRandomValues`、`crypto.randomUUID` 来自种子，`Date`、`performance.now` 这些是固定的时钟，定时器按这个时钟走。

结果按这些内容存起来，刷新后不重算。项目里不再用到的结果，超过 7 天没用过，或者全部结果超过 500 MB 时，在打开项目时清掉，最久没用的先清。导入的素材不会被清。`sounds/<id>/` 或 `code/` 里任何文件变了都算新的声音。跨浏览器时 `Math.sin` 这类函数的最后几位可能不同，运行时管不到。

### 限制

- 能读到的文件是自己的文件夹和 `code/`。不能用素材，`aq.asset` 不存在。
- 代码最多运行 60 秒，超时被停止。死循环只占一个 CPU 核，影响不到编辑器和播放。
- 声音最长 300 秒。
- 向外发太多消息的代码会被停止。
- 没算好的声音不挡播放：片段上显示状态，时间照常走，算好后从当时的位置响起来。
- 失败的声音不自动重试。属性选项卡和片段的右键菜单里有“重试”，改代码或者刷新页面也会再算一次。
