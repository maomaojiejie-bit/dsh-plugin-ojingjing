// 陪伴时长账本（A3）。移植自 Python 外壳 ojingjing_py.py 的 Companionship 类，
// 行为逐条对齐：同一个 json 文件（%APPDATA%\ojingjing\companionship.json），
// 两个外壳可以来回切换而不丢账本。
//
// 「陪伴」的语义是**窗口在 + 人也在**：窗口可见，并且全系统 5 分钟内有过键鼠输入。
// 挂机一夜不算——那只是鲸鱼在守着，不是陪着你。
// 判「人在不在」用 GetLastInputInfo（整个会话最后一次输入的时间），比在窗口上装事件过滤器准得多：
// 窗口只有 108px，鼠标在屏幕另一头时照样是「人在」。
//
// 只记秒数，不碰任何内容 —— 纯本地，不出本机。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Ojingjing
{
    class Companionship
    {
        readonly string path;
        readonly object gate = new object();
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        Dictionary<string, object> data;
        Stopwatch clock = Stopwatch.StartNew();
        double frac;
        bool dirty;
        int? pendingMilestone;

        //: 多久没输入就不算「人在陪着」
        const int IDLE_LIMIT_MS = 5 * 60 * 1000;

        //: 记账节拍（与 py 外壳一致）
        const int TICK_MS = 15000;

        //: 落盘节拍（每拍都写文件没必要，坏盘不说，还吵）
        const int SAVE_SEC = 60;

        //: 里程碑（秒）。到了就放星星 + 说一句话，每条只庆祝一次。
        static readonly int[] MILESTONES = { 3600, 10 * 3600, 100 * 3600, 500 * 3600, 1000 * 3600 };

        public Companionship(string path)
        {
            this.path = path;
            data = Load();
        }

        /* ---------------- 存储 ---------------- */

        static string Today()
        {
            return DateTime.Now.ToString("yyyy-MM-dd");
        }

        Dictionary<string, object> Blank()
        {
            return new Dictionary<string, object>
            {
                { "first_met", Today() },
                { "total_sec", 0 },
                { "today", Today() },
                { "today_sec", 0 },
                { "streak_days", 1 },
                { "milestones", new List<object>() },
            };
        }

        Dictionary<string, object> Load()
        {
            Dictionary<string, object> base0 = Blank();
            try
            {
                if (!File.Exists(path)) return base0;
                Dictionary<string, object> raw =
                    json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                if (raw == null) return base0;
                foreach (KeyValuePair<string, object> kv in raw)
                {
                    if (kv.Value != null) base0[kv.Key] = kv.Value;
                }
                return base0;
            }
            catch (Exception ex)
            {
                ShellSettings.Trace("companionship.json 读不动（" + ex.Message + "），重新开始记");
                return base0;
            }
        }

        public void Save(bool force = false)
        {
            lock (gate)
            {
                if (!dirty && !force) return;
                try
                {
                    string dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.WriteAllText(path, json.Serialize(data), Encoding.UTF8);
                    dirty = false;
                }
                catch (Exception ex)
                {
                    ShellSettings.Trace("companionship.json 写不进去（" + ex.Message + "）");
                }
            }
        }

        /* ---------------- 记账 ---------------- */

        static string Yesterday()
        {
            return DateTime.Now.AddDays(-1).ToString("yyyy-MM-dd");
        }

        void RollDay()
        {
            string today = Today();
            string cur = data.ContainsKey("today") ? Convert.ToString(data["today"]) : "";
            if (cur == today) return;
            // 昨天也陪过 → 连击 +1；中间断过 → 从 1 重新数
            int streak = data.ContainsKey("streak_days") ? Convert.ToInt32(data["streak_days"]) : 1;
            data["today"] = today;
            data["today_sec"] = 0;
            data["streak_days"] = cur == Yesterday() ? streak + 1 : 1;
            dirty = true;
            ShellSettings.Trace("陪伴跨天：连击 " + data["streak_days"] + " 天");
        }

        public void Tick(bool active)
        {
            double elapsed = clock.Elapsed.TotalSeconds;
            clock.Restart();
            if (!active) return;
            // 睡眠 / 长时间阻塞后 elapsed 会很大：一次最多补 3 拍，
            // 否则合盖一夜再打开会凭空多出几小时「陪伴」。
            elapsed = Math.Min(elapsed, TICK_MS / 1000.0 * 3);
            lock (gate)
            {
                RollDay();
                frac += elapsed;
                int whole = (int)frac;
                if (whole <= 0) return;
                frac -= whole;
                data["total_sec"] = Total("total_sec") + whole;
                data["today_sec"] = Total("today_sec") + whole;
                dirty = true;
                CheckMilestone();
            }
        }

        int Total(string key)
        {
            return data.ContainsKey(key) ? Convert.ToInt32(data[key]) : 0;
        }

        void CheckMilestone()
        {
            int total = Total("total_sec");
            List<object> done = AsList(data.ContainsKey("milestones") ? data["milestones"] : null);
            HashSet<string> doneSet = new HashSet<string>();
            foreach (object o in done) doneSet.Add(Convert.ToString(o));
            foreach (int mark in MILESTONES)
            {
                if (total >= mark && !doneSet.Contains(mark.ToString()))
                {
                    doneSet.Add(mark.ToString());
                    List<object> next = new List<object>();
                    foreach (string s in doneSet) next.Add(int.Parse(s));
                    next.Sort();
                    data["milestones"] = next;
                    pendingMilestone = mark;
                    dirty = true;
                    ShellSettings.Trace("陪伴里程碑：" + mark / 3600 + " 小时");
                    return;
                }
            }
        }

        /// <summary>
        /// JSON 数组反序列化回来是 ArrayList（JavaScriptSerializer 的癖好），不是
        /// List&lt;object&gt;——直接强转会 InvalidCastException 把整个外壳崩掉。
        /// 2026-10-21 老大踩到：companionship.json 落盘后重启外壳，第一个记账 tick
        /// （启动 15s、窗口可见、人在）就走 CheckMilestone 炸出 .NET 未处理异常对话框。
        /// 这里认 IEnumerable（ArrayList / List 都吃），字符串除外。
        /// </summary>
        static List<object> AsList(object value)
        {
            List<object> list = new List<object>();
            if (value == null || value is string) return list;
            System.Collections.IEnumerable each = value as System.Collections.IEnumerable;
            if (each == null) return list;
            foreach (object o in each) list.Add(o);
            return list;
        }

        /* ---------------- 给页面 ---------------- */

        /// <summary>快照字段。里程碑只在被取走的那一次带出去，页面据此放星星；取过就清掉，不会重复庆祝。</summary>
        public Dictionary<string, object> Payload()
        {
            lock (gate)
            {
                RollDay();
                string first = data.ContainsKey("first_met") ? Convert.ToString(data["first_met"]) : Today();
                int days = 1;
                try
                {
                    DateTime a = DateTime.ParseExact(Today(), "yyyy-MM-dd", null);
                    DateTime b = DateTime.ParseExact(first, "yyyy-MM-dd", null);
                    days = (int)(a - b).TotalDays + 1;
                }
                catch
                {
                    days = 1;
                }
                if (days < 1) days = 1;
                Dictionary<string, object> out0 = new Dictionary<string, object>
                {
                    { "first_met", first },
                    { "days_known", days },
                    { "total_sec", Total("total_sec") },
                    { "today_sec", Total("today_sec") },
                    { "streak_days", data.ContainsKey("streak_days") ? Convert.ToInt32(data["streak_days"]) : 1 },
                    { "milestone", pendingMilestone.HasValue ? (object)pendingMilestone.Value : null },
                };
                pendingMilestone = null;
                return out0;
            }
        }

        /// <summary>回给页面的整条消息（type 走外壳→页面的约定，字段与 Payload() 相同）。</summary>
        public string PayloadMessage()
        {
            Dictionary<string, object> msg = Payload();
            msg["type"] = "companion";
            return json.Serialize(msg);
        }
    }
}
