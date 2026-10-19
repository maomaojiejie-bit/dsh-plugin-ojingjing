/* =============================================================================
   view-onboarding.js · 三步引导（§8.5）
   ① 欢迎 → ② 权限与自启 → ③ 停靠位置；每步只推一个主行动，可跳过（落默认值）。
   引导里不弹任何系统权限请求，自启/通知是先写配置、真正生效在安装后。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h } = XJ.dom;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  const CORNERS = [
    { id: "br", label: "右下角（推荐）", hint: "任务栏上方，余光最容易扫到" },
    { id: "bl", label: "左下角", hint: "和开始菜单同侧" },
    { id: "tr", label: "右上角", hint: "和通知中心同侧" },
    { id: "tl", label: "左上角", hint: "最安静的位置" },
  ];

  function onboarding(s) {
    const step = Math.min(2, Math.max(0, s.ui.onboardingStep || 0));
    const steps = [welcome, permissions, position];

    return h(
      "div",
      { class: "onboarding", role: "dialog", "aria-label": "哦鲸鲸引导" },
      steps[step](s),
      h(
        "div",
        { class: "ob-foot" },
        h(
          "div",
          { class: "dots" },
          [0, 1, 2].map((i) => h("i", { class: i === step ? "on" : "" }))
        ),
        step > 0
          ? h(
              "button",
              {
                class: "btn-ghost btn-sm",
                onclick: () => {
                  s.ui.onboardingStep = step - 1;
                  A().patchSettings({});
                },
              },
              "上一步"
            )
          : h(
              "button",
              {
                class: "btn-ghost btn-sm",
                onclick: () => finish(s, { skipped: true }),
              },
              "跳过"
            ),
        step < 2
          ? h(
              "button",
              {
                class: "btn-solid",
                onclick: () => {
                  s.ui.onboardingStep = step + 1;
                  A().patchSettings({});
                },
              },
              step === 0 ? "开始" : "下一步"
            )
          : h(
              "button",
              { class: "btn-solid", onclick: () => finish(s, {}) },
              "完成"
            )
      )
    );
  }

  /* ---------------- ① 欢迎 ---------------- */
  function welcome(s) {
    return h(
      "div",
      { class: "ob-step" },
      h("div", { class: "ob-ring" }, XJ.ui.whale("happy", 72)),
      h("div", { class: "ob-title" }, "老大好，我是哦鲸鲸"),
      h(
        "div",
        { class: "ob-desc" },
        "常驻右下角，Harness 有一点动静我都禀报老大——"
      ),
      h(
        "div",
        { class: "ob-desc", style: { color: "var(--text-primary)", fontWeight: 470 } },
        "不用老大主动打开页面，也不会漏掉等你点头的那一下。"
      ),
      h(
        "div",
        { class: "ob-shortcut" },
        h("span", null, "随时唤起我"),
        h("kbd", null, s.settings.hotkeyPanel || "Ctrl+Shift+Space")
      ),
      h(
        "div",
        { class: "ob-demos" },
        demo("sleep", "空闲"),
        demo("focus", "工作中"),
        demo("alert", "要你确认"),
        demo("happy", "完成未读")
      )
    );
  }

  function demo(expr, label) {
    return h("div", { class: "ob-demo-item" }, h("div", { class: "mini-orb" }, XJ.ui.whale(expr, 24)), h("span", null, label));
  }

  /* ---------------- ② 权限与自启 ---------------- */
  function permissions(s) {
    const st = s.settings;
    return h(
      "div",
      { class: "ob-step" },
      h("div", { class: "ob-ring" }, XJ.ui.whale("focus", 72)),
      h("div", { class: "ob-title" }, "两件小事，老大说了算"),
      h(
        "div",
        { class: "ob-desc" },
        "哦鲸鲸不读老大的聊天内容，也不需要额外的系统权限。"
      ),
      h(
        "div",
        { style: { width: "100%", maxWidth: "310px", marginTop: "14px" } },
        h(
          "div",
          { class: "set-row" },
          h(
            "div",
            { class: "set-row-main" },
            h("div", { class: "set-row-title" }, "开机自启 ", h("span", { class: "t-aux", style: { fontSize: "11px" } }, "推荐")),
            h("div", { class: "set-row-sub" }, "开机后在托盘静默启动，不占前台")
          ),
          h("span", {
            class: "switch" + (st.autostart ? " on" : ""),
            role: "switch",
            "aria-checked": String(!!st.autostart),
            tabindex: "0",
            onclick: () => A().patchSettings({ autostart: !st.autostart }),
          })
        ),
        h(
          "div",
          { class: "set-row" },
          h(
            "div",
            { class: "set-row-main" },
            h("div", { class: "set-row-title" }, "完成通知 ", h("span", { class: "t-aux", style: { fontSize: "11px" } }, "推荐")),
            h("div", { class: "set-row-sub" }, "会话跑完时发一条，点通知直达会话")
          ),
          h("span", {
            class: "switch" + (st.notifyComplete ? " on" : ""),
            role: "switch",
            "aria-checked": String(!!st.notifyComplete),
            tabindex: "0",
            onclick: () => A().patchSettings({ notifyComplete: !st.notifyComplete }),
          })
        )
      ),
      h(
        "div",
        { class: "ob-privacy" },
        "哦鲸鲸只读任务状态（不读对话正文）；审批、消息、你主动截的图和拖进来的文件，都只在你自己的机器和你的 Harness 之间流转，不上传任何内容。"
      )
    );
  }

  /* ---------------- ③ 停靠位置 ---------------- */
  function position(s) {
    const cur = s.settings.dockCorner || "br";
    return h(
      "div",
      { class: "ob-step" },
      h("div", { class: "ob-ring" }, XJ.ui.whale("sleep", 72)),
      h("div", { class: "ob-title" }, "把我放在哪？"),
      h("div", { class: "ob-desc" }, "拖到任意位置也行，松手会吸附最近的角。"),
      h(
        "div",
        { class: "ob-demos", style: { flexWrap: "wrap", maxWidth: "300px" } },
        CORNERS.map((c) =>
          h(
            "div",
            {
              class: "ob-demo-item",
              style: {
                cursor: "pointer",
                color: cur === c.id ? "var(--accent-soft)" : null,
              },
              title: c.hint,
              onclick: () => A().patchSettings({ dockCorner: c.id }),
            },
            h(
              "div",
              {
                class: "mini-orb",
                style: {
                  boxShadow: cur === c.id ? "0 0 0 2px rgba(124,194,255,.75)" : null,
                },
              },
              XJ.ui.whale("sleep", 24)
            ),
            h("span", null, c.label.replace("（推荐）", ""))
          )
        )
      ),
      h(
        "div",
        { class: "ob-shortcut", style: { marginTop: "16px" } },
        h("span", null, "拖动鲸鱼可换位置 · 松手吸附最近的角")
      )
    );
  }

  function finish(s, opts) {
    s.ui.showOnboarding = false;
    XJ.platform.store.set("onboarded", true);
    A().patchSettings({});
    if (!opts || !opts.skipped) {
      XJ.ui.toast({ type: "success", title: "欢迎上船", sub: "老大，哦鲸鲸已经在角落待命了" });
    }
  }

  XJ.views = XJ.views || {};
  XJ.views.onboarding = onboarding;
  XJ.views.CORNERS = CORNERS;
})();
