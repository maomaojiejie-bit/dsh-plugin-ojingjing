# 哦鲸鲸 · 改进与新增功能任务清单

> v0.5 规划 · 2026-10-20 · 状态：**P0 全部完成**（A1/A2 主体 + A3 + B1 + C1 + C2 + D1 + E4 + F1 + F4）；其余 P1/P2 待办
> 2026-10-21 更新：A1 收尾完成——独立窗换成 C# + WebView2（[`standalone-cs/`](standalone-cs/)，1.17MB / 240fps），
> 页面整份内嵌进 exe（DSH 没开也是真面板），截图提问、外壳设置窗、托盘、开机自启、DSH 退出跟随全部搬齐；
> PySide6 旧壳整条删除（源码 / spec / PyInstaller 打包链 / install 里的 venv 后备路线）。
> 优先级：**P0** = 本版必做 · **P1** = 本版争取 · **P2** = 排队
> 工作量：S = 半天内 · M = 1-2 天 · L = 3 天以上

---

## 总览

| # | 任务 | 模块 | 优先级 | 量 | 风险 |
|---|---|---|---|---|---|
| A1 | 独立窗口与插件分离，悬浮窗成为独立应用 | 架构 | P0 | L | 中 · **已完成（C# + WebView2 外壳）** |
| A2 | 打开 DSH 立刻自动连接（含苏醒动画） | 架构 | P0 | M | 低 · **发现/降级已落地，苏醒动画待 B3** |
| A3 | 陪伴时长记录系统 | 新功能 | P0 | M | 低 · **已完成** |
| B1 | 深睡停呼吸 + 正弦微浮动 | 动画 | P0 | S | 无 |
| B2 | 视线跟随鼠标 | 动画 | P1 | M | 低 |
| B3 | 苏醒/入睡两段式过渡（灰度沉睡→彩光复活） | 动画 | P1 | M | 低 |
| B4 | 形态切换 spring 化 + 内容独立 crossfade | 动画 | P1 | M | 中 |
| B5 | 点击 Q 弹 / 拖拽甩抛物理 | 动画 | P2 | M | 中 |
| B6 | 动画前后帧率实测固化为流程 | 动画 | P1 | S | 无 · **已完成（tools/dev/fps-probe + scroll-bench/scroll-wheel）** |
| C1 | 补 embed.js 的 prompt() 通道（内嵌态文字发送） | 通道 | P0 | S | 无 · **已完成（含单图内联）** |
| C2 | /xj/stop 路由 + 会话卡「停止」 | 通道 | P1 | M | 中 · **已完成** |
| C3 | 拖文件进会话 | 通道 | P1 | S | 低 |
| D1 | 只读审批批量放行 + 键盘流（1/2 键） | 审批 | P0 | M | 低 · **已完成** |
| D2 | 审批倒计时环（5 分钟 fail-closed 可视化） | 审批 | P1 | S | 无 |
| D3 | 审批风险分级着色 | 审批 | P1 | S | 无 |
| D4 | 自动放行 allowlist（保守设计，默认全关） | 审批 | P2 | M | 高 |
| E1 | 停滞检测（会话 N 分钟没动静→冒泡） | 新功能 | P1 | S | 无 |
| E2 | 晨间摘要 / 今日日报 | 新功能 | P2 | S | 无 |
| E3 | 系统 toast 通知（全屏不错过审批） | 新功能 | P1 | M | 低 |
| E4 | 双击鲸鱼直达最新待办 | 新功能 | P1 | S | 无 · **已完成** |
| E5 | 静音单会话 / 专注模式 / 免打扰时段 | 新功能 | P1 | M | 低 |
| E6 | 成本预测条 + 预算告警 + CSV 导出 | 新功能 | P1 | S | 无 |
| E7 | 会话计时器（已跑 12:34） | 新功能 | P2 | S | 无 |
| E8 | 状态时间线导出（不含正文） | 新功能 | P2 | S | 无 |
| E9 | 诊断包一键导出 | 工程 | P1 | S | 无 |
| E10 | 桌面歌词式浮层（第二窗口 + 鼠标穿透） | 新功能 | P2 | M | 中 |
| F1 | render 前置状态签名闸门 | 工程 | P1 | S | 无 · **已完成（lastStageHTML + enterKey 闸门）** |
| F2 | 前端冒烟测试 + GitHub Actions | 工程 | P1 | M | 低 |
| F3 | mock / embed 双跑契约测试 | 工程 | P2 | M | 低 |
| F4 | README ⛔ 清单更新（点击穿透已实现等） | 工程 | P0 | S | 无 |

---

## A. 架构（本版重点）

### A1 · 独立窗口与插件分离，悬浮窗成为独立应用 【P0 · L】

**现状**：独立窗的页面从 DSH 的 `http://127.0.0.1:<port>/xj/app.html` 加载——DSH 没开或插件没装，窗口一片白。exe 只是"外壳"，不是"应用"。

**目标**：哦鲸鲸独立窗成为**自包含应用**——自带页面资源，DSH 开着就自动连上真数据；DSH 没开就显示**内置的同一份页面**（球转黑白 + 灰虚线环，面板照样能翻开），不白屏、不报错。

**做法**：
1. 外壳内置一份页面资源（**已按 C# 壳的 `payload.zip` + 虚拟主机方案落地**；最初设想是 PySide6 起一个仅回环的 `http.server`）；
2. 连接模型改为**端口发现 + 轮询**：沿用设置里已有的发现顺序（`runtime.json` → `43120` → 上次成功端口），连上即切 online，连不上保持 offline 灰度态；
3. 插件（`lib/index.js`）职责**退化为纯数据 API**（`/xj/*`），不再承担页面托管；DSH 关闭时鲸鱼是否退出仍是托盘可选项（默认不退，转离线态）；
4. 版本管理：外壳记录自己内置的页面版本号，与插件 `/xj/state` 的 `api_version` 对不上时 toast 提示"插件版本较旧，部分功能可能不可用"，不阻塞使用。

**风险**：静态资源服务要守回环边界（只绑 `127.0.0.1`）；DSH 端口被别的程序占用时的误判（`/xj/state` 返回非 JSON 即视为不是 DSH，继续找下一个候选）。

**依赖**：无。**这是 A2/A3 的前置。**

**落地（2026-10-20，PySide6 版做法，已随旧壳删除）**：`build-plugin.mjs` 第 6 步把 `web/` 镜像到 `standalone-py/shell-res/`；
`ojingjing_py.py` 新增 `LocalServer`（仅回环、固定端口 43121 起）托管页面，`/xj/*` 里的数据接口
反向代理到 DSH（剥掉 Origin / Sec-Fetch-*，否则插件 `security()` 会 403）；资源缺失自动回退老路径。
**未做**：版本不一致的 toast（现在只把 `api_version` 记进日志）。

### A2 · 打开 DSH 立刻自动连接 【P0 · M】

**现状**：自动拉起配置（`~/.dsh/ojingjing-shell.json`）已经做到"DSH 启动 → 拉独立窗"，但窗口起来后连不连得上 DSH 靠运气——端口发现只在页面加载时试一次。

**做法**：
1. 连接状态机显式化：`offline → discovering → online`， discovering 态每 2s 重试候选端口，成功后记忆"上次成功端口"优先；
2. 连上那一刻触发**苏醒动画**（见 B3）：灰度沉睡 → 彩光复活，配合台词"老大，连上了"；
3. DSH 关闭 → 1 分钟内切 offline 灰度态（现有逻辑保留）。

**依赖**：A1（页面不再依赖 DSH 托管后，重连逻辑才干净）。

**落地（2026-10-20）**：`Upstream` 后台线程每 2s 探一次，候选 `XJ_DSH_BASE` → 上次成功端口
（`%APPDATA%\ojingjing\endpoints.json`）→ `settings.port` → `43120`；判定标准是 `/xj/state`
返回带 `api_version` 的 JSON。代理连续失败即 `mark_down()` 回到发现态；页面侧走
`reconnecting →（20s）→ offline` 灰度（2026-10-21 老大拍板从 30s 调快到 20s，和 C# 外壳
「页面探活 20s 连不上转离线态」同一个阈值）。**未做**：苏醒动画与「老大，连上了」台词（等 B3）。

**补丁（2026-10-21 晚，C# 壳 · 最终版）**：外壳侧彻底改成**自带完整页面**——`web/` 打进 exe
（`payload.zip` + `SetVirtualHostNameToFolderMapping` 挂 `https://ojingjing.local`），DSH 没开也导航
同一个真面板，不再是自绘占位卡（中途试过的「黑白沉睡鲸鱼卡 + 8 条文案轮播 + 236x264 卡片」已全删）。
探活成功走插件服务器，失败走内置副本；页面已在而服务器掉线时**绝不覆盖**，只推 `connection:offline`
让前端自己切黑白球 + 灰虚线环。顺带修了两个硬伤：①「导航失败重试」在 DSH 没开时会闪 Chromium
错误页 → 改**探活再导航**；② WinForms WebView2 不会自己初始化（老代码靠 `web.Source` 间接触发）→
显式 `EnsureCoreWebView2Async()`。文案侧另加了不跟状态走的万能闲聊池（`lines.js` 的 `POOLS.fun`）。

### A3 · 陪伴时长记录系统 【P0 · M】

**需求**（老大原话）：悬浮球记录陪伴时长。

**设计**：
- **语义**：窗口存在 **且** 用户近期有交互（鼠标/键盘，5 分钟内）才算"陪伴"——挂机一夜不算，那只是鲸鱼在守着；
- **数据存哪**：`standalone-py/data/companionship.json`（外壳数据目录，经 QWebChannel 桥读写）。理由：① A1 之后页面来源会变，localStorage 跟着失效，必须有个不随页面源漂移的存储；② 外壳知道窗口真实可见性，语义最准；
- **记录字段**：`first_met`（首次相识日期）、`total_sec`（累计）、`today_sec` + `today`（跨天归零）、`streak_days`（连续陪伴天数）；
- **展示**：面板新增「陪伴」卡——"今天陪你 3 小时 12 分 · 相识第 47 天 · 累计 128 小时"；空闲气泡台词池（`lines.js`）加陪伴类句子；
- **里程碑庆祝**：1h / 10h / 100h / 500h / 1000h → 鲸鱼放星星 + 专属台词 + toast。数据在壳里存，庆祝在页面里演；
- **隐私**：纯本地，不出本机，README 隐私章节补一句。

**依赖**：A1（存储落地在外壳）。

**落地（2026-10-20）**：`Companionship` 在 `ojingjing_py.py` 里，15s 一拍；「人在不在」读
`GetLastInputInfo`（全系统最后一次输入时间，不装钩子）。落盘改到 `CONFIG_DIR/companionship.json`
（= `%APPDATA%\ojingjing\`，和 settings / window.json 挨着）——ROADMAP 原来写的 `standalone-py/data/`
只是配置目录的**兜底**位置，跟着现有约定走更省事。面板「陪伴」条 + 里程碑（星星 + 台词 + toast，
每档一次）都已接上，页面经 `companionData` 信号取数。

**补丁（2026-10-21，C# 壳）**：A1 换 C# + WebView2 外壳后这座桥没搬过去——新窗口里陪伴计时
不显示（`window.xjNative` 只在 Qt 壳存在）。已修：`standalone-cs/Companionship.cs` 逐条移植
py 版账本（同一个 json，两壳可来回切换；15s tick / GetLastInputInfo 判活跃 / 跨天连击 / 里程碑
全部同语义），`OverlayForm` 起 15s 计时器、退出强制落盘，`Bridge` 接 `{type:"companion"}` 请求；
页面侧 `refreshCompanion` 在没有 QWebChannel 时改走 `XJ.embed.post`，`embed.js` 把外壳回推的
`{type:"companion"}` 转交 `app.companionData`。端到端探针验证通过（假 WebView2 桥跑通
请求→回推→陪伴条渲染→里程碑 toast→放星星）。

**修崩溃（2026-10-21 下午）**：老大实机跑到 .NET 未处理异常对话框——`CheckMilestone` 把
`milestones` 强转 `List<object>`，而 `JavaScriptSerializer` 把 JSON 数组反序列化回来是
**`ArrayList`**。触发链：账本落盘（60s 存 / 退出存）→ 重启外壳 → 第一个 active tick
（启动 15s、窗口可见、人有输入）→ 强转炸。UI 线程异常原来的 `AppDomain` 处理器接不住
（WinForms 走 ThreadException），所以用户看到的是原始 .NET 对话框。修法：`AsList()` 认
`IEnumerable`（字符串除外）+ `Program.cs` 补 `Application.ThreadException`（记全栈 + 人话
提示，继续跑）。回归固化为 `tools/dev/comp-check.mjs`（csc 编译 + 四组毒数据：数组/空数组/
null/无文件，11 断言）。

---

## B. 动画流畅度与表现力

> 审计结论先说：**大头已经榨干**——DOM 重建前的 HTML diff 闸门、只动 transform/opacity、`xj-sw` 软件光栅降级、滚动暂停、静止帧、按时间插值的缓动，都已到位。剩下的是①闲置态省 CPU ②表现力升级。外部参考见文末。

### B1 · 深睡停呼吸 + 正弦微浮动 【P0 · S】

- 入睡持续数分钟后停掉 `whaleBreath`（transform 回 `scale(1)` 无跳变），zzz 保留——idle 是最长驻状态，分层透明窗里每帧都是 CPU；
- 参考"生命律动"手法：叠加一层 **0.3-0.5px 振幅、3s 周期、相位随时间漂移**的正弦微浮动（只加在角色头像版 `.whale-av` 上）。实测 >2px 就显得画面在晃，0.5px 以下人眼读作"活着"而不是"抖动"；
- 登记进 §21/§22 既有清单，不新增特例。

### B2 · 视线跟随鼠标 【P1 · M】 ✅ 已落地（2026-10-21）

- 参考 Claw Desktop Pet 的 15 种眼部表情之"follow mouse"：鲸鱼眼睛/眼白以 **±4° 内的小角度**跟随指针；
- 用 spring 插值（stiffness ~100-200，damping ~15-20）追踪指针，**不要直连**——直连显得机械，spring 给出"注意到了、看过去"的迟滞感；
- 只在收起态/气泡态启用；面板开着时不跟（用户在操作，别抢戏）；软件光栅下降级为关；
- 2D 分解成 X/Y 两个独立 spring，避免斜向移动时不同步。

**实现要点**：没上 JS spring——那意味着指针每动一下合成器就出一帧，分层透明窗里就是一帧整窗重绘。改成「rAF 合并 + 只写两个 CSS 变量，平滑交给 CSS transition」（220ms ease-soft），常驻零开销。幅度按结构分两档：SVG 几何版眼珠 ±1.2 viewBox 单位（≈±1.7px），角色头像版整脸 ±0.7px。**独立 `scale` 属性叠加方案**：各态表情的 scaleY（alert 瞪眼 1.18 / sleep 闭眼 0.16）从 `transform` 搬到独立 `scale` 属性，跟随写 `transform: translate()`——渲染顺序 translate→rotate→scale→transform，两者叠加不互踩（早年 transform 版本特异性 (0,4,0) 吞过 alert 瞪眼）。睡觉/离线/拖动中/reduce-motion/静息/滚动中全不跟，§21/§22 已登记。回归：`tools/dev/anim-check.mjs`。

### B3 · 苏醒/入睡两段式过渡 【P1 · M】 ✅ 已落地（2026-10-21，简版）

- 参考 Claw 的 "gray sleep → colorful revival with particles"：offline→online 不再硬切，先一圈微小粒子/星光从鲸鱼身上散开，同时灰度褪去、色彩涌回，最后换表情；
- 入睡反向：先 `zzz` 飘两朵，再整体灰度；
- 现有 `xj-swap`（缩放淡入）作为 reduced-motion / 软件光栅下的保底。

**实现要点**：落地的是「两段式」骨架而非完整粒子版——`whaleWake`（700ms spring：translateY(3px) scale(0.93) → 过头 → 回位，苏醒后 260ms 补一次眨眼，读作「X 眼收回 + 睁眼」）/ `whaleDoze`（320ms 垂头 scale 0.97）。检测放在 diff 闸门**之前**：reconnecting→online 时 orb HTML 只差一个 class，闸门会整段跳过，所以另给 orb 加了 `is-reconnecting` class 让连接态变化必触发重建（顺手也让重连态有样式可挂）。panel 形态不记 pending（没有鲸鱼，几十秒后关面板不该补播陈年动画）。粒子/星光是表现力选项，留作后续增强，骨架已在。

### B4 · 形态切换 spring 化 + 内容独立 crossfade 【P1 · M】

- 参考灵动岛拆解（godui）：**外壳与内容两套独立系统**。外壳（stage 容器）的尺寸/圆角变化走 layout + 一个偏刚的 spring（CSS 侧用 `cubic-bezier` 近似 Apple 的 stiffness 520 / damping 32，带一点 rubbery overshoot）；**内容不跟着外壳的曲线**，独立走 200ms 的 opacity 1→0 / scale 1→0.9 / blur 0→4px crossfade；
- overshoot **只在硬件模式开**，软件光栅保持现有 ease-out（每多一帧过冲都是 UpdateLayeredWindow 的全窗重绘）；
- 原则：形态只在"设计好的几个状态"间过渡，不做连续形变。

### B5 · 点击 Q 弹 / 拖拽甩抛物理 【P2 · M】 🔸 Q 弹已落地（2026-10-21），甩抛未做

- 参考 dsh-pet（Fat 鱼，DSH 生态同类）：点击鲸鱼 squash-and-stretch Q 弹；拖拽释放按指针速度抛物线落位 + 回弹，而不是松手即停；
- 拖拽开始时暂停待机动画，避免两套 transform 打架（现有 dragging class 已部分处理）；
- 风险中：物理感调参依赖肉眼，必须配截图/录帧验证，排 P2。

**实现要点**：Q 弹（orbTap 460ms 两段式 squash&stretch）已落地，三个实测坑已修：① 点击时先摘悬停预备（orbArm 的 `both` 填充 + 更高特异性会盖住 Q 弹，且语义上「点了就该让位给点击反馈」）；② Q 弹必须放在形态切换**之后**加——setForm 是同步全量重建，提前加类会连旧 orb 一起被 replaceChildren 吞掉；③ 反馈与行为解耦——「刚被悬停撑开就点上来」的保护分支也要弹，否则悬停预备比 tap 早 1ms 到期时 Q 弹被静默跳过。甩抛物理仍未做（P2 风险项，需录帧调参）。

### B6 · 帧率实测固化为流程 【P1 · S】

- `tools/dev/fps-probe.mjs` 已有：每个动画任务改前改后各跑一次，记录空闲 CPU / 帧间隔中位数 / 交互期（展开面板、滚动列表）帧率；
- 结果写进任务提交说明，不凭感觉说"流畅了"。

---

## C. 通道补齐

### C1 · 补 embed.js 的 prompt() 【P0 · S】

- 现状：`web/embed.js` 的 `prompt()` 是 `unsupported` 桩，composer 走 `XJ.mock.harness.prompt()`——**内嵌插件态输入条是死的**，只有独立窗能发；
- 实现 `prompt(sessionId, {text})` → `POST /xj/prompt`（协议层 image 可选、纯文字可投，已核实）；
- 顺手支持图片附件内联（dataURL → base64），拖文件/粘贴截图在内嵌态一起解锁；非图片附件给明确报错；
- `stop()` 无宿主路由，保持 unsupported 并注释原因（等 C2）。

### C2 · /xj/stop + 会话卡「停止」 【P1 · M】

- 先探 DSH `sessionController` 有无 interrupt/stop 能力（读宿主类型定义）；
- 有 → 加 `POST /xj/stop` + 会话卡停止按钮（幂等、409 竞态处理同 decide）；
- 没有 → 按钮继续隐藏，README 清单如实写"宿主未提供"。

**落地（2026-10-20）**：宿主有 `sessionController.cancel({ sessionId })`（`dsh-api-session-controller`），
语义是 `agent.cancel({kind:"user"}, {keepInbox:true})`——只停当前这一轮，排队消息保留。
`POST /xj/stop` 已加，`web/embed.js` 的 `stop()` 接上，会话卡的停止按钮原本就在（只有 working 态渲染），
现在真的能按了。**按钮一直没被隐藏**，README 里「按钮已隐藏」那句是过时的，已改。
踩到的坑：`RemoteError` 的错误码是**字符串** `session/not-found`，`Number()` 得 `NaN`，
照 prompt 那套 `Number.isFinite` 判会一律落到 502 —— 已单独映射成 404 并加了断言。

### C3 · 拖文件进会话 【P1 · S】

- C1 的图片内联通路建成后，拖文件 = 选会话 + 同一个 `/xj/prompt`；
- 文件大小走宿主 `imageLimits` 上限，超限 toast 明说。

---

## D. 审批体验（每天点几十次的人真正的痛点）

### D1 · 只读批量放行 + 键盘流 【P0 · M】

- 宿主 `riskOf()` 已把审批分 `read/network/write/exec/danger` 五档推给浮窗——数据侧零成本；
- 待办区按 risk 排序 + 着色（read 灰蓝 / danger 标红）；「通过全部 read 档」按钮（后端循环 decide 或加批量路由，幂等键照旧）；
- 键盘流：审批卡聚焦时 `1`=通过 `2`=拒绝、`←/→` 切卡；
- danger 档强制逐个确认，不进批量。

**落地（2026-10-20）**：排序和着色本来就有（`pendingList` 按 `RISK.rank` 降序、`riskTag` 带 `.risk-{档}`），
所以这条只补了后半截：`approveAllRead()` 串行放行 `risk === "read"` 且 `status === "pending"` 的条目
（幂等键照旧 `id + ":allow"`，409/404 当作「别处已处理」不算失败，只弹一条汇总 toast）；
面板首页加 `s.ui.pendingCursor` + `←/→` 换钉着的那张卡，`1/2` 通过/拒绝，`danger` 要连按两次。
**安全边界**：三个前提（panel + home + 光标不在输入框）缺一不可，否则在输入框里敲 `1` 会批文件 ——
这条单独用探针钉过。

### D2 · 审批倒计时环 【P1 · S】

- 审批 5 分钟没人点就 fail-closed，Agent 干等。鲸鱼光环加一圈进度环显示剩余时间，剩 1 分钟变急（闪）；
- 纯前端：条目带 `requestedAt`（宿主已有，需确认 `/xj/state` 有透出；没有就加）。

### D3 · 风险分级着色 【P1 · S】

- D1 的展示部分可独立交付：命令按 risk 档着色 + tooltip 说明为什么是这档。

### D4 · 自动放行 allowlist 【P2 · M · 高风险】

- 设置里配只读 pattern（如 `^(ls|cat|git status)`），命中的审批宿主侧直接作答不推浮窗；
- 安全边界：**默认全关**、只允许用户显式添加的 pattern、启动时 toast 一次"当前有 N 条自动放行规则"、danger 档永不自放；
- 排在 D1 用顺之后。

---

## E. 新功能

| # | 功能 | 一句话 |
|---|---|---|
| E1 | 停滞检测 | 会话 working 但 N 分钟没事件 → 鲸鱼冒泡"会话 X 已经 12 分钟没动静，要看看吗" |
| E2 | 晨间摘要/日报 | 早上第一次开面板："昨晚 3 个跑完 / 1 个失败 / 花了 ¥x"；下班点鲸鱼出全天摘要 |
| E3 | 系统 toast | 全屏游戏时审批走 Windows 通知中心（Qt 托盘 `showMessage`，零新依赖），点击直达；和免打扰联动 |
| E4 | 双击直达待办 | 有待办时双击鲸鱼直接弹第一张审批卡，没待办才开面板 |

**落地（2026-10-20）**：面板本来就把第一张待办钉在顶上（§8.3），所以「直达」要解决的是手势和注意力，
不是滚动 —— 双击后给那张卡加 `.xj-attn` 亮 1.2s（只动 border-color，不碰它原本的两层阴影）。
**顺带修了个更严重的问题**：独立窗里 `orbPointerDown` 一按下就 `SendMessage(WM_NCLBUTTONDOWN)` 并 `return`，
指针被系统移动循环抢走、页面收不到 `pointerup`，所以**单击鲸鱼在独立窗里一直是没反应的**。
现在改成移动超过 4px 才交给系统，没移动就是一次「点」。有待办时单击延后 260ms 给双击让位
（只在有待办时延后，否则单击要多等一拍）。
| E5 | 声音管理 | 静音单会话（长按会话卡）/ 专注模式（只放行 danger 级通知）/ 免打扰时段 |
| E6 | 成本管理 | 按当前速度预测今日花费；超预算阈值鲸鱼变琥珀+气泡；usage 导出 CSV |
| E7 | 会话计时器 | 每张卡显示"已跑 12:34" |
| E8 | 时间线导出 | "14:02 会话A开工 → 14:15 请求批准 rm → 14:31 完成"，不含正文，Markdown/CSV |
| E9 | 诊断包 | 设置里一键导出（版本/连接/最近事件/shell 日志路径）打 zip，用户直接贴 issue |
| E10 | 桌面歌词浮层 | 参考 Claw 双窗架构：鲸鱼说话时旁边浮一层白光打字机文字，鼠标穿透、说完自动淡隐。第二窗口由外壳管 |

---

## F. 工程化

- **F1 · render 前置签名**（P1·S）：1s/2s/2.6s 三个定时器目前每跳都建 frag + 序列化 outerHTML 比对。加 20 字符状态签名（form+connection+level+counts+关键状态），一致直接 return；
- **F2 · 冒烟测试 + CI**（P1·M）：`tools/shoot.mjs` 的 CDP 基础设施扩一个套件（四形态渲染/审批流/离线降级/409 竞态），接 GitHub Actions；
- **F3 · mock/embed 双跑契约**（P2·M）：`test-host.mjs` 的 16 项断言扩成同一份用例双跑，防两份 harness 漂移；
- **F4 · 文档还债**（P0·S）：README/PLUGIN 的 ⛔ 清单更新——点击穿透前端已实现（`pointer-events` 路线，`styles.css` §6.9）；纯文字 prompt 协议层早已支持；E 类功能上线后同步"现状"章节。

---

## 需要老大拍板的决策点

1. **A1 的页面资源内置方式**：Qt `qrc` 编译进二进制（改页面要重编译）vs 外壳目录散文件 + 相对路径加载（改页面只覆盖文件）。推荐后者，开发迭代快；
2. **A3 陪伴时长的存储**：推荐外壳 data 目录（页面源漂移不丢）；如需 DSH 侧也能读到（比如插件想报"今日陪伴"），则改存插件 `~/.dsh/ojingjing-companionship.json`，页面经 `/xj/*` 读写；
3. **D4 allowlist 的默认值**：推荐默认全关 + 显式开启；
4. **发布节奏**：A/B/C 做完先内部装起来用几天，还是直接发 v0.5.0？

---

## 动画参考来源（2026-10-20 检索）

| 参考 | 用上的点 |
|---|---|
| [Claw Desktop Pet](https://github.com/kk43994/claw-desktop-pet)（Electron 双窗玻璃球宠物） | 双窗口架构（精灵窗+歌词窗）、视线跟随鼠标、灰度沉睡→彩光复活+粒子、7 色心情系统、鼠标穿透浮层 |
| [Anatomy of the Dynamic Island](https://godui.design/docs/lab/overlays/dynamic-island/learn) | 外壳 spring（520/32）与内容 crossfade 两套独立系统；只在设计好的状态间过渡；空闲零成本；reduced-motion 分别门控 |
| [Spring Animations 参考](https://github.com/firstsun-dev/skills/blob/main/plugins/frontend-product-design/skills/ui-animation/references/spring-animations.md) | spring 参数预设（Snappy 500/40、Bouncy 300/20）；鼠标追踪用 spring 不直连；2D 分解 XY；从当前值打断、携带速度重定向 |
| [灵动岛动画细节（网易）](https://www.163.com/dy/article/HTMET0P905169V9M.html) | 预备动作（先蹲后跳）、挤压与拉伸、合并/分裂的动能传递、模糊暗示层级 |
| [智能桌面宠物开发实战](https://kwkr.cn/news/567508) | 呼吸动画 opacity 比 scale 更省（alpha 不触发重绘）；睡眠态 8s 周期、下界 0.6；超时兜底台词 |
| [手机桌面宠物（CSDN）](https://blog.csdn.net/coffee/article/details/161734139) | 0.3-0.5px 正弦微浮动"生命律动"（>2px 即显坏）；onTouch 零延迟 |
| [dsh-pet / cute-fat-fish-pet](https://github.com/12we21/cute-fat-fish-pet)（DSH 生态桌宠） | 点击 Q 弹、拖拽甩抛反弹、随机动作轮换、右键点播、多开同屏、webm 透明动画格式 |
| [Whaleharbor 鲸娘桌宠](https://dshpluginhub.ai/en/plugins/duke-dsh-plugins-dsh-whaleharbor-pet)（DSH 生态桌宠） | 八种状态表情映射（idle A/B 轮换、忙碌、审批红 !、提问蓝 ?）、CSS 纸片人拆件、60fps |
