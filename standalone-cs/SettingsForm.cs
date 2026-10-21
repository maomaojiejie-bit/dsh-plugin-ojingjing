// 外壳设置窗（Python 版那个 QDialog 的 C# 版）：端口、两个热键、截图模式、
// 高帧率、开机自启、DSH 关掉后自动退出、视觉模型的三个字段。
// 存的是 %APPDATA%\ojingjing\settings.json，和 PySide6 版共用同一份键名。
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace Ojingjing
{
    class SettingsForm : Form
    {
        readonly ShellSettings settings;
        readonly NumericUpDown port;
        readonly TextBox hotkeyToggle;
        readonly TextBox hotkeyCapture;
        readonly ComboBox captureMode;
        readonly CheckBox highFps;
        readonly CheckBox autostart;
        readonly CheckBox exitWithDsh;
        readonly TextBox visionBase;
        readonly TextBox visionKey;
        readonly TextBox visionModel;

        public SettingsForm(ShellSettings settings)
        {
            this.settings = settings;

            Text = "哦鲸鲸 · 设置";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(468, 470);
            Font = new Font("Microsoft YaHei UI", 9f);

            TableLayoutPanel grid = new TableLayoutPanel();
            grid.Dock = DockStyle.Fill;
            grid.Padding = new Padding(16, 12, 16, 8);
            grid.ColumnCount = 2;
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 128));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            int row = 0;
            AddLabel(grid, "端口", row);
            port = new NumericUpDown();
            port.Minimum = 1024;
            port.Maximum = 65535;
            port.Value = Math.Min(65535, Math.Max(1024, settings.Port));
            port.Width = 120;
            grid.Controls.Add(port, 1, row++);

            AddLabel(grid, "显隐热键", row);
            hotkeyToggle = new TextBox();
            hotkeyToggle.Text = settings.HotkeyToggle;
            hotkeyToggle.Width = 200;
            grid.Controls.Add(hotkeyToggle, 1, row++);

            AddLabel(grid, "截图热键", row);
            hotkeyCapture = new TextBox();
            hotkeyCapture.Text = settings.HotkeyCapture;
            hotkeyCapture.Width = 200;
            grid.Controls.Add(hotkeyCapture, 1, row++);

            AddLabel(grid, "截图模式", row);
            captureMode = new ComboBox();
            captureMode.DropDownStyle = ComboBoxStyle.DropDownList;
            captureMode.Items.Add("整屏（默认）");
            captureMode.Items.Add("框选");
            captureMode.SelectedIndex = settings.CaptureMode == "region" ? 1 : 0;
            captureMode.Width = 160;
            grid.Controls.Add(captureMode, 1, row++);

            AddLabel(grid, "", row);
            highFps = new CheckBox();
            highFps.Text = "高帧率（解除 60 帧限制，更吃 CPU）";
            highFps.Checked = settings.HighFps;
            grid.Controls.Add(highFps, 1, row++);

            AddLabel(grid, "", row);
            autostart = new CheckBox();
            autostart.Text = "开机自启";
            autostart.Checked = ShellSettings.AutostartEnabled();
            grid.Controls.Add(autostart, 1, row++);

            AddLabel(grid, "", row);
            exitWithDsh = new CheckBox();
            exitWithDsh.Text = "DSH 关掉后自动退出";
            exitWithDsh.Checked = settings.ExitWithDsh;
            grid.Controls.Add(exitWithDsh, 1, row++);

            AddLabel(grid, "视觉模型", row);
            visionBase = new TextBox();
            visionBase.Text = settings.VisionBaseUrl;
            visionBase.Width = 280;
            grid.Controls.Add(visionBase, 1, row++);

            AddLabel(grid, "", row);
            visionKey = new TextBox();
            visionKey.Text = settings.VisionApiKey;
            visionKey.Width = 280;
            visionKey.UseSystemPasswordChar = true;
            grid.Controls.Add(visionKey, 1, row++);

            AddLabel(grid, "", row);
            visionModel = new TextBox();
            visionModel.Text = settings.VisionModel;
            visionModel.Width = 280;
            grid.Controls.Add(visionModel, 1, row++);

            Label hint = new Label();
            hint.ForeColor = Color.FromArgb(110, 110, 110);
            hint.Text = "热键 / 端口 / 高帧率改完要重启外壳才生效。截图在设置里叫「整屏」时，\r\n框选从主屏整屏开始，按住拖动就是局部。";
            hint.AutoSize = true;
            grid.Controls.Add(hint, 0, row);
            grid.SetColumnSpan(hint, 2);
            row++;

            Controls.Add(grid);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Bottom;
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.Padding = new Padding(0, 4, 14, 10);
            buttons.Height = 46;

            Button ok = new Button();
            ok.Text = "保存";
            ok.Width = 88;
            ok.DialogResult = DialogResult.OK;
            ok.Click += delegate { Save(); };
            buttons.Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Width = 88;
            cancel.DialogResult = DialogResult.Cancel;
            buttons.Controls.Add(cancel);

            Button openDir = new Button();
            openDir.Text = "打开配置目录";
            openDir.Width = 120;
            openDir.Click += delegate
            {
                try
                {
                    System.Diagnostics.Process.Start(settings.ConfigDir);
                }
                catch (Exception err)
                {
                    ShellSettings.Trace("打开配置目录失败：" + err.Message);
                }
            };
            buttons.Controls.Add(openDir);

            Controls.Add(buttons);
            AcceptButton = ok;
            CancelButton = cancel;
        }

        static void AddLabel(TableLayoutPanel grid, string text, int row)
        {
            Label label = new Label();
            label.Text = text;
            label.AutoSize = true;
            label.Anchor = AnchorStyles.Left;
            label.Margin = new Padding(3, 8, 3, 3);
            grid.Controls.Add(label, 0, row);
        }

        void Save()
        {
            settings.Port = (int)port.Value;
            settings.HotkeyToggle = hotkeyToggle.Text.Trim();
            settings.HotkeyCapture = hotkeyCapture.Text.Trim();
            settings.CaptureMode = captureMode.SelectedIndex == 1 ? "region" : "screen";
            settings.HighFps = highFps.Checked;
            settings.ExitWithDsh = exitWithDsh.Checked;
            settings.VisionBaseUrl = visionBase.Text.Trim();
            settings.VisionApiKey = visionKey.Text.Trim();
            settings.VisionModel = visionModel.Text.Trim();
            settings.Save();
            ShellSettings.ApplyAutostart(autostart.Checked, Application.ExecutablePath);
            ShellSettings.Trace("设置已保存（port=" + settings.Port + "，开机自启=" + autostart.Checked + "）");
        }
    }
}
