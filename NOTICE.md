# 第三方素材与许可

## 鲸鱼图形（哦鲸鲸本体）

`app/src/whale.js` 里鲸鱼主体的路径轮廓取自 **Twemoji** 的 🐳 `1f433`：

- 源文件：<https://github.com/twitter/twemoji/blob/master/assets/svg/1f433.svg>
- 许可：**CC-BY 4.0**（© Twitter, Inc and other contributors）
- 本项目对其做的改动：重新着色（`#BFE4FF → #7CC2FF → #3E6EA8` 的深海渐变）、重排眼睛/眉毛/腮红坐标，并叠加自绘的喷水、`zzz`、感叹号、星星、X 眼等状态图层。

按 CC-BY 4.0 要求，分发本组件时需保留上述署名与许可链接。

## 字体

`app/index.html` 通过 Google Fonts 引用 **Outfit** 与 **Noto Sans SC**（均为 SIL Open Font License）。字体不打包，离线时回落到系统 `Microsoft YaHei UI`，不影响可用性。

## 图标

`app/src/icons.js` 里的 24px 线性图标为本项目自绘的 path，未从第三方图标库复制。
