// 截图提问：Ctrl+Shift+A（或托盘菜单、页面按钮）→ 藏窗 240ms → 抓整屏 → 框选 → 把 PNG 推给页面卡片
// → 页面上填问题、点「发送」→ 走 /xj/prompt 发给当前会话。
using System;
using System.Drawing;
using System.Windows.Forms;

namespace Ojingjing
{
    partial class OverlayForm
    {
        /// <summary>藏起外壳 → 240ms 后抓屏框选（240ms 是给窗口动画让路，跟 Python 版一致）。</summary>
        public void StartCapture()
        {
            if (capturing || web == null) return;
            capturing = true;
            if (Visible) Hide();
            SendToPage("{\"type\":\"pointer\",\"inside\":false}");
            captureTimer.Stop();
            captureTimer.Start();
        }

        void OnCaptureTick(object sender, EventArgs e)
        {
            captureTimer.Stop();
            try
            {
                DoGrabAndSelect();
            }
            catch (Exception err)
            {
                ShellSettings.Trace("截图失败：" + err);
                capturing = false;
                ShowIfHidden();
            }
        }

        void DoGrabAndSelect()
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            float dpr;
            byte[] png;
            using (Bitmap screen = ShotCapture.GrabDesktop(bounds, out dpr))
            {
                Rectangle primary = Screen.PrimaryScreen.Bounds;
                Rectangle def;
                if (settings.CaptureMode == "region")
                {
                    int w = (int)(primary.Width * 0.6);
                    int h = (int)(primary.Height * 0.6);
                    def = new Rectangle(primary.Left + (primary.Width - w) / 2,
                                        primary.Top + (primary.Height - h) / 2, w, h);
                }
                else
                {
                    def = primary;
                }
                def.Offset(-bounds.Left, -bounds.Top);   // 弹窗客户区以虚拟屏幕左上为原点

                Rectangle picked;
                if (Environment.GetEnvironmentVariable("XJ_NO_SELECT") == "1")
                {
                    // 调试/无头验证用：跳过交互框选，直接用默认选区
                    picked = def;
                }
                else
                {
                    picked = ShotSelectionForm.Run(screen, bounds, def, dpr);
                }
                if (picked.Width < 4 || picked.Height < 4)
                {
                    ShellSettings.Trace("截图取消");
                    capturing = false;
                    ShowIfHidden();
                    return;
                }
                png = ShotCapture.CropToPng(screen, bounds, picked, dpr);
            }
            lastShot = png;
            int w2, h2;
            ShotCapture.PngSize(png, out w2, out h2);
            ShellSettings.Trace("截图确认（" + png.Length + " bytes，" + w2 + "x" + h2 + "）");

            PlayChime();
            ShowIfHidden();
            Native.ForceForeground(Handle);

            string title = "";
            string sid = ShotApi.PickSession(settings.Port, out title);
            ShellSettings.Trace("截图：默认目标会话 " + (string.IsNullOrEmpty(sid) ? "(无)" : sid + " " + title));
            SendToPage("{\"type\":\"shot\",\"dataUrl\":\"data:image/png;base64," + Convert.ToBase64String(png)
                + "\",\"width\":" + w2 + ",\"height\":" + h2
                + ",\"sessionId\":" + JsonQuote(sid)
                + ",\"sessionTitle\":" + JsonQuote(title) + "}");
            capturing = false;
        }

        /// <summary>卡片上的「发送 / 重新截 / 优化」。sessionId 是页面挑的目标（空 = 自动挑）。</summary>
        void OnShotAction(string action, string text, string sessionId)
        {
            if (action == "capture" || action == "retake")
            {
                if (action == "retake") BeginInvoke(new MethodInvoker(StartCapture));
                else StartCapture();
                return;
            }
            if (action == "send")
            {
                byte[] png = lastShot;
                if (png == null || png.Length == 0)
                {
                    SendToPage("{\"type\":\"shot-done\",\"ok\":false,\"message\":\"截图丢了，重新截一张吧\"}");
                    return;
                }
                int port = settings.Port;
                ShellSettings.Trace("截图：开始发送（" + png.Length + " bytes，目标 "
                    + (string.IsNullOrEmpty(sessionId) ? "自动" : sessionId) + "）");
                System.Threading.Tasks.Task.Factory.StartNew(delegate
                {
                    try
                    {
                        string message;
                        bool ok = ShotApi.PostScreenshot(port, png, text, sessionId, out message);
                        PostLater("{\"type\":\"shot-done\",\"ok\":" + (ok ? "true" : "false")
                            + ",\"message\":" + JsonQuote(message) + "}");
                    }
                    catch (Exception err)
                    {
                        ShellSettings.Trace("截图：发送异常 " + err);
                        PostLater("{\"type\":\"shot-done\",\"ok\":false,\"message\":" + JsonQuote("没发出去：" + err.Message) + "}");
                    }
                });
                return;
            }
            if (action == "polish")
            {
                byte[] png2 = lastShot;
                ShellSettings snapshot = settings;
                System.Threading.Tasks.Task.Factory.StartNew(delegate
                {
                    try
                    {
                        string result, reason;
                        bool ok = ShotApi.Polish(snapshot, png2, text, out result, out reason);
                        PostLater(ok
                            ? "{\"type\":\"shot-polished\",\"text\":" + JsonQuote(result) + "}"
                            : "{\"type\":\"shot-polish-failed\",\"reason\":" + JsonQuote(reason) + "}");
                    }
                    catch (Exception err)
                    {
                        ShellSettings.Trace("优化：异常 " + err);
                        PostLater("{\"type\":\"shot-polish-failed\",\"reason\":" + JsonQuote("优化失败：" + err.Message) + "}");
                    }
                });
            }
        }

        void ShowIfHidden()
        {
            if (Visible) return;
            Show();
            Native.ShowWindow(Handle, Native.SW_SHOW);
        }

        static void PlayChime()
        {
            try
            {
                System.Media.SystemSounds.Asterisk.Play();
            }
            catch
            {
                // 没声音也不影响
            }
        }
    }
}
