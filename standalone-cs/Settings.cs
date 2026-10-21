// 配置读写：直接复用 Python 版留下的 %APPDATA%\ojingjing\settings.json + window.json，
// 两个外壳可以来回切换而不丢设置（键名沿用 port / hotkey_toggle / hotkey_capture / autostart …）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Ojingjing
{
    class ShellSettings
    {
        public int Port = 43120;
        public string HotkeyToggle = "Ctrl+Shift+Space";
        public string HotkeyCapture = "Ctrl+Shift+A";
        public bool Autostart;
        public bool HighFps;
        public string CaptureMode = "screen";      // screen = 默认整屏，region = 先给一个 60% 的框
        public bool ExitWithDsh;
        public string VisionBaseUrl = "";
        public string VisionApiKey = "";
        public string VisionModel = "";
        public string ConfigDir;
        public string DataSource = "settings.json";

        readonly JavaScriptSerializer json = new JavaScriptSerializer();

        public static string PickConfigDir()
        {
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            List<string> candidates = new List<string>();
            if (!string.IsNullOrEmpty(roaming)) candidates.Add(Path.Combine(roaming, "ojingjing"));
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!string.IsNullOrEmpty(local)) candidates.Add(Path.Combine(local, "ojingjing"));
            candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data"));

            foreach (string dir in candidates)
            {
                try
                {
                    Directory.CreateDirectory(dir);
                    string probe = Path.Combine(dir, ".xj-probe");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return dir;
                }
                catch
                {
                    // 写不进去就试下一个（受沙箱限制时退到程序目录）
                }
            }
            return candidates[candidates.Count - 1];
        }

        public static ShellSettings Load()
        {
            ShellSettings s = new ShellSettings();
            s.ConfigDir = PickConfigDir();
            string path = Path.Combine(s.ConfigDir, "settings.json");
            try
            {
                if (File.Exists(path))
                {
                    Dictionary<string, object> data = s.json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                    s.Apply(data);
                }
            }
            catch (Exception err)
            {
                Trace("settings.json 读不动：" + err.Message);
            }
            return s;
        }

        void Apply(Dictionary<string, object> data)
        {
            if (data == null) return;
            object v;
            if (data.TryGetValue("port", out v) && v != null) Port = ToInt(v, Port);
            if (data.TryGetValue("hotkey_toggle", out v) && v is string) HotkeyToggle = (string)v;
            if (data.TryGetValue("hotkey_capture", out v) && v is string) HotkeyCapture = (string)v;
            if (data.TryGetValue("autostart", out v) && v is bool) Autostart = (bool)v;
            if (data.TryGetValue("highFps", out v) && v is bool) HighFps = (bool)v;
            if (data.TryGetValue("capture_mode", out v) && v is string) CaptureMode = (string)v;
            if (data.TryGetValue("exit_with_dsh", out v) && v is bool) ExitWithDsh = (bool)v;
            if (data.TryGetValue("vision", out v))
            {
                Dictionary<string, object> vision = v as Dictionary<string, object>;
                if (vision != null)
                {
                    object a;
                    if (vision.TryGetValue("baseUrl", out a) && a is string) VisionBaseUrl = (string)a;
                    if (vision.TryGetValue("apiKey", out a) && a is string) VisionApiKey = (string)a;
                    if (vision.TryGetValue("model", out a) && a is string) VisionModel = (string)a;
                }
            }
        }

        /// <summary>把设置写回 settings.json（只覆盖我们管的键，其它插件写的键原样留着）。</summary>
        public void Save()
        {
            string path = Path.Combine(ConfigDir, "settings.json");
            Dictionary<string, object> data = new Dictionary<string, object>();
            try
            {
                if (File.Exists(path))
                {
                    Dictionary<string, object> old = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                    if (old != null) data = old;
                }
            }
            catch (Exception err)
            {
                Trace("settings.json 读不动（保存前）：" + err.Message);
            }
            data["port"] = Port;
            data["hotkey_toggle"] = HotkeyToggle;
            data["hotkey_capture"] = HotkeyCapture;
            data["autostart"] = Autostart;
            data["highFps"] = HighFps;
            data["capture_mode"] = CaptureMode;
            data["exit_with_dsh"] = ExitWithDsh;
            Dictionary<string, object> vision = new Dictionary<string, object>();
            vision["baseUrl"] = VisionBaseUrl;
            vision["apiKey"] = VisionApiKey;
            vision["model"] = VisionModel;
            data["vision"] = vision;
            try
            {
                Directory.CreateDirectory(ConfigDir);
                File.WriteAllText(path, json.Serialize(data), Encoding.UTF8);
            }
            catch (Exception err)
            {
                Trace("settings.json 写不动：" + err.Message);
            }
        }

        static int ToInt(object value, int fallback)
        {
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        /* ---------------- 窗口位置：和 Python 版同一个 window.json ---------------- */

        public bool LoadPosition(out int x, out int y)
        {
            x = 0;
            y = 0;
            try
            {
                string path = Path.Combine(ConfigDir, "window.json");
                if (!File.Exists(path)) return false;
                Dictionary<string, object> data = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                object vx, vy;
                if (data != null && data.TryGetValue("x", out vx) && data.TryGetValue("y", out vy))
                {
                    x = ToInt(vx, 0);
                    y = ToInt(vy, 0);
                    return true;
                }
            }
            catch (Exception err)
            {
                Trace("window.json 读不动：" + err.Message);
            }
            return false;
        }

        public void SavePosition(int x, int y)
        {
            try
            {
                Dictionary<string, object> data = new Dictionary<string, object>();
                data["x"] = x;
                data["y"] = y;
                Directory.CreateDirectory(ConfigDir);
                File.WriteAllText(Path.Combine(ConfigDir, "window.json"), json.Serialize(data), Encoding.UTF8);
            }
            catch (Exception err)
            {
                Trace("window.json 写不动：" + err.Message);
            }
        }

        /* ---------------- 热键文本 → RegisterHotKey 参数 ---------------- */

        /// <summary>"Ctrl+Shift+Space" → (MOD_CONTROL|MOD_SHIFT, VK_SPACE)。解析不了返回 false。</summary>
        public static bool ParseHotkey(string text, out uint modifiers, out uint key)
        {
            modifiers = 0;
            key = 0;
            if (string.IsNullOrEmpty(text)) return false;
            string[] parts = text.Split('+');
            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i].Trim();
                if (p.Length == 0) continue;
                string low = p.ToLowerInvariant();
                if (low == "ctrl" || low == "control") modifiers |= Native.MOD_CONTROL;
                else if (low == "shift") modifiers |= Native.MOD_SHIFT;
                else if (low == "alt") modifiers |= Native.MOD_ALT;
                else if (low == "win" || low == "super") modifiers |= Native.MOD_WIN;
                else
                {
                    uint vk;
                    if (!TryKey(p, out vk)) return false;
                    key = vk;
                }
            }
            return key != 0;
        }

        static bool TryKey(string name, out uint vk)
        {
            vk = 0;
            string upper = name.ToUpperInvariant();
            if (upper.Length == 1)
            {
                char c = upper[0];
                if (c >= 'A' && c <= 'Z') { vk = (uint)c; return true; }
                if (c >= '0' && c <= '9') { vk = (uint)c; return true; }
                if (c == ' ') { vk = 0x20; return true; }
            }
            if (upper.StartsWith("F") && upper.Length <= 3)
            {
                int n;
                if (int.TryParse(upper.Substring(1), out n) && n >= 1 && n <= 24)
                {
                    vk = (uint)(0x70 + n - 1);
                    return true;
                }
            }
            string[] named = { "SPACE", "ENTER", "TAB", "ESC", "ESCAPE", "BACKSPACE", "HOME", "END", "INSERT", "DELETE", "UP", "DOWN", "LEFT", "RIGHT" };
            uint[] codes = { 0x20, 0x0D, 0x09, 0x1B, 0x1B, 0x08, 0x24, 0x23, 0x2D, 0x2E, 0x26, 0x28, 0x25, 0x27 };
            for (int i = 0; i < named.Length; i++)
            {
                if (named[i] == upper) { vk = codes[i]; return true; }
            }
            return false;
        }

        /* ---------------- 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run ---------------- */

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "Ojingjing";

        /// <summary>开/关开机自启；返回是否成功。</summary>
        public static bool ApplyAutostart(bool on, string exePath)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (key == null) return false;
                    if (on) key.SetValue(RunName, "\"" + exePath + "\"");
                    else if (key.GetValue(RunName) != null) key.DeleteValue(RunName, false);
                }
                return true;
            }
            catch (Exception err)
            {
                Trace("开机自启写注册表失败：" + err.Message);
                return false;
            }
        }

        public static bool AutostartEnabled()
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    return key != null && key.GetValue(RunName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void Trace(string message)
        {
            try
            {
                string dir = PickConfigDir();
                File.AppendAllText(Path.Combine(dir, "ojingjing-cs.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + "\r\n", Encoding.UTF8);
            }
            catch
            {
                // 日志写不动就算了，不能因此崩掉外壳
            }
        }
    }
}
