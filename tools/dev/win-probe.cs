// 窗口探针：枚举桌面窗口，打标题/类名/矩形/客户区/区域盒。
// 用途：排查「外壳窗口到底多大」——CDP 只能量 WebView2 视口，量不到 WinForms 窗口本身。
// 跑法：node tools/dev/win-probe.mjs（内部用 csc 编译本文件后执行）。
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinProbe
{
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindowRgn(IntPtr hWnd, IntPtr hRgn);
    [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr rgn, out RECT rc);

    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static void Main()
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* 老宿主没有就拉倒 */ }
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder cls = new StringBuilder(256), title = new StringBuilder(256);
            GetClassNameW(h, cls, 256);
            GetWindowTextW(h, title, 256);
            string c = cls.ToString(), t = title.ToString();
            if (t.IndexOf("哦鲸鲸", StringComparison.Ordinal) < 0) return true;
            RECT wr, cr;
            GetWindowRect(h, out wr);
            GetClientRect(h, out cr);
            Console.WriteLine("[顶层] hwnd=" + h + " cls=" + c + " title=" + t
                + " winRect=(" + wr.L + "," + wr.T + ")-(" + wr.R + "," + wr.B + ") " + (wr.R - wr.L) + "x" + (wr.B - wr.T)
                + " client=" + (cr.R - cr.L) + "x" + (cr.B - cr.T));
            // 子窗口全部量一遍：WebView2 的渲染窗口是子 HWND，不受父窗口 Rgn 裁剪
            EnumChildWindows(h, (ch, _) =>
            {
                StringBuilder ccls = new StringBuilder(256), ctitle = new StringBuilder(256);
                GetClassNameW(ch, ccls, 256);
                GetWindowTextW(ch, ctitle, 256);
                RECT cwr;
                GetWindowRect(ch, out cwr);
                int cpid; GetWindowThreadProcessId(ch, out cpid);
                Console.WriteLine("  [子] hwnd=" + ch + " pid=" + cpid + " cls=" + ccls + " title=" + (ctitle.Length > 0 ? ctitle.ToString() : "(无)")
                    + " rect=(" + cwr.L + "," + cwr.T + ")-(" + cwr.R + "," + cwr.B + ") " + (cwr.R - cwr.L) + "x" + (cwr.B - cwr.T)
                    + " visible=" + IsWindowVisible(ch));
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
    }

    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int a, int b, int c, int d);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
}
