// 独立窗本体：一个无边框置顶窗口 + WebView2 页面。
// 页面以 ?embed=1&host=app 加载，尺寸/拖拽/打开 DSH/退出全部走 chrome.webview.postMessage。
//
// 代码按职责拆成四个 partial 文件（都编译进同一个类，字段只在本文声明）：
//   OverlayForm.cs         窗口骨架：样式、热键、显示时机、尺寸协商、位置记忆、拖拽、打开 DSH
//   OverlayForm.Load.cs    页面加载：初始化、失败占位页 + 重试
//   OverlayForm.Shot.cs    截图提问：藏窗 → 抓屏 → 框选 → 卡片 → 发送/优化
//   OverlayForm.Bridge.cs  页面桥：消息分发、postMessage、指针信号、几个手写 JSON 小工具
//
// 关于「可点区域」的坑（2026-10-21）：
//   原本用 WS_EX_LAYERED 做逐像素透明，但分层窗口的命中区域只在样式被设置的那一刻按当时的
//   尺寸登记，之后窗口自己长大不会跟着变。结果是 108x108 的鲸鱼球能点、长到 444x604 的面板里
//   的按钮全点不到（WindowFromPoint 直接把点击穿到下面的窗口）。
//   反复试过：改尺寸、SWP_FRAMECHANGED、隐藏/显示、最小化/还原、重设 DefaultBackgroundColor，
//   都不能让命中区跟上；只有把 WS_EX_LAYERED 关掉再打开能刷新，但那样 WebView2 的逐像素透明
//   就永久丢了（窗口变黑底）。
//   所以现在默认走「不透明 + 外形裁剪」：窗口不做分层，用 SetWindowRgn 把外形裁成圆角矩形
//   （收起态是圆形），页面里透明的地方由窗体底色补上 —— 命中判定跟着窗口区域走，稳。
//   想看原来的分层透明效果可以设 XJ_HIT=0 对比。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Ojingjing
{
    partial class OverlayForm : Form
    {
        const int HOTKEY_TOGGLE = 1;
        const int HOTKEY_CAPTURE = 2;
        const int MIN_W = 96;
        const int MIN_H = 96;
        const int MAX_W = 760;
        const int MAX_H = 900;

        readonly ShellSettings settings;
        string url;                     // 插件服务器上的页面（DSH 开着时用，能拿真数据）
        readonly string localUrl;       // exe 内置的页面（没有 DSH 也是那个完整面板）
        readonly WebView2 web;

        Timer sizeTimer;     // 页面 resize 消息的去抖（40ms）
        Timer shrinkTimer;   // 「变小」要等页面收起动画播完（240ms）
        Timer saveTimer;     // 位置落盘（400ms）
        int[] pendingSize;
        int[] shrinkSize;
        int savedX = int.MinValue;
        int savedY = int.MinValue;
        // 收起态窗口尺寸（页面报 108x108 时记下来），保存位置时用它换算左上角
        int collapsedW = 108;
        int collapsedH = 108;
        // 页面加载（详见 OverlayForm.Load.cs 文件头）：页面本体随 exe 打包，双击就有完整 UI；
        // 探活插件服务器（127.0.0.1:<port>/xj/app.html），活着就切到那版拿真数据，
        // 挂了就退回内置那版——不再有「离线胶囊 / 自绘小卡片」那套占位。
        Timer probeTimer;
        bool showingPlaceholder;                        // 正在放「连接中…」兜底页
        bool navigating;                                // 导航进行中，探活别插手
        bool wantLocal;                                 // 这次导航的目标是内置页面
        bool onLocalPage;                               // 当前页面是内置那版
        // 成功加载过页面。有这个标记，探活失败时**不许**拿占位页把页面冲掉——
        // 页面还在内存里，前端自己会切离线视觉（黑白球 + 灰虚线环），
        // 点球照样展开那个面板，数据停在最后一次。
        // 老大 2026-10-21：「之前离线也可以打开在线的面板的」——就是这个行为。
        bool pageLoaded;
        // 已经把「你掉线了」推给页面了（页面保留时只推一次，避免每 3 秒刷一遍渲染）
        bool toldPageOffline;
        // 探活的两段式状态：先 TCP 监听端口（DSH 活着没），再 HTTP 确认页面取得到（在线没）。
        bool serverAlive;
        // 实测可用的插件服务器端口（0 = 还没找到）。DSH 的 web server 端口不是我们说了算的：
        // 换版本 / 换端口设置都会变，写死 settings.Port 一旦对不上就永远探不到。
        // 端口对不上时 DiscoverPort() 会枚举本机 loopback 监听端口挨个问 /xj/app.html，
        // 谁能 2xx 就认谁，顺手写回 settings.json（下次启动直接命中）。
        int serverPort;
        // 连续多少拍没找到服务器（DSH 关着的时候用来退避：别每 3 秒把 70 多个端口扫一遍）
        int probeMiss;
        // 上一次端口扫描的结果（只用来「结果变了才打日志」，别每 3 秒刷一行）
        static int lastScanResult = -1;
        // 后台探活线程正在跑（UI 线程不能同步等，否则每秒卡一下，动画掉帧）
        bool probing;
        DateTime lastPageCheck = DateTime.MinValue;

        /// <summary>当前页面是不是插件服务器那版（能拿真数据的那版）</summary>
        bool onServerPage
        {
            get { return pageLoaded && !onLocalPage; }
        }
        // 页面画出第一帧之前不露脸：WinForms 的窗体底色是不透明的，
        // 一 Show 出来会看到一块方块闪一下（Qt 版的 backing store 是透明的，所以没这毛病）
        Timer revealTimer;
        bool revealed;
        // 指针在不在窗口里：WebView2 在 resize 之后会自己把 :hover 判错，
        // 而外壳看得到真实光标（Cursor.Position）和窗口矩形，是唯一可信的答案
        Timer pointerTimer;
        bool pointerInside;
        // 点击兜底：全屏游戏独占鼠标时，窗口可能一个 WM_LBUTTONDOWN 都收不到。
        // 但 GetAsyncKeyState 读得到按键状态、Cursor.Position 读得到物理光标，
        // 两者一对上就补发一次「点了鲸鱼」，页面再按自己有没有收到真实事件去重
        Timer clickTimer;
        bool leftDownPrev;
        DateTime lastFallbackAt = DateTime.MinValue;
        DateTime lastClickTraceAt = DateTime.MinValue;
        // 页面最近一次 ack「我收到点击了」的时刻。30ms 内收到 ack 的那一下绝不补发——
        // 否则点在气泡/面板的按钮上时会被当成「点了鲸鱼」，按钮就点不动了
        DateTime lastPageAckAt = DateTime.MinValue;
        // 截图提问：藏 240ms → 抓整屏 → 框选 → 推给页面那张卡片
        Timer captureTimer;
        bool capturing;
        byte[] lastShot;
        // 不透明模式下把外形裁成页面内容的样子（必须等页面画完再裁，否则 WebView2 不再合成）
        Timer regionTimer;
        // 页面（web/embed.js）上报的可见区域：每块 .form 一个矩形，坐标是**物理像素**
        // （页面已经乘过 devicePixelRatio，见 embed.js 的 cardRects）。
        // 为什么是复数：气泡 / 输入条形态下 stage 里有两个 .form（气泡 + 鲸鱼球），中间还隔着
        // gap。只按 stage 外接矩形裁的话，那片空隙会透出窗体深底 ——
        // 2026-10-21 老大报的「一大块黑色背景」就是它。多块用 CombineRgn 并成复合区域后，
        // 空隙真的被切掉，桌面直接透过来。
        struct CardRect { public int X, Y, W, H, R; }
        readonly System.Collections.Generic.List<CardRect> cardRects = new System.Collections.Generic.List<CardRect>();
        bool hasCard;
        // 裁剪失败后的重试次数（页面报新几何时归零），见 regionTimer.Tick
        int cardRetry;
        // 陪伴记账（A3）：15s 一拍，窗口收起来（托盘隐藏）不算——用户看不见鲸鱼。
        // 账本与 py 外壳共用 %APPDATA%\ojingjing\companionship.json，来回切壳不丢数据。
        Timer companyTimer;
        Companionship company;
        DateTime companySavedAt = DateTime.MinValue;
        // 页面发 {type:"settings"} 时用（页面里没有设置界面，设置窗归外壳）
        public Action OpenSettingsRequested;

        public OverlayForm(ShellSettings settings)
        {
            this.settings = settings;
            serverPort = 0;                    // 还没实测过，先按 settings.Port 猜
            url = PageUrl(settings.Port);
            // 内置页面走 WebView2 的虚拟主机（映射到解包目录），路径 /xj/... 跟插件服务器同构，
            // 所以 app.html 里那些绝对路径一行都不用改
            localUrl = "https://" + LocalHost + "/xj/app.html?embed=1&host=app";

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            // 卡片底色：页面里的玻璃是 0.965 的 rgba(13,19,32)，垫这个色后边缘看不出来。
            // 分层模式下这个颜色不参与合成，只有不透明模式会露出来。
            BackColor = Color.FromArgb(13, 19, 32);
            Text = "哦鲸鲸";
            DoubleBuffered = true;
            ClientSize = new Size(108, 108);

            int x, y;
            // 存的是「收起态」左上角。读回来先校验：老版本存过展开态的位置（面板左上角），
            // 那种坐标会让球飘到屏幕中间甚至飞出屏幕，所以出界就退回右下角默认位置
            if (settings.LoadPosition(out x, out y) && OnSomeScreen(x, y))
            {
                Location = new Point(x, y);
            }
            else
            {
                Rectangle area = Screen.PrimaryScreen.WorkingArea;
                Location = new Point(area.Right - Width - 24, area.Bottom - Height - 24);
            }

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.AllowExternalDrop = false;
            CoreWebView2CreationProperties creation = new CoreWebView2CreationProperties();
            // 用户数据目录挪到配置目录：默认会在 exe 旁边生成 Ojingjing.exe.WebView2\（几十 MB 缓存），
            // 绿色版解压到桌面就被污染了
            try
            {
                string data = Path.Combine(settings.ConfigDir, "webview2");
                Directory.CreateDirectory(data);
                creation.UserDataFolder = data;
            }
            catch (Exception ex)
            {
                ShellSettings.Trace("WebView2 数据目录设置失败，用默认位置：" + ex.Message);
            }
            string extra = "";
            string debugPort = Environment.GetEnvironmentVariable("XJ_DEBUG_PORT");
            if (!string.IsNullOrEmpty(debugPort)) extra += " --remote-debugging-port=" + debugPort;
            if (settings.HighFps) extra += " --disable-gpu-vsync --disable-frame-rate-limit";
            // WebView2 默认可能在 CPU 上做光栅化（gpu-process 单核 25~40%、GPU 引擎却只有 2%），
            // 动画一多就发涩。XJ_GPU_RASTER=1 打开硬件光栅做对照实验（实测更差，默认不开）
            if (Environment.GetEnvironmentVariable("XJ_GPU_RASTER") == "1")
                extra += " --enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy --enable-accelerated-2d-canvas";
            if (extra.Length > 0) creation.AdditionalBrowserArguments = extra.Trim();
            web.CreationProperties = creation;
            web.CoreWebView2InitializationCompleted += OnWebInit;
            Controls.Add(web);

            sizeTimer = new Timer();
            sizeTimer.Interval = 40;
            sizeTimer.Tick += OnSizeTick;

            shrinkTimer = new Timer();
            shrinkTimer.Interval = 240;
            shrinkTimer.Tick += OnShrinkTick;

            saveTimer = new Timer();
            saveTimer.Interval = 400;
            saveTimer.Tick += OnSaveTick;

            probeTimer = new Timer();
            probeTimer.Interval = 3000;
            probeTimer.Tick += OnProbeTick;

            revealTimer = new Timer();
            revealTimer.Interval = 2600;
            revealTimer.Tick += (s, e) => { revealTimer.Stop(); Reveal(); };

            pointerTimer = new Timer();
            pointerTimer.Interval = 200;
            pointerTimer.Tick += OnPointerTick;

            clickTimer = new Timer();
            clickTimer.Interval = 30;
            clickTimer.Tick += OnClickWatch;

            captureTimer = new Timer();
            captureTimer.Interval = 240;
            captureTimer.Tick += OnCaptureTick;

            regionTimer = new Timer();
            regionTimer.Interval = 140;
            regionTimer.Tick += (s, e) =>
            {
                regionTimer.Stop();
                // 页面报过几何就按那些块裁（切掉内缩和 form 之间的空隙，没有黑边）。
                if (hasCard)
                {
                    if (ApplyCardRects())
                    {
                        cardRetry = 0;
                        return;
                    }
                    // 坐标还没跟上新窗口（resize 刚发生、页面还在量）：先按整窗外形过渡，
                    // 稍后再试几次。**不把 hasCard 清掉** —— 清了就再也回不来，
                    // 页面只在几何变化时才上报，稳定的界面会一直顶着整窗深底。
                    if (cardRetry < 3)
                    {
                        cardRetry += 1;
                        regionTimer.Start();
                    }
                }
                ApplyRegionFallback();
            };

            company = new Companionship(Path.Combine(settings.ConfigDir, "companionship.json"));
            companyTimer = new Timer();
            companyTimer.Interval = 15000;
            companyTimer.Tick += OnCompanyTick;
            companyTimer.Start();

            Load += OnLoaded;
            FormClosing += OnClosing;
        }

        /* ---------------- 窗口 ---------------- */

        void OnLoaded(object sender, EventArgs e)
        {
            int ex = Native.GetWindowLong(Handle, Native.GWL_EXSTYLE);
            ex |= Native.WS_EX_TOOLWINDOW;   // 不进 Alt+Tab
            // 默认不透明（避免上面说的命中区问题）。XJ_HIT=0 走老的分层透明，只为做对比。
            if (Environment.GetEnvironmentVariable("XJ_NO_LAYERED") != "1" && HitMode() == 0) ex |= Native.WS_EX_LAYERED;
            Native.SetWindowLong(Handle, Native.GWL_EXSTYLE, ex);

            RegisterHotkeys();
            revealTimer.Start();
            // WebView2 不会自己发车：控件入了树、建了句柄也不会初始化（老代码靠
            // OnLoaded 里设 web.Source 间接触发）。现在导航挪到 OnWebInit 里探活
            // 之后再做，初始化必须显式拉起来，否则 InitializationCompleted 永远
            // 不触发、窗口就一块空白（2026-10-21 踩过，见 OverlayForm.Load.cs）。
            web.EnsureCoreWebView2Async();
            // 先藏起来，等页面有内容再露脸（见 Reveal 的注释）
            Native.ShowWindow(Handle, Native.SW_HIDE);
        }

        /// <summary>第一次拿到页面尺寸（或页面加载完）才真正露面。</summary>
        void Reveal()
        {
            if (revealed) return;
            revealed = true;
            revealTimer.Stop();
            Show();
            Native.ShowWindow(Handle, Native.SW_SHOW);
            ShellSettings.Trace("reveal（页面已画出内容）");
        }

        void RegisterHotkeys()
        {
            uint mods, key;
            if (ShellSettings.ParseHotkey(settings.HotkeyToggle, out mods, out key))
            {
                if (!Native.RegisterHotKey(Handle, HOTKEY_TOGGLE, mods | Native.MOD_NOREPEAT, key))
                    ShellSettings.Trace("热键注册失败（可能被别的程序占用）：" + settings.HotkeyToggle);
            }
            else
            {
                ShellSettings.Trace("热键解析失败：" + settings.HotkeyToggle);
            }
            if (ShellSettings.ParseHotkey(settings.HotkeyCapture, out mods, out key))
            {
                if (!Native.RegisterHotKey(Handle, HOTKEY_CAPTURE, mods | Native.MOD_NOREPEAT, key))
                    ShellSettings.Trace("截图热键注册失败：" + settings.HotkeyCapture);
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                if (id == HOTKEY_TOGGLE) ToggleVisible();
                else if (id == HOTKEY_CAPTURE) StartCapture();
                return;
            }
            if (m.Msg == Native.WM_EXITSIZEMOVE)
            {
                saveTimer.Stop();
                saveTimer.Start();
            }
            base.WndProc(ref m);
        }

        void ToggleVisible()
        {
            // 游戏独占前台时窗口抢不到焦点（实测 SetForegroundWindow 返回 False、光标被游戏钉住），
            // 鼠标点不到浮窗——所以把热键做成「不看鼠标也能用」的召唤键：
            // 隐藏就显示并开面板；已经开着就收起。真正隐藏窗口走托盘菜单。
            if (!Visible)
            {
                Show();
                Native.ShowWindow(Handle, Native.SW_SHOW);
                Activate();
                Native.ForceForeground(Handle);
                if (web != null) web.Focus();
            }
            SendToPage("{\"type\":\"summon\"}");
        }

        /* ---------------- 尺寸：长大立刻跟，缩小等动画 ---------------- */

        void QueueSize(int w, int h)
        {
            pendingSize = new[] { Math.Max(MIN_W, Math.Min(MAX_W, w)), Math.Max(MIN_H, Math.Min(MAX_H, h)) };
            if (pendingSize[0] <= 160 && pendingSize[1] <= 160)
            {
                collapsedW = pendingSize[0];
                collapsedH = pendingSize[1];
            }
            Reveal();
            sizeTimer.Stop();
            sizeTimer.Start();
            // 尺寸没变时 ApplySize 会提前 return，这里也得排一次裁剪，
            // 否则启动时那个 108x108 的球会一直顶着方角（默认尺寸就是 108x108）
            regionTimer.Stop();
            regionTimer.Start();
        }

        void OnSizeTick(object sender, EventArgs e)
        {
            sizeTimer.Stop();
            int[] size = pendingSize;
            pendingSize = null;
            if (size == null) return;
            if (size[0] >= Width && size[1] >= Height)
            {
                shrinkSize = null;
                shrinkTimer.Stop();
                ApplySize(size[0], size[1]);
                return;
            }
            shrinkSize = size;
            shrinkTimer.Stop();
            shrinkTimer.Start();
        }

        void OnShrinkTick(object sender, EventArgs e)
        {
            shrinkTimer.Stop();
            int[] size = shrinkSize;
            shrinkSize = null;
            if (size != null) ApplySize(size[0], size[1]);
        }

        /// <summary>右下角锚定：变大向左上长，位置不动。</summary>
        void ApplySize(int w, int h)
        {
            if (w == Width && h == Height) return;
            Rectangle screen = Screen.FromControl(this).WorkingArea;
            int right = Right;
            int bottom = Bottom;
            ClientSize = new Size(w, h);
            int x = Math.Max(screen.Left, Math.Min(screen.Right - w, right - w));
            int y = Math.Max(screen.Top, Math.Min(screen.Bottom - h, bottom - h));
            Location = new Point(x, y);
            ShellSettings.Trace("窗口 " + w + "x" + h + " @" + x + "," + y + (HitMode() == 0 ? "" : " (hit mode " + HitMode() + ")"));
            // 不透明模式：等页面把新尺寸的画面画出来再裁外形（立刻裁会让 WebView2 不再合成）
            regionTimer.Stop();
            regionTimer.Start();
        }

        static int HitMode()
        {
            string v = Environment.GetEnvironmentVariable("XJ_HIT");
            int n;
            if (!string.IsNullOrEmpty(v) && int.TryParse(v, out n)) return n;
            return 11;   // 默认：不透明 + 延迟裁剪外形
        }

        /// <summary>
        /// 不透明路线：窗口不做分层（于是没有「可点区域只认创建时尺寸」的毛病，
        /// 命中判定跟着窗口区域走），用 SetWindowRgn 把外形裁成页面内容的样子。
        /// 尺寸取 GetClientRect 的**物理像素**，跟 SetWindowRgn 的坐标系一致
        /// （WinForms 的 ClientSize 是设备无关单位，125% 屏上差 1.25 倍，会裁歪）。
        /// </summary>
        void ApplyRegionFallback()
        {
            Native.RECT rc;
            if (!Native.GetClientRect(Handle, out rc)) return;
            int w = rc.Right - rc.Left;
            int h = rc.Bottom - rc.Top;
            if (w <= 0 || h <= 0) return;
            IntPtr rgn;
            if (w <= 160 && h <= 160)
            {
                // 鲸鱼球是「右下各留 10px 的 64px 方块」（108 窗口时就是 (34,34)）。
                // 椭圆只比球大 1px，和 ApplyCardRects 的球分支同一条规则 ——
                // 多出来的那圈在页面里是透明的，会透出窗体深底，越大越像一圈深色毛边。
                int size = Math.Min(64, Math.Min(w, h) - 20);
                if (size < 24) size = Math.Max(24, Math.Min(w, h) - 2);
                int x = w - size - 10;
                int y = h - size - 10;
                if (x < 0) x = Math.Max(0, (w - size) / 2);
                if (y < 0) y = Math.Max(0, (h - size) / 2);
                rgn = Native.CreateEllipticRgn(x - 1, y - 1, x + size + 2, y + size + 2);
            }
            else
            {
                int pad = Math.Min(8, Math.Min(w, h) / 8);
                rgn = Native.CreateRoundRectRgn(pad, pad, w - pad + 1, h - pad + 1, 40, 40);
            }
            Native.SetWindowRgn(Handle, rgn, true);   // 成功后区域归系统所有，不要再 DeleteObject
            ShellSettings.Trace("裁剪 " + w + "x" + h + (w <= 160 && h <= 160 ? " 圆形" : " 圆角矩形"));
        }

        /// <summary>
        /// 按页面报的每一块可见区域裁外形：每块建一个圆角矩形（小球建椭圆），
        /// 再用 CombineRgn(RGN_OR) 并成一个复合区域交给窗口。
        /// 返回 false = 这份几何已经对不上窗口（收缩动画那一瞬：卡片坐标还在、窗口已缩），
        /// 调用方退回整窗外形，等页面在新尺寸里重报。
        /// </summary>
        bool ApplyCardRects()
        {
            if (cardRects.Count == 0) return false;
            Native.RECT rc;
            if (!Native.GetClientRect(Handle, out rc)) return false;
            int winW = rc.Right - rc.Left;
            int winH = rc.Bottom - rc.Top;
            if (winW <= 0 || winH <= 0) return false;
            // 越界超过 4px 就当这帧不可信 —— 动画中间帧的坐标常常还在旧窗口里
            for (int i = 0; i < cardRects.Count; i++)
            {
                CardRect c = cardRects[i];
                if (c.W <= 0 || c.H <= 0) return false;
                if (c.X < -4 || c.Y < -4 || c.X + c.W > winW + 4 || c.Y + c.H > winH + 4) return false;
            }

            IntPtr total = IntPtr.Zero;
            for (int i = 0; i < cardRects.Count; i++)
            {
                CardRect c = cardRects[i];
                int x = c.X, y = c.Y;
                int min = Math.Min(c.W, c.H);
                IntPtr one;
                if (min <= 100)
                {
                    // 球类：只外扩 1px，让 CSS 自己那圈半透明抗锯齿边缘完整露出来。
                    // 早期写的「外扩 10px 包 box-shadow 光晕」是错的：那 10px 在页面里是
                    // 完全透明的，透出来的是窗体深底 #0d1320 —— 等于给球套了一圈脏兮兮的
                    // 深色毛边，边界再从深色硬切到桌面，锯齿被放大一倍。
                    // 老大 2026-10-21：「窗口边缘太粗糙了」说的就是这圈。
                    // 光晕本来就投在这层深底上、本来就看不见，切掉一点损失都没有。
                    int ex = x - 1, ey = y - 1;
                    one = Native.CreateEllipticRgn(ex, ey, ex + c.W + 2 + 1, ey + c.H + 2 + 1);
                }
                else if (c.R * 2 >= min)
                {
                    one = Native.CreateEllipticRgn(x, y, x + c.W + 1, y + c.H + 1);
                }
                else
                {
                    one = Native.CreateRoundRectRgn(x, y, x + c.W + 1, y + c.H + 1, c.R, c.R);
                }
                if (one == IntPtr.Zero) continue;
                if (total == IntPtr.Zero)
                {
                    total = one;
                    continue;
                }
                // 合并到新区域里再换手，避免 CombineRgn 拿 dst 当 src 的未定义行为
                IntPtr merged = Native.CreateRectRgn(0, 0, 0, 0);
                Native.CombineRgn(merged, total, one, Native.RGN_OR);
                Native.DeleteObject(total);
                Native.DeleteObject(one);
                total = merged;
            }
            if (total == IntPtr.Zero) return false;
            Native.SetWindowRgn(Handle, total, true);   // 成功后区域归系统所有

            // 日志：块数和第一块就够定位了，别每个 tick 刷屏
            CardRect f = cardRects[0];
            ShellSettings.Trace("按卡片裁剪 " + cardRects.Count + " 块 (" + f.X + "," + f.Y + ") "
                + f.W + "x" + f.H + " r" + f.R + " 窗口 " + winW + "x" + winH);
            return true;
        }

        /* ---------------- 位置记忆与拖拽 ---------------- */

        void StartDrag()
        {
            if (!Visible) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
        }

        void OnSaveTick(object sender, EventArgs e)
        {
            saveTimer.Stop();
            Point at = CollapsedCorner();
            if (at.X == savedX && at.Y == savedY) return;
            savedX = at.X;
            savedY = at.Y;
            settings.SavePosition(savedX, savedY);
        }

        /// <summary>收起态的左上角。展开时窗口更宽更高，直接存 Location 会把球「记」到面板左上角去。</summary>
        Point CollapsedCorner()
        {
            return new Point(Right - collapsedW, Bottom - collapsedH);
        }

        static bool OnSomeScreen(int x, int y)
        {
            Rectangle v = SystemInformation.VirtualScreen;
            return x >= v.Left - 40 && y >= v.Top - 40 && x <= v.Right - 40 && y <= v.Bottom - 40;
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            try
            {
                Native.UnregisterHotKey(Handle, HOTKEY_TOGGLE);
                Native.UnregisterHotKey(Handle, HOTKEY_CAPTURE);
            }
            catch
            {
                // 热键注销失败不影响退出
            }
            sizeTimer.Stop();
            shrinkTimer.Stop();
            saveTimer.Stop();
            probeTimer.Stop();
            revealTimer.Stop();
            captureTimer.Stop();
            regionTimer.Stop();
            companyTimer.Stop();
            company.Save(true);
            Point at = CollapsedCorner();
            settings.SavePosition(at.X, at.Y);
            // 优雅收尸：不等 GC 兜底，浏览器进程跟着宿主一起走，
            // 不会留下占着用户数据目录的孤儿 msedgewebview2
            try
            {
                if (web != null) web.Dispose();
            }
            catch
            {
                // 收尸失败不影响退出
            }
        }

        /* ---------------- 陪伴记账（A3） ----------------
           窗口收起来（托盘隐藏）就不算：用户看不见鲸鱼，那只是它在守着。
           「人在不在」看全系统空闲时间（GetLastInputInfo），与 py 外壳同语义。
           落盘每 60s 一次，退出时强制写。数据不主动推页面——面板开着时页面
           自己 60s 来要一次（app.js 的 refreshCompanion），要的时候顺带把
           攒着的里程碑带出去庆祝。 */
        void OnCompanyTick(object sender, EventArgs e)
        {
            bool active = Visible && WindowState != FormWindowState.Minimized && Native.SystemIdleMs() < 5 * 60 * 1000;
            company.Tick(active);
            if ((DateTime.UtcNow - companySavedAt).TotalSeconds >= 60)
            {
                companySavedAt = DateTime.UtcNow;
                company.Save();
            }
        }

        /* ---------------- 打开 DSH / 浏览器 ---------------- */

        void OpenDsh()
        {
            try
            {
                // Electron 是多进程的，Process.MainWindowHandle 经常给 0（实测 10 个
                // "DSH Desktop" 进程里只有 1 个有标题，而它 MainWindowHandle 也是 0）。
                // 所以按进程集合枚举顶层窗口，找第一个「可见 + 有标题」的。
                Process[] list = Process.GetProcessesByName("DSH Desktop");
                var pids = new System.Collections.Generic.HashSet<int>();
                for (int i = 0; i < list.Length; i++) pids.Add(list[i].Id);

                IntPtr hwnd = pids.Count > 0 ? Native.FindMainWindow(pids) : IntPtr.Zero;
                if (hwnd == IntPtr.Zero && pids.Count > 0)
                {
                    // 窗口可能被最小化到托盘、或者标题为空：退一步枚举全部顶层窗口按标题认
                    hwnd = Native.FindMainWindowByTitle("DeepSeek Harness");
                }
                if (hwnd != IntPtr.Zero)
                {
                    // 最小化的窗口要从别的进程还原，ShowWindow(SW_RESTORE) 会被拒；
                    // Native.RestoreAndFocus 走 WM_SYSCOMMAND/SC_RESTORE（等于任务栏点一下）。
                    bool wasIconic = Native.IsIconic(hwnd);
                    Native.RestoreAndFocus(hwnd);
                    System.Threading.Thread.Sleep(180);
                    Native.RestoreAndFocus(hwnd);
                    ShellSettings.Trace("open-dsh: 切到 " + hwnd.ToInt64()
                        + "（图标化=" + wasIconic + " 仍最小化=" + Native.IsIconic(hwnd)
                        + " 前台=" + Native.ForegroundTitle() + "）");
                    return;
                }
                if (pids.Count > 0)
                {
                    ShellSettings.Trace("open-dsh: DSH 在跑但没找到可见窗口（可能在托盘里）");
                    return;
                }
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string exe = Path.Combine(local, Path.Combine("Programs", Path.Combine("DSH Desktop", "DSH Desktop.exe")));
                if (File.Exists(exe))
                {
                    Process.Start(exe);
                    ShellSettings.Trace("open-dsh: DSH 没在跑，已启动");
                }
                else
                {
                    ShellSettings.Trace("open-dsh: 没找到 DSH 可执行文件");
                }
            }
            catch (Exception err)
            {
                ShellSettings.Trace("open-dsh 失败：" + err.Message);
            }
        }

        /// <summary>只放行 https —— 设置里那些链接都是 GitHub。</summary>
        void OpenUrl(string target)
        {
            if (string.IsNullOrEmpty(target)) return;
            if (target.IndexOf("https://", StringComparison.OrdinalIgnoreCase) != 0)
            {
                ShellSettings.Trace("open-url 拒绝：" + target);
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                ShellSettings.Trace("open-url: " + target);
            }
            catch (Exception err)
            {
                ShellSettings.Trace("open-url 失败：" + err.Message);
            }
        }
    }
}
