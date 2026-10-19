# 把「哦鲸鲸」装进 DSH（插件形态）

这一版把原型包成了 **DSH bundle 插件**：宿主插件（Node）负责汇总会话状态、
接管浮窗能处理的审批、提供 `/xj/*` 路由（含截图提问投递）；可选把独立桌面窗拉起来。
原型代码零改动，`file://` 打开仍然是完整可点的 M2 原型。

## 包格式（对齐 DSH 插件规范）

**仓库根目录就是插件包**，形状与 `dsh-plugin-kit` 的 `templates/hello`、`dsh-whale-widget@0.4.2` 这类已装 bundle 一致：

```
package.json          # name/version/type/main/exports/icon/files/license
                      #   main → lib/index.js
                      #   dsh.manifestVersion → 1
                      #   dsh.bundle.patch → ./cordis.patch.yml
                      #   dsh.engines.dsh → >=0.1.7-rc.2
cordis.patch.yml      # - insert: [{ id: dsh-plugin-ojingjing, name: dsh-plugin-ojingjing }]
lib/index.js          # 入口：export default { name, apply(root) { … } }
web/icon.png          # 插件图标（也是托盘/exe 的来源）
web/app.html          # 由 tools/build-plugin.mjs 从 app/index.html 生成
web/embed.js          # iframe 内：XJ.embed + 真数据 Harness（/xj/state、/xj/decide、/xj/answer、/xj/prompt）
web/embed.css         # 嵌入态样式（透明底、隐藏演示桌面/原型控制台/输入区）
web/inject.js         # 页面内注入版用（默认关闭 INJECT_IN_PAGE=false）
web/static/src/**     # 原型源码副本（构建产物，来自 app/src/；esbuild minify + 剥离 mock/devbar）
LICENSE               # 随包发布（MIT）
```

`app/`（原型）、`standalone-py/`（桌面外壳）、`tools/`、`docs/` 是随仓库带的配套内容，
**不在 `files` 白名单里**，`npm pack` 实测只出 31 个文件（`package.json` 的白名单就是安装边界的唯一真源：
`dsh plugin add` 按 tgz 装，`tools/install.mjs --direct` 直接照着它复制）。

约定（与参考插件一致）：

- 入口导出 Cordis 插件对象 `{ name, apply(root) }`，**不用对象级 `inject`**——`apply()` 立刻执行，
  需要服务的逻辑各自 `root.inject([...], cb)`，避免宿主启动时那次注入表收集被推迟；
- 卸载收尾挂 `root.effect(() => () => …)`；`root.on` / `ctx.webServer.register` 注册在插件作用域里，
  随插件卸载回收；只有 `spawn` 出来的独立窗进程由 `root.effect` 里 `stopShellIfOwned()` 手动收；
- 服务从 `root.inject` 的局部 ctx 拿（`ctx.webServer.register(...)`、`sctx.sessionController.prompt(...)`），
  日志走 `root.logger.info`；
- profile 安装登记在 `dsh.profile.bundles`，patch id / name 与包名一致。


## 跟 DSH 联动：打开 DSH 就自动打开哦鲸鲸

宿主插件跑在 DSH 的宿主进程里，能拿到 Node 的 `child_process`，所以「DSH 启动 → 独立窗出现」
就是插件加载时 fork 一个 `pythonw`：

1. `tools\install.mjs` 第 6 步写 `%USERPROFILE%\.dsh\ojingjing-shell.json`（`tools\shell-config.mjs`），
   内容是外壳目录 + 解释器候选（venv 优先，其次系统 Python，最后 `pyw.exe`）；
2. 插件 `apply()` 末尾调 `launchShellIfNeeded()`：文件存在、`autoLaunch !== false`、脚本和解释器
   都在 → `spawn(pythonw, [ojingjing_py.py], { detached: true, stdio: "ignore", env: { XJ_LAUNCHED_BY: "dsh" } })`；
3. 幂等两层：插件里 `shellSpawned` 只拉一次；外壳自己有命名互斥量，重复启动会自我退出。

**关掉自动启动**任选一种：

- 编辑 `~/.dsh/ojingjing-shell.json`，把 `"autoLaunch"` 改成 `false`（保留文件）；
- 或直接删掉这个 json；
- 或 `node tools\uninstall.mjs`（连插件一起卸）。

**反向（DSH 关闭 → 哦鲸鲸退出）** 是可选项，默认关：托盘「设置…」里勾「DSH 关掉后自动退出」，
勾上后外壳每 15s 探一次 `/xj/state`，连续约 1 分钟不通就自己退。

验证这条联动（会真的拉起一个实例）：

```powershell
node tools\test-shell-launch.mjs
# 配置存在: true / 拉起前实例数: 0 / host: [ojingjing] 已拉起独立窗: …pythonw.exe …ojingjing_py.py
# 拉起后实例数: 2（venv 转接 + 真解释器，算一个实例）/ 二次调用后实例数: 2（幂等）
```

## 一、构建

```powershell
cd C:\Users\17897\Desktop\new\ojingjing-widget
node tools\build-plugin.mjs      # 重新生成 web/app.html + web/static/src（minify + 剥离 mock/devbar）
node tools\build-exe.mjs         # 打 Windows 分发版：PyInstaller onedir + 裁语言包 → dist/Ojingjing（约 425MB）
```

`build-plugin.mjs` 的 minify 走 esbuild（可选依赖，装在受管 node workspace：
`cd %USERPROFILE%\.workbuddy\binaries\node\workspace && npm install esbuild`），找不到就原样拷贝。
`build-exe.mjs` 会自动挑解释器（venv python 优先，坏了退回系统 Python + PYTHONPATH），
PyInstaller 没装会先自动补。

## 二、安装

### A. 脚本（推荐）

```powershell
node tools\install.mjs                   # 全套：构建 → npm pack → dsh plugin add → venv 依赖 → 自动拉起配置
node tools\install.mjs --dry-run         # 只打印将执行的命令
node tools\install.mjs --relaunch        # 装完顺手把 DSH 拉起来
node tools\uninstall.mjs                 # 回滚：摘插件 + 去登记 + 停独立窗 + 删自动拉起配置
node tools\uninstall.mjs --purge         # 连 .venv / data（含 API key）/ 日志 / dist 一起清
```

双击等价物：`安装到DSH.cmd`、`从DSH卸载.cmd`（故意只写 ASCII——cmd 按 OEM 码页读批处理，中文会变乱码，
所有中文提示都由 node 脚本打）。

装到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-ojingjing`（第 4 步走 pnpm），
并在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里登记：
`dsh plugin add` 成功后它的 `reconcile()` 一般会自己登记，脚本再补一次落地校验——没登记就手动写进数组
（原文件备份为 `package.json.bak-<时间戳>`）。**不登记不加载。**

> **必须用 DSH Desktop 自带的 dsh**，即
> `%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd`。
> 它设好 `ELECTRON_RUN_AS_NODE=1` 后跑 `resources\app\lib\desktop-cli.js`，那个入口调的是
> `runCli({ manageDesktopProfile: true })` —— 只有这条路径被授权管理 desktop profile。
> 纯 CLI 版（`npm i -g @deepseek-ai/dsh`、`npx dsh`）里 `lib/bin.js` 有一条静态校验
> `rejectElectronProfile()`，profile 名是 `desktop` 就直接报
> `profile "desktop" is managed exclusively by the Electron application` 并退出——
> **这跟 DSH 有没有开着无关，是代码级禁止。** 脚本会优先去 `host-commands` 翻最新那代 shim。

> **不要直接 spawn 那个 `.cmd`**：shim 里先 `chcp 65001` 再用 `%*` 展开参数，链上任何一环按
> ANSI/OEM 码页转码，含中文的路径就会变成乱码（实测 `新建文件夹` → `鏂板缓鏂囦欢澶`，且
> `文件夹\ojingjing` 的反斜杠被双字节字符吞成 `澶筡`），pnpm 拿着不存在的路径直接 exit 1。
> `tools/dsh.mjs` 因此把 shim 拆成「`DSH Desktop.exe` + `desktop-cli.js` + 那几个环境变量」，
> 用 `spawn(shell: false)` 直接起 exe——参数走 `CreateProcessW`（UTF-16），绕开 cmd 的代码页。

> **重复安装先 `remove` 再 `add`（必须）**：pnpm 对同一个 spec 的 tarball 只比对 specifier 和版本号，
> 都没变就说 `Already up to date`，**不重新读 tgz**（2026-10 实测：改完前端重新打包再 add，
> profile 里还是旧文件）。所以脚本检测到 profile 里已有这条依赖时，会先 `dsh plugin remove` 再 `add`。
> 副作用：bundle 会排到 `dsh.profile.bundles` 末尾（功能无影响，层栈顺序而已）。

### B. 手敲 dsh CLI

```powershell
# 用 Desktop 那个 shim，别用全局 dsh，否则被静态校验拒掉
"%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd" plugin --profile desktop add "dist\dsh-plugin-ojingjing-<版本>.tgz"
# dsh plugin 只等价于 pnpm add，不一定写 dsh.profile.bundles，装完要自己检查/登记
```

`dsh plugin` 本质上就是把参数转发给 profile 目录里的 pnpm（`withFileLock` 会等在跑的 `package.json`
最多 2 分钟），所以比脚本少干了「构建 + 打包 + 登记校验 + venv + 自动拉起配置」这几步。

### C. npm 包（分发给别人）

```powershell
cd C:\Users\17897\Desktop\新建文件夹\ojingjing-widget
npm.cmd pack --pack-destination dist        # → dist\dsh-plugin-ojingjing-<版本>.tgz（约 230KB，30 个文件）
```

对方拿到 tarball 后：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm.cmd install --no-save "C:\path\to\dsh-plugin-ojingjing-<版本>.tgz"
# 再在 package.json 的 dsh.profile.bundles 里加 "dsh-plugin-ojingjing"
```

发布到 registry（有 npm 账号时）：

```powershell
cd C:\Users\17897\Desktop\新建文件夹\ojingjing-widget
npm.cmd publish --access public            # 已配 publishConfig.access=public
# 之后对方可以：npm.cmd install --no-save dsh-plugin-ojingjing
```

包内容（`files` 白名单）：`lib/index.js`（宿主插件）、`web/**`（app.html + embed + static 前端）、
`cordis.patch.yml`、`README.md`、`LICENSE`；**不含** `app/`、`docs/`、`tools/`、
`standalone-py/`（Python 外壳是独立程序，通过 `~/.dsh/ojingjing-shell.json` 联动）。`npm pack --dry-run`
已验证清单（31 个文件）；`XJ_PLUGIN_ENTRY=<tgz 解出的 lib/index.js> node tools\test-host.mjs`
能跑完整套 `/xj/*` 契约断言（16 项全过）。

## 三、生效

**重启 DeepSeek Harness Desktop**（宿主插件在主进程里注册，必须重启才加载）。
重启后应看到：

1. 右下角出现哦鲸鲸（64px 圆 + 状态光环 + 双角标）；
2. 悬停 300ms / 单击出气泡，`Ctrl+Shift+Space` 开面板；
3. 面板里出现**真实的**会话名和「N 项待确认」；
4. Agent 要执行命令时，浮窗弹出琥珀审批卡 —— 点「通过 / 拒绝」真的会作答
   （宿主注册了 `approval/request` 应答者；浮窗 20 秒内没轮询时会自动退回原审批流程，
   不会把审批吞掉）；
5. 会话跑完，浮窗右下角出现翠绿未读角标。

自检：

```powershell
node tools\check-plugin.mjs     # 探测 /xj/state、/xj/app.html 是否可用
```

## 四、这一版能做什么 / 还不能做什么

| 能力 | 状态 |
|---|---|
| 四形态（收起 / 气泡 / 快捷输入条线框 / 面板） | ✅ 真渲染 |
| 状态真值表、双角标、未读制 | ✅ 接真实 `session/event` |
| 内嵌审批（通过 / 拒绝 / 幂等 / 409 竞态） | ✅ 接 `approval/request` |
| 提问选项按钮（单选点一下 / 多选勾完提交 / 「其它…」打字） | ✅ 接 `user-questions/request`，回填走 `POST /xj/answer` |
| 截图提问（独立窗 `Ctrl+Shift+A` → 整屏 → 进会话） | ✅ 新增 `POST /xj/prompt` → `ctx.sessionController.prompt(...)`，图片走内联 base64 |
| 用量与余额（面板「今日 ¥ / 余额 ¥」+ 会话卡单价） | ✅ `lib/usage.js`：从 `assistant/message` 的真实 usage 按峰谷价目表折算，余额读 DeepSeek `/user/balance`（60s 缓存） |
| 会话卡「停止」、输入条发文字、拖文件 | ⛔ 宿主侧还没接（按钮已隐藏，不会点了报错） |
| 跨应用常驻（真桌面悬浮窗） | ⛔ 受宿主进程模型限制，见下；已用 `standalone-py/`（Python + PySide6）外壳解决 |

### `/xj/prompt` 契约（截图提问用的那条路）

```
POST /xj/prompt      Content-Type: application/json
{ "sessionId": "…", "text": "可选", "mode": "queue"|"steer",
  "image": { "mediaType": "image/png|image/jpeg|image/webp|image/gif", "data": "<base64>", "name": "可选" } }

200 { "ok": true, "requestId": "xj_…" }
400 bad_json / 413 payload_too_large / 415 unsupported_media_type / 422 missing_session|empty_content
409|503 prompt_failed（把 DSH 的 status 透出来） / 502 prompt_unavailable（没拿到 sessionController）
```

宿主侧组装成 `SessionPromptRequest`：`{ requestId, sessionId, content: [image, text?], mode }`。
上限取 `ctx.attachments.imageLimits.maxImageBytes`（通常 20MiB）。请求体上限 40MiB
（`readBody(req, 40 * 1024 * 1024)`；默认的 64KB 会把整屏截图挡成 `400 bad_json`）。
**改了这条路由要重启一次 DSH**（插件在宿主启动时加载），否则 `POST` 会落到 405。

**为什么不是真桌面窗口**：DSH 的插件宿主跑在 `utilityProcess` 里（`lib/main.js`
`utilityProcess.fork(...)`），拿不到 Electron `BrowserWindow`；桌面端只透出白名单
RPC（`show / notifyAttention / tray:set / shell:*` 等），不包含「创建我的窗口」。
所以「跨应用常驻」需要独立 exe（Tauri/WPF 外壳），这一版先做页面内浮层，
两者共用同一套 `app/src/` UI。

## 五、数据与隐私

- 只在 `127.0.0.1` 上通信；`/xj/*` 只认回环 Host、拒绝跨站标记、POST 只收 JSON；
- **不读对话正文**：只订阅会话事件里的 state / action / title；
- 命令摘要只存在内存里，进程退出即消失；不写日志、不落盘；
- 审批决定只回给 DSH 的审批流程，不额外上报。

## 六、回滚

```powershell
node tools\uninstall.mjs            # 摘插件 + 去登记 + 停独立窗 + 删 ~/.dsh/ojingjing-shell.json
node tools\uninstall.mjs --purge    # 再连 .venv / data（含 API key）/ 日志 / dist tarball 一起清
```

再重启 DSH。手工等价操作：删
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-ojingjing`，
从 profile `package.json` 的 `dsh.profile.bundles` 里去掉 `dsh-plugin-ojingjing`，
再删 `%USERPROFILE%\.dsh\ojingjing-shell.json`（不删的话 DSH 下次启动还是会去拉独立窗）。

**卸载为什么可能「不干净」**：`dependencies`、`dsh.profile.bundles`、`node_modules/<包名>`、
`pnpm-lock.yaml` 是四处独立状态，且 DSH 开着时它把 `lib/index.js` 装进内存、文件句柄不放，
Windows 不让删目录——旧脚本在删目录这步直接中断，就留下「登记摘了、目录还在」的半截现场，
下次安装还会被绊一下。`uninstall.mjs` 现在：删不掉就改名为 `<包名>.removed-<时间戳>`
（效果等同卸载，DSH 重启后加载不到它），每次运行顺手清这些残留，第 5 步校验把
`dependencies` / `bundles` / 目录 / lockfile 四处都查一遍并直说还差哪儿。
