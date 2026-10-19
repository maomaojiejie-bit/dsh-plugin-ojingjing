/* =============================================================================
   whale.js · 鲸鱼 IP
   造型为本项目自绘：深海玻璃蓝，拆成「身体 / 眼睛 / 眉毛 / 附属件」四层，
   供五种状态交叉过渡与静态帧降级使用（§7.6）。
   所有轮廓、渐变、高光与表情均为原创，无第三方素材。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { svg } = XJ.dom;
  let seq = 0;

  const EXPR = {
    sleep: "st-sleep", // 空闲：睡觉 + zzz
    focus: "st-focus", // 工作中：专注 + 头顶转圈
    alert: "st-alert", // 需要确认：瞪眼 + 眉毛 + 感叹号
    happy: "st-happy", // 完成未读：眯眼笑 + 星星
    offline: "st-offline", // 离线：灰度 + X 眼
  };

  // 自绘轮廓（viewBox 0 0 36 36）
  const P = {
    body:
      "M31 15c-1.5-5.5-7-8.5-14-6.5-5 1.5-9.5 3.5-12.5 7-2.7 2.8-2.3 6.5-.1 10.3 1.8 3.5 5 5.7 8.5 6.2 5 .8 11 .8 15.5-2 3-1.5 4.3-5 4.5-9 .3-3.5-.6-5.7-1.9-6z",
    tailFin:
      "M31.5 13.5c1.5-4.5 3.7-6 4.1-2 .2 2-.9 3.3-2.8 3.7 1.5 1.3 2.6 4.3 2 7.3-.4 2.7-2.2 3.1-3.2 1.7-1.2-1.9-1.6-5-.1-10.7z",
    belly:
      "M5.5 26.5c1.5 3 5 4.8 9 5.3 4.5.6 10 0 14.3-1.8-2.3.8-8.8 1.5-14.3.6-4-.7-7.1-2-9-4.1z",
  };

  /* ---- 工作环（工作中）-------------------------------------------
     这里原本是「喷水」：一根水柱 + 两瓣水花。静止时读起来像头顶长了一撮白毛，
     动起来又是「升腾 + 缩放 + 淡出」三条属性一起变，软件光栅下最费。
     换成本地化的转圈：三颗泡泡绕一个圆心匀速自转，外面再套一圈虚线反向慢转。
     只动 transform-rotate，linear 匀速，没有形变、没有透明度抖动，
     因此它被归为「功能动画」——软件光栅模式（html.xj-sw）里也保留。 */
  const ORBIT = { cx: 28.4, cy: 7.8, r: 4.5 };
  const ORBIT_DOTS = [
    { deg: 0, r: 1.15, fill: "#CDE9FF", opacity: 1 },
    { deg: 120, r: 0.92, fill: "#DCF1FF", opacity: 0.85 },
    { deg: 240, r: 0.76, fill: "#EAF7FF", opacity: 0.7 },
  ];
  function orbitNodes() {
    const { cx, cy, r } = ORBIT;
    return [
      svg("circle", {
        class: "orbit-track",
        cx: cx,
        cy: cy,
        r: r,
        fill: "none",
        stroke: "#BFE4FF",
        "stroke-width": "1",
        "stroke-dasharray": "1.5 3.1",
        "stroke-linecap": "round",
        opacity: "0.5",
      }),
      svg(
        "g",
        { class: "orbit-arm" },
        ...ORBIT_DOTS.map((d) => {
          const a = (d.deg * Math.PI) / 180;
          return svg("circle", {
            cx: (cx + r * Math.cos(a)).toFixed(2),
            cy: (cy + r * Math.sin(a)).toFixed(2),
            r: d.r,
            fill: d.fill,
            opacity: d.opacity,
          });
        })
      ),
    ];
  }

  /* ---- 角色皮肤（用户指定形象）-------------------------------
     有 XJ.avatarData 时，「身体 + 眼睛」换成角色图，状态装饰（zzz / 喷水 /
     感叹号 / 星星）仍然按状态叠加上去，所以五态的三重编码不变：
     光环(色) + 装饰(形) + 角标(文)。 */
  const FXV = {
    sleep: {
      cls: "zzz",
      shapes: [
        [
          "path",
          {
            d: "M26.4 8.6h3.6l-3.6 4h3.6",
            stroke: "#BBD9F7",
            "stroke-width": "1.3",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            fill: "none",
          },
        ],
        [
          "path",
          {
            d: "M30.8 3.4h2.9l-2.9 3.2h2.9",
            stroke: "#BBD9F7",
            "stroke-width": "1.1",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            fill: "none",
            opacity: "0.72",
          },
        ],
      ],
    },
    focus: {
      cls: "orbit",
      // 角色是正脸，工作环挪到右上角，别糊在头发上
      style: "transform:translate(17px,-1px) scale(.82);transform-box:view-box",
      build: orbitNodes,
    },
    alert: {
      cls: "bang",
      shapes: [
        ["circle", { cx: "29.4", cy: "6.6", r: "5.4", fill: "#FBBF24", opacity: "0.18" }],
        ["circle", { cx: "29.4", cy: "6.6", r: "4.1", fill: "#FBBF24" }],
        ["path", { d: "M29.4 4.5v2.7", stroke: "#2A1D02", "stroke-width": "1.6", "stroke-linecap": "round" }],
        ["circle", { cx: "29.4", cy: "8.5", r: "0.85", fill: "#2A1D02" }],
      ],
    },
    happy: {
      cls: "stars",
      shapes: [
        ["path", { d: "M28.6 9.4l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z", fill: "#FFD580" }],
        ["path", { d: "M21.2 5.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z", fill: "#FFE3AC", opacity: "0.9" }],
      ],
    },
    offline: null,
  };

  function makeAvatar(expression, px) {
    const st = EXPR[expression] || EXPR.sleep;
    const el = XJ.dom.h("div", { class: "whale whale-av " + st, "aria-hidden": "true" });
    el.style.setProperty("--whale-size", px + "px");

    const img = document.createElement("img");
    img.className = "whale-face";
    img.src = XJ.avatarData;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);

    const fx = FXV[st.replace("st-", "")];
    const kids = fx ? (fx.build ? fx.build() : (fx.shapes || []).map(([tag, attrs]) => svg(tag, attrs))) : [];
    if (kids.length) {
      const group = svg(
        "g",
        { class: fx.cls, style: fx.style || "transform-box:fill-box;transform-origin:center" },
        ...kids
      );
      el.appendChild(
        svg("svg", { viewBox: "0 0 36 36", class: "whale-fx", "aria-hidden": "true", focusable: "false" }, group)
      );
    }
    return el;
  }

  function make(expression, size) {
    const id = "wg" + ++seq;
    const st = EXPR[expression] || EXPR.sleep;
    const px = size || 52;

    // 有角色皮肤时走 img 版本（表情在画里，装饰仍按状态叠加）
    if (XJ.avatarData) return makeAvatar(expression, px);

    const shadow = "#0E1A33";

    const el = svg(
      "svg",
      { viewBox: "0 0 36 36", width: px, height: px, "aria-hidden": "true", focusable: "false" },

      /* ---- defs：深海玻璃蓝渐变 ---- */
      svg(
        "defs",
        null,
        svg(
          "linearGradient",
          { id: id, x1: "30%", y1: "18%", x2: "72%", y2: "100%" },
          svg("stop", { offset: "0%", "stop-color": "#BFE4FF" }),
          svg("stop", { offset: "46%", "stop-color": "#7CC2FF" }),
          svg("stop", { offset: "100%", "stop-color": "#3E6EA8" })
        ),
        svg(
          "linearGradient",
          { id: id + "h", x1: "20%", y1: "0%", x2: "60%", y2: "100%" },
          svg("stop", { offset: "0%", "stop-color": "#FFFFFF", "stop-opacity": "0.55" }),
          svg("stop", { offset: "100%", "stop-color": "#FFFFFF", "stop-opacity": "0" })
        )
      ),

      /* ---- 附属件：工作环（工作中） ---- */
      svg("g", { class: "orbit" }, ...orbitNodes()),

      /* ---- 附属件：zzz（空闲） ---- */
      svg(
        "g",
        { class: "zzz", style: "transform-box:fill-box;transform-origin:center" },
        svg("path", {
          d: "M26.4 8.6h3.6l-3.6 4h3.6",
          stroke: "#BBD9F7",
          "stroke-width": "1.3",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          fill: "none",
        }),
        svg("path", {
          d: "M30.8 3.4h2.9l-2.9 3.2h2.9",
          stroke: "#BBD9F7",
          "stroke-width": "1.1",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          fill: "none",
          opacity: "0.72",
        })
      ),

      /* ---- 附属件：星星（完成未读） ---- */
      svg(
        "g",
        { class: "stars" },
        svg("path", {
          d: "M28.6 9.4l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z",
          fill: "#FFD580",
        }),
        svg("path", {
          d: "M21.2 5.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z",
          fill: "#FFE3AC",
          opacity: "0.9",
        })
      ),

      /* ---- 附属件：感叹号（需要确认） ---- */
      svg(
        "g",
        { class: "bang", style: "transform-box:fill-box;transform-origin:center" },
        svg("circle", { cx: "29.4", cy: "6.6", r: "5.4", fill: "#FBBF24", opacity: "0.18" }),
        svg("circle", { cx: "29.4", cy: "6.6", r: "4.1", fill: "#FBBF24" }),
        svg("path", {
          d: "M29.4 4.5v2.7",
          stroke: "#2A1D02",
          "stroke-width": "1.6",
          "stroke-linecap": "round",
        }),
        svg("circle", { cx: "29.4", cy: "8.5", r: "0.85", fill: "#2A1D02" })
      ),

      /* ---- 身体（渐变 + 顶部高光 + 肚皮 + 尾鳍） ---- */
      svg(
        "g",
        { class: "body-grad" },
        svg(
          "g",
          { class: "whale-body" },
          svg("path", { d: P.tailFin, fill: "url(#" + id + ")", opacity: "0.95" }),
          svg("path", { d: P.body, fill: "url(#" + id + ")" }),
          // 肚皮亮区（浅色腹面，压低不透明度当高光用）
          svg("path", { d: P.belly, fill: "#EAF6FF", opacity: "0.38" }),
          // 背部高光
          svg("path", {
            d: "M2.6 20.4c2.6-2.4 6-3.6 9.8-3.4",
            stroke: "url(#" + id + "h)",
            "stroke-width": "2.4",
            "stroke-linecap": "round",
            fill: "none",
            opacity: "0.8",
          }),
          // 胸鳍
          svg("path", {
            d: "M13.4 26.6c1.6 1.2 2.6 2.8 2.9 4.7-2.2.3-3.9-.5-5.1-2.2-.5-.8 1.7-2.9 2.2-2.5z",
            fill: "#A8D8FF",
            opacity: "0.75",
          })
        )
      ),

      /* ---- 眼睛 / 眉毛 / 嘴 ---- */
      svg(
        "g",
        { class: "eye-open", style: "transform-box:fill-box;transform-origin:center" },
        svg("circle", { cx: "6.6", cy: "25.4", r: "2.5", fill: shadow }),
        svg("circle", { cx: "7.4", cy: "24.4", r: "0.86", fill: "#FFFFFF", opacity: "0.95" }),
        svg("circle", { cx: "5.7", cy: "26.4", r: "0.4", fill: "#FFFFFF", opacity: "0.5" })
      ),
      svg(
        "g",
        { class: "eye-happy" },
        svg("path", {
          d: "M4 25.9c1.4-2 3.9-2 5.3 0",
          stroke: shadow,
          "stroke-width": "1.7",
          "stroke-linecap": "round",
          fill: "none",
        })
      ),
      svg(
        "g",
        { class: "eye-offline" },
        svg("path", {
          d: "M4.3 23.6l4.5 4.5M8.8 23.6l-4.5 4.5",
          stroke: "#0B1120",
          "stroke-width": "1.7",
          "stroke-linecap": "round",
          opacity: "0.85",
        })
      ),
      svg(
        "g",
        { class: "brows" },
        svg("path", {
          d: "M3.9 21.4l5.4-1.1",
          stroke: shadow,
          "stroke-width": "1.6",
          "stroke-linecap": "round",
          opacity: "0.85",
        })
      ),
      // 嘴（鲸鱼下缘的小弧）
      svg("path", {
        d: "M5.2 29.9c1.7 1.2 3.6 1.5 5.6.9",
        stroke: shadow,
        "stroke-width": "1.3",
        "stroke-linecap": "round",
        fill: "none",
        opacity: "0.5",
      }),
      // 腮红
      svg("ellipse", {
        cx: "10.4",
        cy: "28.2",
        rx: "2.2",
        ry: "1.3",
        fill: "#FFD580",
        opacity: "0.22",
      })
    );

    const wrap = XJ.dom.h("div", { class: "whale " + st, "aria-hidden": "true" }, el);
    wrap.style.setProperty("--whale-size", px + "px");
    return wrap;
  }

  XJ.whale = { make };
})();
