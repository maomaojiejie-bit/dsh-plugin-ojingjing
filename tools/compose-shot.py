"""把 Qt 独立窗合成进一张「全屏截图」里。

为什么需要合成：GDI 的屏幕抓取（PIL ImageGrab / CopyFromScreen）抓不到
WS_EX_LAYERED 逐像素透明的窗口，直接抓会得到一张「哦鲸鲸凭空消失」的桌面。
所以分两步：
  1. PIL ImageGrab(all_screens=True) 抓整个虚拟桌面（壁纸、其他窗口都在）
  2. 通过 CDP 抓 Qt 窗口里的页面像素（带 alpha），按窗口矩形贴回去

输出：docs/screenshots/desktop-with-widget.png —— 主屏 1920×1080，哦鲸鲸在上面的真实位置。
用法：.venv\\Scripts\\python.exe tools\\compose-shot.py [devtools端口] [输出文件]
"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageGrab

ROOT = Path(__file__).resolve().parent.parent
_args = sys.argv[1:]
PORT = next((a for a in _args if a.isdigit()), "9223")
_out = next((a for a in _args if not a.isdigit()), None)
OUT = (ROOT / _out).resolve() if _out else ROOT / "docs" / "screenshots" / "desktop-with-widget.png"
SCRATCH = ROOT / ".shots"
SCRATCH.mkdir(exist_ok=True)
RAW = SCRATCH / "_widget-raw.png"

PRIMARY = (0, 0, 1920, 1080)


def window_rect(title: str):
    user32 = ctypes.WinDLL("user32")
    user32.FindWindowW.restype = wt.HWND
    hwnd = user32.FindWindowW(None, title)
    if not hwnd:
        raise SystemExit(f"找不到窗口：{title}（哦鲸鲸没在跑？）")
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def virtual_origin():
    user32 = ctypes.WinDLL("user32")
    return (
        user32.GetSystemMetrics(76),  # SM_XVIRTUALSCREEN
        user32.GetSystemMetrics(77),  # SM_YVIRTUALSCREEN
    )


def grab_widget():
    subprocess.run(
        ["node", str(ROOT / "tools" / "cdp-eval.mjs"), PORT, "'shot'", "--shot", str(RAW)],
        check=True,
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return Image.open(RAW).convert("RGBA")


def main() -> None:
    left, top, right, bottom = window_rect("哦鲸鲸")
    w, h = right - left, bottom - top
    xv, yv = virtual_origin()

    desktop = ImageGrab.grab(all_screens=True).convert("RGBA")
    shot = grab_widget()
    if shot.size != (w, h):
        shot = shot.resize((w, h), Image.LANCZOS)

    desktop.alpha_composite(shot, dest=(left - xv, top - yv))

    crop = (
        PRIMARY[0] - xv,
        PRIMARY[1] - yv,
        PRIMARY[2] - xv,
        PRIMARY[3] - yv,
    )
    out = desktop.crop(crop)
    out.save(OUT)
    print(f"widget=({left},{top})-({right},{bottom}) {w}x{h}  virtual=({xv},{yv})  -> {OUT} {out.size}")


if __name__ == "__main__":
    main()
