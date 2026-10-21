// 页面 ↔ 外壳的消息桥。
//
// 页面 → 外壳（chrome.webview.postMessage，见 web/embed.js 的 post()）：
//   {type:"resize", w, h}       页面说的目标尺寸（外壳按「长大立刻跟、缩小等动画」应用）
//   {type:"card", rects:[…]}    可见区域（每块 .form 一个矩形，物理像素）：外壳按它裁窗口外形
//   {type:"drag"}               按住鲸鱼拖窗口
//   {type:"open-dsh"}           切到 / 启动 DSH Desktop
//   {type:"quit"}               退出外壳
//   {type:"open-url", url}      打开链接（只放行 https）
//   {type:"shot-capture"}       截一张（Ctrl+Shift+A 之外的入口）
//   {type:"shot-action", action, text}  action = send / retake / polish / capture
//   {type:"settings"}           在外壳里弹设置窗
//
// 外壳 → 页面（PostWebMessageAsJson）：
//   {type:"pointer", inside}    真实光标在不在窗口矩形里（WebView2 自己会判错 :hover）
//   {type:"connection", state}  连接状态（offline / online）：DSH 关掉后宿主不再推
//                               connection.offline，壳的探活替它告诉页面（见 TellPageOffline）
//   {type:"shell-tap"}          外壳补发的「点了鲸鱼」（窗口收不到鼠标消息时的兜底，见 OnClickWatch）
//   {type:"shot", dataUrl, width, height, sessionTitle}
//   {type:"shot-done", ok, message} / {type:"shot-polished", text} / {type:"shot-polish-failed", reason}
using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Ojingjing
{
    partial class OverlayForm
    {
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string raw;
            try
            {
                raw = e.WebMessageAsJson;
            }
            catch
            {
                return;
            }
            if (string.IsNullOrEmpty(raw)) return;

            string type = JsonString(raw, "type");
            if (type == "resize")
            {
                int w = JsonInt(raw, "w");
                int h = JsonInt(raw, "h");
                if (w > 0 && h > 0) QueueSize(w, h);
            }
            else if (type == "card")
            {
                // 页面量到的可见区域：每块 .form 一个矩形（物理像素，页面已乘 dpr）。
                // 气泡 / 输入条形态下有两个（气泡 + 鲸鱼球），中间的 gap 靠复合区域切掉，
                // 不然那片空隙会露出一整块窗体深底（2026-10-21 老大报的「大块黑背景」）。
                System.Collections.Generic.List<int[]> list = JsonRectList(raw);
                if (list.Count > 0)
                {
                    cardRects.Clear();
                    for (int i = 0; i < list.Count; i++)
                    {
                        int[] v = list[i];
                        CardRect c = new CardRect();
                        c.X = v[0]; c.Y = v[1]; c.W = v[2]; c.H = v[3]; c.R = v[4];
                        cardRects.Add(c);
                    }
                    hasCard = true;
                    cardRetry = 0;
                    // 展开/收起动画第一帧可能还在旧窗口坐标系里，越界就先不动外形，
                    // regionTimer 会再试几次（页面一量到新尺寸就重报）
                    ApplyCardRects();
                }
            }
            else if (type == "drag")
            {
                StartDrag();
            }
            else if (type == "open-dsh")
            {
                OpenDsh();
            }
            else if (type == "open-url")
            {
                OpenUrl(JsonString(raw, "url"));
            }
            else if (type == "quit")
            {
                Close();
            }
            else if (type == "shot-action")
            {
                OnShotAction(JsonString(raw, "action"), JsonString(raw, "text"));
            }
            else if (type == "shot-capture")
            {
                StartCapture();
            }
            else if (type == "settings")
            {
                if (OpenSettingsRequested != null) OpenSettingsRequested();
            }
            else if (type == "companion")
            {
                // 陪伴账本（A3）：页面要一份快照（面板打开时 + 开着时每 60s）。
                // 里程碑只在被取走的这一次带出去，页面放完星星就清，不会重复庆祝。
                SendToPage(company.PayloadMessage());
            }
            else if (type == "tap-ack")
            {
                // 页面确实收到了这次点击 —— 和 OnClickWatch 的「左键在窗内」对照，
                // 就知道是「点击没送到」还是「送到了但页面没反应」
                lastPageAckAt = DateTime.UtcNow;
                ShellSettings.Trace("页面收到点击 " + JsonInt(raw, "x") + "," + JsonInt(raw, "y"));
            }
            else if (type == "form")
            {
                // 页面形态变化（collapsed / bubble / panel / quickbar）——
                // 「点了没反应」时看这一行就知道页面到底有没有切形态
                ShellSettings.Trace("页面形态=" + JsonString(raw, "value"));
            }
        }

        /* 每 200ms 告诉页面「指针还在不在窗口里」。
           WebView2 在自己被 resize 之后会把 :hover 判错（CSS 以为指针走了、还不发 enter），
           而悬停收起靠的正是这个 —— 判错就会 展开→收→展开 地弹。外壳这边有真实光标坐标，
           所以这个信号比任何 DOM 事件都可信。只在状态变化时发，不刷屏。

           两侧的脾气不一样，所以是「进立刻、出要等」：
           - 进来马上回报，气泡才能跟手撑住；
           - 出去先压 POINTER_HOLD_MS。全屏游戏/独占程序会每帧 SetCursorPos 抢光标，
             指针在窗口边上反复进出（日志里 pointer inside 一秒能翻好几次），
             直接回报就是你看到的 展开→收→展开 抽搐。 */
        const int POINTER_HOLD_MS = 500;
        bool pointerPending;
        DateTime pointerLeftAt;

        void OnPointerTick(object sender, EventArgs e)
        {
            bool inside = Bounds.Contains(Cursor.Position);
            if (inside)
            {
                pointerPending = false;
                if (pointerInside) return;
                pointerInside = true;
                EmitPointer(true);
                return;
            }
            if (!pointerInside) { pointerPending = false; return; }
            if (!pointerPending)
            {
                pointerPending = true;
                pointerLeftAt = DateTime.UtcNow;
                return;
            }
            if ((DateTime.UtcNow - pointerLeftAt).TotalMilliseconds < POINTER_HOLD_MS) return;
            pointerPending = false;
            pointerInside = false;
            EmitPointer(false);
        }

        void EmitPointer(bool inside)
        {
            ShellSettings.Trace("pointer inside=" + inside);
            CoreWebView2 core = web == null ? null : web.CoreWebView2;
            if (core == null) return;
            core.PostWebMessageAsJson(inside ? "{\"type\":\"pointer\",\"inside\":true}" : "{\"type\":\"pointer\",\"inside\":false}");
        }

        /* ---------------- 点击兜底 ----------------
           全屏游戏（异环）独占鼠标时，光标被游戏每帧 SetCursorPos 拽走，
           窗口收不到 WM_LBUTTONDOWN，页面就成了「点了没反应」。
           这里用 GetAsyncKeyState（全局、不需要焦点）+ Cursor.Position 兜底：
           左键按下且此刻光标在窗口矩形里 → 补发一次 shell-tap。
           页面会看自己最近 400ms 内有没有收到真实 pointerdown，收到了就忽略这条。 */
        void OnClickWatch(object sender, EventArgs e)
        {
            bool down = Native.GetAsyncKeyState(0x01) < 0;
            if (down && !leftDownPrev)
            {
                Point p = Cursor.Position;
                bool inside = Visible && Bounds.Contains(p);
                // 诊断：点击落在窗口附近就记一笔（含是否在窗内、离窗多远），
                // 用来区分「点没到窗口」和「点到了但页面没理」
                if (Visible && (DateTime.UtcNow - lastClickTraceAt).TotalMilliseconds > 400)
                {
                    int dx = Math.Max(Math.Max(Bounds.Left - p.X, p.X - Bounds.Right), 0);
                    int dy = Math.Max(Math.Max(Bounds.Top - p.Y, p.Y - Bounds.Bottom), 0);
                    int away = Math.Max(dx, dy);
                    if (inside || away <= 240)
                    {
                        lastClickTraceAt = DateTime.UtcNow;
                        ShellSettings.Trace("左键 " + p.X + "," + p.Y + " 在窗内=" + inside + " 距窗=" + away);
                    }
                }
                if (inside)
                {
                    // 页面已经在 300ms 内 ack 过「我收到点击了」→ 这一下是它自己的，
                    // 绝不能再补一条 shell-tap（补了就会把按钮点击变成「开关气泡」）
                    bool pageGotIt = (DateTime.UtcNow - lastPageAckAt).TotalMilliseconds < 300;
                    if (!pageGotIt && (DateTime.UtcNow - lastFallbackAt).TotalMilliseconds > 60)
                    {
                        lastFallbackAt = DateTime.UtcNow;
                        ShellSettings.Trace("补发 shell-tap（页面这次没收到鼠标消息）");
                        // 先把「指针在窗内」这条状态同步过去，页面就不必自己猜
                        EmitPointer(true);
                        SendToPage("{\"type\":\"shell-tap\"}");
                    }
                }
            }
            leftDownPrev = down;
        }

        void PostLater(string json)
        {
            try
            {
                if (IsDisposed) return;
                BeginInvoke(new MethodInvoker(delegate { SendToPage(json); }));
            }
            catch
            {
                // 窗口已经关了，这条消息没意义
            }
        }

        void SendToPage(string json)
        {
            try
            {
                if (web == null || web.CoreWebView2 == null) return;
                web.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch
            {
                // 页面还没起来，丢掉
            }
        }

        /* ---------------- 手写 JSON 小工具 ----------------
           只处理「我们和页面之间那几个固定形状」的消息（扁平对象、一级字符串/整数），
           不值得为它引 System.Web.Extensions（那是 ShotApi/Settings 在用的大件）。 */

        static string JsonQuote(string text)
        {
            if (text == null) return "\"\"";
            System.Text.StringBuilder sb = new System.Text.StringBuilder("\"");
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        static string JsonString(string raw, string key)
        {
            string needle = "\"" + key + "\":\"";
            int start = raw.IndexOf(needle, StringComparison.Ordinal);
            if (start < 0) return "";
            start += needle.Length;
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            for (int i = start; i < raw.Length; i++)
            {
                char c = raw[i];
                if (c == '\\' && i + 1 < raw.Length)
                {
                    sb.Append(raw[i + 1]);
                    i++;
                    continue;
                }
                if (c == '"') break;
                sb.Append(c);
            }
            return sb.ToString();
        }

        static int JsonInt(string raw, string key)
        {
            string needle = "\"" + key + "\":";
            int start = raw.IndexOf(needle, StringComparison.Ordinal);
            if (start < 0) return 0;
            start += needle.Length;
            int end = start;
            while (end < raw.Length && (char.IsDigit(raw[end]) || raw[end] == '-')) end++;
            int value;
            if (int.TryParse(raw.Substring(start, end - start), out value)) return value;
            return 0;
        }

        /// <summary>
        /// 取 `"rects":[{x,y,w,h,r},…]` 里的每一项。固定形状、无嵌套花括号，
        /// 所以按 { } 配对扫就行，不值得为它引一个 JSON 库。
        /// </summary>
        static System.Collections.Generic.List<int[]> JsonRectList(string raw)
        {
            var list = new System.Collections.Generic.List<int[]>();
            int at = raw.IndexOf("\"rects\":", StringComparison.Ordinal);
            if (at < 0) return list;
            int open = raw.IndexOf('[', at);
            if (open < 0) return list;
            int i = open + 1;
            while (i < raw.Length)
            {
                int a = raw.IndexOf('{', i);
                if (a < 0) break;
                int closeBracket = raw.IndexOf(']', i);
                if (closeBracket >= 0 && closeBracket < a) break;   // 数组已经结束
                int b = raw.IndexOf('}', a);
                if (b < 0) break;
                string body = raw.Substring(a, b - a + 1);
                list.Add(new int[]
                {
                    JsonInt(body, "x"), JsonInt(body, "y"),
                    JsonInt(body, "w"), JsonInt(body, "h"), JsonInt(body, "r")
                });
                i = b + 1;
            }
            return list;
        }
    }
}
