/* =============================================================================
   lines.js · 台词库
   干什么：给鲸鱼一张会说话的嘴。鼠标一移到收起态的鲸鱼上就甩一句出来，
           文案按当前状态分池抽：断线 / 待确认 / 有未读 / 正在跑 / 都清空 / 闲着。
   为什么单独一个文件：台词本质是一张表，加一句不该动逻辑。所以这里只有
           POOLS + 抽词规则，加台词 = 往对应池里塞一行。
   抽词规则：同一句不会连着出现两次；句子里的 {n} 会换成当前那个数。
   称呼：对用户的称呼统一「老大」（greeting / 台词里用，功能文案不用）。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});

  /* ---------- 台词表：按状态分池 ---------- */
  const POOLS = {
    /* 断线 / 重连中 */
    offline: [
      "老大，这边断了，我在重连。",
      "暂时够不着 Harness，老大别急。",
      "连不上，老大。我在这儿守着。",
      "信号没了，老大。不是你掉线，是它。",
      "老大，海面上全是杂音，我先等你恢复。",
    ],
    /* 有待确认（优先级最高：先谈正事） */
    pending: [
      "老大，{n} 项等着你点头。",
      "这个我不敢替你做主，老大。",
      "等你一句话，老大。",
      "要确认的在这儿了，老大。",
      "老大，它卡住等你呢。",
    ],
    /* 有会话跑完了还没看 */
    unread: [
      "老大，活儿干完了，等你阅。",
      "有结果了，老大。看不看随你。",
      "收工了，老大。我替你高兴一下。",
      "老大，这波已经跑完，等你来看。",
      "结果躺在里面了，老大。",
    ],
    /* 有任务正在跑 */
    working: [
      "老大，{n} 个在跑，我盯着。",
      "跑起来了，老大。有结果我第一时间喊你。",
      "任务转着呢，老大先歇会儿。",
      "老大放心，进度我替你看着。",
      "正在干活，老大不用一直盯着这儿。",
    ],
    /* 会话还在，但都没动静了 */
    clear: [
      "都跑完了，老大。现在是干净的。",
      "没活了，老大。要不要再来一单？",
      "全部结束，老大。我也可以喘口气。",
      "老大，清单清空了，可以收工。",
    ],
    /* 一个会话都没有 */
    idle: [
      "老大，今天还没开工。",
      "水面很平静，老大。我候着。",
      "老大，我要是有手，这会儿一定在泡茶。",
      "没什么要报的，老大。有动静我第一时间喊。",
      "老大，我在。有事儿尽管吩咐。",
      "闲着也是闲着……老大，我可以表演个喷水。",
    ],
  };

  /* ---------- 内部：最近一句，用来避免连着重复 ---------- */
  const LAST = { text: null };

  /** 当前该说哪个池的话：按紧急程度排序（§4.3 状态真值表同序） */
  function contextOf(s) {
    if (s.connection === "offline" || s.connection === "reconnecting") return "offline";
    if (XJ.state.pendingList(s).length) return "pending";
    if (s.sessions.some((x) => x.unread)) return "unread";
    if (s.sessions.some((x) => x.state === "working")) return "working";
    if (s.sessions.length) return "clear";
    return "idle";
  }

  /** {n} 换成正主的数字：待确认就数待确认，在跑就数在跑 */
  function countFor(ctx, s) {
    if (ctx === "pending") return XJ.state.pendingList(s).length;
    if (ctx === "working") return s.sessions.filter((x) => x.state === "working").length;
    return 0;
  }

  function fill(tpl, s, ctx) {
    return tpl.replace(/\{n\}/g, String(countFor(ctx, s)));
  }

  /** 抽一句返回 { text, ctx, at }；同一句不连着出两次 */
  function pick(s) {
    s = s || XJ.state.store.state;
    const ctx = contextOf(s);
    const pool = POOLS[ctx] || POOLS.idle;
    const filled = pool.map((t) => fill(t, s, ctx));
    const usable = filled.length > 1 ? filled.filter((t) => t !== LAST.text) : filled;
    const text = usable[Math.floor(Math.random() * usable.length)] || filled[0];
    LAST.text = text;
    return { text, ctx, at: Date.now() };
  }

  XJ.lines = { pick, contextOf, pools: POOLS };
})();
