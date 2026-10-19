# dsh-plugin-ojingjing · 哦鲸鲸

一只常驻桌面右下角的鲸鱼：看 DSH 会话在不在跑、有没有东西等你点头，审批和截图提问都能在浮窗里直接做完，不用切回主界面。

**只读任务状态，不读对话正文。**

> **仓库根目录本身就是一个 DSH bundle 插件包**（`package.json` + `cordis.patch.yml` + `lib/` + `web/`）。
> `app/`（可点击原型）、`standalone-py/`（独立桌面窗）、`tools/`（构建与校验）是随仓库带的配套内容，
> 不在 npm 包的 `files` 白名单里。装上插件后，浮窗用同一份前端源码，一条 `/xj/*` 接口喂真数据。

---

## 三种形态，一份 UI

前端只有一份源码（[`app/src/`](app/src/)），三种承载方式各自解决一个问题：

| 形态 | 位置 | 解决什么 | 从哪开始 |
|---|---|---|---|
| **DSH 插件** | 仓库根（`lib/` + `web/`） | 数据从哪来：汇总会话、接管审批、提供 `/xj/*` 路由 | [安装](#安装) → [`PLUGIN.md`](PLUGIN.md) |
| **可点击原型** | [`app/`](app/) | 不装任何东西就能点完所有交互 | 双击 [`app/index.html`](app/index.html) → [`app/README.md`](app/README.md) |
| **独立桌面窗** | [`standalone-py/`](standalone-py/) | 窗口不跟着 DSH 走：无边框、置顶、逐像素透明 | [`standalone-py/README.md`](standalone-py/README.md) |

插件负责把 DSH 的真状态喂给浮窗，Python 外壳负责把同一个页面画成一个真正的桌面窗口，
两者只通过 `127.0.0.1` 上的 `/xj/*` 说话。

## 上来先看（零安装）

双击 [`app/index.html`](app/index.html)。所有交互都能走完，数据来自 `app/src/mock.js` 的假 Harness
（含 409 竞态 / 410 过期 / 422 / 503 断连的故障演练）。

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+Space` | 展开 / 收起面板 |
| `Ctrl+Shift+Q` | 光标旁唤起快捷输入条 |
| `Ctrl+Shift+A` | 截图提问（遮罩 → 框选 → 问题 → 发送） |
| `Ctrl+Shift+D` | 原型控制台（仅原型，可推审批 / 推提问 / 造竞态 / 断网） |
| `Esc` | 逐层收起：遮罩 → 气泡 → 面板 |

状态锚点可以直接跳到某一形态：`index.html#demo=panel` `#demo=bubble` `#demo=quickbar`
`#demo=settings` `#demo=approvals` `#demo=onboarding` `#demo=unread` `#demo=offline`
`#demo=danger` `#demo=capture-edit` `#demo=capture-confirm` `#demo=drop` `#demo=presenting`。

## 安装

**双击 [`安装到DSH.cmd`](安装到DSH.cmd)**，或在仓库里跑：

```powershell
node tools/install.mjs              # 全套
node tools/install.mjs --dry-run    # 只打印将执行的命令，什么都不改
node tools/install.mjs --relaunch   # 装完自动把 DSH 拉起来
```

一个脚本把下面六步全做完：

| 步骤 | 干什么 |
| --- | --- |
| 1 | 环境自检：Node 版本、npm、`dsh`、desktop profile 是否存在 |
| 2 | 构建前端：`app/src` → `web/`（见[构建链路](#构建链路)） |
| 3 | 打包：`npm pack` → `dist/dsh-plugin-ojingjing-0.3.0.tgz`（缓存写在仓库的 `.npm-cache/`） |
| 4 | **装进 DSH**：`dsh plugin add <tgz>`（走 DSH Desktop 自带的 dsh），补登记 `dsh.profile.bundles`，落地校验 |
| 5 | 装 Python 依赖：没有 `standalone-py/.venv` 就建一个，再 `pip install -r requirements.txt`（PySide6，约 300MB，已装则跳过） |
| 6 | 写自动拉起配置 `~/.dsh/ojingjing-shell.json`（DSH 起来时自动弹独立窗） |

装完**重启 DSH** 才生效（宿主启动时按层栈加载 bundle）。

卸载：

```powershell
node tools/uninstall.mjs            # 摘插件 + 去登记 + 停独立窗 + 删自动拉起配置
node tools/uninstall.mjs --dry-run  # 先看看会动什么
node tools/uninstall.mjs --purge    # 连 .venv / data（含 API key）/ 日志 / dist 一起清
```

或双击 [`从DSH卸载.cmd`](从DSH卸载.cmd)。

<details>
<summary><b>全部选项</b></summary>

`install.mjs`：`--dry-run` `--no-build` `--skip-deps` `--force-deps` `--mirror <url|cn>` `--no-shell-config` `--direct` `--relaunch` `--profile <name>` `--dsh <path>`

`uninstall.mjs`：`--dry-run` `--direct` `--keep-shell-config` `--purge` `--profile <name>` `--dsh <path>`

`--direct` = 不走 dsh，直接拷进 profile 并登记 bundles（等价于老的 `tools/install-plugin.mjs`，dsh 不可用时的退路）。
`--mirror cn` = pip 走阿里云镜像。

</details>

## 四个踩过的坑（都写在脚本里了）

### 为什么必须用「DSH Desktop 自带的 dsh」

`dsh` 分两种，装 desktop profile 只有一种能用：

- **DSH Desktop 生成的 shim**：`%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd`。
  它只是把 `ELECTRON_RUN_AS_NODE=1` 设上，然后跑 `resources\app\lib\desktop-cli.js`，那个入口调的是
  `runCli({ manageDesktopProfile: true })` —— 也就是说它被授权管理 desktop profile。
- **纯 CLI 版**（`npm i -g @deepseek-ai/dsh` / `npx dsh`）：`lib/bin.js` 里有一条静态校验
  `rejectElectronProfile()`，只要 profile 名是 `desktop` 就直接报
  `profile "desktop" is managed exclusively by the Electron application` 并退出。
  **这跟 DSH 有没有开着无关**，是代码级禁止。

所以 `install.mjs` 会优先去 `host-commands` 里翻最新那代 shim，找不到才退回 PATH 上的 `dsh`（并警告）。
你也可以 `--dsh "<shim 路径>"` 直接指定。

### 为什么不直接 spawn 那个 `.cmd`

shim 是个批处理：里面先 `chcp 65001`，再用 `%*` 把参数展开给 Electron。这条链上任何一步按
ANSI/OEM 代码页转码，含中文的参数就会变成乱码 —— 实测把
`C:\...\Desktop\新建文件夹\ojingjing-widget\dist\dsh-plugin-ojingjing-0.3.0.tgz` 交给 pnpm 时，
它变成 UTF-8-当-GBK 读的样子（`新建文件夹` → `鏂板缓鏂囦欢澶`），连结尾那个反斜杠都被双字节字符吞掉，
pnpm 只能 exit 1，日志里还只留一句 `Command failed with exit code 1: pnpm add "…乱码…"`。

所以 [`tools/dsh.mjs`](tools/dsh.mjs) 把 shim 拆开：读出它要跑的 `DSH Desktop.exe`、`desktop-cli.js`
和那几个环境变量，用 `spawn(shell: false)` 直接起 exe——参数走 `CreateProcessW`（UTF-16），
不经过 cmd，也就没有代码页这回事。解析不出来才退回走 `.cmd`。

### 重复安装会先 `remove` 再 `add`

pnpm 对「同一个 spec 的 tarball」是幂等的——它只比对 `package.json` 里的 specifier 和版本号，
两者都没变就直接说 `Already up to date`，**根本不看 tgz 里的内容**。于是「改完前端 → 重新打包 → 再 add」
会静默装回旧代码。脚本因此每次都先 `dsh plugin remove` 再 `dsh plugin add`；改完代码只要重跑一次
`node tools/install.mjs`。

### 卸载为什么会「不干净」

两件事夹在一起：

- **DSH 开着**：它把插件的 `lib/index.js` 装进了内存，Windows 不放文件句柄，`node_modules` 里那个目录删不掉；
  旧脚本删目录失败会直接中断，留下「登记摘了、目录还在」的半截状态。
- **pnpm 的账本**：`dependencies`、`dsh.profile.bundles`、`node_modules` 目录、`pnpm-lock.yaml`
  是四处独立的状态，任意一处没清都会被下一次安装绊倒。

[`tools/uninstall.mjs`](tools/uninstall.mjs) 现在：① 发现 DSH 开着先警告；② 删目录失败不中断，改名为
`<包名>.removed-<时间戳>`（效果等同卸载，DSH 下次启动加载不到它）；③ 每次跑都顺手清掉这些改名残留；
④ 除了查 `dependencies`/`bundles`，还查 `node_modules` 目录和 lockfile，把「还有哪儿没干净」直接说出来。

## 构建链路

```
app/src/**  ──┬─→ web/static/src/**      （esbuild minify + 剥离 mock/devbar，19 个文件）
              └─→ web/app.html           （app/index.html 改路径 + 挂 embed + 删原型脚本）
standalone-py  ──→  直接加载 http://127.0.0.1:<port>/xj/app.html?embed=1&host=py
```

`node tools/build-plugin.mjs` 做四件事：

1. 把 `app/src/` 下的 `js|css|svg|png|webp|woff2` 复制到 `web/static/src/`（位图和 data-URI 原样拷）；
2. JS/CSS 过 esbuild minify（**可选依赖**：装在受管 node workspace 或仓库 `node_modules` 里，
   找不到就原样拷贝并提示；`XJ_NO_MINIFY=1` 强制关）；
3. **embed 剥离**：`mock.js` / `devbar.js` 是原型专用（假 Harness + 评审控制台），插件包里整个删掉——
   app.js 里 devbar 的调用点有 `XJ.embed` 守卫，`XJ.mock` 命名空间由 embed.js 兜底；
4. 把 `app/index.html` 里的相对路径 `src/…` 重写成 `/xj/static/src/…`、删掉原型脚本的 `<script>` 行、
   挂 `embed.css` / `embed.js`、改 `<title>`、给原型提示条打 `data-remove-in-embed` 标记。

所以原型和插件页面共用同一份源码，但插件包里的页面是「瘦身版」；`file://` 打开原型依旧可用
（原型永远用 `app/src` 的未压缩原件，不受构建影响）。

> **`app/src/` 是唯一事实来源。** `web/static/src/`、`web/app.html`、`web/embed.*`、`web/icon.png`
> 都是产物，改页面只改 `app/src/` 然后重跑构建——直接改 `web/` 会在下次构建时被覆盖。

## 仓库地图

```
ojingjing-widget/
├── package.json  cordis.patch.yml  README.md  PLUGIN.md  LICENSE
├── 安装到DSH.cmd            双击安装（纯 ASCII：cmd 按 OEM 码页读批处理，中文会乱码）
├── 从DSH卸载.cmd            双击卸载
├── Ojingjing.spec            PyInstaller 打包独立窗 exe（tools/build-exe.mjs 一条龙：构建+裁语言包+盘点）
├── OjingjingDebug.spec       同上，带控制台版
├── lib/index.js            ② 宿主插件（单文件）：apply(root) → session/event · approval/request · /xj/*
├── web/                    ② 插件静态资源（app.html、static/ 是 build-plugin 的产物）
│   ├── app.html  embed.js  embed.css  inject.js  icon.png
│   └── static/src/**       app/src/ 的构建副本
├── app/                    ① 原型（唯一前端源）
│   ├── index.html              双击即跑；src/ 全是原生 JS + CSS，无构建
│   ├── dev-whale.html          鲸鱼五表情校验页（大 / 中 / 小并排看）
│   ├── README.md               前端说明书（§编号、台词池、四形态规格）
│   └── src/**                  20 个 JS/CSS（约 9.3k 行）+ avatar.webp
├── standalone-py/          ③ PySide6 + QtWebEngine 桌面外壳
│   ├── ojingjing_py.py         窗口 / 置顶 / 热键 / 托盘 / 截图 / 设置 / 渲染模式
│   ├── 启动哦鲸鲸.cmd           日常双击启动（GBK 编码）
│   ├── 停止哦鲸鲸.cmd           按命令行匹配结束进程（GBK 编码）
│   └── requirements.txt        PySide6>=6.6
├── assets/icon-source.png  头像原图（tools/prep-avatar.py 的输入）
├── .shots/                 自检截图：verify-avatar-app.png · verify-whale-svg.png
├── tools/                  构建 / 安装 / 打包 / 截图 / 校验（见[工具链](#工具链)）
│   └── dev/                一次性探针（probe-*、cdp-eval、qt-interact、wheel-check…）
└── dist/                   构建产物：npm tarball、交付包、zip
```

## 插件包结构

发布到 npm 的只有 `package.json` 里 `files` 白名单列的东西（`npm pack` 实测 29 个文件，约 216 KB）：

```
package.json          # main → lib/index.js；dsh.bundle.patch → cordis.patch.yml；files 白名单
cordis.patch.yml      # - insert: [{ id: dsh-plugin-ojingjing, name: dsh-plugin-ojingjing }]
lib/index.js          # 宿主插件入口：export default { name, apply(root) }
web/app.html          # tools/build-plugin.mjs 从 app/index.html 生成（别手改）
web/embed.js          # 页面侧：XJ.embed + 真数据 harness（/xj/state、/xj/decide、/xj/prompt）
web/embed.css         # 嵌入态样式
web/inject.js         # 页面内注入版（默认关闭，见 lib/index.js 的 INJECT_IN_PAGE = false）
web/icon.png          # 插件图标（tools/make-icon.mjs 生成；托盘 / 窗口图标也读它）
web/static/src/**     # 构建产物：app/src/ 的副本
README.md  LICENSE
```

零依赖设计：`peerDependencies` 只声明 `@deepseek-ai/cordis`（optional，宿主自带），
`lib/index.js` 只用 Node 内置模块。`engines` 要求 node `^22.19.0 || >=24.0.0`，
`dsh.engines.dsh` 要求 `>=0.1.7-rc.2`。

## 数据入口：`/xj/*`

插件在宿主里注册的只读接口，独立窗和嵌入页都吃这一份：

| 路由 | 作用 |
|---|---|
| `GET /xj/state` | 连接状态 + 会话列表 + 角标计数 + 待批准项（浮窗轮询的就是它） |
| `POST /xj/decide` | 通过 / 拒绝某个审批（带幂等键，撞 409 表示已在别处处理） |
| `POST /xj/prompt` | 截图提问：图片以 data URL 内联，投进指定会话的 `prompt()` |
| `GET /xj/app.html` | 浮窗页面本体 |
| `GET /xj/static/*` | 页面静态资源 |
| `GET /xj/embed.js` `embed.css` `inject.js` | 嵌入态脚本与样式 |

`/xj/state` 实际返回（节选，字段名以真机为准）：

```json
{
  "api_version": "v1",
  "connection": "online",
  "sessions": [
    { "id": "session-…", "title": "会话 afb0", "state": "working",
      "action": "正在pwsh", "progress": 0.35, "unread": 0, "pending": [] }
  ],
  "counts": { "pending": 0, "unread": 0 },
  "pending": []
}
```

自测：`node tools/check-plugin.mjs` 探测运行中的宿主；`node tools/test-host.mjs --serve`
起一个 43999 端口上的假宿主，`$env:XJ_DSH_BASE="http://127.0.0.1:43999"` 把外壳指过去就能跑全链路。

## 工具链

| 脚本 | 作用 |
|---|---|
| [`tools/build-plugin.mjs`](tools/build-plugin.mjs) | `app/index.html` + `app/src/` → `web/app.html` + `web/static/src/` |
| [`tools/install.mjs`](tools/install.mjs) | **装进 DSH**：构建 → 打包 → `dsh plugin add` → venv 依赖 → 自动拉起配置，六步一遍过 |
| [`tools/uninstall.mjs`](tools/uninstall.mjs) | 卸载：摘插件 + 去登记 + 停独立窗 + 删自动拉起配置（`--purge` 连 venv/data/日志一起清） |
| [`tools/shell-config.mjs`](tools/shell-config.mjs) | 读写 `~/.dsh/ojingjing-shell.json`、探测/停止自动拉起的独立窗 |
| [`tools/dsh.mjs`](tools/dsh.mjs) | 把 `dsh` shim 拆成「exe + desktop-cli.js + env」直接 spawn，绕开 cmd 代码页 |
| [`tools/install-plugin.mjs`](tools/install-plugin.mjs) | 老直装脚本（不经过 dsh，直接拷 profile + 登记 bundles）；现在是 `install.mjs --direct` 的退路 |
| [`tools/pack.mjs`](tools/pack.mjs) | 白名单打交付包 → `dist/pack/`，`--zip` 再压一个 `dist/ojingjing-widget-<日期>.zip` |
| [`tools/test-host.mjs`](tools/test-host.mjs) | 假 Cordis 宿主跑整套 `/xj/*` 契约断言（16 项） |
| [`tools/test-shell-launch.mjs`](tools/test-shell-launch.mjs) | 验证「DSH 起来 → 自动拉起独立窗」这条联动 |
| [`tools/check-plugin.mjs`](tools/check-plugin.mjs) | 探测运行中的宿主：`/xj/inject.js`、`/xj/app.html`、`/xj/state` |
| [`tools/shoot.mjs`](tools/shoot.mjs) | 无头 Chrome + CDP 拍「交互后」截图 → `docs/screenshots/` |
| [`tools/compose-shot.py`](tools/compose-shot.py) | 把 Qt 窗口合成进全屏截图（分层窗口抓不到，只能合成） |
| [`tools/prep-avatar.py`](tools/prep-avatar.py) | `assets/icon-source.png` → `app/src/avatar.webp` + `avatar.js`（WebP data URL，比 PNG 小约 78%） |
| [`tools/make-icon.mjs`](tools/make-icon.mjs) | 生成 `web/icon.png`（插件图标 + 托盘 + 窗口图标） |

`tools/dev/` 里是一次性探针，别在日常流程里跑：

| 探针 | 用途 |
|---|---|
| `cdp-eval.mjs` | 对运行中的页面执行一段 JS（`node tools/dev/cdp-eval.mjs 9223 "…"`） |
| `probe-embed.mjs` / `probe-plugin.mjs` / `probe-prompt.mjs` | 分别验证嵌入态、插件安装态、`/xj/prompt` 投递 |
| `qt-interact.mjs` | 驱动独立窗做点击 / 拖动 / resize |
| `fps-probe.mjs` / `scroll-probe.mjs` / `wheel-check.mjs` | 帧率、滚动容器、滚轮缓动的抽样验证 |
| `rename-brand.mjs` | 批量改品牌名；**跑之前先 `git status` 确认干净**，不要对 `tools/` 自身跑 |

## 现状

- 宿主插件已装进 desktop profile，`/xj/state` 返回真实会话；独立窗由 DSH 启动时拉起（或双击 `standalone-py/启动哦鲸鲸.cmd`）。
- 已接真数据：四形态渲染、状态真值表、双角标、未读制、内嵌审批（通过 / 拒绝 / 幂等 / 409 竞态）、截图提问。
- 还没接：会话卡「停止」、输入条发文字、拖文件进会话（按钮已隐藏，不会点了报错）、点击穿透。
- DSH 插件宿主跑在 `utilityProcess` 里，拿不到 `BrowserWindow`，所以跨应用常驻必须靠 `standalone-py/` 这个独立程序。
- 状态真值表（`app/src/state.js`）：**需要确认 > 工作中 > 完成未读 > 空闲 > 离线**；离线时整体灰度 + 光环转虚线。
- 角色设定：招呼类文案统一称呼「老大」，改台词只动 `app/src/lines.js` 那张表。

## 隐私与安全

- 只监听**状态事件**与**审批请求**，不读对话正文；命令 / 参数只在内存里拼一句摘要，不落盘。
- 所有 `/xj/*` 路由只接受回环 Host（`127.0.0.1` / `localhost` / `[::1]`）；带 `Origin` 时必须同源；
  写操作（`/xj/decide`、`/xj/prompt`）只收 `POST`。
- 截图提问的像素只在内存里过一手（`QBuffer`），不写临时文件；单张上限 8MB（外观图）/ 20MiB（投递）。
- 视觉模型（「✨ 优化」）是可选项，不配就不发任何外部请求；配了走你自己填的 OpenAI 兼容端点。

## 编码约定（踩过坑，别改）

| 文件 | 编码 | 原因 |
|---|---|---|
| 两个根目录 `.cmd` | **纯 ASCII** | `cmd.exe` 按 OEM 码页读批处理，写中文必乱码；面向用户的输出全部由 `tools/*.mjs` 以 UTF-8 打印 |
| `standalone-py/*.cmd` | **GBK** | 中文 Windows 的 cmd 默认代码页；用 UTF-8 另存会乱码甚至被当成命令执行 |
| 其余全部 | **UTF-8** | 包括 `lib/`、`app/`、`web/`、`tools/`、所有 `.md` |

## 排错

| 现象 | 处理 |
|---|---|
| DSH 里看不到浮窗 | 装完没重启 DSH（bundle 在启动时加载）；`node tools/check-plugin.mjs` 看 `/xj/state` 是否返回 JSON |
| 改了前端但界面没变 | 只改了 `app/src/` 没重新构建：`node tools/build-plugin.mjs` 后重跑 `node tools/install.mjs` |
| 重装了还是旧代码 | pnpm 幂等看的是版本号，不是 tgz 内容——脚本已内置先 `remove` 再 `add`，别手工 `pnpm add` |
| 卸载后残留目录 | DSH 开着时文件被占用，会改名成 `<包名>.removed-<时间戳>`；关掉 DSH 再跑一次 `uninstall.mjs` 即可清掉 |
| 独立窗一片白 | DSH 没开或插件没装：浏览器打开 `http://127.0.0.1:43120/xj/state` 验一下 |
| 独立窗点开面板就消失 | `QT_OPENGL=software` 带进来了（swiftshader 下渲染进程会退）；清掉该环境变量 |
| `Ojingjing.spec` 打包失败 | spec 里写的是绝对路径，换了目录要同步改 `standalone-py/ojingjing_py.py` 那一行 |

## 许可与素材

MIT，见 [`LICENSE`](LICENSE)。鲸鱼 SVG 造型与全部状态装饰为自绘（Twemoji 已清零）；
角色头像素材来自 [DeepSeek-Balance-Whale-Widget](https://github.com/lvxingye/DeepSeek-Balance-Whale-Widget)，
换成自己的图后跑 `python tools/prep-avatar.py` + `node tools/build-plugin.mjs` 即可。

更多细节：[`PLUGIN.md`](PLUGIN.md)（宿主契约与能力矩阵）、[`app/README.md`](app/README.md)（前端与四形态规格）、
[`standalone-py/README.md`](standalone-py/README.md)（外壳、热键、渲染模式与截图链路）。
