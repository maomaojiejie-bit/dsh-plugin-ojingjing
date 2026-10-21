// 入口：单实例 + 托盘 + 托盘菜单。窗口本身在 OverlayForm。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Ojingjing
{
    class TrayApp : ApplicationContext
    {
        readonly Mutex single;
        readonly ShellSettings settings;
        OverlayForm overlay;
        NotifyIcon tray;
        ToolStripMenuItem autostartItem;
        System.Windows.Forms.Timer dshWatchdog;
        int dshMisses;

        public TrayApp(Mutex single)
        {
            this.single = single;
            settings = ShellSettings.Load();
            settings.DataSource = Path.Combine(settings.ConfigDir, "settings.json");
            ShellSettings.Trace("=== start (cs) === config dir: " + settings.ConfigDir + " port: " + settings.Port);

            overlay = new OverlayForm(settings);
            overlay.OpenSettingsRequested = OpenSettings;
            overlay.FormClosed += OnOverlayClosed;
            overlay.Show();

            tray = new NotifyIcon();
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "哦鲸鲸";
            tray.Visible = true;
            tray.MouseClick += OnTrayClick;
            tray.ContextMenuStrip = BuildMenu();
            StartDshWatchdog();
        }

        ContextMenuStrip BuildMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("显示 / 隐藏", null, delegate { Toggle(); });
            menu.Items.Add("截图提问（" + settings.HotkeyCapture + "）", null, delegate { if (overlay != null) overlay.StartCapture(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("设置…", null, delegate { OpenSettings(); });
            autostartItem = new ToolStripMenuItem("开机自启", null, delegate { ToggleAutostart(); });
            autostartItem.Checked = ShellSettings.AutostartEnabled();
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开 DSH", null, delegate { OpenDsh(); });
            menu.Items.Add("打开配置目录", null, delegate { OpenConfigDir(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { Quit(); });
            return menu;
        }

        void OpenSettings()
        {
            try
            {
                using (SettingsForm form = new SettingsForm(settings))
                {
                    DialogResult result = form.ShowDialog();
                    if (autostartItem != null) autostartItem.Checked = ShellSettings.AutostartEnabled();
                    if (result == DialogResult.OK)
                    {
                        // 端口 / 热键 / 高帧率改完得重启：直接提示（不自动重启，免得用户正在看的东西被打断）
                        MessageBox.Show("设置已保存。\r\n端口、热键、高帧率要重启哦鲸鲸之后生效（托盘 → 退出，再打开）。",
                            "哦鲸鲸", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
            }
            catch (Exception err)
            {
                ShellSettings.Trace("打开设置失败：" + err.Message);
            }
        }

        void ToggleAutostart()
        {
            bool on = !ShellSettings.AutostartEnabled();
            ShellSettings.ApplyAutostart(on, Application.ExecutablePath);
            if (autostartItem != null) autostartItem.Checked = ShellSettings.AutostartEnabled();
            settings.Autostart = on;
            settings.Save();
            ShellSettings.Trace("开机自启 -> " + on);
        }

        /// <summary>「DSH 关掉后自动退出」：每 15s 探一次 /xj/state，连续 4 次不通就退。</summary>
        void StartDshWatchdog()
        {
            if (!settings.ExitWithDsh) return;
            dshWatchdog = new System.Windows.Forms.Timer();
            dshWatchdog.Interval = 15000;
            dshWatchdog.Tick += delegate
            {
                int port = settings.Port;
                OverlayForm form = overlay;
                if (form == null) return;
                System.Threading.Tasks.Task.Factory.StartNew(delegate
                {
                    bool alive = ProbeHost(port);
                    try
                    {
                        // ApplicationContext 没有 BeginInvoke，借窗体的消息泵切回 UI 线程
                        form.BeginInvoke(new Action(delegate
                        {
                            if (alive)
                            {
                                dshMisses = 0;
                                return;
                            }
                            dshMisses++;
                            if (dshMisses >= 4)
                            {
                                ShellSettings.Trace("DSH 连续 " + dshMisses + " 次不通，自动退出");
                                dshWatchdog.Stop();
                                Quit();
                            }
                        }));
                    }
                    catch (Exception)
                    {
                        /* 窗体已经关掉了，忽略 */
                    }
                });
            };
            dshWatchdog.Start();
        }

        static bool ProbeHost(int port)
        {
            try
            {
                System.Net.HttpWebRequest req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(
                    "http://127.0.0.1:" + port + "/xj/state");
                req.Timeout = 2500;
                req.Proxy = null;
                using (System.Net.HttpWebResponse resp = (System.Net.HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode == 200;
                }
            }
            catch
            {
                return false;
            }
        }

        void OnTrayClick(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) Toggle();
        }

        void Toggle()
        {
            if (overlay == null) return;
            if (overlay.Visible)
            {
                overlay.Hide();
            }
            else
            {
                overlay.Show();
                overlay.Activate();
            }
        }

        void OpenDsh()
        {
            try
            {
                Process[] list = Process.GetProcessesByName("DSH Desktop");
                for (int i = 0; i < list.Length; i++)
                {
                    IntPtr hwnd = list[i].MainWindowHandle;
                    if (hwnd != IntPtr.Zero)
                    {
                        Native.ShowWindow(hwnd, Native.SW_SHOW);
                        Native.SetForegroundWindow(hwnd);
                        return;
                    }
                }
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    Path.Combine("Programs", Path.Combine("DSH Desktop", "DSH Desktop.exe")));
                if (File.Exists(exe)) Process.Start(exe);
            }
            catch (Exception err)
            {
                ShellSettings.Trace("托盘打开 DSH 失败：" + err.Message);
            }
        }

        void OpenConfigDir()
        {
            try
            {
                Process.Start(settings.ConfigDir);
            }
            catch (Exception err)
            {
                ShellSettings.Trace("打开配置目录失败：" + err.Message);
            }
        }

        void OnOverlayClosed(object sender, FormClosedEventArgs e)
        {
            Quit();
        }

        void Quit()
        {
            try
            {
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                    tray = null;
                }
            }
            catch
            {
                // 托盘释放失败不影响退出
            }
            ShellSettings.Trace("=== quit (cs) ===");
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && single != null) single.ReleaseMutex();
            base.Dispose(disposing);
        }
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            Mutex single = new Mutex(true, "Local\\ojingjing-cs-shell", out created);
            if (!created)
            {
                // 已经有一个在跑：这次静默退出（第二个实例只会让两份窗口互相打架）
                return;
            }

            try
            {
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    ShellSettings.Trace("未处理异常：" + (e.ExceptionObject == null ? "?" : e.ExceptionObject.ToString()));
                };
                // 界面线程（计时器/事件）的未处理异常默认弹 .NET 原始对话框（继续/退出），
                // 用户看不懂也选不了。2026-10-21 陪伴记账的强转 bug 就是这么爆的：
                // AppDomain 处理器接不住 UI 线程异常。这里接住：记全栈 + 一句人话，程序继续跑。
                Application.ThreadException += (s, e) =>
                {
                    ShellSettings.Trace("界面线程未处理异常：" + e.Exception);
                    try
                    {
                        MessageBox.Show("哦鲸鲸刚刚绊了一下（已记进日志）。\r\n要是它变得怪怪的，托盘右键 → 退出，再打开就好。",
                            "哦鲸鲸", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    catch
                    {
                        // 弹窗本身挂了就别双重报错
                    }
                };
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(single));
            }
            catch (Exception err)
            {
                ShellSettings.Trace("外壳崩了：" + err);
                MessageBox.Show("哦鲸鲸没能起来：\r\n" + err.Message, "哦鲸鲸", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                try
                {
                    single.ReleaseMutex();
                }
                catch
                {
                    // 已经释放过就算了
                }
            }
        }
    }
}
