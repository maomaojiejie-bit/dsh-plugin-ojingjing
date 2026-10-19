# 哦鲸鲸 · 独立桌面窗（Python + PySide6 版）

和原型同一只鲸鱼、同一个页面，外壳是 **Python + PySide6（QtWebEngine）**（早期还有过一版 C# WPF，
因为要装 .NET SDK、改一次就得重新发布，已经删掉，只留这一版）。
不需要 .NET、不需要编译、也没有 pythonnet：透明、置顶、无边框都由 Qt 自己做。

```
┌─ 无边框窗口（逐像素透明，只看得到鲸鱼/气泡/面板）──────────┐
│  页面：http://127.0.0.1:43120/xj/app.html?embed=1&host=py
│  数据：DSH 插件 dsh-plugin-ojingjing 的 /xj/state、/xj/decide
│  桥：  QWebChannel → window.xjNative.resize / drag / open_dsh / quit
└────────────────────────────────────────────────────────────┘
```

## 前置

| 需要 | 说明 |
|---|---|
| Python 3.10+ 64 位 | 本机 3.12.10 验证 |
| **PySide6** | 包含 QtWebEngine，约 250–350MB；`pip install pyside6` |
| DSH 插件已装 | `node tools\install-plugin.mjs`，之后重启 DSH。页面内注入默认关闭，插件只提供 `/xj/*` 接口 |

## 双击启动

目录里有两个批处理，给不想碰命令行的场景：

| 脚本 | 作用 |
|---|---|
| **`启动哦鲸鲸.cmd`** | 没有 `.venv` 时先建虚拟环境并装 PySide6（走阿里云镜像），然后 `pythonw` 静默启动。**日常就双击它** |
| **`停止哦鲸鲸.cmd`** | 按命令行匹配 `ojingjing_py.py` 的 python 进程并结束（托盘「退出哦鲸鲸」也行） |

> 这两个 `.cmd` 存的是 **GBK** 编码（中文 Windows 的 cmd 默认代码页），别用把编码改成 UTF-8 的编辑器另存，
> 否则中文提示会变成乱码、甚至被 cmd 当成命令执行。

## 跟 DSH 联动（自动启动 / 自动退出）

**DSH 打开 → 哦鲸鲸自动出现**：装插件时 `tools\install-plugin.mjs` 会写
`%USERPROFILE%\.dsh\ojingjing-shell.json`（外壳目录 + 解释器候选），宿主插件加载时按它 fork 一个
`pythonw`。所以只要你装了插件并开着 DSH，就不必再双击 `启动哦鲸鲸.cmd`。

- 关掉：把那个 json 里的 `"autoLaunch"` 改成 `false`，或删掉文件，或 `--uninstall` 插件。
- 幂等：插件只拉一次；外壳自己有互斥量，重复启动会退出（日志「已有实例在跑」）。

**DSH 关闭 → 哦鲸鲸自动退出**（可选，默认关）：托盘「设置…」勾上「DSH 关掉后自动退出」，
之后每 15s 探一次 `/xj/state`，连续约 1 分钟不通就退出；想让窗口一直留着就别勾。
日志里 `launched by dsh` / `launched by user` 能看出这次是谁拉起来的。

## 设置（托盘 → 设置…）

值存在 `%APPDATA%\ojingjing\settings.json`；如果那个目录写不进去（受限环境），自动退到
`%LOCALAPPDATA%\ojingjing`，再退到程序目录下的 `data\`，日志里第一行会打印实际用的位置。

| 项 | 说明 | 默认 |
|---|---|---|
| DSH 端口 | 连哪个 `127.0.0.1:<port>`；改完自动重载页面 | 43120 |
| 截图默认 | `整屏`（回车直接发主屏）/ `框选`（先给 60% 起始框） | 整屏 |
| 显隐热键 | `Ctrl+Shift+Space`，可改，保存即重注册 | `Ctrl+Shift+Space` |
| 截图热键 | `Ctrl+Shift+A`，可改 | `Ctrl+Shift+A` |
| 开机自动启动 | 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | 关 |
| DSH 关掉后自动退出 | 连续约 1 分钟连不上 `/xj/state` 就退出 | 关 |
| 外观 · 头像 | 选本机图片当角色头像（圆、气泡头、面板头、引导页全换）；清除=内置 | 内置 |
| 外观 · 背景 | 选本机图片铺在气泡/面板/输入条底下；清除=玻璃底 | 无 |
| 外观 · 背景压暗 | 0–90%，图太亮时往上拖 | 60% |
| 视觉模型 | Base URL / API Key / 模型，「✨ 优化」用；留空就关掉 | 空 |

外观图片只在**本机**读：外壳把它转成 data URL 直接交给页面，不写数据库、不上传，单张上限 8MB；
托盘图标会跟着头像自动重裁（256×256，写到 `data\icon.png`）。选完立刻生效，不需要重启。

同一个配置目录里还有 `window.json`（位置记忆）和 `vision.json`（旧版视觉模型配置，仍兼容）。

只允许跑一个实例（命名互斥量 `Local\ojingjing-overlay-widget`）：第二次启动会直接退出并在日志里写
「已有实例在跑」——否则两个实例会互抢全局热键，看着像热键失灵。

## 装依赖

```powershell
cd C:\Users\17897\Desktop\新建文件夹\ojingjing-widget\standalone-py
python -m venv .venv
.venv\Scripts\python.exe -m pip install -i https://mirrors.aliyun.com/pypi/simple/ pyside6
```

## 跑

```powershell
# 日常：没有控制台窗口
.venv\Scripts\pythonw.exe ojingjing_py.py

# 排错：带控制台（stderr 里有 QtWebEngine 自己的日志）
.venv\Scripts\python.exe ojingjing_py.py
```

开机自启：`shell:startup` 里放一个指向 `pythonw.exe ojingjing_py.py` 的快捷方式，工作目录填本目录。

## 行为

| 交互 | 结果 |
|---|---|
| 悬停鲸鱼 | 气泡展开，窗口向右上变大（右下角锚定） |
| 单击鲸鱼 | 在气泡 / 收起之间切换 |
| 左键拖鲸鱼 | 交给系统拖动（`ReleaseCapture` + `WM_NCLBUTTONDOWN`），松手写位置 |
| 面板 | 窗口变 400×560（有审批时 600），右下角不动 |
| `Ctrl+Shift+Space` | 显示 / 隐藏 |
| 托盘单击 | 显示 / 隐藏 |
| 托盘右键 | 显示/隐藏 · 截图提问 · 打开 Harness · **设置…** · 重置位置 · 退出 |
| 面板「主界面」 | 拉起 `%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe` |
| `Ctrl+Shift+A` | **截图提问**（默认就是整屏，见下） |

窗口属性：`WS_POPUP | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED`（不进任务栏、不进 Alt+Tab、压在最上层、逐像素透明）。

## 截图提问（默认整屏）

`Ctrl+Shift+A` → 先把自己藏起来 240ms → 抓多屏合成图 → 铺一层全屏遮罩，**默认选区就是主屏整屏**：

| 操作 | 结果 |
|---|---|
| `Enter` / 双击 | 按当前选区发送（默认整屏，不用拖） |
| 拖拽 | 改成局部选区（虚线框 + 尺寸角标） |
| `Esc` | 取消，什么都不发 |

确认后**不会直接发出去**，而是右下角弹一张「截图提问」卡：

- 预览缩略图 + 尺寸 + 发给哪个会话；
- 输入框写问题（留空就发一句「请查看这张截图。」）；
- `✨ 优化`：让视觉模型把你的草稿改写成一句更具体的提问（要配 key，见下）；
- `重新截` / `取消` / `发送`；发送时按钮进 loading、成功后卡片显示「已发送到《会话名》」再收起。

### 配「优化提问」用的视觉模型（可选）

不配也能用，点优化会提示怎么配。配置写在：

```
%APPDATA%\ojingjing\vision.json
{ "baseUrl": "https://api.example.com/v1", "apiKey": "sk-…", "model": "某个支持图片的模型" }
```

走 OpenAI 兼容的 `POST {baseUrl}/chat/completions`，图片以 `image_url` 的 data URL 内联。

### 链路与坑

- 发送：PNG → `POST /xj/prompt` → 插件 `ctx.sessionController.prompt(...)`
  → 以 `{type:'image', mediaType:'image/png', data:<base64>}` + 文本投进会话；上限 20MiB。
- 像素**只在内存里过一手**（`QBuffer`，不落盘），对齐设计稿 §9.2。
- **这条路由要 DSH 重启一次才会进宿主**（插件在宿主启动时加载），否则日志写
  `截图：发送失败（HTTP 405）`，卡片会明确显示失败原因。
- 自测：`XJ_CAPTURE_SELFTEST=1` 启动 → 抓完 1.5s 自动按「整屏」确认；
  `XJ_DSH_BASE=http://127.0.0.1:43999` 可以把外壳指到 `node tools/test-host.mjs --serve` 这个假宿主上，
  跑完一整条「截图 → 卡片 → 发送 → 200 → 收起」。

## 渲染模式（重要）

托盘「设置…」或面板「设置 → 渲染」二选一，存在 `settings.json` 的 `render`：

| 档位 | 行为 |
|---|---|
| 软件（默认） | ANGLE + WARP 软件光栅，并关掉 GPU 合成。逐像素透明的分层窗口能正常显示，代价是模糊/动画吃 CPU |
| 硬件（实验） | ANGLE + D3D11 + GPU 合成，拖动和滚动更顺。**注意：GDI 抓图（`PIL.ImageGrab`、截图工具）抓不到硬件合成的分层窗口内容，截出来是灰糊——那是抓图限制，不代表窗口没画**。判断窗口是否真在显示用 `PrintWindow`，或者直接看屏幕 |

改完保存会问「现在重启」；托盘菜单也有「重新启动」。硬件模式的环境变量：

```python
QT_OPENGL=angle
QT_ANGLE_PLATFORM=d3d11
QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy
```

- 排查用的环境变量优先级最高：`$env:XJ_HW_GL = "1"` 强制硬件、`"0"` 强制软件。
- `data/gpu-off` 标记只在硬件模式加载失败（`loadFinished ok=False` / 渲染进程崩）时写入，
  写了之后选「硬件」也会走软件，删掉即可重试。
- 软件模式下页面会带 `html.xj-sw`（由外壳注入的 `window.__XJ_RENDER__` 决定），`styles.css`
  第 21 节据此关掉 `backdrop-filter` 和装饰性无限动画——透明窗口 + 实时模糊 + 呼吸动画在
  软件光栅下是掉帧主因。硬件模式不加这个类，视觉不变。
- 滚动流畅性在 `styles.css` 第 22 节：滚动容器去掉了 `mask-image` 底部淡出（换成 sticky
  渐变，mask 会让整层每帧重新栅格化）、滚动条位置固定；滚轮一动页面挂 `html.xj-scrolling`，
  转圈/呼吸/hover 过渡全部暂停，松手 160ms 后恢复（`app.js` 的 `bindScrollBoost`）。
- 滚轮缓动在 `app.js` 的 `bindSmoothScroll`：鼠标滚轮（|deltaY| ≥ 32）改由 rAF 逐帧逼近目标，
  松手后还有一段指数收敛；触控板的小 delta、Ctrl+滚轮缩放、输入框、减少动画都交回浏览器。
  `tools/dev/wheel-check.mjs` 抽样验证缓动是否生效（scrollTop 应该是一列间距递减的值）。
- 不要用 `QT_OPENGL=software`（swiftshader）：本机上窗口一放大（面板 444×604）渲染进程就会退出，
  现象是「点开面板窗口就消失」，日志停在 `resize 444x604`。
- 帧率上限：QtWebEngine 默认被 vsync 锁在 60fps（实测 58–59fps，帧间隔中位数 16.7ms）。设置里的
  「高帧率（实验）」= `highFps`，加 `--disable-gpu-vsync --disable-frame-rate-limit`，rAF 能到 300fps；
  但软件光栅下重绘是整块 `UpdateLayeredWindow`，实测空闲 CPU 从 43% 涨到 215%，所以默认关，
  只在硬件模式值得试。临时试：`$env:XJ_HIGH_FPS = "1"`。
- 收起时窗口不立刻缩：`_shrink_timer` 延迟 240ms 再缩到球的尺寸，让 200ms 的离场动画先播完，
  否则右边缘会被裁一截（窗口比内容更早缩小）。

## 打包成 exe（绿色版）

```powershell
node tools\build-exe.mjs     # PyInstaller 构建 + 瘦身 + 盘点，约 2 分钟
```

产物在 `dist\Ojingjing\`，整个目录拷走就能用，不需要装 Python / PySide6：

| 项 | 体积 |
|---|---|
| `Ojingjing.exe` | 1.9 MB（壳） |
| `_internal\` 合计 | 327 MB（QtWebEngine 内核 194 MB、Qt 运行库 ~30 MB、ICU 10 MB、PySide6 插件 6 MB） |
| **整个目录** | **329 MB**（未瘦身是 425 MB） |

`tools/trim-dist.mjs` 负责最后一刀，规则和理由都写在脚本头部：Chromium 语言包只留中英 4 个、
`resources\*.debug.pak`（含 72 MB 的 devtools debug pak）、devtools 前端、Qt 的 `.qm` 翻译——
合计 141 个文件 / 95.9 MB。**故意不删** `opengl32sw.dll`（19.7 MB，没有可用 D3D11 时的兜底光栅）
和 `icudtl.dat`（10 MB，中文与编码全靠它）。

两点必须知道：

1. **exe 只是外壳，页面还是从 DSH 取**（`http://127.0.0.1:43120/xj/app.html?embed=1&host=py`）。
   DSH 没开时窗能起来，但页面连不上宿主。
2. **配置落在 exe 同级的 `data\`**，不是 `%APPDATA%\ojingjing`：本机有安全软件拦 python 往 Roaming
   写文件（`Roaming\ojingjing` 的 ACL 是用户全开，PowerShell 能写、python 报 `Errno 13`，属进程级
   拦截），`_writable_dir` 于是退到程序目录。副作用：「venv 里跑」和「exe 跑」两份设置互不相通；
   把 exe 放进只读目录就别指望存设置。


## 落盘

- 日志：`standalone-py\ojingjing-py.log`（启动、hwnd、热键、每次 resize 的 dip→px 与实际窗口矩形、DPI）
- 位置：`%APPDATA%\ojingjing\window.json`（`{x, y}`，首次默认右下角、留 48px 给任务栏）

## 技术选择（为什么是 PySide6）

| 方案 | 结论 |
|---|---|
| C# + WPF + `WebView2CompositionControl` | 早期版本的实现，能跑（逐像素透明、26.4MB 发布目录），但每次改动都要 `dotnet publish`，还需要 .NET 10 SDK，已删除 |
| **Python + PySide6（QtWebEngine）** | **当前版本**：`WA_TranslucentBackground` + `page().setBackgroundColor(Qt.transparent)` 就够，改 py 重启即生效 |
| pywebview（WinForms 后端） | 不行：本机 .NET Core 下 `System.Windows.Forms.IFileDialog` 不公开，import 阶段就崩，与网络无关 |

改页面后要重新 `node tools\build-plugin.mjs`（页面在 `web/` 里，外壳和原型共用同一份）。

## 排错

| 现象 | 处理 |
|---|---|
| 窗口一片白 | DSH 没开或插件没装：浏览器打开 `http://127.0.0.1:43120/xj/state` 是否返回 JSON |
| 点开面板后窗口消失 | 渲染模式问题，确认没有外部把 `QT_OPENGL=software` 带进来（见上） |
| 窗口全黑 | 远程桌面/无显卡会话常见：外壳会自动切软件渲染重开一次；仍然全黑说明合成器不支持透明 |
| 位置跑出屏幕 | 托盘 → 重置位置 |
| 热键无效 | 被别的程序占用；日志里是空的说明 `RegisterHotKey` 失败 |
| 页面看起来没更新 | 插件是热加载的，但页面有缓存：关掉窗口重开，或 `node tools\build-plugin.mjs` 后重启 DSH |
| 想看 DevTools | `$env:QTWEBENGINE_REMOTE_DEBUGGING = "9223"`，然后 `node tools\cdp-eval.mjs 9223 "..."` |

## 还没做（和设计稿的差距）

独立窗目前做到「状态 + 气泡 + 面板 + 审批/提问处理 + 截图提问 + 打开主界面」。
**发送文字消息、新建会话、拖入文件、点击穿透** 仍未接宿主能力（见 `PLUGIN.md` 的能力矩阵）。
