# 哦鲸鲸 · 原型说明书

`app/index.html` 是一份**零依赖、零构建**的可点击原型：双击就能玩，所有交互都能走完，数据来自 `mock.js` 里的假 Harness。

```
app/
├── index.html      入口（双击打开）
├── dev-whale.html  鲸鱼五表情校验页（大 / 中 / 小三种尺寸并排看）
└── src/            20 个文件 ≈ 8.9k 行，全是原生 JS + CSS
```

## 怎么玩

- **双击 `index.html`** —— 出现假桌面 + 右下角鲸鱼，按引导走一遍即可；
- **状态锚点** 直接跳到某形态：`index.html#demo=panel`、`#demo=bubble`、`#demo=quickbar`、`#demo=settings`、`#demo=approvals`、`#demo=onboarding`、`#demo=unread`、`#demo=offline`、`#demo=danger`、`#demo=capture-edit`、`#demo=capture-confirm`、`#demo=drop`、`#demo=presenting`；
- **原型控制台**：`Ctrl+Shift+D` 打开，可以推送审批、推送提问、让审批在别处被处理（造 409 竞态）、断网 / 重连。

## 快捷键

| 组合 | 动作 |
|---|---|
| `Ctrl+Shift+Space` | 展开 / 收起面板 |
| `Ctrl+Shift+Q` | 光标旁唤起快捷输入条 |
| `Ctrl+Shift+A` | 截图提问（遮罩 → 框选 → 问题 → 发送） |
| `Ctrl+Shift+D` | 原型控制台（仅原型） |
| `Esc` | 逐层收起：遮罩 → 气泡 → 面板 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |

组合键在「设置 → 快捷键」里可改，会存进 `settings`。

## 四形态

| 形态 | 尺寸 | 内容 |
|---|---|---|
| 收起 | 64 | 鲸鱼本体 + 状态光环 + 待确认 / 未读双角标 |
| 气泡 | 360 | 一句话现状、3 条进行中、「展开面板 / 审批中心」 |
| 输入条 | 360 | 会话下拉 + 输入框 + 截图 / 发送，Enter 发送 |
| 面板 | 400 × 480–600 | 头部 + 审批中心 + 会话列表 + 快捷输入条 |

## 能点到的交互

- **台词**：鼠标移到收起态的鲸鱼上就自动甩一句（300ms 后随气泡一起出来），按状态分池：断线 / 待确认 / 有未读 / 正在跑 / 都清空 / 闲着；同一句不会连着出两次，句子里的 `{n}` 会换成当前的待确认或在跑数量；
- **状态真值表**：需要确认 > 工作中 > 完成未读 > 空闲 > 离线；离线时整体灰度 + 光环转虚线；
- **未读制**：完成角标只在你看过之后才清，没有计时器；
- **内嵌审批**：通过 / 拒绝 / 幂等二次确认 / 已在别处处理（409）/ 超时过期，都有对应视觉；
- **截图提问**：遮罩框选 → 可写问题 / AI 优化 / 重新截 → 卡片预览 → 发送；
- **拖放**：拖文件到鲸鱼上出现投放区，确认后进会话；
- **设置**：外观（头像 / 背景 / 压暗 0–90%）、快捷键、免打扰时段、点击穿透、动效、演示模式、连接参数；
- **引导**：首次运行三步，可跳过，也可在设置里重看。

## 外观

托盘「设置…」→ 外观：可换头像与背景、拖动压暗（默认 60%），单图上限 8MB，存在 `settings` 的 `appearance` 里。

内置角色头像走构建期生成：

```powershell
# assets/icon-source.png → app/src/avatar.webp + app/src/avatar.js（WebP data URL）
python tools\prep-avatar.py
node tools\build-plugin.mjs        # 改完记得重新生成插件静态资源
```

data URL 是为了让 `file://` 原型和 `/xj/static` 插件两份页面用同一份头像，不受路径差异影响。

## src/ 文件职责

| 文件 | 职责 |
|---|---|
| `lines.js` | 台词库：按状态分池的台词表 + 抽词规则（hover 时甩一句，去重、`{n}` 替换） |
| `state.js` | 唯一数据源 `XJ.state.store`；`mainStatus()` 状态真值表；未读制；`defaultSettings()` |
| `app.js` | 装配、热键、拖拽吸附、悬停计时、粘贴 / 拖入、离线退避、渲染循环 |
| `mock.js` | 假 Harness（`XJ.mock.Harness`），含审批 / 提问 / 发送 / 停止 / 断连 / 事件推送 |
| `dom.js` | `h()` 建节点、焦点陷阱、滚动锁等小工具 |
| `platform.js` | 平台能力探测（是否嵌入、是否桌面壳、剪贴板、拖放） |
| `ui.js` | toast、浮层等通用件 |
| `composer.js` | 气泡 / 输入条 / 面板共用的 Composer |
| `view-*.js` | 各形态与遮罩：`view-bubble` `view-quickbar` `view-panel` `view-settings` `view-onboarding` `view-capture` |
| `shot.js` | 截图提问流程（遮罩 → 框选 → 卡片 → 发送） |
| `whale.js` | 鲸鱼本体：五表情 + 附属件（工作转圈、zzz、感叹号、星星、X 眼） |
| `avatar.js` | 角色头像的 data URL（生成物，别手改） |
| `icons.js` | 24px 线性图标（自绘 path） |
| `devbar.js` | 原型控制台 |
| `styles.css` | 全部样式：tokens、玻璃材质、离线灰度、动效 |
| `avatar.webp` | 头像位图（`prep-avatar.py` 产物；WebP 仅为体积，页面实际用的是 `avatar.js` 里的 data URL） |

源码注释里保留了设计稿的 §编号（比如 `styles.css` 的 §8.1 离线灰度），方便和设计稿逐条对照。

## 角色设定：管用户叫「老大」

称呼统一用「老大」，范围限制在**招呼类文案**：引导页标题与描述、首次运行 toast、台词、空状态提醒。
功能按钮、开关标签、Toast 里的操作结果这类中性文案不用——不然满屏都是老大，反而腻。
改称呼或加台词，改 `src/lines.js` 那张表就够了（加一句不需要动逻辑）。

## 已知简化

- 没有真实 Harness：`window.__XJ_EMBED_HARNESS__` 存在时（插件形态）才会换成真数据，见 `src/app.js`；
- 没有原生窗口：窗口的置顶 / 透明 / 热键由 `standalone-py/` 负责；
- 「截图」截的是假桌面（`shot.js` 画出来的），真机是外壳抓整屏后推给页面；
- 拖放走 HTML5 事件，没有系统级拖放目标；
- 会话卡「停止」、输入条发文字、拖文件进会话这三项宿主侧还没接，按钮已隐藏。
