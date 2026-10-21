// 页面加载这一摊：页面从哪来、DSH 起来后怎么切过去、探活。
//
// 2026-10-21 大改（老大原话：「我要打开exe文件的时候也是那个面版 不需要现在这个」）：
//   页面本体已经随 exe 打包——build-shell-cs.mjs 把 web/ 压成 payload.zip 嵌成资源，
//   启动时解到 <配置目录>\web\<stamp>\，再用 WebView2 的虚拟主机映射挂成
//   https://ojingjing.local/xj/app.html。于是**没有 DSH、没装插件，双击 exe 也是那个完整面板**：
//   前端自己的心跳探不到 /xj/state 就会切离线视觉（黑白球 + 灰虚线环 + 「连接已断开，正在重连…」），
//   点球照样展开面板（会话/审批空着，但界面是真的那套）。之前那套「离线胶囊 + 40 条文案 +
//   自绘小卡片」全部删掉——老大明确说不需要。
//
//   两套页面来源，谁在就用谁：
//     · 插件服务器活着（127.0.0.1:<port>/xj/app.html 2xx）→ 用它，那版能拿真数据
//       （会话列表 / 审批 / 用量都走 /xj/state）；
//     · 连不上 → 内置那版顶上，不空白、不闪 Chromium 错误页。
//
// 探活是两段式（2026-10-21 老大：「通过监听服务器来确认dsh是否存活 再一次判断哦鲸鲸的在线状态」）：
//   ① 监听服务器：对 127.0.0.1:<port> 做一次 TCP 连接，1 秒一拍。DSH 进程一退，
//      loopback 立刻 ECONNREFUSED，比 HTTP 超时判断快一个数量级；
//   ② 判断在线：端口在听只说明 DSH 在跑，不代表插件页面部署好了（重装插件时
//      app.html 会 404）。所以再 GET 一次页面本体确认 2xx —— 已切到服务器那版时
//      每 5 秒复核，没切过去时每拍都试。
//   两段都不做导航失败重试：失败导航会闪 ERR_CONNECTION_REFUSED 错误页，而且一次
//   要 ~2.2s。Loopback 上这两步都是毫秒级，成败立刻知道。
using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Ojingjing
{
    partial class OverlayForm
    {
        /// <summary>内置页面的虚拟主机名（WebView2 把某个 host 映射到本地目录，不需要开 HTTP 服务）</summary>
        const string LocalHost = "ojingjing.local";
        /// <summary>csc /resource 打进来的页面包（见 tools/build-shell-cs.mjs）</summary>
        const string PayloadResource = "Ojingjing.payload.zip";

        /// <summary>解包出来的页面目录（<配置目录>\web\<stamp>）</summary>
        string webRoot;

        void OnWebInit(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                ShellSettings.Trace("WebView2 起不来：" + (e.InitializationException == null ? "未知" : e.InitializationException.Message));
                MessageBox.Show(
                    "哦鲸鲸需要 Microsoft Edge WebView2 运行时（Win10/11 一般自带）。\r\n" +
                    "可以去 https://developer.microsoft.com/microsoft-edge/webview2/ 装一次再来。",
                    "哦鲸鲸", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
                return;
            }

            // 关键一句：让页面透明的地方真透明，窗口才不会顶着一块黑底。
            // 注意 DefaultBackgroundColor 只接受 alpha 0 或 255（中间值抛异常）。
            // 不透明模式（默认）里必须给个实色底 —— 分层窗去掉之后，alpha=0 的底
            // 会让整个 WebView2 内容都不合成（窗口只剩窗体背景色）。
            web.DefaultBackgroundColor = HitMode() == 0
                ? Color.Transparent
                : Color.FromArgb(13, 19, 32);
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("XJ_DEBUG_PORT"));
            core.WebMessageReceived += OnWebMessage;
            web.NavigationCompleted += OnNavDone;
            pointerTimer.Start();
            clickTimer.Start();

            // 先把内置页面挂上（解包 + 虚拟主机映射），挂不上就只剩占位页。
            bool local = SetupLocalPage(core);
            // 启动时只做一次毫秒级的快判（猜的端口 + 一次 GET）。猜错了不干等：
            // 先上内置页面，之后每一拍由后台探活去 DiscoverPort 找真正的端口再切过去。
            serverPort = settings.Port;
            if (PortAlive(serverPort, 300) && ProbePage(url, 1500))
            {
                serverAlive = true;
                NavigateToServer();
            }
            else
            {
                serverPort = 0;   // 猜的端口不算数，交给 DiscoverPort
                if (local) NavigateLocal();
                else
                {
                    showingPlaceholder = true;
                    web.NavigateToString(PlaceholderHtml());
                }
            }
            // 探活一直转：1 秒一拍 TCP（DSH 一退立刻知道），HTTP 只按需/每 5 秒复核。
            // DSH 起来那一刻自动切到服务器那版（带真数据），不用重启外壳。
            probeTimer.Interval = 1000;
            probeTimer.Start();
            ShellSettings.Trace("webview2 ok，透明已开；内置页面=" + (local ? webRoot : "不可用"));
        }

        /// <summary>
        /// 解包 + 映射虚拟主机。返回 false 表示内置页面不可用（资源缺失 / 解包失败 /
        /// 运行时太老不认 SetVirtualHostNameToFolderMapping）——那就退回占位页 + 等 DSH。
        /// </summary>
        bool SetupLocalPage(CoreWebView2 core)
        {
            try
            {
                webRoot = ExtractWebBundle();
                if (webRoot == null) return false;
                // https://ojingjing.local/xj/app.html —— 页面里的绝对路径 /xj/... 正好落在
                // 解包目录的 xj/ 子目录上（app.html 写的是 /xj/static/src/*.js）。
                // 用虚拟主机而不是 file://：file:// 下 fetch/localStorage 全被当不透明源，
                // 前端一启动就炸；虚拟主机是个正经 https 源，行为跟插件服务器那版一致。
                core.SetVirtualHostNameToFolderMapping(LocalHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);
                return true;
            }
            catch (Exception err)
            {
                ShellSettings.Trace("内置页面不可用：" + err.Message);
                return false;
            }
        }

        /// <summary>
        /// 把嵌在 exe 里的 payload.zip 解到 &lt;配置目录&gt;\web\&lt;stamp&gt;\，返回该目录。
        /// stamp 是构建时写进去的「版本号+时间戳」，跟目录里的 stamp.txt 一致就跳过解包，
        /// 所以正常启动只 stat 两个文件，不重复解压。
        /// 解到按 stamp 分的子目录而不是覆盖同一个 web\：WebView2 可能还占着上一版的文件，
        /// 原地删会失败；分目录以后新旧并存，解析完顺手清理别的版本。
        /// </summary>
        string ExtractWebBundle()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream raw = asm.GetManifestResourceStream(PayloadResource);
            if (raw == null) return null;
            using (raw)
            {
                ZipArchive zip = new ZipArchive(raw, ZipArchiveMode.Read);
                ZipArchiveEntry stampEntry = zip.GetEntry("stamp.txt");
                if (stampEntry == null) return null;
                string stamp;
                using (StreamReader r = new StreamReader(stampEntry.Open()))
                {
                    stamp = r.ReadToEnd().Trim();
                }
                if (stamp.Length == 0) return null;

                string baseDir = Path.Combine(settings.ConfigDir, "web");
                string dir = Path.Combine(baseDir, stamp);
                string marker = Path.Combine(dir, "stamp.txt");
                bool ok = File.Exists(marker) && File.Exists(Path.Combine(dir, "xj", "app.html"));
                if (!ok)
                {
                    Directory.CreateDirectory(dir);
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        if (entry.Name.Length == 0) continue;   // 目录项，CreateDirectory 会按需建
                        string target = Path.Combine(dir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                        string parent = Path.GetDirectoryName(target);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        using (Stream src = entry.Open())
                        using (FileStream dst = File.Create(target))
                        {
                            src.CopyTo(dst);
                        }
                    }
                    File.WriteAllText(marker, stamp);
                    ShellSettings.Trace("内置页面已解包：" + dir);
                }
                PruneOldBundles(baseDir, stamp);
                return dir;
            }
        }

        /// <summary>清掉别的版本目录（best effort，占着就留着下次再说）</summary>
        static void PruneOldBundles(string baseDir, string keep)
        {
            try
            {
                foreach (string d in Directory.GetDirectories(baseDir))
                {
                    if (string.Equals(Path.GetFileName(d), keep, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(d, true); }
                    catch { }
                }
            }
            catch { }
        }

        void OnNavDone(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            navigating = false;
            // 导航期间探活是停着的（见 NavigateToServer / NavigateLocal），这里必须拉回来。
            // 漏了这一步就是「切换过一次页面之后再也不探活」——DSH 后来退了也没人知道，
            // 页面只能靠自己的心跳慢慢转 offline。2026-10-21 实测踩到。
            probeTimer.Interval = 1000;
            probeTimer.Start();
            if (showingPlaceholder)
            {
                // 占位页自己的「加载成功」不算数
                showingPlaceholder = false;
                return;
            }
            if (e.IsSuccess)
            {
                pageLoaded = true;
                onLocalPage = wantLocal;
                if (!onLocalPage) toldPageOffline = false;
                Reveal();
                // 页面刚就绪时，把当前的指针状态补发一次：启动那一刻光标可能已经在窗口里，
                // 而那时候页面还没挂监听，那条消息就丢了。
                pointerInside = !Bounds.Contains(Cursor.Position);
                return;
            }
            // 探活说能连、真导航却挂了（DSH 重装插件时 app.html 404 那一路）：
            // 退到内置页面继续探。这里绝不反复 web.Source 重试——失败导航会闪 Chromium 错误页。
            ShellSettings.Trace("导航失败（WebErrorStatus=" + e.WebErrorStatus + "），"
                + (wantLocal ? "内置页面也挂了，回占位页" : "退回内置页面"));
            if (wantLocal || webRoot == null)
            {
                showingPlaceholder = true;
                web.NavigateToString(PlaceholderHtml());
                return;
            }
            NavigateLocal();
        }

        /* ---------------- 探活 ----------------
           老大 2026-10-21：「再通过监听服务器来确认dsh是否存活 再一次判断哦鲸鲸的在线状态」。
           两段式，都扔到后台线程跑（在 UI 线程同步等会每秒卡一下，动画掉帧）：

           ① 监听服务器：对 127.0.0.1:<port> 做一次 TCP 连接。端口还在听 = DSH 进程活着；
              进程一退 loopback 上立刻 ECONNREFUSED，亚毫秒级，不用等 HTTP 超时。
              **端口从哪来**：settings.Port 只是「猜」的起点。DSH 的 web server 端口不是
              插件能决定的，换版本 / 改过配置就会变，写死一个数字一旦对不上就永远探不到
              （老大报的「还是不能监听」）。所以连不上就 DiscoverPort()：枚举本机所有
              loopback 监听端口，并行挨个 GET 一次 /xj/app.html，谁能 2xx 就认谁，
              并写回 settings.json。
           ② 判断在线：端口在听只说明 DSH 活着，不代表哦鲸鲸的页面部署好了
              （重装插件期间 app.html 会 404）。所以还要确认页面本体能取到 ——
              已经在服务器那版上时每 4 秒复核一次，没切过去时每拍都试。
        */

        /// <summary>服务器那版页面的地址（端口可变，URL 别写死）</summary>
        static string PageUrl(int port)
        {
            return "http://127.0.0.1:" + port + "/xj/app.html?embed=1&host=app";
        }

        struct ProbeResult
        {
            public int Port;      // 找到的端口，0 = 没有
            public bool PageOk;   // 该端口上的 /xj/app.html 能取到（2xx）
        }

        void OnProbeTick(object sender, EventArgs e)
        {
            probeTimer.Stop();
            // 导航期间不插手（OnNavDone 会把定时器拉回来）；上一拍还没回来就等下一拍
            if (navigating || probing) { probeTimer.Start(); return; }
            probing = true;
            int guess = serverPort > 0 ? serverPort : settings.Port;
            // 已经在服务器那版上时不用每拍都拉页面，4 秒复核一次就够
            bool checkPage = !onServerPage || (DateTime.UtcNow - lastPageCheck).TotalSeconds >= 4;
            if (checkPage) lastPageCheck = DateTime.UtcNow;
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                ProbeResult r;
                try { r = RunProbe(guess, checkPage); }
                catch { r = new ProbeResult(); }
                try
                {
                    BeginInvoke((Action)delegate
                    {
                        try { ApplyProbe(r); }
                        catch (Exception ex) { probing = false; ShellSettings.Trace("探活结果应用失败：" + ex.Message); }
                    });
                }
                catch { probing = false; }   // 窗口已经关了
            });
        }

        /// <summary>后台线程里跑的两段式探活，不碰任何 UI 状态。</summary>
        static ProbeResult RunProbe(int guess, bool checkPage)
        {
            ProbeResult r = new ProbeResult();
            r.Port = PortAlive(guess, 300) ? guess : DiscoverPort(guess);
            if (r.Port <= 0) return r;
            // 这一拍没轮到时复用上一拍的结论（端口刚确认活着，页面也刚确认过）
            r.PageOk = !checkPage || ProbePage(PageUrl(r.Port), 1500);
            return r;
        }

        /// <summary>回到 UI 线程：按探活结果决定导航 / 通知页面转离线。</summary>
        void ApplyProbe(ProbeResult r)
        {
            probing = false;
            probeTimer.Stop();

            if (r.Port > 0 && r.Port != serverPort)
            {
                serverPort = r.Port;
                url = PageUrl(serverPort);
                ShellSettings.Trace("插件服务器端口：" + serverPort);
                if (settings.Port != serverPort)
                {
                    settings.Port = serverPort;
                    try { settings.Save(); }        // 下次启动直接命中；存不下也不影响本次判断
                    catch (Exception ex) { ShellSettings.Trace("端口没能写回 settings.json：" + ex.Message); }
                }
            }

            if (r.Port <= 0)
            {
                // ── 没有服务器在听：DSH 退了 ──
                if (serverAlive)
                {
                    serverAlive = false;
                    ShellSettings.Trace("没找到在监听的插件服务器：DSH 已退出");
                }
                // 服务器那版已经在跑就**别覆盖它**。页面本体和 JS 都在内存里，
                // 点球照样展开那个在线面板，数据停在最后一次。
                // 宿主不会再推 connection.offline，所以这里壳级别补一条。
                if (onServerPage && !toldPageOffline)
                {
                    toldPageOffline = true;
                    TellPageOffline();
                }
            }
            else if (r.PageOk)
            {
                if (!serverAlive)
                {
                    serverAlive = true;
                    ShellSettings.Trace("端口 " + serverPort + " + 页面都在：哦鲸鲸在线");
                }
                if (toldPageOffline)
                {
                    toldPageOffline = false;
                    TellPageOnline();    // 断线又回来了：把页面从黑白切回在线
                }
                if (!onServerPage && !navigating)
                {
                    NavigateToServer();  // 自己会停定时器，OnNavDone 再拉回来
                    return;
                }
            }
            else if (onServerPage && !toldPageOffline)
            {
                // 端口在、页面取不到（插件被卸载 / 正在重装）
                toldPageOffline = true;
                ShellSettings.Trace("端口 " + serverPort + " 在监听但 app.html 取不到：插件可能正在重装");
                TellPageOffline();
            }

            // DSH 关着的时候别每 3 秒把 70 多个端口扫一遍：失败越多退得越远（上限 8 秒）。
            // 已经找到端口就 1 秒一拍（这个只是 TCP 连接，几乎不花东西）。
            if (r.Port > 0) probeMiss = 0;
            else probeMiss = Math.Min(probeMiss + 1, 9);
            int idleInterval = probeMiss <= 1 ? 2000 : (probeMiss <= 3 ? 5000 : 8000);
            probeTimer.Interval = onServerPage ? 2000 : (r.Port > 0 ? 1000 : idleInterval);
            probeTimer.Start();
        }

        /// <summary>切到插件服务器那版（能拿真数据）。</summary>
        void NavigateToServer()
        {
            wantLocal = false;
            navigating = true;
            toldPageOffline = false;
            probeTimer.Stop();
            // 卡片几何作废：新页面的卡片位置要等它首屏重发。这期间 regionTimer 退回
            // 整窗外形裁剪，不会闪一块没切的大方角。
            hasCard = false;
            ShellSettings.Trace("探活成功，加载插件页面");
            web.Source = new Uri(url);
        }

        /// <summary>切到内置页面（没有 DSH 时的完整 UI，离线视觉由前端自己切）。</summary>
        void NavigateLocal()
        {
            wantLocal = true;
            navigating = true;
            probeTimer.Stop();
            hasCard = false;
            ShellSettings.Trace("加载内置页面");
            web.Source = new Uri(localUrl);
        }

        /// <summary>
        /// 服务器那版页面还在、服务器没了：告诉页面它掉线了。
        /// 页面收到 `{type:"connection",state:"offline"}` 会走 XJ.state.actions.setConnection
        /// ——和真宿主推 connection.offline 走同一条路（黑白球 + 灰虚线环 + toast），
        /// 但页面本身留在原地，点球照样展开在线那个面板。
        /// 老大 2026-10-21：「之前离线也可以打开在线的面板的」。
        /// </summary>
        void TellPageOffline()
        {
            TryTellConnection("offline");
        }

        /// <summary>
        /// 反向的一条：DSH 又起来了 / 插件页面又能取到了，让页面从黑白切回在线。
        /// 页面侧收到 `{type:"connection",state:"online"}` 会走 build 里同一个
        /// setConnection("online")，与宿主自己推的那条等价。
        /// </summary>
        void TellPageOnline()
        {
            TryTellConnection("online");
        }

        void TryTellConnection(string state)
        {
            try
            {
                if (web.CoreWebView2 != null)
                    web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"connection\",\"state\":\"" + state + "\"}");
                ShellSettings.Trace("页面保留：已通知页面转 " + state);
            }
            catch (Exception ex)
            {
                ShellSettings.Trace("通知页面 " + state + " 失败：" + ex.Message);
            }
        }

        /// <summary>
        /// 监听服务器：对 127.0.0.1:&lt;port&gt; 做一次 TCP 连接，成功即「有东西在听」。
        /// 用 TCP 而不是 HTTP GET 的理由：
        ///   · 进程刚死时 loopback 上直接 ECONNREFUSED，亚毫秒返回；
        ///     HTTP 要建连接、等响应，超时设 2s 就意味着最坏 2s 才知道；
        ///   · 不产生请求日志、不占 webServer 的处理能力，1 秒一拍也不心疼。
        /// 注意这只能证明「端口在听」（DSH 起了），页面本身能不能取到要 ProbePage 再确认一次。
        /// </summary>
        static bool PortAlive(int port, int timeoutMs)
        {
            if (port <= 0) return false;
            try
            {
                using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                    client.EndConnect(ar);
                    return client.Connected;
                }
            }
            catch
            {
                return false;   // 拒绝连接 / 端口不可用
            }
        }

        /// <summary>
        /// 端口对不上时的兜底：枚举本机所有 loopback 监听端口，**并行**挨个问一句
        /// /xj/app.html，第一个 2xx 的就是插件服务器。
        /// 为什么不能写死端口：DSH 的 web server 端口由 DSH 自己决定（插件只管往它上面挂
        /// 路由），换版本、用户改过配置、同时开两个实例都会变。写死一个数字，一旦对不上
        /// 就永远探不到 —— 老大 2026-10-21 说的「还是不能监听」就是这个。
        /// 并行是为了别让「几十个端口 × 串行超时」把一拍拖成十几秒（实测本机 20+ 个监听）。
        /// </summary>
        static int DiscoverPort(int guess)
        {
            System.Collections.Generic.List<int> ports = new System.Collections.Generic.List<int>();
            try
            {
                foreach (System.Net.IPEndPoint ep in System.Net.NetworkInformation.IPGlobalProperties
                    .GetIPGlobalProperties().GetActiveTcpListeners())
                {
                    if (ep.Port < 1024) continue;
                    // 只认回环 / 通配地址：别的网卡地址不可能是本机插件
                    if (!System.Net.IPAddress.IsLoopback(ep.Address)
                        && !ep.Address.Equals(System.Net.IPAddress.Any)) continue;
                    if (!ports.Contains(ep.Port)) ports.Add(ep.Port);
                }
            }
            catch { }
            // 猜的那个端口排第一（命中率最高时第一个就中）
            ports.Remove(guess);
            if (guess > 0) ports.Insert(0, guess);
            if (ports.Count == 0) return 0;

            int found = 0;
            object gate = new object();
            int next = 0;
            object cursor = new object();
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(1800);
            // 自己开线程 + 游标分活，而不是 Parallel.ForEach：
            // 每个任务都在阻塞等 socket，用线程池会被饿死（实测 76 个端口一起冲，
            // Parallel 直接不返回，连 BeginInvoke 都排不上）。这里还有硬截止时间，
            // 某个服务只发 header 不给 body 也拖不住整轮扫描。
            int workers = Math.Min(12, ports.Count);
            System.Threading.Thread[] workers_ = new System.Threading.Thread[workers];
            for (int i = 0; i < workers; i++)
            {
                workers_[i] = new System.Threading.Thread(delegate()
                {
                    while (true)
                    {
                        int idx;
                        lock (cursor) { idx = next; next = idx + 1; }
                        if (idx >= ports.Count) return;
                        if (System.Threading.Volatile.Read(ref found) != 0) return;
                        if (DateTime.UtcNow > deadline) return;
                        int p = ports[idx];
                        if (!PortAlive(p, 80)) continue;              // 没在听，80ms 就放掉
                        if (!ProbePage(PageUrl(p), 600)) continue;
                        lock (gate) { if (found == 0) found = p; }
                        return;
                    }
                });
                workers_[i].IsBackground = true;   // 卡住也不拦着进程退出
                workers_[i].Start();
            }
            // 总等待上限 2 秒（不是每个线程 2 秒）：一个不吭声的服务不该拖住整拍
            DateTime hardEnd = DateTime.UtcNow.AddMilliseconds(2000);
            for (int i = 0; i < workers_.Length; i++)
            {
                int left = (int)(hardEnd - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) break;
                workers_[i].Join(left);
            }
            // 只在结果变化时打日志：找不到的时候每 3 秒刷一行没意义
            if (found != lastScanResult)
            {
                lastScanResult = found;
                ShellSettings.Trace("扫描端口：" + (found > 0 ? "命中 " + found : "没找到插件服务器"));
            }
            return found;
        }

        /// <summary>
        /// 探活：GET 一下插件页面本体，**并且确认正文是我们的页面**才算连上。
        /// 只看 2xx 不够 —— 本机上有一类服务（实测 0.0.0.0:58473 那个网关）对**任何路径**
        /// 都回 200 `{"errcode":200,"message":"METHOD_NOT_ALLOWED"}`，端口扫描时它会抢答，
        /// 外壳就把窗口导航过去，结果白屏（2026-10-21 踩到）。
        /// 校验用 `xj-stage`：web/app.html 里的根容器 id，5KB 的页面上只有这一处，
        /// 别的服务不可能凑巧有。
        /// </summary>
        static bool ProbePage(string target, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(target);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    int code = (int)resp.StatusCode;
                    if (code < 200 || code >= 300) return false;
                    // 先用 Content-Type 一刀切掉 API 服务：本机那类「对任何路径都回 200」的
                    // 网关返回的是 application/json，命中就能立刻否掉，body 一个字节都不用读。
                    // 扫描几十个端口时这一刀是关键 —— 否则每个都要等满超时。
                    string ctype = resp.ContentType == null ? "" : resp.ContentType;
                    if (ctype.IndexOf("html", StringComparison.OrdinalIgnoreCase) < 0) return false;
                    using (Stream st = resp.GetResponseStream())
                    {
                        // ReadTimeout 必须设：有的服务发了 header 就再也不吐 body
                        // （或者吐个没完的流），不设的话这里会一直挂着
                        st.ReadTimeout = timeoutMs;
                        using (StreamReader sr = new StreamReader(st, System.Text.Encoding.UTF8))
                        {
                            char[] buf = new char[65536];
                            int n = sr.Read(buf, 0, buf.Length);
                            string body = new string(buf, 0, n);
                            return body.IndexOf("xj-stage", StringComparison.Ordinal) >= 0;
                        }
                    }
                }
            }
            catch (WebException)
            {
                return false;   // 连不上 / 非 2xx（404 等）都算没连上
            }
            catch
            {
                return false;
            }
        }

        /// <summary>内置页面都起不来时的最后兜底（真·异常情况：资源损坏 / WebView2 太老）。
        /// 注意底色必须跟 WebView2 的 DefaultBackgroundColor（#0d1320）同色实底：
        /// 「不透明 + Rgn 裁剪」模式下页面透明区域透出的是窗体深底，透明外围
        /// 会变成一圈突兀的黑边（2026-10-21 老大报的「大黑框」）。</summary>
        static string PlaceholderHtml()
        {
            return "<!doctype html><meta charset=utf-8><style>" +
                "html,body{margin:0;height:100%;background:#0d1320;overflow:hidden}" +
                "body{display:flex;align-items:center;justify-content:center}" +
                ".c{width:88px;height:88px;border-radius:50%;background:#0d1320;" +
                "border:1px solid rgba(255,255,255,.07);" +
                "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;" +
                "color:#cfe4ff;font:11px/1.4 'Microsoft YaHei',sans-serif}" +
                ".d{width:8px;height:8px;border-radius:50%;background:#7fb6ff;animation:p 1.2s ease-in-out infinite}" +
                "@keyframes p{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}" +
                "</style><div class=c><div class=d></div><div>连接中…</div></div>";
        }
    }
}
