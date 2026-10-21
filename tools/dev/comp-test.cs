// 一次性回归（2026-10-21）：陪伴账本 JSON 反序列化 + 记账 tick。
// 老代码在 CheckMilestone 里把 milestones 强转 List<object>，而
// JavaScriptSerializer 把 JSON 数组读回来是 ArrayList —— 落盘后重启外壳，
// 第一个 active tick 就 InvalidCastException 崩出 .NET 对话框（老大踩到）。
// 编译：csc /nologo /target:exe /out:.shots/comp-test.exe /r:System.dll /r:System.Core.dll
//       /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll
//       .shots/comp-test.cs standalone-cs/Companionship.cs standalone-cs/Settings.cs standalone-cs/Native.cs
using System;
using System.IO;
using System.Threading;
using Ojingjing;

class CompTest
{
    static int fail = 0;

    static void Check(string name, bool ok, string detail)
    {
        Console.WriteLine((ok ? "  [OK] " : "  [FAIL] ") + name + " → " + detail);
        if (!ok) fail++;
    }

    static int Main()
    {
        // 数据目录放 exe 旁边（.shots/，工作区内；沙箱不让写 %TEMP%）
        string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "comp-test-data");
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, "companionship.json");
        string today = DateTime.Now.ToString("yyyy-MM-dd");

        // 用例 1：milestones 是 JSON 数组（读回来 = ArrayList，老代码的雷）
        File.WriteAllText(path, "{\"first_met\":\"2026-10-20\",\"total_sec\":30,\"today\":\"" + today
            + "\",\"today_sec\":30,\"streak_days\":1,\"milestones\":[\"3600\"]}");
        Companionship a = new Companionship(path);
        Thread.Sleep(1100);
        a.Tick(true);
        a.Save(true);
        string out1 = File.ReadAllText(path);
        Console.WriteLine("[1] 数组 milestones（老大崩的那形状）");
        Check("tick 存活", true, "无异常");
        Check("total_sec 30→31", out1.IndexOf("\"total_sec\":31", StringComparison.Ordinal) >= 0, out1);
        Check("milestones 原样留着我", out1.IndexOf("3600", StringComparison.Ordinal) >= 0, "序列化回数组");

        // 用例 2：空数组（Blank() 自己写的形状）
        File.WriteAllText(path, "{\"milestones\":[]}");
        Companionship b = new Companionship(path);
        Thread.Sleep(1100);
        b.Tick(true);
        Console.WriteLine("[2] 空数组 milestones");
        Check("tick 存活", true, "total=" + b.Payload()["total_sec"]);

        // 用例 3：null 值 + 字符串数值
        File.WriteAllText(path, "{\"milestones\":null,\"total_sec\":null,\"streak_days\":\"2\"}");
        Companionship c = new Companionship(path);
        Thread.Sleep(1100);
        c.Tick(true);
        Console.WriteLine("[3] null / 字符串数值");
        Check("tick 存活", true, "total=" + c.Payload()["total_sec"] + " streak=" + c.Payload()["streak_days"]);

        // 用例 4：文件不存在（全新账本）
        string gone = Path.Combine(dir, "nope.json");
        if (File.Exists(gone)) File.Delete(gone);
        Companionship d = new Companionship(gone);
        Thread.Sleep(1100);
        d.Tick(true);
        Console.WriteLine("[4] 无文件");
        Check("tick 存活", true, "total=" + d.Payload()["total_sec"]);

        Console.WriteLine(fail == 0 ? "ALL OK" : "FAIL " + fail);
        return fail;
    }
}
