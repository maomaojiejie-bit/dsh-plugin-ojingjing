/* =============================================================================
   view-settings.js · 设置（§8.4）· 审批中心（§9.5.4）· 审批记录（§9.5.7）
   三者都是面板内的 sheet，覆盖在面板之上，关闭后回到 home。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, fmtClock, fmtDuration, truncate } = XJ.dom;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  /* ---------------- 关于 / 检查更新（接 git 仓库） ----------------
     外壳（Qt）把 version/repo/releases 推进 window.__XJ_SHELL__（见
     standalone-py/ojingjing_py.py 的 push_shell_info），浏览器里跑原型时用下面的默认值。
     检查更新打 GitHub 的 releases/latest：
       · 200 → 和本地版本比 semver。原来是 latest !== VERSION 直接比字符串，
               0.3.10 会被判成比 0.3.9 小，这种坑等发到两位数版本就要咬人。
       · 404 → 这个仓库还没发过 release（tag 也还是空的），引导去 Releases / 提交历史。 */
  const SHELL = window.__XJ_SHELL__ || {};
  const REPO = SHELL.repo || "https://github.com/maomaojiejie-bit/dsh-plugin-ojingjing";
  const RELEASES = SHELL.releases || REPO + "/releases";
  const ISSUES = REPO + "/issues";
  const COMMITS = REPO + "/commits/main";
  /** 仓库地址 → API 地址：外壳换仓库时不用改代码 */
  const API = REPO.replace(/^https?:\/\/github\.com\//i, "https://api.github.com/repos/").replace(/\/+$/, "");
  /** 版本号来源优先级：外壳推的（源码运行读 package.json）→ 构建时注入的 → 兜底常量 */
  const BUILD = window.__XJ_BUILD__ || {};
  const VERSION = String(SHELL.version || BUILD.version || "0.4.0").replace(/^v/, "");
  /** 自动检查的冷却时间：打开设置时距上次超过这么久就静默查一次 */
  const CHECK_TTL = 6 * 3600 * 1000;

  /** 把链接塞进剪贴板：浏览器打不开时，至少能手动粘一次 */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* 无剪贴板权限，往下走 execCommand */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  /** 没打开时的兜底：弹完整链接 + 塞进剪贴板，绝不静默失败 */
  function openFailed(url, why) {
    const copied = copyText(url);
    XJ.ui.toast({
      type: "warn",
      title: copied ? "链接已复制，浏览器没能打开" : "浏览器没能打开",
      sub: (why ? why + " · " : "") + url,
      duration: 12000,
    });
  }

  /** 连点保护：同一链接 1.2s 内只发一次（点不出来时人会连点） */
  const openRecent = new Map();

  /** 打开外部链接：独立窗走外壳桥（系统浏览器），原型/浏览器直接 window.open。
      外壳会回推结果（xj-open-result）；4s 没动静就当没打开，弹提示 + 复制链接。
      浏览器拦截弹窗（window.open 返回 null）时同样走兜底——总比点了没反应强。 */
  function openExternal(url) {
    const now = Date.now();
    if (now - (openRecent.get(url) || 0) < 1200) return;
    openRecent.set(url, now);

    if (XJ.embed && XJ.embed.enabled && XJ.embed.post) {
      let settled = false;
      let tid = 0;
      const done = (ok, why) => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        window.removeEventListener("xj-open-result", onResult);
        if (!ok) openFailed(url, why);
      };
      const onResult = (e) => {
        const d = (e && e.detail) || {};
        if (d.url && d.url !== url) return; // 不是这条链接点的，别管
        if (!d.final) {
          // 外壳说「已经在开了」：先收掉等待兜底，但别摘监听——真失败时它还会推终局结果
          clearTimeout(tid);
          tid = 0;
          return;
        }
        done(!!d.ok, d.err || d.how || "");
      };
      window.addEventListener("xj-open-result", onResult);
      tid = setTimeout(() => done(false, "外壳没有回应"), 6000);
      XJ.embed.post({ type: "open-url", url });
      return;
    }
    const win = window.open(url, "_blank", "noopener");
    if (!win) openFailed(url, "浏览器拦了弹窗");
  }

  /** semver 比较：-1 / 0 / 1。数字段按数值比，预发布后缀（-rc.1、-beta）小于同段正式版。 */
  function cmpVer(a, b) {
    const norm = (v) =>
      String(v || "")
        .replace(/^v/i, "")
        .split("+")[0]
        .split("-");
    const [ca, ...ra] = norm(a);
    const [cb, ...rb] = norm(b);
    const pa = ca.split(".");
    const pb = cb.split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      // 缺的段当 0：「0.3」和「0.3.0」是同版本，不能因为少一段就判小
      const na = i < pa.length ? parseInt(pa[i], 10) : 0;
      const nb = i < pb.length ? parseInt(pb[i], 10) : 0;
      if (Number.isNaN(na) && Number.isNaN(nb)) continue;
      if (Number.isNaN(na)) return -1;
      if (Number.isNaN(nb)) return 1;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    // 主版本一样，比预发布后缀：有后缀的更小
    if (ra.length && !rb.length) return -1;
    if (!ra.length && rb.length) return 1;
    const sa = ra.join("-");
    const sb = rb.join("-");
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  /** 「3 分钟前」这种粗粒度时间，别把 fmtDuration 的 03h05m 塞给用户 */
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "刚刚";
    const m = Math.round(s / 60);
    if (m < 60) return m + " 分钟前";
    const hh = Math.round(m / 60);
    if (hh < 48) return hh + " 小时前";
    return Math.round(hh / 24) + " 天前";
  }

  /** 问 GitHub 要最新 release。没有 release 时返 { none: true } 而不是抛错。 */
  async function fetchLatest() {
    const res = await fetch(API + "/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (res.status === 404) return { none: true, tag: "" };
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    return {
      none: false,
      tag: String(d.tag_name || d.name || "").replace(/^v/i, ""),
      url: d.html_url || RELEASES,
      at: d.published_at || "",
    };
  }

  let checking = false;
  /** 失败后的重试冷却：offline 时不至于每渲染一次就打一次 GitHub */
  let retryAt = 0;

  async function checkUpdate(opts) {
    const silent = !!(opts && opts.silent);
    if (checking) return;
    checking = true;
    if (!silent) XJ.ui.toast({ type: "info", title: "正在检查更新…", duration: 1500 });
    try {
      const r = await fetchLatest();
      A().patchSettings({ lastUpdateAt: Date.now(), latestVersion: r.tag || "" });
      if (r.none) {
        if (!silent) {
          XJ.ui.toast({
            type: "info",
            title: "仓库还没发布版本",
            sub: "等第一个 Release 出来，这里会自己亮起来",
            actions: [{ label: "看提交历史", onClick: () => openExternal(COMMITS) }],
            duration: 9000,
          });
        }
        return;
      }
      if (r.tag && cmpVer(r.tag, VERSION) > 0) {
        XJ.ui.toast({
          type: "success",
          title: (silent ? "有新版本 " : "发现新版本 ") + "v" + r.tag,
          sub: "当前 v" + VERSION + " · 去 Releases 看更新说明",
          actions: [{ label: "去看看", onClick: () => openExternal(r.url) }],
          duration: silent ? 11000 : 14000,
        });
      } else if (!silent) {
        XJ.ui.toast({ type: "success", title: "已是最新版本", sub: "哦鲸鲸 v" + VERSION });
      }
    } catch (err) {
      retryAt = Date.now() + 60 * 1000;
      if (!silent) {
        XJ.ui.toast({
          type: "warn",
          title: "检查失败",
          sub: "网络或 GitHub 抽风了",
          actions: [{ label: "打开仓库", onClick: () => openExternal(REPO) }],
          duration: 9000,
        });
      }
    } finally {
      checking = false;
    }
  }

  /** 打开设置时顺手静默查一次（6 小时内查过就跳过） */
  function maybeAutoCheck(st) {
    if (checking) return;
    if (Date.now() < retryAt) return;
    if (Date.now() - Number(st.lastUpdateAt || 0) < CHECK_TTL) return;
    setTimeout(() => checkUpdate({ silent: true }), 320);
  }

  /* ---------------- 通用小组件 ---------------- */
  function group(title, ...rows) {
    return h("div", { class: "set-group" }, h("div", { class: "set-group-title" }, title), ...rows);
  }

  function row(title, sub, control, opts) {
    const o = opts || {};
    return h(
      "div",
      { class: "set-row", onclick: o.onClick || null, style: o.onClick ? { cursor: "pointer" } : null },
      h(
        "div",
        { class: "set-row-main" },
        h("div", { class: "set-row-title" }, title),
        sub ? h("div", { class: "set-row-sub" + (o.warn ? " warn" : "") }, sub) : null
      ),
      control || null
    );
  }

  function toggle(key, opts) {
    const s = S();
    const o = opts || {};
    const on = !!s.settings[key];
    return h("span", {
      class: "switch" + (on ? " on" : "") + (o.disabled ? " disabled" : ""),
      role: "switch",
      "aria-checked": String(on),
      tabindex: "0",
      title: on ? "已开启" : "已关闭",
      onclick: (e) => {
        e.stopPropagation();
        if (o.disabled) return;
        A().patchSettings({ [key]: !on });
        if (o.after) o.after(!on);
      },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.target.click();
        }
      },
    });
  }

  function btn(label, onClick, opts) {
    const o = opts || {};
    return h(
      "button",
      { class: "btn-ghost btn-sm" + (o.danger ? " danger" : ""), onclick: (e) => { e.stopPropagation(); onClick(); } },
      label
    );
  }

  function kbd(key, action) {
    const s = S();
    const rec = s.ui.hotkeyRecording === action;
    return h(
      "button",
      {
        class: "kbd-input" + (rec ? " recording" : ""),
        title: "点击后按下新的组合键",
        onclick: (e) => {
          e.stopPropagation();
          s.ui.hotkeyRecording = rec ? null : action;
          A().patchSettings({});
          XJ.ui.toast({ type: "info", title: "按下新的组合键", sub: "Esc 取消 · 需要至少一个修饰键" });
        },
      },
      rec ? "按下按键…" : s.settings[key] || "未设置"
    );
  }

  /* ============================ 设置 ============================ */
  function settingsSheet(s) {
    const st = s.settings;
    const body = h("div", { class: "sheet-body" });
    maybeAutoCheck(st);

    body.append(
      group(
        "通用",
        row("开机自启", "开机后在托盘静默启动，不弹窗", toggle("autostart")),
        row(
          "退出哦鲸鲸",
          "关闭面板只是收起；退出会停止接收审批提醒",
          btn("退出", () => {
            XJ.ui.toast({
              type: "warn",
              title: "退出后你将收不到审批提醒",
              sub: "原型里不真的退出，真实版本会先二次确认",
              actions: [{ label: "知道了" }],
              duration: 5000,
            });
          })
        )
      )
    );

    body.append(
      group(
        "快捷键",
        row("唤起面板", "点击后按下新的组合键", kbd("hotkeyPanel", "panel")),
        row("截图提问", "框选屏幕区域后提问", kbd("hotkeyCapture", "capture")),
        row("快捷对话", "在光标旁唤起输入条", kbd("hotkeyQuick", "quick"))
      )
    );

    body.append(
      group(
        "提醒",
        row(
          "免打扰时段",
          "这段时间不响铃，只留一条系统通知；角标不会消失",
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("input", {
              type: "time",
              class: "select-mini",
              value: st.dndFrom,
              onchange: (e) => A().patchSettings({ dndFrom: e.target.value }),
            }),
            h("span", { class: "t-ter", style: { fontSize: "11px" } }, "至"),
            h("input", {
              type: "time",
              class: "select-mini",
              value: st.dndTo,
              onchange: (e) => A().patchSettings({ dndTo: e.target.value }),
            }),
            toggle("dndEnabled")
          )
        ),
        row("免打扰期间审批仍响铃", "默认关：免打扰就是免打扰", toggle("dndRingApproval")),
        row("完成通知", "会话跑完时发一条系统通知", toggle("notifyComplete")),
        row(
          "闲着主动说句话",
          "长时间没碰我，我会浮上来冒个泡；没人理就自己沉下去",
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h(
              "select",
              {
                class: "select-mini",
                onchange: (e) => A().patchSettings({ idleNudgeMin: Number(e.target.value) }),
              },
              ...[2, 5, 6, 10, 15, 30].map((m) =>
                h(
                  "option",
                  { value: m, selected: Number(st.idleNudgeMin) === m ? true : null },
                  m + " 分钟"
                )
              )
            ),
            toggle("idleNudge")
          )
        ),
        row("完成提示音", "", toggle("soundComplete")),
        row("需要确认提示音", "这一项是唯一的强提醒，建议开", toggle("soundApproval"))
      )
    );

    body.append(
      group(
        "连接",
        row(
          "对账间隔",
          "SSE 是实时源，轮询只用来补漏",
          h(
            "select",
            {
              class: "select-mini",
              onchange: (e) => A().patchSettings({ pollInterval: Number(e.target.value) }),
            },
            [5, 15, 30].map((v) =>
              h("option", { value: String(v), selected: st.pollInterval === v ? true : null }, v + " 秒")
            )
          )
        ),
        row("端口", "自动发现（runtime.json → 43120 → 上次成功端口）", h("span", { class: "set-row-sub", style: { margin: 0 } }, "自动")),
        row(
          "立即重连",
          s.connection === "online" ? "当前连接正常" : "正在重连中…",
          btn("重连", () => XJ.app.reconnect())
        )
      )
    );

    body.append(
      group(
        "窗口",
        row(
          "点击穿透",
          "开启后鼠标不再和鲸鱼交互，只能用托盘或 " + st.hotkeyPanel + " 恢复",
          toggle("clickThrough", {
            after: (on) => {
              s.runtime.throughBanner = on;
              if (on) {
                XJ.ui.toast({
                  type: "info",
                  title: "已开启点击穿透",
                  sub: "按 " + st.hotkeyPanel + " 或从托盘菜单恢复",
                  duration: 5200,
                });
              }
            },
          }),
          { warn: true }
        ),
        row(
          "位置",
          "记住每个显示器的相对位置，显示器拔掉时回落到主屏右下角",
          btn("重置到右下角", () => {
            XJ.app.resetDock();
          })
        ),
        row(
          "动画效果",
          "跟随系统「减少动画」设置",
          h(
            "select",
            {
              class: "select-mini",
              onchange: (e) => A().patchSettings({ motion: e.target.value }),
            },
            [
              ["system", "跟随系统"],
              ["reduce", "减少动画"],
            ].map(([v, t]) => h("option", { value: v, selected: st.motion === v ? true : null }, t))
          )
        )
      )
    );

    /* ---------------- 渲染（只有 Qt 外壳能调；webview / 浏览器里没有这一组） ---------------- */
    const native = window.xjNative;
    if (native) {
      const shell = window.__XJ_SHELL__ || { render: "sw", active: "" };
      const activeText = shell.active === "hw" ? "硬件" : shell.active === "sw" ? "软件" : "未知";
      const restart = () => {
        if (native.restartShell) native.restartShell();
      };
      const pickRender = (value) => {
        if (native.setRender) native.setRender(value);
        window.__XJ_SHELL__ = Object.assign({}, shell, { render: value });
        XJ.ui.toast({
          type: "success",
          title: "渲染方式已保存",
          sub: "重启哦鲸鲸后生效（也可以点下面的「重启」）",
          actions: [{ label: "现在重启", onClick: restart }],
          duration: 6500,
        });
      };
      body.append(
        group(
          "渲染",
          row(
            "渲染方式",
            "当前进程：" + activeText + " · 软件最稳；硬件更快，但个别机器上分层窗口会看不见",
            h(
              "select",
              { class: "select-mini", onchange: (e) => pickRender(e.target.value) },
              [
                ["sw", "软件（默认，最稳，CPU 光栅）"],
                ["hw", "硬件（GPU 合成，滚动更顺）"],
              ].map(([v, t]) =>
                h("option", { value: v, selected: (shell.render === "hw" ? "hw" : "sw") === v ? true : null }, t)
              )
            )
          ),
          row("重新启动", "改完渲染方式点一下，窗口会重新拉起（约两秒）", btn("重启", restart))
        )
      );
    }

    body.append(
      group(
        "隐私",
        row(
          "演示模式",
          "检测到屏幕共享时自动遮住命令正文；检测不到也能手动开",
          h(
            "select",
            {
              class: "select-mini",
              onchange: (e) => A().patchSettings({ presentation: e.target.value }),
            },
            [
              ["auto", "自动"],
              ["always", "始终开"],
              ["off", "关"],
            ].map(([v, t]) => h("option", { value: v, selected: st.presentation === v ? true : null }, t))
          )
        ),
        row("审批记录", "只存时间和决定，不存命令正文与路径，保留 30 天", btn("查看", () => A().setPanelScreen("audit"))),
        row(
          "使用统计",
          "只上报 19 类事件名，绝不上报会话标题、命令、路径、输入与截图内容",
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            btn("看上报内容", () => {
              XJ.ui.toast({
                type: "info",
                title: "上报的是事件名，不是内容",
                sub: "overlay_launch · state_transition · approval_decided · approval_race · capture_sent · prompt_sent …（19 类）",
                duration: 8000,
              });
            }),
            toggle("telemetry")
          )
        ),
        row(
          "清除本地数据",
          "草稿、待发附件副本、审批记录、缓存一次清空",
          btn("清除", () => {
            XJ.platform.store.remove("draft");
            XJ.platform.store.remove("attachments");
            A().patchSettings({});
            XJ.ui.toast({ type: "success", title: "已清除本地数据", sub: "设置不会重置" });
          }, { danger: true })
        )
      )
    );

    const latest = String(st.latestVersion || "");
    const newer = !!latest && cmpVer(latest, VERSION) > 0;
    const updateSub = newer
      ? "有新版本 v" + latest + " · 当前 v" + VERSION
      : st.lastUpdateAt
        ? "当前 v" + VERSION + " · " + ago(Date.now() - Number(st.lastUpdateAt)) + "查过"
        : "当前 v" + VERSION + " · 连 GitHub Releases 比一比";

    body.append(
      group(
        "其它",
        row(
          "反馈问题",
          "去 GitHub Issues 提问题 · 别贴对话内容和密钥",
          btn("打开 Issues", () => openExternal(ISSUES))
        ),
        row(
          "检查更新",
          updateSub,
          newer ? btn("去更新", () => openExternal(RELEASES)) : btn("检查", () => checkUpdate()),
          newer ? { warn: true } : null
        ),
        row("更新日志", "每个版本改了什么，都记在 Releases 里", btn("查看", () => openExternal(RELEASES))),
        row(
          "关于",
          "哦鲸鲸 v" + VERSION + " · DeepSeek Harness 悬浮窗 · 只看状态，不看聊天内容",
          btn("打开仓库", () => openExternal(REPO))
        )
      )
    );

    return sheet("设置", body);
  }

  /* ============================ 审批中心 ============================ */
  function approvalCenter(s) {
    const list = XJ.state.pendingList(s);
    const idx = s.ui.approvalCenterIndex || 0;
    const body = h("div", { class: "sheet-body" });

    body.append(
      h(
        "div",
        { class: "center-summary" },
        XJ.icon("shield", 13),
        h("span", null, "共 " + list.length + " 项 · 按风险排序，高危永远在上"),
        h("span", { class: "spacer" })
      )
    );

    if (!list.length) {
      body.append(
        h(
          "div",
          { class: "empty" },
          XJ.ui.whale("sleep", 48),
          h("div", { class: "empty-title" }, "没有待确认的审批"),
          h(
            "div",
            { class: "empty-sub" },
            "Agent 需要你放行某个操作时会出现在这里。收到一条就强提醒一次，不用一直盯。"
          )
        )
      );
    } else {
      body.append(
        h(
          "div",
          { class: "center-hint" },
          XJ.icon("keyboard", 13),
          h(
            "span",
            null,
            "↑↓ 选择 · Enter 看详情 · ",
            h("b", { style: { color: "#a8d8ff" } }, "Y 通过"),
            " · ",
            h("b", { style: { color: "#ffb0b0" } }, "N 拒绝"),
            " · Esc 返回；高危按两次 Y 才生效"
          )
        )
      );
      list.forEach((item, i) => {
        const card = (XJ.views.pendingCard || XJ.views.approvalCard)(s, item, { detail: true });
        if (i === idx) card.classList.add("is-selected");
        card.addEventListener("click", () => {
          s.ui.approvalCenterIndex = i;
          A().patchSettings({});
        });
        body.append(card);
      });
      body.append(
        h(
          "div",
          { class: "set-row-sub", style: { marginTop: "10px", paddingLeft: "2px" } },
          "不允许跨会话批量通过，也不提供「一键全部通过」——放行必须看得见每个操作。"
        )
      );
    }

    return sheet("审批中心", body, { badge: list.length });
  }

  /* ============================ 审批记录 ============================ */
  function auditSheet(s) {
    const body = h("div", { class: "sheet-body" });
    if (!s.audit.length) {
      body.append(
        h(
          "div",
          { class: "empty" },
          XJ.icon("clock", 26),
          h("div", { class: "empty-title" }, "还没有审批记录"),
          h("div", { class: "empty-sub" }, "每次放行或拒绝都会在这里留一条，只记录时间与决定，保留 30 天。")
        )
      );
    } else {
      body.append(
        h(
          "div",
          { class: "set-row-sub", style: { marginBottom: "8px", paddingLeft: "2px" } },
          "本机存储 · 不落盘命令正文与路径"
        )
      );
      s.audit.forEach((a) => {
        const meta = XJ.state.RISK[a.risk] || XJ.state.RISK.exec;
        body.append(
          h(
            "div",
            { class: "set-row" },
            h(
              "div",
              { class: "set-row-main" },
              h(
                "div",
                { class: "set-row-title" },
                meta.label,
                h("span", { class: "t-ter", style: { fontWeight: 400, marginLeft: "6px" } }, a.decision === "allow" ? "已通过" : "已拒绝"),
                h("span", { class: "t-ter", style: { fontWeight: 400, marginLeft: "6px", fontSize: "11px" } }, a.by === "web" ? "主窗口" : a.by === "widget" ? "悬浮窗" : "系统")
              ),
              h(
                "div",
                { class: "set-row-sub" },
                fmtClock(a.at) + " · 等待 " + fmtDuration(a.waitedMs || 0) + " · " + String(a.id).slice(0, 12) + "…"
              )
            )
          )
        );
      });
    }
    return sheet("审批记录", body);
  }

  /* ---------------- 外壳 ---------------- */
  function sheet(title, body, opts) {
    const o = opts || {};
    const s = S();
    return h(
      "div",
      { class: "sheet", role: "dialog", "aria-label": title },
      h(
        "div",
        { class: "sheet-head" },
        h("div", { class: "sheet-title" }, title),
        o.badge ? h("span", { class: "count-badge" }, o.badge) : null,
        XJ.ui.iconBtn("close", { title: "返回", size: 15, onClick: () => A().setPanelScreen("home") })
      ),
      body
    );
  }

  XJ.views = XJ.views || {};
  XJ.views.settingsSheet = settingsSheet;
  XJ.views.approvalCenter = approvalCenter;
  XJ.views.auditSheet = auditSheet;
})();
