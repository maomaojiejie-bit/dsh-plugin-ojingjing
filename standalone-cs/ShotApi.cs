// 截图提问要用到的网络出口：挑会话、POST /xj/prompt、调视觉模型「优化问法」。
// 全程用 HttpWebRequest（.NET 4.0 就有），不依赖 HttpClient —— csc 那边少一个引用就少一个坑。
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace Ojingjing
{
    static class ShotApi
    {
        const string PolishSystem =
            "你是提问助手。用户对哦鲸鲸（一个常驻桌面的 AI 助手）截了一张图，想向 AI 追问。" +
            "把用户的草稿改写成一句中文提问：具体、可执行、不臆测画面内容、不超过 60 字；" +
            "如果草稿为空，就根据图片给出一句最有信息量的提问。只输出问题本身，不要解释。";

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        static ShotApi()
        {
            // 默认上限 2MB，一张 1080p PNG 的 base64 就有 3~4MB，不放开会直接抛
            // ArgumentException（而且异常被吞掉，页面只会一直停在「发送中…」）
            Json.MaxJsonLength = int.MaxValue;
            Json.RecursionLimit = 200;
        }

        static string Base(int port)
        {
            return "http://127.0.0.1:" + port;
        }

        /// <summary>目标会话：正在执行的优先，否则最近一个。拿不到返回 null。</summary>
        public static string PickSession(int port, out string title)
        {
            title = "";
            Dictionary<string, object> state = GetJson(Base(port) + "/xj/state", 3000, null);
            if (state == null) return null;
            object sessionsObj;
            if (!state.TryGetValue("sessions", out sessionsObj)) return null;
            IEnumerable list = sessionsObj as IEnumerable;
            if (list == null) return null;
            string first = null;
            string working = null;
            string workingTitle = null;
            string firstTitle = null;
            foreach (object item in list)
            {
                Dictionary<string, object> s = item as Dictionary<string, object>;
                if (s == null) continue;
                string id = Str(s, "id");
                if (string.IsNullOrEmpty(id)) continue;
                string t = Str(s, "title");
                if (first == null)
                {
                    first = id;
                    firstTitle = t;
                }
                if (working == null && Str(s, "state") == "working")
                {
                    working = id;
                    workingTitle = t;
                }
            }
            if (working != null)
            {
                title = workingTitle ?? "";
                return working;
            }
            title = firstTitle ?? "";
            return first;
        }

        /// <summary>把截图投进会话；返回是否成功 + 给人看的一句话。</summary>
        public static bool PostScreenshot(int port, byte[] png, string question, out string message)
        {
            string title;
            string sessionId = PickSession(port, out title);
            if (string.IsNullOrEmpty(sessionId))
            {
                message = "没有可发送的会话";
                return false;
            }
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["sessionId"] = sessionId;
            body["text"] = string.IsNullOrEmpty(question) ? "请查看这张截图。" : question;
            Dictionary<string, object> image = new Dictionary<string, object>();
            image["mediaType"] = "image/png";
            image["data"] = Convert.ToBase64String(png);
            image["name"] = "ojingjing-shot.png";
            body["image"] = image;

            try
            {
                Dictionary<string, object> reply = PostJson(Base(port) + "/xj/prompt", body, 20000, null);
                if (reply == null)
                {
                    message = "发送失败：宿主没回应";
                    return false;
                }
                ShellSettings.Trace("截图：已发送到 " + sessionId + "（" + png.Length + " bytes）");
                message = "已发到《" + (string.IsNullOrEmpty(title) ? sessionId.Substring(Math.Max(0, sessionId.Length - 4)) : title) + "》";
                return true;
            }
            catch (WebException err)
            {
                HttpWebResponse resp = err.Response as HttpWebResponse;
                string detail = "";
                if (resp != null)
                {
                    try
                    {
                        using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                        {
                            detail = reader.ReadToEnd();
                        }
                    }
                    catch
                    {
                        // 读不到就只留状态码
                    }
                    ShellSettings.Trace("截图：发送失败 HTTP " + (int)resp.StatusCode + " " + Trim(detail, 200));
                    message = "发送失败（HTTP " + (int)resp.StatusCode + "）";
                }
                else
                {
                    ShellSettings.Trace("截图：发送失败 " + err.Message);
                    message = "没发出去，检查 Harness 是否在跑";
                }
                return false;
            }
            catch (Exception err)
            {
                ShellSettings.Trace("截图：发送失败 " + err.Message);
                message = "没发出去，检查 Harness 是否在跑";
                return false;
            }
        }

        /// <summary>让视觉模型把草稿改成一句更好的提问。</summary>
        public static bool Polish(ShellSettings settings, byte[] png, string text, out string result, out string reason)
        {
            result = "";
            reason = "";
            string baseUrl = (settings.VisionBaseUrl ?? "").TrimEnd('/');
            string key = settings.VisionApiKey ?? "";
            string model = settings.VisionModel ?? "";
            if (baseUrl.Length == 0 || key.Length == 0 || model.Length == 0)
            {
                reason = "还没配视觉模型：托盘 → 设置 → 视觉模型，填好再用";
                return false;
            }

            List<object> content = new List<object>();
            if (png != null && png.Length > 0)
            {
                Dictionary<string, object> part = new Dictionary<string, object>();
                part["type"] = "image_url";
                Dictionary<string, object> url = new Dictionary<string, object>();
                url["url"] = "data:image/png;base64," + Convert.ToBase64String(png);
                part["image_url"] = url;
                content.Add(part);
            }
            Dictionary<string, object> textPart = new Dictionary<string, object>();
            textPart["type"] = "text";
            textPart["text"] = string.IsNullOrEmpty(text) ? "（我还没想好问什么，帮我提一个）" : text;
            content.Add(textPart);

            Dictionary<string, object> system = new Dictionary<string, object>();
            system["role"] = "system";
            system["content"] = PolishSystem;
            Dictionary<string, object> user = new Dictionary<string, object>();
            user["role"] = "user";
            user["content"] = content;
            List<object> messages = new List<object>();
            messages.Add(system);
            messages.Add(user);

            Dictionary<string, object> body = new Dictionary<string, object>();
            body["model"] = model;
            body["messages"] = messages;
            body["temperature"] = 0.3;
            body["max_tokens"] = 200;

            try
            {
                Dictionary<string, object> reply = PostJson(baseUrl + "/chat/completions", body, 40000, key);
                if (reply == null)
                {
                    reason = "优化失败，直接发也行";
                    return false;
                }
                object choicesObj;
                if (!reply.TryGetValue("choices", out choicesObj))
                {
                    reason = "模型没给出问法，自己写一句也行";
                    return false;
                }
                IList choices = choicesObj as IList;
                if (choices == null || choices.Count == 0)
                {
                    reason = "模型没给出问法，自己写一句也行";
                    return false;
                }
                Dictionary<string, object> first = choices[0] as Dictionary<string, object>;
                object messageObj;
                if (first == null || !first.TryGetValue("message", out messageObj)) return Fail(out reason);
                Dictionary<string, object> message = messageObj as Dictionary<string, object>;
                object contentObj;
                if (message == null || !message.TryGetValue("content", out contentObj)) return Fail(out reason);
                string outText = (contentObj as string ?? "").Trim();
                if (outText.Length == 0) return Fail(out reason);
                result = outText;
                ShellSettings.Trace("优化：" + Trim(outText, 40));
                return true;
            }
            catch (WebException err)
            {
                HttpWebResponse resp = err.Response as HttpWebResponse;
                if (resp != null)
                {
                    ShellSettings.Trace("优化：HTTP " + (int)resp.StatusCode);
                    reason = "优化失败（HTTP " + (int)resp.StatusCode + "）";
                }
                else
                {
                    ShellSettings.Trace("优化失败 " + err.Message);
                    reason = "优化失败，直接发也行";
                }
                return false;
            }
            catch (Exception err)
            {
                ShellSettings.Trace("优化失败 " + err.Message);
                reason = "优化失败，直接发也行";
                return false;
            }
        }

        static bool Fail(out string reason)
        {
            reason = "模型没给出问法，自己写一句也行";
            return false;
        }

        /* ---------------------------------- HTTP ---------------------------------- */

        static Dictionary<string, object> PostJson(string url, Dictionary<string, object> body, int timeoutMs, string bearer)
        {
            return Send("POST", url, Json.Serialize(body), timeoutMs, bearer);
        }

        static Dictionary<string, object> GetJson(string url, int timeoutMs, string bearer)
        {
            try
            {
                return Send("GET", url, null, timeoutMs, bearer);
            }
            catch
            {
                return null;
            }
        }

        static Dictionary<string, object> Send(string method, string url, string payload, int timeoutMs, string bearer)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.KeepAlive = false;
            req.Proxy = null;                    // 127.0.0.1 别走系统代理
            if (payload != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(payload);
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                if (bearer != null) req.Headers["Authorization"] = "Bearer " + bearer;
                using (Stream stream = req.GetRequestStream())
                {
                    stream.Write(bytes, 0, bytes.Length);
                }
            }
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                string text = reader.ReadToEnd();
                if (string.IsNullOrEmpty(text)) return new Dictionary<string, object>();
                try
                {
                    return Json.Deserialize<Dictionary<string, object>>(text);
                }
                catch
                {
                    return new Dictionary<string, object>();
                }
            }
        }

        static string Str(Dictionary<string, object> data, string key)
        {
            object v;
            if (data != null && data.TryGetValue(key, out v) && v != null) return v as string ?? Convert.ToString(v);
            return "";
        }

        static string Trim(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max);
        }
    }
}
