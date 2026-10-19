/* =============================================================================
   usage.js · 用量与余额（给面板底部那一条「今日 / 本次会话 / 余额」供数）

   数据从哪来：
     1) 会话花费 —— DSH 的 session/event 里 `assistant/message` 带真实 usage
        （inputTokens / cacheReadTokens / outputTokens），我们按 (会话, 轮) 累加，
        再乘当前模型价目表换成人民币。turn 结束就把这一轮并进「今天」和「这个会话」。
     2) 余额 —— DeepSeek 官方 `GET /user/balance`（balance_infos[0].total_balance）。
        密钥优先读环境变量 DEEPSEEK_API_KEY，其次读 ~/.dsh/.credentials.yaml 的 refs。
        60 秒缓存：/xj/state 每 1.5 秒被轮询一次，不缓存就等于往官方接口刷请求。

   为什么要自己算钱：DSH 只报 token，不报钱。价目表跟着官方「峰谷定价」走，
   周末/非工作时段按谷价（官方说明：周一至周五 9:00–12:00、14:00–18:00 为高峰，
   其余时段含周末为谷价；法定节假日按谷价，这里没做节假日表，会略偏高一点）。

   落盘：~/.dsh/ojingjing-usage.json（只存「今天」的累计，跨天自动归零），
   这样 DSH 重启后今日花费不会从 0 开始重算。
   ========================================================================== */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ---------- 价目表：元 / 百万 token，[谷价, 峰价] ---------- */
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-09 复核）
//   Flash：缓存命中 0.02/0.04，未命中 1/2，输出 4/8
//   Pro  ：Flash 的 3 倍（0.15/0.3、4.5/9、13.5/27）
const FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
const PRO = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] };
const PRICING = [
  ["deepseek-v4-pro", PRO],
  ["deepseek-pro", PRO],
  ["deepseek-flash", FLASH],
  ["deepseek-v4-flash", FLASH],
];
const DEFAULT_PRICE = FLASH;

export function priceFor(model) {
  const m = String(model || "").toLowerCase();
  for (const [key, price] of PRICING) {
    if (m.indexOf(key) !== -1) return price;
  }
  return DEFAULT_PRICE;
}

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

/** 北京时间是否高峰：周一~周五 9:00–12:00、14:00–18:00（法定节假日没算，按峰价） */
export function isPeak(ts) {
  const d = new Date(Number(ts || Date.now()) + BEIJING_OFFSET);
  const day = d.getUTCDay(); // 0 周日 … 6 周六
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 一轮的 token 数 → 人民币 */
export function costOf({ model, input, cache, output, at }) {
  const p = priceFor(model);
  const i = isPeak(at) ? 1 : 0;
  const inTok = Math.max(0, Number(input) || 0);
  const cacheTok = Math.max(0, Number(cache) || 0);
  // DSH 的 outputTokens 已经包含 reasoningTokens，不能再加一遍（否则输出价算两倍）
  const outTok = Math.max(0, Number(output) || 0);
  return (cacheTok / 1e6) * p.hit[i] + (inTok / 1e6) * p.miss[i] + (outTok / 1e6) * p.out[i];
}

const dayKey = (ts) => {
  const d = new Date(Number(ts || Date.now()) + BEIJING_OFFSET);
  return d.toISOString().slice(0, 10);
};

const LEDGER_FILE = path.join(os.homedir(), ".dsh", "ojingjing-usage.json");
const CRED_FILE = path.join(os.homedir(), ".dsh", ".credentials.yaml");
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TTL = 60 * 1000;

/** DeepSeek 密钥：环境变量 → ~/.dsh/.credentials.yaml 的 refs 段 */
function readApiKey() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const text = fs.readFileSync(CRED_FILE, "utf8");
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\s"']+)["']?\s*$/m);
    if (m && m[1]) return m[1];
  } catch {
    /* 没有文件就当作没配置 */
  }
  return "";
}

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export function createUsage() {
  /* ---------- 本地累计（今天） ---------- */
  let ledger = { day: dayKey(), cost: 0, tokens: 0, sessions: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    if (raw && raw.day === dayKey()) {
      ledger = {
        day: raw.day,
        cost: Number(raw.cost) || 0,
        tokens: Number(raw.tokens) || 0,
        sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
      };
    }
  } catch {
    /* 第一次跑，或文件坏了：从零开始 */
  }

  let saveTimer = null;
  const saveSoon = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
        fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger), "utf8");
      } catch {
        /* 写不进去不影响界面，只是重启后今日花费会重来 */
      }
    }, 3000);
    if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();
  };

  const rollDay = () => {
    const today = dayKey();
    if (ledger.day === today) return;
    ledger = { day: today, cost: 0, tokens: 0, sessions: {} };
    saveSoon();
  };

  /* ---------- 余额缓存 ---------- */
  const balance = { at: 0, value: null, currency: "CNY", error: "", inflight: false, key: "" };

  async function fetchBalance() {
    if (balance.inflight) return;
    const key = readApiKey();
    balance.key = key ? "ok" : "missing";
    if (!key) {
      balance.error = "没有找到 DEEPSEEK_API_KEY";
      balance.at = Date.now();
      return;
    }
    balance.inflight = true;
    try {
      const res = await fetch(BALANCE_URL, {
        headers: { authorization: "Bearer " + key, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null;
      if (info && info.total_balance != null) {
        balance.value = Number(info.total_balance);
        balance.currency = String(info.currency || "CNY");
        balance.error = "";
      } else {
        balance.error = "余额接口没返回数字";
      }
      balance.at = Date.now();
    } catch (err) {
      balance.error = String((err && err.message) || err).slice(0, 120);
      balance.at = Date.now();
    } finally {
      balance.inflight = false;
    }
  }

  /* ---------- 对外 ---------- */
  return {
    /** 记一轮真实用量（来自 session/event 的 assistant/message） */
    observe({ sessionId, usage, model, at }) {
      const u = usage || {};
      const input = Number(u.inputTokens) || 0;
      const cache = Number(u.cacheReadTokens) || 0;
      const output = Number(u.outputTokens) || 0;
      const tokens = input + cache + output;
      if (!tokens) return 0;
      rollDay();
      const cost = costOf({ model, input, cache, output, at: at || Date.now() });
      ledger.cost += cost;
      ledger.tokens += tokens;
      const id = String(sessionId || "unknown");
      const rec = ledger.sessions[id] || { cost: 0, tokens: 0 };
      rec.cost += cost;
      rec.tokens += tokens;
      ledger.sessions[id] = rec;
      saveSoon();
      return cost;
    },

    /** /xj/state 被轮询时顺手刷一下余额（有 60 秒 TTL，不阻塞响应） */
    maybeRefreshBalance() {
      if (balance.inflight) return;
      if (Date.now() - balance.at < BALANCE_TTL) return;
      void fetchBalance();
    },

    /** 强制刷新（面板上的小刷新按钮）：等这一趟真的问完再返回 */
    refreshBalance() {
      balance.at = 0;
      void fetchBalance();
    },

    async refreshNow() {
      balance.at = 0;
      await fetchBalance();
      return this.snapshot();
    },

    snapshot() {
      rollDay();
      const sessions = {};
      for (const [id, rec] of Object.entries(ledger.sessions)) {
        sessions[id] = { cost: round4(rec.cost), tokens: Math.round(rec.tokens) };
      }
      return {
        day: ledger.day,
        today: round4(ledger.cost),
        tokens: Math.round(ledger.tokens),
        sessions,
        balance: balance.value == null ? null : round4(balance.value),
        currency: balance.currency,
        balance_at: balance.at || 0,
        balance_error: balance.error,
        key: balance.key,
        pricing: isPeak(Date.now()) ? "peak" : "valley",
      };
    },
  };
}
