# 场景运行时

版本 1，也就是 `scene.json` 里的 `"runtime": 1`。这份说明写场景代码能依赖什么，不能依赖什么。场景的文件怎么放，见[项目格式](project-format.md)。

## 场景在哪里跑

每个场景是一个独立的页面，放在沙箱里：没有存储，碰不到外面的页面，普通的网络请求全部被挡，被挡的请求会列进问题选项卡。

场景的视口就是片段框，1 世界单位是 1 CSS 像素。成片分辨率场景看不到。

## `aq`

| 接口 | 含义 |
| --- | --- |
| `aq.runtime` | 运行时接口版本 |
| `aq.view` | `width`、`height`、`pixelRatio`、`format`、`language` |
| `aq.asset(id)` | 素材的地址。只有这个场景用到的素材才有，没有时返回空地址，并列进问题选项卡 |
| `aq.frame(callback)` | 注册帧回调，返回取消注册的函数 |

页面上同时有 `lang`、`data-format`，以及 CSS 变量 `--aq-width`、`--aq-height`、`--aq-pixel-ratio`。

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

## 限制

- 场景不能给外面的页面写消息。写得太多、单条太大时，场景会被移除，不会重试。
- 场景收不到键盘和鼠标，编辑器的键盘也不能拿走。`focus()` 不起作用，并列进问题选项卡。其他方式抢走焦点时，编辑器会拿回来，反复抢的场景会被移除，不会重试。
- 卡死的场景会被重开，连续三次后不再运行，等用户手动重试。
- 定位时一直没有进展的场景按卡死处理。一直在走、只是走得慢的场景不算。
- 没有闭合的 `<script>` 不运行，并列进问题选项卡。
- `showModal`、popover 和全屏捕获不到，会列进问题选项卡。
- 地址要在页面、样式表和脚本里写成项目里的路径。代码拼出来的 CSS `url()`、`innerHTML` 里的相对路径改写不到，会被挡，并列进问题选项卡。素材用 `aq.asset(id)`。
- `history.pushState` 不生效，`history.back` 这类操作也不做事。`location.hash` 改了会进标签页的历史记录，不要用。
