// 截图提问：抓整屏 → 框选 → 裁剪成 PNG。
//
// Python 版是 Qt 画的遮罩，这里用 WinForms：同一个虚拟屏幕大小的无边框置顶窗，
// 背景直接贴整张桌面截图（压暗），上面画选框。确认后按设备像素比裁出 PNG。
//
// 对外：
//   ShotSelectionForm.Run(Bitmap screen, Rectangle virtualBounds, Rectangle defaultSel, float dpr)
//     → 返回选中的区域（虚拟屏幕坐标），取消返回 Rectangle.Empty
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

namespace Ojingjing
{
    class ShotSelectionForm : Form
    {
        Bitmap screen;              // 整张虚拟屏幕截图（物理像素）
        Rectangle virtualBounds;    // 虚拟屏幕在桌面坐标里的位置（可能是负的）
        Rectangle selection;        // 当前选框（窗体客户区坐标）
        Rectangle defaultSel;
        float dpr = 1f;
        bool dragging;
        Point dragStart;

        /// <summary>结果：虚拟屏幕坐标下的选区；取消则为空。</summary>
        public Rectangle Result = Rectangle.Empty;

        ShotSelectionForm(Bitmap screen, Rectangle virtualBounds, Rectangle defaultSel, float dpr)
        {
            this.screen = screen;
            this.virtualBounds = virtualBounds;
            this.dpr = dpr <= 0 ? 1f : dpr;
            this.defaultSel = defaultSel;
            this.selection = defaultSel;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = virtualBounds;
            TopMost = true;
            ShowInTaskbar = false;
            DoubleBuffered = true;
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            KeyPreview = true;

            Native.SetWindowLong(Handle, Native.GWL_EXSTYLE,
                Native.GetWindowLong(Handle, Native.GWL_EXSTYLE) | Native.WS_EX_TOOLWINDOW);
        }

        /// <summary>模态跑一次框选；返回虚拟屏幕坐标里的选区（取消返回空）。</summary>
        public static Rectangle Run(Bitmap screen, Rectangle virtualBounds, Rectangle defaultSel, float dpr)
        {
            using (ShotSelectionForm form = new ShotSelectionForm(screen, virtualBounds, defaultSel, dpr))
            {
                form.ShowDialog();
                return form.Result;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Activate();
            Focus();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            // 桌面截图铺满整个虚拟屏幕
            g.DrawImage(screen, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));

            Rectangle box = Clamp(selection);
            // 选框外压暗
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(150, 0, 0, 0)))
            {
                Region outside = new Region(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));
                outside.Exclude(box);
                g.FillRegion(dim, outside);
                outside.Dispose();
            }
            using (Pen pen = new Pen(Color.FromArgb(255, 214, 132, 96), 2f))
            {
                g.DrawRectangle(pen, box);
            }
            // 尺寸提示
            string label = box.Width + " × " + box.Height;
            SizeF size = g.MeasureString(label, SystemFonts.DefaultFont);
            float lx = box.Left + 8;
            float ly = box.Top - size.Height - 8;
            if (ly < 0) ly = box.Top + 8;
            using (SolidBrush bg = new SolidBrush(Color.FromArgb(170, 0, 0, 0)))
            {
                g.FillRectangle(bg, lx - 4, ly - 2, size.Width + 8, size.Height + 4);
            }
            g.DrawString(label, SystemFonts.DefaultFont, Brushes.White, lx, ly);

            string hint = "拖动框选 · Enter 确认 · Esc 取消";
            SizeF hs = g.MeasureString(hint, SystemFonts.DefaultFont);
            using (SolidBrush bg = new SolidBrush(Color.FromArgb(170, 0, 0, 0)))
            {
                g.FillRectangle(bg, (ClientSize.Width - hs.Width) / 2 - 6,
                    ClientSize.Height - hs.Height - 24, hs.Width + 12, hs.Height + 6);
            }
            g.DrawString(hint, SystemFonts.DefaultFont, Brushes.White,
                (ClientSize.Width - hs.Width) / 2, ClientSize.Height - hs.Height - 21);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            dragging = true;
            dragStart = e.Location;
            selection = new Rectangle(e.Location, Size.Empty);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!dragging) return;
            selection = Normalize(dragStart, e.Location);
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            dragging = false;
            if (selection.Width > 4 && selection.Height > 4) Invalidate();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Enter)
            {
                Accept();
            }
            else if (e.KeyCode == Keys.Escape)
            {
                Result = Rectangle.Empty;
                Close();
            }
            else if (e.KeyCode == Keys.A && e.Control)
            {
                selection = new Rectangle(0, 0, ClientSize.Width, ClientSize.Height);
                Invalidate();
            }
        }

        void Accept()
        {
            Rectangle box = Clamp(selection);
            if (box.Width < 4 || box.Height < 4)
            {
                Result = Rectangle.Empty;
                Close();
                return;
            }
            // 窗体客户区坐标 → 虚拟屏幕坐标
            Result = new Rectangle(virtualBounds.Left + box.Left, virtualBounds.Top + box.Top, box.Width, box.Height);
            Close();
        }

        Rectangle Clamp(Rectangle box)
        {
            Rectangle all = new Rectangle(0, 0, ClientSize.Width, ClientSize.Height);
            return Rectangle.Intersect(box, all);
        }

        static Rectangle Normalize(Point a, Point b)
        {
            return new Rectangle(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        }
    }

    static class ShotCapture
    {
        /// <summary>把整块虚拟屏幕抓成位图（物理像素）。</summary>
        public static Bitmap GrabDesktop(Rectangle virtualBounds, out float dpr)
        {
            dpr = 1f;
            try
            {
                using (Graphics probe = Graphics.FromHwnd(IntPtr.Zero))
                {
                    dpr = probe.DpiX / 96f;
                }
            }
            catch
            {
                dpr = 1f;
            }
            int w = Math.Max(1, (int)Math.Round(virtualBounds.Width * dpr));
            int h = Math.Max(1, (int)Math.Round(virtualBounds.Height * dpr));
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(virtualBounds.Left, virtualBounds.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            return bmp;
        }

        /// <summary>按选区裁出 PNG（选区是虚拟屏幕坐标）。</summary>
        public static byte[] CropToPng(Bitmap screen, Rectangle virtualBounds, Rectangle area, float dpr)
        {
            float scale = dpr <= 0 ? 1f : dpr;
            Rectangle src = new Rectangle(
                (int)Math.Round((area.Left - virtualBounds.Left) * scale),
                (int)Math.Round((area.Top - virtualBounds.Top) * scale),
                (int)Math.Round(area.Width * scale),
                (int)Math.Round(area.Height * scale));
            src = Rectangle.Intersect(src, new Rectangle(0, 0, screen.Width, screen.Height));
            if (src.Width < 1 || src.Height < 1) src = new Rectangle(0, 0, screen.Width, screen.Height);
            using (Bitmap cut = screen.Clone(src, screen.PixelFormat))
            using (MemoryStream ms = new MemoryStream())
            {
                cut.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }

        /// <summary>PNG 头里读宽高（IHDR 在偏移 16..24）；读不到返回 0。</summary>
        public static void PngSize(byte[] png, out int width, out int height)
        {
            width = 0;
            height = 0;
            if (png == null || png.Length < 24) return;
            if (!(png[0] == 0x89 && png[1] == 0x50 && png[2] == 0x4E && png[3] == 0x47)) return;
            width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
            height = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
        }
    }
}
