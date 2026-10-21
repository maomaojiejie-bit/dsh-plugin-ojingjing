# standalone-cs —— C# + WebView2 独立窗（当前默认外壳）

哦鲸鲸的桌面常驻窗，用 C# + 系统自带的 WebView2 写成。取代了 `standalone-py/`（Python + PySide6），
解决它的两个硬伤：体积 329 MB、帧率被 Qt 压在 60。

| | Python 版（PySide6，已退役） | 本版（WebView2） |
| --- | --- | --- |
| 体积 | 329 MB（PyInstaller onedir） | **1.17 MB**（exe 291 KB 含内嵌页面 + 三个 DLL） |
| 帧率 | 60 fps（Qt 自己压着） | **240 fps**（跟屏幕刷新率走，这台屏就是 240Hz） |
| 单核占用 | 空闲 43% | 空闲约 25%（同一页面、折叠球状态实测） |
| 透明 | 软光栅逐像素透明 | `WS_EX_LAYERED` + `DefaultBackgroundColor = Transparent` |

页面是同一个 `/xj/app.html?embed=1&host=app`，所以动画和交互跟插件里的完全一致。

## 已经搬齐的功能

- 逐像素透明置顶窗、不进 Alt+Tab、拖拽换角、位置记忆（右下角锚定，展开时不会飘）
- 形态尺寸协商：变大立刻跟、**变小延迟 240ms**（不然 200ms 的收起动画会被窗口裁掉）
- 全局热键：`Ctrl+Shift+Space` 显隐、`Ctrl+Shift+A` 截图提问
- 截图提问：藏窗 240ms → 抓多屏 → 框选（默认整屏）→ 推给页面卡片 → 发送 / ✨优化
- 托盘菜单：显示隐藏、截图提问、设置、开机自启、打开 DSH、打开配置目录、退出
- 外壳设置窗：端口、两个热键、截图模式（整屏/框选）、高帧率、开机自启、DSH 关掉后退出、视觉模型
- 单实例（`Local\ojingjing-cs-shell` 互斥量）、首帧前不露黑块、**两段式探活**（先 TCP 监听 DSH、再 HTTP 确认在线）、DSH 没开时走内嵌页面（见下节）
- 指针信号桥：见下面「消息协议」里 `pointer`，用来修 WebView2 自己判错 `:hover` 导致的悬停抽搐

## 源码结构

四个 `OverlayForm.*.cs` 是同一个类的 partial 文件（字段只声明在 `OverlayForm.cs`）：

| 文件 | 职责 |
| --- | --- |
| `OverlayForm.cs` | 窗口骨架：样式、热键、显示时机（`Reveal`）、尺寸协商、位置记忆、拖拽、打开 DSH/链接 |
| `OverlayForm.Load.cs` | WebView2 初始化、两段式探活（TCP 监听 + HTTP 确认）、内置页面解包 + 虚拟主机 |
| `OverlayForm.Shot.cs` | 截图提问全流程（抓屏 → 框选 → 卡片 → 发送/优化） |
| `OverlayForm.Bridge.cs` | 页面消息分发、`PostWebMessageAsJson`、指针轮询、手写 JSON 小工具 |
| `Settings.cs` | 配置目录三级回退、`settings.json` / `window.json`、热键解析、日志 |
| `SettingsForm.cs` | 外壳设置窗 |
| `Capture.cs` / `ShotApi.cs` | 抓屏与框选窗口 / 挑会话 + `POST /xj/prompt` + 视觉模型「优化」 |
| `Native.cs` | Win32 导入（互斥量、窗口样式、热键、拖拽消息） |
| `Program.cs` | 入口：单实例互斥量 + 托盘 + DSH 退出跟随 |

## 页面加载与离线态（2026-10-21 重做）

**外壳自带一份完整页面**，所以 DSH 没开、插件没装也能用：不是自绘的占位卡，就是那个真面板。

1. **两段式探活，两个来源**（2026-10-21 老大：「通过监听服务器来确认 DSH 是否存活
   再一次判断哦鲸鲸的在线状态」）：
   - **① 监听服务器** —— 对 `127.0.0.1:<port>` 做一次 TCP 连接，**1 秒一拍**。DSH 进程一退，
     loopback 上立刻 `ECONNREFUSED`（亚毫秒），比 HTTP 超时判断快一个数量级；
   - **② 判断在线** —— 端口在听只说明 DSH 在跑，不代表插件页面部署好了（重装插件期间
     `app.html` 会 404）。所以再 `HttpWebRequest` GET 一次页面本体，**2xx 且正文里有
     `xj-stage`** 才算真在线（只看 2xx 会把本机那种「对任何路径都回 JSON 200」的网关
     当成插件服务器，导航过去直接白屏——踩过）。已经在服务器那版上时每 4 秒复核一次，
     没切过去时每拍都试。
   - **端口是哪来的**：`settings.Port` 只是猜的起点。DSH 的 web server 端口由 DSH 自己
     决定（插件只是往它上面 `ctx.webServer.register` 挂路由），换版本 / 改配置都会变，
     写死一个数字一旦对不上就永远探不到（老大报的「还是不能监听」）。所以连不上就
     `DiscoverPort()`：枚举本机所有 loopback 监听端口，12 路线程 + 硬截止 2 秒，
     TCP 80ms / HTTP 600ms 超时，先用 `Content-Type` 一刀切掉 API 服务，命中的端口
     写回 `settings.json`（下次启动直接命中）。**别用 `Parallel.ForEach`**——76 个端口
     一起阻塞会把线程池饿死，实测直接不返回；也别忘了设 `stream.ReadTimeout`，
     遇到只发 header 不给 body 的服务会挂死。
   - 找不到服务器时按 2s → 5s → 8s 退避，别每 3 秒扫一遍 70 多个端口。
   - 2xx → 导航插件服务器（真数据）；取不到 → 导航**内置副本**。不直接盲导航是因为失败要
     ~2.2s 才回 `NavigationCompleted`，中间闪的是 Chromium 自己的 `ERR_CONNECTION_REFUSED` 错误页。
2. **内置副本从哪来**：`tools/build-shell-cs.mjs` 构建时把整个 `web/` 压成 `payload.zip`
   （手写 STORE/deflate，无第三方依赖）→ `csc /resource:` 嵌进 exe → 启动解到
   `<配置目录>\web\<版本-时间戳>\`（时间戳变了才重解）→
   `SetVirtualHostNameToFolderMapping("ojingjing.local", webRoot, Allow)` →
   导航 `https://ojingjing.local/xj/app.html?embed=1&host=app`。
   **不能用 `file://`**：那种来源下 `fetch`、`localStorage` 都是不透明源，页面刚启动就炸；
   虚拟主机是正经 https，`app.html` 里的 `/xj/...` 绝对路径一行都不用改。
3. **页面已经在，服务器挂了**：TCP 那拍失败就推一条 `{type:"connection",state:"offline"}`，
   **绝不覆盖已有页面**。前端切成黑白球 + 灰虚线环，服务器回来再推 `online` 切回去，
   不用重启（`OnNavDone` 里必须把 `probeTimer` 拉回来——导航期间它是停着的）。
4. **窗口外形按「多块」裁**：窗口是「不透明 + `SetWindowRgn`」（分层窗口的命中区不跟尺寸，
   面板按钮会点不到）。页面每块 `.form` 各报一个矩形（`{type:"card",rects:[…]}`，
   **物理像素**，页面已乘 `devicePixelRatio`），外壳逐块建圆角矩形 / 小球椭圆，
   用 `CombineRgn(RGN_OR)` 并成复合区域。只按一个外接矩形裁的话，气泡和鲸鱼球之间那片空隙
   会透出窗体深底，看起来就是「一大块黑色背景」——2026-10-21 老大报的就是它。
   - **球类只外扩 1px**。以前写「外扩 10px 包 box-shadow 光晕」是错的：那 10px 在页面里
     完全透明，透出来的是窗体深底 `#0d1320`，等于给球套一圈脏兮兮的深色毛边，边界再从
     深色硬切到桌面，锯齿被放大一倍（老大：「窗口边缘太粗糙了」）。光晕本来就投在这层
     深底上、本来就看不见，切掉不亏。
   - **探出的角标单独报一块**：`.badges .badge`（待确认琥珀 / 未读绿）绝对定位在球外面，
     form 的 rect 量不到，只按球的椭圆裁会把角标切掉一半。
   - **状态光环（`.aura`）要算进去**：`inset:-3px` + 2px 的 `box-shadow` spread / border，
     视觉外沿在球外 5px；它在转，`getBoundingClientRect` 对旋转元素返回轴对齐外接框
     （70px 的环能报 90 多），所以页面按 CSS 里的 inset + 2 直接把矩形撑出去。
     不撑的话离线灰虚线环整圈消失。
   - `SetWindowRgn` 是二值掩码，**没有抗锯齿**，球/圆角的弧线上一定有 1px 台阶——
     这是这条技术路线的固有代价，要真正平滑只能换 CompositionController 视觉托管
     （per-pixel alpha，得自己接 DirectComposition + 转发所有输入），不是小改。
5. **离线时也能用**：内置副本就是完整页面，双击球照样展开面板、翻设置、看陪伴时长，
   只是没有会话数据。窗口尺寸/裁剪全由页面自己协商，外壳不再有「离线态」这个分支。

## 构建与运行

```bat
node tools\build-shell-cs.mjs          :: 用系统 csc.exe 编译，产物在 dist\Ojingjing-CS\
dist\Ojingjing-CS\Ojingjing.exe
```

`standalone-cs/icon.ico` 由 `python tools\make-ico.py` 从 `assets/icon-source.png`
生成（16–256 六档），构建时经 csc 的 `/win32icon` 烧进 exe——Explorer、任务栏、
托盘（`Icon.ExtractAssociatedIcon`）都认它。换角色图后重跑这两条即可。

编译器是 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，**只支持 C# 5**：
别写字符串插值、`?.`、`Environment.ProcessId`，`TextBox.PlaceholderText`（.NET 5+）也不能用。

`sdk/` 里三个 DLL 来自 NuGet 包 `Microsoft.Web.WebView2` 的 `lib\net462\` 与 `runtimes\win-x64\native\`，
构建脚本会拷到产物目录；这个目录不入库（见 `.gitignore`），换机器要重新下一个（约 9 MB）。

编译前先关掉正在跑的实例，否则删 `dist\Ojingjing-CS` 会报 EPERM。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `XJ_DEBUG_PORT` | 开 CDP 调试端口（`node tools\dev\cdp-eval.mjs <端口> "<js>"`），同时打开 DevTools |
| `XJ_NO_LAYERED=1` | 关掉 `WS_EX_LAYERED`（压测用：验证高 CPU 不是透明造成的） |
| `XJ_NO_SELECT=1` | 截图跳过交互框选，直接用默认选区（无头验证用） |

## 配置与位置

`%APPDATA%\ojingjing\` 写不进去时（本机实测自家 exe 也会被安全软件拦写），自动退到
`%LOCALAPPDATA%\ojingjing\`，再退到程序目录的 `data\`。里面：

- `settings.json`：端口、两个热键、`capture_mode`、`highFps`、`autostart`、`exit_with_dsh`、`vision{...}`
- `window.json`：收起态鲸鱼球的左上角（与 Python 版共用同一个文件）
- `webview2\`：WebView2 自己的用户数据目录（缓存，几百 MB 级别，可随时删）
- `ojingjing-cs.log`：外壳日志（启动、加载、重试、热键、截图、指针）

## 页面 ↔ 外壳 消息协议

页面 → 外壳（`window.chrome.webview.postMessage`，见 `web/embed.js` 的 `post()`）：

| 消息 | 作用 |
| --- | --- |
| `{type:"resize", w, h}` | 形态变了报尺寸（外壳右下角锚定缩放） |
| `{type:"drag"}` | 交给系统拖窗口（`ReleaseCapture` + `WM_NCLBUTTONDOWN`） |
| `{type:"open-dsh"}` / `{type:"open-url", url}`（只放行 https） / `{type:"quit"}` | 打开 DSH / 浏览器 / 退出 |
| `{type:"shot-capture"}` | 截一张 |
| `{type:"shot-action", action, text}` | `action` = `send` / `retake` / `polish` / `capture` |
| `{type:"settings"}` | 在外壳里弹设置窗 |

外壳 → 页面（`CoreWebView2.PostWebMessageAsJson`）：

| 消息 | 作用 |
| --- | --- |
| `{type:"pointer", inside}` | **每 200ms 轮询真实光标是否在窗口矩形里，变了才发；进立刻、出要稳 500ms** |
| `{type:"shot", dataUrl, width, height, sessionTitle}` | 截好图，页面弹卡片 |
| `{type:"shot-done", ok, message}` / `{type:"shot-polished", text}` / `{type:"shot-polish-failed", reason}` | 发送 / 优化结果 |

`pointer` 这条是修「鼠标移上去一直弹」的关键：WebView2 在自己被 resize 之后会把 CSS `:hover` 判错、
还会甩假 `mouseleave`，而悬停收起要是信 DOM 事件就会 展开 → 收 → 展开 地抽。外壳有真实光标坐标，
`app/src/app.js` 的 `bindHoverWatcher()` 优先信它。

两侧的容忍度是配合好的（改一边就得改另一边）：

- 外壳 `OverlayForm.Bridge.cs` 的 `OnPointerTick`：光标**进了**窗口立刻回报；**出去**先压 `POINTER_HOLD_MS = 500`。
  全屏/独占程序会每帧 `SetCursorPos` 抢光标，指针在窗口边上反复进出，立刻回报就会抽。
- 页面 `app.js` 的 `bindHoverWatcher()` + `hoverMissLimit()`：有外壳信号时 3 拍（≈600ms）才收，
  退回 CSS `:hover` 时给到 5 拍。实测指针每 120ms 翻一次时气泡稳 2.2s 不抖，稳定离开后 511ms 收起。

## 已知限制

- 全屏游戏抓住鼠标时（`ClipCursor`），光标到不了鲸鱼上，点击会落进游戏——**热键仍然可靠**，
  要拖位置就先 `Esc`/`Alt+Tab` 把游戏让开。
- 分层窗口不走 vsync，240Hz 屏上就是 240fps；想省电去设置里关掉「高帧率」。
- 点击穿透（透明区域不吃点击）还没做。
- WebView2 运行时靠系统自带（Win10/11 一般都有）；缺了会弹一次提示并退出。
