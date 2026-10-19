/* =============================================================================
   whale.js · 鲸鱼 IP
   造型来自 Twemoji「喷水鲸」🐳 1f433（CC-BY 4.0, © Twitter, Inc. / X Corp.，
   源文件 https://github.com/twitter/twemoji/blob/master/assets/svg/1f433.svg），
   按设计稿重新着色为深海玻璃蓝，并拆成「身体 / 眼睛 / 眉毛 / 附属件」四层，
   供五种状态交叉过渡与静态帧降级使用（§7.6）。
   注意：外部素材只作为轮廓来源，颜色、渐变、高光、表情全部自绘。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { svg } = XJ.dom;
  let seq = 0;

  const EXPR = {
    sleep: "st-sleep", // 空闲：睡觉 + zzz
    focus: "st-focus", // 工作中：专注 + 喷水
    alert: "st-alert", // 需要确认：瞪眼 + 眉毛 + 感叹号
    happy: "st-happy", // 完成未读：眯眼笑 + 星星
    offline: "st-offline", // 离线：灰度 + X 眼
  };

  // Twemoji 1f433 轮廓（viewBox 0 0 36 36）
  const P = {
    body: "M32 12c2.122-2.122 5 14.312-3 21-2.757 2.305-6 2.969-8 2.969-2.371 0-10.029.031-13 .031-7.18 0-8-4.925-8-11s.82-11 8-11c6 0 10 2 13 3.996 4.977 3.312 5.992 3.861 8 2.004 3.213-2.97 1-6 3-8z",
    tailFin: "M32 14c4.123 0 4-5 4-7s-2 1-5 2-7-2-6 0 3 5 7 5z",
    belly:
      "M34.003 23c-.465 3.727-2.041 7.523-5.003 10-2.757 2.305-6 2.969-8 2.969-2.371 0-10.029.031-13 .031-4.035 0-6.062-1.555-7.062-3.996C.157 30.102 4 33 15 33c14 0 17-5 19.003-10z",
    spoutColumn: "M10 7c0 2.209-.896 6-2 6S6 9.209 6 7s.896-2 2-2 2-.209 2 2z",
    spoutSplash:
      "M8 5c0-3-6-2-6 0s3 1 4 3 2-3 2-3zm0 0c0-3 6-2 6 0s-3 1-4 3-2-3-2-3z",
  };

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
      cls: "spout",
      // 角色是正脸，喷水挪到右上角，别糊在头发上
      style: "transform:translate(17px,-1px) scale(.82);transform-box:view-box",
      shapes: [
        ["path", { d: P.spoutColumn, fill: "#CDE9FF", opacity: "0.5" }],
        ["path", { d: P.spoutSplash, fill: "#DCF1FF", opacity: "0.85" }],
        ["circle", { cx: "8", cy: "1.6", r: "0.9", fill: "#EAF7FF", opacity: "0.8" }],
        ["circle", { cx: "12.4", cy: "2.6", r: "0.7", fill: "#EAF7FF", opacity: "0.6" }],
      ],
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
    if (fx && fx.shapes.length) {
      const group = svg(
        "g",
        { class: fx.cls, style: fx.style || "transform-box:fill-box;transform-origin:center" },
        ...fx.shapes.map(([tag, attrs]) => svg(tag, attrs))
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

      /* ---- 附属件：喷水（工作中） ---- */
      svg(
        "g",
        { class: "spout", style: "transform-box:fill-box;transform-origin:30% 100%" },
        svg("path", { d: P.spoutColumn, fill: "#CDE9FF", opacity: "0.55" }),
        svg("path", { d: P.spoutSplash, fill: "#DCF1FF", opacity: "0.85" }),
        svg("circle", { cx: "8", cy: "1.6", r: "0.9", fill: "#EAF7FF", opacity: "0.8" }),
        svg("circle", { cx: "12.4", cy: "2.6", r: "0.7", fill: "#EAF7FF", opacity: "0.6" })
      ),

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
          // 肚皮亮区（Twemoji 的浅色腹面，压低不透明度当高光用）
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

  XJ.whale = { make, license: "Whale silhouette derived from Twemoji (CC-BY 4.0, Twitter, Inc. / X Corp.)" };
})();
