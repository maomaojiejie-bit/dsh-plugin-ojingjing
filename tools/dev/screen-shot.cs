// 桌面区域截图（物理像素）。CDP 只能抓到 WebView2 视口，抓不到「窗口被 SetWindowRgn
// 裁成什么形状」——不透明 + Rgn 路线下，圆角/胶囊/切边只有截屏才看得出来。
// 用法：screen-shot.exe <x> <y> <w> <h> <out.png> [置顶窗口标题]
//   给了标题就先 SetWindowPos(HWND_TOPMOST) 把窗口拎到最前（NOACTIVATE，不抢焦点），
//   截完再撤销置顶——否则桌宠被终端/编辑器盖着，截到的是别人的窗口。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

namespace OjingjingDev
{
    static class Program
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindow(string cls, string title);

        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length < 5)
            {
                Console.WriteLine("usage: screen-shot <x> <y> <w> <h> <out.png> [title]");
                return 2;
            }
            int x = int.Parse(args[0]), y = int.Parse(args[1]);
            int w = int.Parse(args[2]), h = int.Parse(args[3]);
            string outPath = args[4];
            string title = args.Length > 5 ? args[5] : null;

            IntPtr hwnd = IntPtr.Zero;
            if (!string.IsNullOrEmpty(title))
            {
                hwnd = FindWindow(null, title);
                if (hwnd == IntPtr.Zero)
                {
                    Console.WriteLine("ERR 找不到窗口：" + title);
                    return 3;
                }
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Thread.Sleep(400);
            }

            try
            {
                using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                    }
                    bmp.Save(outPath, ImageFormat.Png);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERR " + ex.Message);
                return 1;
            }
            finally
            {
                if (hwnd != IntPtr.Zero)
                    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            Console.WriteLine("OK " + outPath);
            return 0;
        }
    }
}
