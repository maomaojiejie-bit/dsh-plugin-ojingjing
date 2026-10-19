# dsh-plugin-ojingjing · 哦鲸鲸

一只常驻桌面右下角的鲸鱼：看 DSH 会话在不在跑、有没有东西等你点头，审批和截图提问都能在浮窗里直接做完，不用切回主界面。

![收起态](docs/screenshots/look-orb.png) ![面板](docs/screenshots/look-panel.png)

仓库根目录**本身就是一个 DSH bundle 插件包**（`package.json` + `cordis.patch.yml` + `lib/` + `web/`），
`app/`（可点击原型）、`standalone-py/`（独立桌面窗）、`tools/`（构建与校验）是随仓库带的配套内容，
不在 npm 包的 `files` 白名单里。装上插件后，浮窗用同一份前端源码，一条 `/xj/*` 接口喂真数据。

## 三种形态，一份 UI

前端只有一份源码（`app/src/`），三种承载方式各自解决一个问题：

| 形态 | 位置 | 解决什么 | 从哪开始 |
|---|---|---|---|
| DSH 插件 | 仓库根（`lib/` + `web/`） | 数据从哪来：汇总会话、接管审批、`/xj/*` 路由 | 下面的「安装」→ [`PLUGIN.md`](PLUGIN.md) |
| 可点击原型 | `app/` | 不装任何东西就能点完所有交互 | 双击 [`app/index.html`](app/index.html) → [`app/README.md`](app/README.md) |
| 独立桌面窗 | `standalone-py/` | 窗口不跟着 DSH 走：无边框、置顶、逐像素透明 | [`standalone-py/README.md`](standalone-py/README.md) |

插件负责把 DSH 的真状态喂给浮窗，Python 外壳负责把浮窗画成一个真正的桌面窗口，两者只通过 `127.0.0.1` 上的 `/xj/*` 说话。

## 安装

**双击 `安装到DSH.cmd`**（或在仓库里跑 `node tools/install.mjs`）。一个脚本把下面这些全做完：

| 步骤 | 干什么 |
| --- | --- |
| 1 | 环境自检：Node 版本、npm、`dsh`、desktop profile 是否存在 |
| 2 | 构建前端：`app/src` → `web/` |
| 3 | 打包：`npm pack` → `dist/dsh-plugin-ojingjing-0.3.0.tgz`（缓存写在仓库的 `.npm-cache/`） |
| 4 | **装进 DSH**：`dsh plugin add <tgz>`（走 DSH Desktop 自带的 dsh），补登记 `dsh.profile.bundles`，落地校验 |
| 5 | 装 Python 依赖：没有 `standalone-py/.venv` 就建一个，再 `pip install -r requirements.txt`（PySide6，约 300MB，已装则跳过） |
| 6 | 写自动拉起配置 `~/.dsh/ojingjing-shell.json`（DSH 起来时自动弹独立窗） |

```powershell
node tools/install.mjs              # 全套
node tools/install.mjs --dry-run    # 只打印将执行的命令，什么都不改
node tools/install.mjs --relaunch   # 装完自动把 DSH 拉起来
```

卸载：

```powershell
node tools/uninstall.mjs            # 摘插件 + 去登记 + 停独立窗 + 删自动拉起配置
node tools/uninstall.mjs --dry-run  # 先看看会动什么
node tools/uninstall.mjs --purge    # 连 .venv / data（含 API key）/ 日志 / dist 一起清
```

<details>
<summary>全部选项</summary>

`install.mjs`：`--dry-run` `--no-build` `--skip-deps` `--force-deps` `--mirror <url|cn>` `--no-shell-config` `--direct` `--relaunch` `--profile <name>` `--dsh <path>`

`uninstall.mjs`：`--dry-run` `--direct` `--keep-shell-config` `--purge` `--profile <name>` `--dsh <path>`

`--direct` = 不走 dsh，直接拷进 profile 并登记 bundles（等价于老的 `tools/install-plugin.mjs`，dsh 不可用时的退路）。

</details>

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
它变成 UTF-8-当-GBK 读的样子（`新建文件夹` → `鏂板缓鏂囦欢澶`），连结尾那个反斜杠都被双字节字符吞掉
（`...文件夹\ojingjing...` → `...澶筡ojingjing...`），pnpm 只能 exit 1，日志里还只留一句
`Command failed with exit code 1: pnpm add "…乱码…"`。

所以 `tools/dsh.mjs` 把 shim 拆开：读出它要跑的 `DSH Desktop.exe`、`desktop-cli.js` 和那几个环境变量，
用 `spawn(shell: false)` 直接起 exe——参数走 `CreateProcessW`（UTF-16），不经过 cmd，也就没有代码页这回事。
解析不出来才退回走 `.cmd`。

> **重复安装会先 `remove` 再 `add`**：pnpm 对「同一个 spec 的 tarball」是幂等的——它只比对
> `package.json` 里的 specifier 和版本号，两者都没变就直接说 `Already up to date`，**根本不看 tgz 里的内容**。
> 于是「改完前端 → 重新打包 → 再 add」会静默装回旧代码（2026-10 实测）。脚本因此每次都先
> `dsh plugin remove` 再 `dsh plugin add`；改完代码只要重跑一次 `node tools/install.mjs`。

### 卸载为什么会「不干净」

两件事夹在一起：

- **DSH 开着**：它把插件的 `lib/index.js` 装进了内存，Windows 不放文件句柄，`node_modules` 里那个目录删不掉；
  旧脚本删目录失败会直接中断，留下「登记摘了、目录还在」的半截状态。
- **pnpm 的账本**：`dependencies`、`dsh.profile.bundles`、`node_modules` 目录、`pnpm-lock.yaml` 是四处独立的状态，
  任意一处没清都会被下一次安装绊倒。

`uninstall.mjs` 现在：① 发现 DSH 开着先警告；② 删目录失败不中断，改名为 `<包名>.removed-<时间戳>`（效果等同卸载，
DSH 下次启动加载不到它）；③ 每次跑都顺手清掉这些改名残留；④ 第 5 步除了查 `dependencies`/`bundles`，
还查 `node_modules` 目录和 lockfile，把「还有哪儿没干净」直接说出来。

装完**重启 DSH** 才生效（宿主启动时按层栈加载 bundle）。DSH 起来时若哦鲸鲸没在跑，插件会自动拉起独立窗
（`~/.dsh/ojingjing-shell.json` 控制，`autoLaunch: false` 可关）。契约与回滚见 [`PLUGIN.md`](PLUGIN.md)。

### 手工安装（不推荐，脚本已覆盖）

<details>
<summary>方式 B：tarball 直接塞进 profile</summary>

```powershell
npm.cmd pack --pack-destination dist            # → dist/dsh-plugin-ojingjing-0.3.0.tgz
cd $env:USERPROFILE\.dsh\profiles\desktop
npm.cmd install --no-save "C:\path\to\dsh-plugin-ojingjing-0.3.0.tgz"
```

然后手动在 profile 的 `package.json` 里把 `"dsh-plugin-ojingjing"` 加进 `dsh.profile.bundles`，否则不加载。
</details>

<details>
<summary>方式 C：直接敲 dsh</summary>

```powershell
# 用 Desktop 那个 shim，不要用全局 dsh，否则会被静态校验拒掉
"%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd" plugin --profile desktop add "dist\dsh-plugin-ojingjing-0.3.0.tgz"
# dsh plugin 只等价于 pnpm add，不会写 dsh.profile.bundles，还得手动登记
```

注意点：**不登记不加载** —— `dsh plugin add` 之后 `node_modules` 里有了，但 bundles 列表里没有，
DSH 启动时不会加载它。这正是脚本留着「落地校验 + 补登记」的原因。
</details>

> 零依赖设计：`peerDependencies` 只声明 `@deepseek-ai/cordis`（optional，宿主自带），`lib/index.js` 只用 Node 内置模块。
> `engines` 要求 node `^22.19.0 || >=24.0.0`。

## 插件包结构

```
package.json          # main → lib/index.js；dsh.bundle.patch → cordis.patch.yml；files 白名单
cordis.patch.yml      # - insert: [{ id: dsh-plugin-ojingjing, name: dsh-plugin-ojingjing }]
lib/index.js          # 宿主插件入口：export default { name, apply(root) }
web/app.html          # tools/build-plugin.mjs 从 app/index.html 生成（别手改）
web/embed.js          # 页面侧：XJ.embed + 真数据 harness（/xj/state、/xj/decide、/xj/prompt）
web/embed.css         # 嵌入态样式
web/inject.js         # 页面内注入版（默认关闭，见 INJECT_IN_PAGE）
web/icon.png          # 插件图标（tools/make-icon.mjs 生成；托盘/窗口图标也读它）
web/static/src/**     # 构建产物：app/src/ 的副本，由 build-plugin.mjs 生成
LICENSE
```

发布到 npm 的只有上面这些（`npm pack` 实测 31 个文件，约 243KB）。

## 仓库地图

```
ojingjing-widget/
├── package.json  cordis.patch.yml  README.md  PLUGIN.md  LICENSE
├── 安装到DSH.cmd            双击安装（只写 ASCII：cmd 按 OEM 码页读批处理，中文会乱码）
├── 从DSH卸载.cmd            双击卸载
├── lib/index.js            ② 宿主插件：apply(root) → approval/request · session/event · /xj/*
├── web/                    ② 插件静态资源（app.html、static/ 是 build-plugin 的产物）
├── app/                    ① 原型（唯一前端源）
│   ├── index.html              双击即跑；src/ 全是原生 JS + CSS，无构建
│   └── src/                    styles.css · state.js · app.js · mock.js · view-*.js …
├── standalone-py/          ③ PySide6 + QtWebEngine 桌面外壳
│   └── ojingjing_py.py         /xj/state 轮询、置顶、热键、托盘、截图、设置窗
├── assets/                 icon-source.png（头像原图，tools/prep-avatar.py 的输入）
├── docs/screenshots/       评审截图（下文有索引）
├── tools/                  构建 / 安装 / 打包 / 截图 / 校验
│   └── dev/                一次性探针（probe-*、cdp-eval、qt-interact、rename-brand）
└── dist/                   构建产物：npm tarball、交付包、zip
```

## 快速开始（只点点看）

双击 [`app/index.html`](app/index.html)。所有交互都能走完，数据来自 `app/src/mock.js` 的假 Harness（含 409 / 410 / 422 / 503 故障演练）。
要独立置顶的桌面窗，见 [`standalone-py/README.md`](standalone-py/README.md)（需要 Python + PySide6）。

## 工具链

| 脚本 | 作用 |
|---|---|
| [`tools/build-plugin.mjs`](tools/build-plugin.mjs) | `app/index.html` + `app/src/` → `web/app.html` + `web/static/src/`（只改路径、挂 embed） |
| [`tools/install.mjs`](tools/install.mjs) | **装进 DSH**：构建 → 打包 → `dsh plugin add` → venv 依赖 → 自动拉起配置，六步一遍过（`安装到DSH.cmd` 双击等价） |
| [`tools/uninstall.mjs`](tools/uninstall.mjs) | 卸载：摘插件 + 去登记 + 停独立窗 + 删自动拉起配置（`--purge` 连 venv/data/日志一起清） |
| [`tools/shell-config.mjs`](tools/shell-config.mjs) | 读写 `~/.dsh/ojingjing-shell.json`、探测/停止自动拉起的独立窗 |
| [`tools/dsh.mjs`](tools/dsh.mjs) | 把 `dsh` shim 拆成「exe + desktop-cli.js + env」直接 spawn，绕开 cmd 的代码页（中文路径传参不再乱码） |
| [`tools/install-plugin.mjs`](tools/install-plugin.mjs) | 老直装脚本（不经过 dsh，直接拷 profile + 登记 bundles）；现在是 `install.mjs --direct` 的退路 |
| [`tools/pack.mjs`](tools/pack.mjs) | 白名单打交付包 → `dist/pack/`，`--zip` 再压一个 `dist/ojingjing-widget-<日期>.zip` |
| [`tools/test-host.mjs`](tools/test-host.mjs) | 假 Cordis 宿主跑整套 `/xj/*` 契约断言（16 项） |
| [`tools/test-shell-launch.mjs`](tools/test-shell-launch.mjs) | 验证「DSH 起来 → 自动拉起独立窗」这条联动 |
| [`tools/check-plugin.mjs`](tools/check-plugin.mjs) | 探测运行中的宿主：`/xj/inject.js`、`/xj/app.html`、`/xj/state` |
| [`tools/shoot.mjs`](tools/shoot.mjs) | 无头 Chrome + CDP 拍「交互后」截图 → `docs/screenshots/` |
| [`tools/compose-shot.py`](tools/compose-shot.py) | 把 Qt 窗口合成进全屏截图（分层窗口抓不到，只能合成） |
| [`tools/prep-avatar.py`](tools/prep-avatar.py) | `assets/icon-source.png` → `app/src/avatar.webp` + `avatar.js`（WebP data URL，比 PNG 小约 78%） |
| [`tools/make-icon.mjs`](tools/make-icon.mjs) | 生成 `web/icon.png`（插件图标 + 托盘 + 窗口图标） |

## 截图索引

| | |
|---|---|
| 首次运行 / 引导 | [firstrun](docs/screenshots/firstrun.png) · [onboarding](docs/screenshots/onboarding.png) |
| 四形态 | [collapsed](docs/screenshots/collapsed.png) · [bubble](docs/screenshots/bubble.png) · [quickbar](docs/screenshots/quickbar.png) · [panel](docs/screenshots/panel.png) |
| 审批闭环 | [approvals](docs/screenshots/approvals.png) · [danger](docs/screenshots/danger.png) · [approve](docs/screenshots/approve.png) · [reject-confirm](docs/screenshots/reject-confirm.png) · [race](docs/screenshots/race.png) · [stop-confirm](docs/screenshots/stop-confirm.png) |
| 截图提问 | [capture-edit](docs/screenshots/capture-edit.png) · [capture-confirm](docs/screenshots/capture-confirm.png) · [shot-card2](docs/screenshots/shot-card2.png) |
| 发送 / 拖放 | [send](docs/screenshots/send.png) · [send-done](docs/screenshots/send-done.png) · [send-fail](docs/screenshots/send-fail.png) · [drop](docs/screenshots/drop.png) · [drop-confirm](docs/screenshots/drop-confirm.png) |
| 状态 | [empty](docs/screenshots/empty.png) · [unread](docs/screenshots/unread.png) · [offline](docs/screenshots/offline.png) · [presenting](docs/screenshots/presenting.png) |
| 设置 / 风格 | [settings](docs/screenshots/settings.png) · [settings-dialog](docs/screenshots/settings-dialog.png) · [density](docs/screenshots/density.png) · [whales](docs/screenshots/whales.png) |
| 真机 | [desktop-with-widget](docs/screenshots/desktop-with-widget.png) · [standalone-screen](docs/screenshots/standalone-screen.png) · [desktop-widget-final](docs/screenshots/desktop-widget-final.png) |

## 现状

- 宿主插件已装进 desktop profile，`/xj/state` 返回真实会话；独立窗由 DSH 启动时拉起（或双击 `standalone-py/启动哦鲸鲸.cmd`）。
- 已接真数据：四形态渲染、状态真值表、双角标、未读制、内嵌审批（通过 / 拒绝 / 幂等 / 409 竞态）、截图提问。
- 还没接：会话卡「停止」、输入条发文字、拖文件进会话（按钮已隐藏，不会点了报错）。
- DSH 插件宿主跑在 `utilityProcess` 里，拿不到 `BrowserWindow`，所以跨应用常驻必须靠 `standalone-py/` 这个独立程序。

## 隐私

只监听状态事件与审批请求，**不读对话正文**；命令/参数只在内存里拼一句摘要，不落盘；
所有路由只接受 `127.0.0.1`/`localhost`/`[::1]`，带 `Origin` 必须同源，写操作只收 `POST` + `application/json`。

## 许可

MIT。鲸鱼 SVG 造型与全部状态装饰为自绘；角色头像素材来自 [DeepSeek-Balance-Whale-Widget](https://github.com/lvxingye/DeepSeek-Balance-Whale-Widget)，换成自己的图后跑 `tools/prep-avatar.py` + `tools/build-plugin.mjs` 即可。
