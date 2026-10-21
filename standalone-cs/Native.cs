// Win32 互操作：这层只放「外壳必须直接问系统」的东西。
using System;
using System.Runtime.InteropServices;

namespace Ojingjing
{
    static class Native
    {
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int WM_HOTKEY = 0x0312;
        public const int WM_EXITSIZEMOVE = 0x0232;
        public const int HTCAPTION = 2;

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;

        public const int SW_HIDE = 0;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;

        // RegisterHotKey 的修饰键
        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        public const uint MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int w, int h);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateEllipticRgn(int left, int top, int right, int bottom);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

        [DllImport("gdi32.dll")]
        public static extern int CombineRgn(IntPtr dst, IntPtr src1, IntPtr src2, int mode);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr obj);

        public const int RGN_OR = 2;

        [DllImport("user32.dll")]
        public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        /// <summary>
        /// 客户区的**物理像素**尺寸。不用 WinForms 的 ClientSize：那个是设备无关单位，
        /// 125% 缩放下跟 SetWindowRgn / 页面报的坐标对不上，会裁歪（露出一条深底）。
        /// </summary>
        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        // 找「某个进程的可见顶层窗口」用：Electron 主进程的 MainWindowHandle 常常是 0，
        // .NET 的 Process.MainWindowHandle 靠枚举缓存，遇到多进程 Electron 会判空。
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

        /// <summary>
        /// 把最小化的窗口还原并拿到前台。
        /// 实测：从别的进程直接 ShowWindow(SW_RESTORE) 会返回 False、窗口不动；
        /// 走 WM_SYSCOMMAND / SC_RESTORE 才真的还原（和任务栏点一下等价）。
        /// </summary>
        public static void RestoreAndFocus(IntPtr hWnd)
        {
            if (IsIconic(hWnd))
            {
                SendMessage(hWnd, 0x0112 /*WM_SYSCOMMAND*/, (IntPtr)0xF120 /*SC_RESTORE*/, IntPtr.Zero);
                ShowWindowAsync(hWnd, SW_RESTORE);
            }
            else
            {
                ShowWindowAsync(hWnd, SW_SHOW);
            }
            if (!SetForegroundWindow(hWnd)) ForceForeground(hWnd);
        }

        /// <summary>当前前台窗口的标题（写日志用）。</summary>
        public static string ForegroundTitle()
        {
            var sb = new System.Text.StringBuilder(256);
            GetWindowText(GetForegroundWindow(), sb, 256);
            return sb.ToString();
        }

        /// <summary>在给定进程集合里找第一个「可见且有标题」的顶层窗口。</summary>
        public static IntPtr FindMainWindow(System.Collections.Generic.HashSet<int> pids)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr p)
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new System.Text.StringBuilder(256);
                if (GetWindowText(h, sb, 256) <= 0) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains((int)pid)) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        /// <summary>按标题片段找可见顶层窗口（pid 认不出来时的兜底）。</summary>
        public static IntPtr FindMainWindowByTitle(string part)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr p)
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new System.Text.StringBuilder(256);
                if (GetWindowText(h, sb, 256) <= 0) return true;
                if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) < 0) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        // 全局按键状态：不依赖焦点、不依赖窗口消息。全屏游戏抢走鼠标时，
        // 窗口可能收不到 WM_LBUTTONDOWN，但这里仍能读到按键是否按下。
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        // 纯 SetForegroundWindow 在游戏占着前台时会被系统拒掉（只允许前台进程抢前台）。
        // 把自己的输入队列临时挂到当前前台线程上，就和它「共享」了前台资格，这时 SetForegroundWindow 才能成。
        // 实测：异环（UnrealWindow）独占前台时，裸 SetForegroundWindow 失败、本函数成功。
        public static bool ForceForeground(IntPtr hWnd)
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == hWnd) return true;
            uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
            uint me = GetCurrentThreadId();
            bool attached = fgThread != 0 && AttachThreadInput(me, fgThread, true);
            bool ok = SetForegroundWindow(hWnd);
            if (attached) AttachThreadInput(me, fgThread, false);
            return ok;
        }

        /* ---------------- 陪伴时长：全系统空闲多久了（A3） ----------------
           判「人在不在」用 GetLastInputInfo（整个会话最后一次键鼠输入的时间），
           比在窗口上装事件过滤器准得多：窗口只有 108px，鼠标在屏幕另一头时照样是「人在」。
           与 py 外壳 ojingjing_py.py 的 system_idle_ms() 同一套语义。 */
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        [DllImport("kernel32.dll")]
        public static extern uint GetTickCount();

        /// <summary>全系统「多久没有键鼠输入」（毫秒）。取不到就返回 0 —— 宁可多记，别把陪伴记丢。</summary>
        public static uint SystemIdleMs()
        {
            try
            {
                LASTINPUTINFO info = new LASTINPUTINFO();
                info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(info);
                if (!GetLastInputInfo(ref info)) return 0;
                // GetTickCount 49.7 天回绕一次，按无符号减法取差才不会出现负数
                return (uint)((GetTickCount() - info.dwTime) & 0xFFFFFFFF);
            }
            catch
            {
                return 0;
            }
        }
    }
}
