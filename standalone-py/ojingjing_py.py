"""哦鲸鲸 · DSH 悬浮窗（Python + PySide6 / QtWebEngine 外壳）

和 standalone/（C# + WPF）同一只鲸鱼、同一个页面：
    http://127.0.0.1:43120/xj/app.html?embed=1&host=py

外壳能力：
    无边框 · 逐像素透明 · 置顶 · 不进任务栏/Alt+Tab · 托盘 · 全局热键 · 右下角锚定 · 位置记忆

为什么要 Qt 而不是 pywebview：那套 WinForms 后端在本机 .NET 上
（netfx 的 pythonnet 加载失败、coreclr 下 System.Windows.Forms.IFileDialog 不对外暴露）
import 阶段就崩，和网络无关。Qt 的 WebEngine 自带合成器，透明是原生支持。

跑法：
    .venv\\Scripts\\pythonw.exe ojingjing_py.py     # 无控制台
    .venv\\Scripts\\python.exe  ojingjing_py.py     # 带控制台/日志
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

BASE = (
    # PyInstaller 打包后 __file__ 落在 _internal/ 里，运行时数据（data/、日志）要跟着 exe 走
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
LOG_PATH = BASE / "ojingjing-py.log"


def _writable_dir(candidates: list[Path]) -> Path:
    """配置目录：优先 %APPDATA%\\ojingjing，退到 LOCALAPPDATA，最后退到程序目录下的 data/。
    为什么要有退路：程序跑在被限制的文件沙箱里时，Roaming/Local 会 Access Denied，
    而安静失败会让「记忆位置」「保存设置」看起来像没生效。"""
    for candidate in candidates:
        if not str(candidate):
            continue
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return candidate
        except Exception:  # noqa: BLE001
            continue
    return candidates[-1]


def _migrate_legacy_dir(target: Path) -> None:
    """老版本（叫「小鲸」时）的配置目录 copy 一份过来，免得改名后设置/位置/API key 全丢。
    只在新目录里还没有对应文件时复制，失败静默。"""
    legacy = Path(os.environ.get("APPDATA", "")) / "xiaojing" if os.environ.get("APPDATA") else None
    if not legacy or not legacy.is_dir():
        return
    for name in ("settings.json", "vision.json", "window.json"):
        src, dst = legacy / name, target / name
        if src.is_file() and not dst.exists():
            try:
                dst.write_bytes(src.read_bytes())
            except Exception:  # noqa: BLE001
                pass


CONFIG_DIR = _writable_dir([
    Path(os.environ.get("APPDATA", "")) / "ojingjing" if os.environ.get("APPDATA") else None,
    Path(os.environ.get("LOCALAPPDATA", "")) / "ojingjing" if os.environ.get("LOCALAPPDATA") else None,
    BASE / "data",
])
try:
    _migrate_legacy_dir(CONFIG_DIR)
except Exception:  # noqa: BLE001
    pass
POS_PATH = CONFIG_DIR / "window.json"
PID_PATH = CONFIG_DIR / "ojingjing.pid"
ICON_CANDIDATES = [BASE.parent / "web" / "icon.png"]  # 只保留角色图标；自定义头像见 custom_icon_path()

TITLE = "哦鲸鲸"

# QtWebEngine 两条渲染路径：
#   软件（默认）：ANGLE + WARP 软件光栅 + 关 GPU 合成。逐像素透明的分层窗口能正常显示；
#                代价是透明窗口上的模糊/动画吃 CPU —— 页面侧靠 html.xj-sw 减负。
#   硬件：ANGLE + D3D11 + GPU 合成，拖动明显更顺；但本机实测有坑——分层透明窗口拿不到
#        GPU 合成的那一帧，屏幕上看不见窗口（PrintWindow 抓出来的内容却是好的），
#        所以只作「硬件（实验）」opt-in。
# 判定：settings.json 的 render = sw|hw（auto 一律按 sw 处理）；XJ_HW_GL=0/1 环境变量最高优先。
# data/gpu-off 标记只用于 hw 的失败降级（loadFinished ok=False / 渲染进程崩）。
_GPU_OFF_MARK = CONFIG_DIR / "gpu-off"
_RENDER_PREFS = ("auto", "sw", "hw")
# 重启等待区：pending 时 main() 在 app.exec() 返回后重新拉起自己；force_sw 决定用哪条渲染路径
# （None = 让新进程重新读 settings.json）。
_RESTART = {"pending": False, "force_sw": None}


def _render_pref() -> str:
    """启动最早期就得定下来，所以直接读 settings.json；不能走 settings()（那时 log 还没定义，
    而且 SETTINGS_PATH 也还没绑定）。"""
    forced = (os.environ.get("XJ_HW_GL") or "").strip()
    if forced == "0":
        return "sw"
    if forced == "1":
        return "hw"
    try:
        data = json.loads((CONFIG_DIR / "settings.json").read_text(encoding="utf-8"))
        pref = str((data or {}).get("render") or "sw").strip().lower()
    except Exception:  # noqa: BLE001
        pref = "sw"
    return pref if pref in _RENDER_PREFS else "sw"


def _use_hw_gl() -> bool:
    pref = _render_pref()
    if pref == "hw":
        # 之前硬件渲染已经证明加载不了（RDP/无显卡）就别再撞一次
        return not _GPU_OFF_MARK.exists()
    return False  # auto / sw 都走软件：先保证窗口看得见


RENDER_PREF = _render_pref()
HW_GL = _use_hw_gl()
if HW_GL:
    os.environ.setdefault("QT_OPENGL", "angle")
    os.environ.setdefault("QT_ANGLE_PLATFORM", "d3d11")
    os.environ.setdefault(
        "QTWEBENGINE_CHROMIUM_FLAGS",
        "--no-sandbox --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy",
    )
else:
    os.environ.setdefault("QT_OPENGL", "angle")
    os.environ.setdefault("QT_ANGLE_PLATFORM", "warp")
    # 单进程 + 禁 GPU：本机实测只有这个组合能稳定出帧。
    # 之前用的「--disable-gpu-compositing」会让渲染子进程在 8–9 秒后崩
    # （CrashedTerminationStatus / 0x80000003），连 about:blank 都一样，
    # 所以问题在子进程本身而不是页面内容；--single-process 把它并回主进程就正常了。
    os.environ.setdefault(
        "QTWEBENGINE_CHROMIUM_FLAGS",
        "--single-process --disable-gpu --no-sandbox",
    )


def mark_gpu_failure(reason: str) -> None:
    """硬件渲染起不来：留标记，让 main() 退出后改用软件渲染重开一次。"""
    if not HW_GL or _RESTART["pending"]:
        return
    _RESTART["pending"] = True
    _RESTART["force_sw"] = True
    try:
        _GPU_OFF_MARK.write_text(time.strftime("%Y-%m-%d %H:%M:%S ") + reason + "\n", encoding="utf-8")
        log(f"硬件渲染失败（{reason}）：写 {_GPU_OFF_MARK.name}，改用软件渲染重启一次")
    except Exception as exc:  # noqa: BLE001
        log(f"写 gpu-off 标记失败：{exc}")


def relaunch(force_sw=None) -> None:
    """重启自己。force_sw：True 强制软件、False 强制硬件、None 按设置重算。

    互斥量要先放开，否则新实例会以为自己重复，直接退出。
    """
    release_single_instance()
    env = dict(os.environ)
    env.pop("QTWEBENGINE_CHROMIUM_FLAGS", None)  # 渲染方式变了，让新进程按自己的模式重写
    if force_sw is True:
        env["XJ_HW_GL"] = "0"
    elif force_sw is False:
        env["XJ_HW_GL"] = "1"
    else:
        env.pop("XJ_HW_GL", None)
    try:
        subprocess.Popen(
            [sys.executable, str(BASE / "ojingjing_py.py")],
            cwd=str(BASE),
            env=env,
            close_fds=True,
        )
        log("已重新启动：" + ("软件渲染" if force_sw else "按设置"))
    except Exception as exc:  # noqa: BLE001
        log(f"重新启动失败：{exc}")


MIN_W, MIN_H, MAX_W, MAX_H = 96, 96, 900, 900

_log_lock = threading.Lock()


def log(message: str) -> None:
    line = time.strftime("%H:%M:%S") + "  " + str(message)
    with _log_lock:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass
        if sys.stdout:
            try:
                print(line, flush=True)
            except Exception:
                pass


# ------------------------------------------------------------------ Win32

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WM_NCLBUTTONDOWN = 0xA1
HTCAPTION = 0x2
WM_HOTKEY = 0x0312
WM_SYSCOMMAND = 0x0112
SC_RESTORE = 0xF120
HOTKEY_RELOAD = 0x0400 + 1  # WM_APP + 1：主线程改完设置，叫热键线程重注册
_hotkey_tid: int | None = None
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
VK_SPACE = 0x20
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080


class MSG(ctypes.Structure):
    _fields_ = [("hwnd", wt.HWND), ("message", wt.UINT),
                ("wParam", wt.WPARAM), ("lParam", wt.LPARAM),
                ("time", wt.DWORD), ("pt", ctypes.c_long * 2)]


def _win_proto() -> None:
    user32.ReleaseCapture.restype = wt.BOOL
    user32.SendMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.SendMessageW.restype = wt.LPARAM
    user32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.SetWindowLongW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_long]
    user32.SetWindowLongW.restype = ctypes.c_long
    user32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
    user32.RegisterHotKey.restype = wt.BOOL
    user32.UnregisterHotKey.argtypes = [wt.HWND, ctypes.c_int]
    user32.UnregisterHotKey.restype = wt.BOOL
    user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.PostThreadMessageW.restype = wt.BOOL
    kernel32.GetCurrentThreadId.restype = wt.DWORD
    user32.GetMessageW.argtypes = [ctypes.POINTER(MSG), wt.HWND, wt.UINT, wt.UINT]
    user32.GetMessageW.restype = wt.BOOL
    # 打开主窗口：枚举窗口 → 拉前台
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM), wt.LPARAM]
    user32.EnumWindows.restype = wt.BOOL
    user32.IsWindowVisible.argtypes = [wt.HWND]
    user32.IsWindowVisible.restype = wt.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    user32.GetWindowThreadProcessId.restype = wt.DWORD
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wt.HWND
    user32.SetForegroundWindow.argtypes = [wt.HWND]
    user32.SetForegroundWindow.restype = wt.BOOL
    user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wt.BOOL
    user32.BringWindowToTop.argtypes = [wt.HWND]
    user32.BringWindowToTop.restype = wt.BOOL
    user32.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
    user32.AttachThreadInput.restype = wt.BOOL
    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    kernel32.QueryFullProcessImageNameW.restype = wt.BOOL
    kernel32.CloseHandle.argtypes = [wt.HANDLE]
    kernel32.CloseHandle.restype = wt.BOOL
    user32.IsIconic.argtypes = [wt.HWND]
    user32.IsIconic.restype = wt.BOOL
    user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.PostMessageW.restype = wt.BOOL
    # 未文档化但 Win10/11 上对「前台锁拒绝」很有效的强激活兜底
    try:
        user32.SwitchToThisWindow.argtypes = [wt.HWND, wt.BOOL]
        user32.SwitchToThisWindow.restype = None
    except AttributeError:
        pass


_win_proto()

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
DSH_EXE_NAMES = ("dsh desktop", "deepseek harness", "dsh")


def _proc_image_name(pid: int) -> str:
    """取进程可执行文件名（小写）；拿不到返回空串。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return Path(buf.value).name.lower()
    finally:
        kernel32.CloseHandle(h)
    return ""


def _dsh_windows() -> list[int]:
    """枚举顶层可见窗口，返回属于 DSH 进程的句柄（可能多个：主窗 + 子窗）。"""
    found: list[int] = []
    proto = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd: int, _lp: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        name = _proc_image_name(pid.value)
        if any(n in name for n in DSH_EXE_NAMES):
            found.append(hwnd)
        return True

    # 回调对象在 EnumWindows 返回前必须存活，用局部变量持有引用
    keep = proto(cb)
    user32.EnumWindows(keep, 0)
    return found


def _to_front(hwnd: int) -> str:
    """把窗口恢复到前台。返回诊断串（写日志用），不抛异常。

    关键：Electron/Chromium 自己管窗口状态，外部 ShowWindow(SW_RESTORE) 常被它
    忽略（实测：调用返回成功、IsIconic 仍是 True、rect 还在 -32000）。它只认
    WM_SYSCOMMAND / SC_RESTORE（等价于点任务栏的「还原」），所以最小化要走这条。

    顺序：SC_RESTORE（异步，轮询确认）→ ShowWindow 兜底 → 绕前台锁设前台
         → SwitchToThisWindow 兜底 → 回报 IsIconic 与前台是否真的切过去。
    """
    try:
        was_iconic = bool(user32.IsIconic(hwnd))

        # 1) 最小化：发系统命令「还原」，Chromium 会真正改窗口状态
        if was_iconic:
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
            for _ in range(25):  # 最多等 ~500ms，通常几十毫秒就恢复了
                if not user32.IsIconic(hwnd):
                    break
                time.sleep(0.02)
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)  # 最后兜底

        user32.BringWindowToTop(hwnd)

        # 2) 绕开「只有前台进程能改前台窗口」的限制
        fore_before = user32.GetForegroundWindow()
        tid_fg = user32.GetWindowThreadProcessId(fore_before, None) if fore_before else 0
        tid_cur = kernel32.GetCurrentThreadId()
        attached = False
        if tid_fg and tid_fg != tid_cur:
            attached = bool(user32.AttachThreadInput(tid_cur, tid_fg, True))
        try:
            set_ok = bool(user32.SetForegroundWindow(hwnd))
        finally:
            if attached:
                user32.AttachThreadInput(tid_cur, tid_fg, False)

        # 3) 前台锁仍在拒绝时，用未文档化但有效的强激活
        if user32.GetForegroundWindow() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:  # noqa: BLE001
                pass

        after = user32.GetForegroundWindow()
        still_iconic = bool(user32.IsIconic(hwnd))
        return (
            f"was_min={was_iconic} now_min={still_iconic} set={set_ok} attach={attached} "
            f"fore_before={fore_before} after={after} "
            f"restored={not still_iconic} focused={after == hwnd}"
        )
    except Exception as exc:  # noqa: BLE001
        return f"error={exc}"


# ------------------------------------------------------------------ 位置记忆


def load_pos() -> tuple[int | None, int | None]:
    try:
        data = json.loads(POS_PATH.read_text(encoding="utf-8"))
        return int(data["x"]), int(data["y"])
    except Exception:
        return None, None


def save_pos(x: int, y: int) -> None:
    try:
        POS_PATH.parent.mkdir(parents=True, exist_ok=True)
        POS_PATH.write_text(json.dumps({"x": x, "y": y}), encoding="utf-8")
    except Exception:
        pass


# ------------------------------------------------------------------ 设置
# 统一放在 %APPDATA%\ojingjing\settings.json，和 window.json 挨着；托盘「设置…」改它。
# 环境变量 XJ_DSH_BASE 仍然优先（调试时用假宿主顶掉端口）。

SETTINGS_PATH = CONFIG_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "port": 43120,
    "capture_mode": "screen",  # screen = 回车直接发整屏；region = 默认空选区，等你自己拖
    "hotkey_toggle": "Ctrl+Shift+Space",
    "hotkey_capture": "Ctrl+Shift+A",
    "autostart": False,
    "exit_with_dsh": False,  # DSH 关掉约 1 分钟后自动退出（默认关，免得误杀）
    # sw = 软件（默认，窗口一定看得见）；hw = 硬件（更顺，个别机器上分层窗口不显示，实验性）
    "render": "sw",
    "vision": {"base_url": "", "api_key": "", "model": ""},
    # 外观：avatar / background 都是本机图片的绝对路径（空 = 用内置），dim = 背景压暗程度 0–0.9
    "appearance": {"avatar": "", "background": "", "dim": 0.6},
}

_settings: dict = {}


def _merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def settings() -> dict:
    """读一次就缓存；文件坏了退回默认值，不抛异常。"""
    global _settings
    if _settings:
        return _settings
    data: dict = {}
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001
        log(f"settings.json 读不动（{exc}），用默认值")
    _settings = _merge(DEFAULT_SETTINGS, data if isinstance(data, dict) else {})
    return _settings


def save_settings(patch: dict) -> dict:
    global _settings
    _settings = _merge(settings(), patch)
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(_settings, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"settings saved -> {SETTINGS_PATH}")
    except Exception as exc:  # noqa: BLE001
        log(f"settings.json 写不进去（{exc}）")
    return _settings


def dsh_base() -> str:
    override = os.environ.get("XJ_DSH_BASE")
    if override:
        return override.rstrip("/")
    try:
        port = int(settings().get("port") or 43120)
    except Exception:  # noqa: BLE001
        port = 43120
    return f"http://127.0.0.1:{port}"


def app_url() -> str:
    return dsh_base() + "/xj/app.html?embed=1&host=py"


# ---- 外观：自定义头像 / 背景（图片读成 data URL 交给页面，页面里 XJ.app.applyAppearance 落地）
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}
APPEARANCE_ICON = CONFIG_DIR / "icon.png"


def image_data_url(path_text: str) -> str:
    """本机图片 → data URL；读不动/太大/格式不认就返回空串（页面会回落默认）。"""
    if not path_text:
        return ""
    try:
        path = Path(path_text).expanduser()
        if not path.is_file():
            log(f"外观图片不存在：{path}")
            return ""
        mime = IMAGE_MIME.get(path.suffix.lower())
        if not mime:
            log(f"外观图片格式不支持：{path.suffix}")
            return ""
        raw = path.read_bytes()
        if len(raw) > 8 * 1024 * 1024:
            log(f"外观图片超过 8MB（{len(raw)}），不加载")
            return ""
        return "data:" + mime + ";base64," + base64.b64encode(raw).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        log(f"读外观图片失败：{exc}")
        return ""


def appearance_js() -> str:
    cfg = settings().get("appearance") or {}
    dim = cfg.get("dim")
    try:
        dim = 0.6 if dim is None else max(0.0, min(0.9, float(dim)))
    except Exception:  # noqa: BLE001
        dim = 0.6
    payload = {
        "avatar": image_data_url(str(cfg.get("avatar") or "")),
        "background": image_data_url(str(cfg.get("background") or "")),
        "dim": dim,
    }
    return "window.XJ && XJ.app && XJ.app.applyAppearance(" + json.dumps(payload) + ")"


def custom_icon_path():
    """自定义头像 → 托盘图标（正方形居中裁切，尽量把脸放进去）。"""
    avatar = str((settings().get("appearance") or {}).get("avatar") or "")
    if not avatar:
        return None
    src = Path(avatar).expanduser()
    if not src.is_file():
        return None
    out = APPEARANCE_ICON
    try:
        from PIL import Image  # 可选依赖：装了 pillow 才重裁，没装就直接用原图
    except Exception:  # noqa: BLE001
        return src
    try:
        im = Image.open(src).convert("RGBA")
        w, h = im.size
        side = min(w, h)
        left = (w - side) // 2
        top = int((h - side) * 0.42)
        im = im.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
        out.parent.mkdir(parents=True, exist_ok=True)
        im.save(out)
        return out
    except Exception as exc:  # noqa: BLE001
        log(f"生成托盘图标失败（{exc}），直接用原图")
        return src


# 热键字符串 → (modifiers, vk)
MOD_ALT = 0x0001
MOD_WIN = 0x0008
VK_NAMES = {
    "SPACE": 0x20, "TAB": 0x09, "RETURN": 0x0D, "ENTER": 0x0D, "ESC": 0x1B, "ESCAPE": 0x1B,
    "INS": 0x2D, "DEL": 0x2E, "HOME": 0x24, "END": 0x23, "PGUP": 0x21, "PGDOWN": 0x22,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
    **{f"F{i}": 0x6F + i for i in range(1, 25)},
    **{chr(code): code for code in range(ord("A"), ord("Z") + 1)},
    **{str(digit): 0x30 + digit for digit in range(10)},
}


def parse_hotkey(text: str) -> tuple[int, int] | None:
    """'Ctrl+Shift+Space' → (mods, vk)；认不出来就返回 None（调用方回退默认）。"""
    parts = [p.strip() for p in (text or "").split("+") if p.strip()]
    if not parts:
        return None
    mods = 0
    for part in parts[:-1]:
        low = part.lower()
        if low in ("ctrl", "control"):
            mods |= MOD_CONTROL
        elif low == "shift":
            mods |= MOD_SHIFT
        elif low == "alt":
            mods |= MOD_ALT
        elif low in ("win", "meta"):
            mods |= MOD_WIN
        else:
            return None
    key = parts[-1].strip().upper()
    if key in VK_NAMES:
        return mods, VK_NAMES[key]
    if len(key) == 1 and key.isprintable():
        return mods, ord(key)
    return None


# 开机自启：HKCU\...\Run 写一个 pythonw + 脚本路径
AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "OjingjingWidget"


def set_autostart(enabled: bool) -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                exe = Path(sys.executable).with_name("pythonw.exe")
                if not exe.exists():
                    exe = Path(sys.executable)
                script = Path(__file__).resolve()
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, f'"{exe}" "{script}"')
                log("autostart on")
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
                log("autostart off")
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"自启设置失败（{exc}）")
        return False


def is_autostart() -> bool:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, AUTOSTART_NAME)
            return True
    except Exception:  # noqa: BLE001
        return False


# 单实例：两个实例会互相抢全局热键（第二个注册失败，看起来像「热键坏了」）
_single_instance_handle = None


def acquire_single_instance() -> bool:
    global _single_instance_handle
    try:
        kernel32.CreateMutexW.restype = wt.HANDLE
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR]
        handle = kernel32.CreateMutexW(None, False, "Local\\ojingjing-overlay-widget")
        _single_instance_handle = handle
        if not handle:
            return True
        return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS
    except Exception:  # noqa: BLE001
        return True


def release_single_instance() -> None:
    """软件渲染兜底重启前必须放开：否则新进程会看到互斥量还在，直接退出。"""
    global _single_instance_handle
    if not _single_instance_handle:
        return
    try:
        kernel32.CloseHandle(_single_instance_handle)
    except Exception:  # noqa: BLE001
        pass
    _single_instance_handle = None


def write_pid() -> None:
    """写 pid 文件，让「停止哦鲸鲸.cmd」能精确杀掉这一个实例（而不是杀所有 pythonw）。"""
    try:
        PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def clear_pid() -> None:
    try:
        if PID_PATH.is_file():
            PID_PATH.unlink()
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ 截图提问

VK_A = 0x41
HOTKEY_TOGGLE = 0x5A01
HOTKEY_CAPTURE = 0x5A02


def pick_session() -> str | None:
    """目标会话：正在执行的优先，否则最近一个。"""
    try:
        with urllib.request.urlopen(dsh_base() + "/xj/state", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        log(f"截图：读不到 /xj/state（{exc}）")
        return None
    sessions = data.get("sessions") or []
    if not sessions:
        return None
    working = [s for s in sessions if s.get("state") == "working"]
    return str((working or sessions)[0].get("id") or "") or None


def shot_size(png: bytes) -> tuple[int, int]:
    """PNG 头里读宽高（IHDR，偏移 16..24），失败就返回 0。"""
    try:
        if png[:8] == b"\x89PNG\r\n\x1a\n":
            w = int.from_bytes(png[16:20], "big")
            h = int.from_bytes(png[20:24], "big")
            return w, h
    except Exception:  # noqa: BLE001
        pass
    return 0, 0


VISION_CONFIG = CONFIG_DIR / "vision.json"
POLISH_SYSTEM = (
    "你是提问助手。用户对哦鲸鲸（一个常驻桌面的 AI 助手）截了一张图，想向 AI 追问。"
    "把用户的草稿改写成一句中文提问：具体、可执行、不臆测画面内容、不超过 60 字；"
    "如果草稿为空，就根据图片给出一句最有信息量的提问。只输出问题本身，不要解释。"
)


def load_vision_config() -> dict:
    try:
        with open(VISION_CONFIG, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        log(f"优化：读配置失败（{exc}）")
        return {}


def polish_prompt(text: str, png: bytes | None = None) -> tuple[bool, str]:
    """用 OpenAI 兼容的视觉接口改写提问。没配 key 就返回一句人话让 UI 提示。"""
    cfg = load_vision_config()
    base = (cfg.get("baseUrl") or "").rstrip("/")
    key = cfg.get("apiKey") or ""
    model = cfg.get("model") or ""
    if not (base and key and model):
        return False, (
            "还没配视觉模型：写 %APPDATA%\\ojingjing\\vision.json "
            '{"baseUrl":"…/v1","apiKey":"…","model":"…"}，再点优化'
        )
    image_url = ""
    if png:
        image_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    content = [{"type": "text", "text": (text or "（我还没想好问什么，帮我提一个）")}]
    if image_url:
        content.insert(0, {"type": "image_url", "image_url": {"url": image_url}})
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": POLISH_SYSTEM},
            {"role": "user", "content": content},
        ],
        "temperature": 0.3,
        "max_tokens": 200,
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": "Bearer " + key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out = (data["choices"][0]["message"]["content"] or "").strip()
        if not out:
            return False, "模型没给出问法，自己写一句也行"
        log(f"优化：{out[:40]}")
        return True, out
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:160]
        except Exception:  # noqa: BLE001
            pass
        log(f"优化：HTTP {exc.code} {detail}")
        return False, f"优化失败（HTTP {exc.code}）"
    except Exception as exc:  # noqa: BLE001
        log(f"优化失败 {exc}")
        return False, "优化失败，直接发也行"


def post_screenshot(png: bytes, question: str = "") -> tuple[bool, str]:
    """把整屏截图作为 image content part 投进会话（DSH 的 SessionController.prompt）。"""
    session_id = pick_session()
    if not session_id:
        return False, "没有可发送的会话"
    payload = {
        "sessionId": session_id,
        "text": question.strip() or "请查看这张截图。",
        "image": {
            "mediaType": "image/png",
            "data": base64.b64encode(png).decode("ascii"),
            "name": "ojingjing-shot.png",
        },
    }
    req = urllib.request.Request(
        dsh_base() + "/xj/prompt",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            log(f"截图：已发送到 {session_id}（HTTP {resp.status}, {len(png)} bytes）")
            return True, "已发到《" + short_title(session_id) + "》"
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        log(f"截图：发送失败 HTTP {exc.code} {detail}")
        return False, f"发送失败（HTTP {exc.code}）"
    except Exception as exc:  # noqa: BLE001
        log(f"截图：发送失败 {exc}")
        return False, "没发出去，检查 Harness 是否在跑"


def short_title(session_id: str) -> str:
    """把会话 id 换成一个短标题给人看（拿不到就用 id 末四位）。"""
    try:
        with urllib.request.urlopen(dsh_base() + "/xj/state", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for item in data.get("sessions") or []:
            if item.get("id") == session_id:
                return str(item.get("title") or session_id[-4:])
    except Exception:  # noqa: BLE001
        pass
    return session_id[-4:]


# ------------------------------------------------------------------ 外壳


def main() -> None:
    from PySide6.QtCore import (QBuffer, QFile, QIODevice, QPoint, QRect, Qt, QTimer, Signal, QObject, Slot)
    from PySide6.QtGui import QAction, QColor, QFont, QIcon, QKeySequence, QPainter, QPen, QPixmap
    from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
                                   QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QKeySequenceEdit,
                                   QLabel, QLineEdit, QMenu, QMessageBox, QPushButton, QSlider, QSpinBox,
                                   QSystemTrayIcon, QVBoxLayout, QWidget)
    from PySide6.QtWebChannel import QWebChannel
    from PySide6.QtWebEngineCore import QWebEngineScript
    from PySide6.QtWebEngineWidgets import QWebEngineView

    log("=== start (qt) ===")
    log("launched by " + os.environ.get("XJ_LAUNCHED_BY", "user"))
    log(f"config dir: {CONFIG_DIR}")

    if not acquire_single_instance():
        log("已有实例在跑，这次退出（避免两个实例抢热键）")
        return

    write_pid()

    # ---------------------------------------------------------- 桥
    class Bridge(QObject):
        """页面的 window.xjNative（QWebChannel 注册名 host）"""

        toggleRequested = Signal()
        captureRequested = Signal()
        shotOk = Signal(str)
        shotErr = Signal(str)
        polishOk = Signal(str)
        polishErr = Signal(str)

        def __init__(self, overlay: "Overlay") -> None:
            super().__init__()
            self.overlay = overlay
            # 页面每次布局完都会上报尺寸，悬停进出时会在两三个尺寸之间抖动。
            # 先把上报攒 40ms 只取最后一个，避免一串 resize 把窗口来回改大改小（这是拖动卡顿的一大来源）。
            self._pending_size = None
            self._size_timer = QTimer(self)
            self._size_timer.setSingleShot(True)
            self._size_timer.setInterval(40)
            self._size_timer.timeout.connect(self._flush_size)

        def _flush_size(self) -> None:
            size, self._pending_size = self._pending_size, None
            if size:
                self.overlay.apply_size(size[0], size[1])

        @Slot(int, int)
        def resize(self, w: int, h: int) -> None:
            self._pending_size = (int(w), int(h))
            self._size_timer.start()

        @Slot()
        def drag(self) -> None:
            self.overlay.start_drag()

        @Slot()
        def open_dsh(self) -> None:
            try:
                # DSH 已在运行：直接把它的窗口拉到前台。
                # （os.startfile 对已运行的 Electron 单实例应用只会再拉一个进程、
                #   被单实例锁静默挡掉，表现就是「点了没反应」。）
                wins = _dsh_windows()
                if wins:
                    for hwnd in wins:
                        log(f"open-dsh: hwnd={hwnd} {_to_front(hwnd)}")
                    return
                exe = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "DSH Desktop" / "DSH Desktop.exe"
                if exe.exists():
                    os.startfile(str(exe))  # noqa: S606
                    log("open-dsh: 没找到窗口，DSH 未运行 → 已启动")
                else:
                    log("open-dsh: 没找到窗口，也没找到 DSH 可执行文件")
            except Exception as exc:  # noqa: BLE001
                log(f"打开 Harness 失败：{exc}")

        @Slot()
        def quit(self) -> None:
            self.overlay.request_exit()

        @Slot()
        def capture(self) -> None:
            self.overlay.capture()

        # ---- 渲染方式（面板「设置 → 渲染」用；没有返回值，改成推给页面）----
        def push_shell_info(self) -> None:
            """把外壳的渲染状态推给页面，页面缓存在 window.__XJ_SHELL__ 里再渲染。"""
            payload = {
                "render": str(settings().get("render") or "auto"),
                "active": "hw" if HW_GL else "sw",
                "pref": RENDER_PREF,
            }
            try:
                self.overlay.view.page().runJavaScript(
                    "window.__XJ_SHELL__ = " + json.dumps(payload, ensure_ascii=False)
                )
            except Exception as exc:  # noqa: BLE001
                log(f"推渲染状态失败：{exc}")

        @Slot(str)
        def setRender(self, mode: str) -> None:  # noqa: N802
            mode = (mode or "").strip().lower()
            if mode not in _RENDER_PREFS:
                log(f"渲染方式忽略非法值：{mode!r}")
                return
            save_settings({"render": mode})
            log(f"渲染方式 -> {mode}（重启哦鲸鲸后生效）")
            self.push_shell_info()

        @Slot()
        def restartShell(self) -> None:  # noqa: N802
            _RESTART["pending"] = True
            _RESTART["force_sw"] = None
            log("面板：重新启动")
            self.overlay.request_exit()

        @Slot(str)
        def log(self, text: str) -> None:
            log("js: " + text)

        # ---- 截图提问卡（页面里那张卡片的按钮）----
        @Slot(str)
        def sendShot(self, payload: str) -> None:  # noqa: N802
            try:
                data = json.loads(payload or "{}")
            except Exception:  # noqa: BLE001
                data = {}
            text = (data.get("text") or "").strip()
            png = self.overlay.last_shot
            if not png:
                self.shotErr.emit("截图丢了，重新截一张吧")
                return
            threading.Thread(
                target=self.overlay.post_shot, args=(png, text), daemon=True
            ).start()

        @Slot()
        def retakeShot(self) -> None:  # noqa: N802
            QTimer.singleShot(80, self.overlay.capture)

        @Slot(str)
        def polishShot(self, payload: str) -> None:  # noqa: N802
            try:
                data = json.loads(payload or "{}")
            except Exception:  # noqa: BLE001
                data = {}
            threading.Thread(
                target=self.overlay.polish, args=((data.get("text") or "").strip(),), daemon=True
            ).start()

    # ---------------------------------------------------------- 截图选区
    class CaptureOverlay(QWidget):
        """整块屏幕的快照 + 选区遮罩。

        默认选中「整屏」（用户要的默认全屏），拖拽可以改小；Enter 发送、Esc 取消。
        像素只在内存里过一手，不落盘（对齐设计稿 §9.2 隐私条款）。
        """

        def __init__(self, canvas, origin, default_sel, dpr, on_done) -> None:
            super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
            self.setAttribute(Qt.WA_TranslucentBackground, True)
            self.setAttribute(Qt.WA_DeleteOnClose, True)
            self.canvas = canvas
            self.origin = origin
            self.dpr = dpr
            self.on_done = on_done
            self.sel = QRect(default_sel)
            self._anchor = None
            self.setCursor(Qt.CrossCursor)
            self.setFocusPolicy(Qt.StrongFocus)
            self.setGeometry(origin.x(), origin.y(),
                             int(canvas.width() / dpr), int(canvas.height() / dpr))
            self.setWindowTitle("哦鲸鲸 · 截图")

        # ---- 画 ----
        def paintEvent(self, event):  # noqa: N802
            p = QPainter(self)
            p.setRenderHint(QPainter.Antialiasing, False)
            p.drawPixmap(0, 0, self.canvas)

            shade = QColor(6, 10, 20, 148)
            full = self.rect()
            sel = self.sel.intersected(full)
            p.fillRect(QRect(full.left(), full.top(), full.width(), sel.top() - full.top()), shade)
            p.fillRect(QRect(full.left(), sel.bottom() + 1, full.width(), full.bottom() - sel.bottom()), shade)
            p.fillRect(QRect(full.left(), sel.top(), sel.left() - full.left(), sel.height()), shade)
            p.fillRect(QRect(sel.right() + 1, sel.top(), full.right() - sel.right(), sel.height()), shade)

            p.setPen(QPen(QColor(124, 194, 255), 2))
            p.drawRect(sel.adjusted(0, 0, -1, -1))

            text = f"{int(sel.width() * self.dpr)} × {int(sel.height() * self.dpr)}"
            p.setFont(QFont("Microsoft YaHei UI", 9))
            p.setPen(QColor(255, 255, 255, 235))
            box = QRect(sel.left() + 8, sel.top() + 8, 96, 22)
            p.fillRect(box, QColor(15, 23, 42, 210))
            p.drawText(box, Qt.AlignCenter, text)

            hint = "拖动选择区域 · Enter 发送 · Esc 取消（默认整屏）"
            p.setFont(QFont("Microsoft YaHei UI", 10))
            metrics = p.fontMetrics()
            w = metrics.horizontalAdvance(hint) + 32
            bar = QRect(int((full.width() - w) / 2), 18, w, 34)
            p.fillRect(bar, QColor(15, 23, 42, 225))
            p.setPen(QColor(124, 194, 255))
            p.drawRect(bar.adjusted(0, 0, -1, -1))
            p.setPen(QColor(255, 255, 255, 238))
            p.drawText(bar, Qt.AlignCenter, hint)
            p.end()

        # ---- 鼠标 ----
        def mousePressEvent(self, event):  # noqa: N802
            if event.button() == Qt.LeftButton:
                self._anchor = event.position().toPoint()
                self._prev_sel = QRect(self.sel)
                self.sel = QRect(self._anchor, self._anchor)
                self.update()

        def mouseMoveEvent(self, event):  # noqa: N802
            if self._anchor is not None:
                self.sel = QRect(self._anchor, event.position().toPoint()).normalized()
                self.update()

        def mouseReleaseEvent(self, event):  # noqa: N802
            if event.button() == Qt.LeftButton:
                self._anchor = None
                self.sel = self.sel.normalized().intersected(self.rect())
                # 单击/误触不该把「默认整屏」缩成一个点：退化就还原上一次选区
                if self.sel.width() < 24 or self.sel.height() < 24:
                    self.sel = QRect(getattr(self, "_prev_sel", QRect(self.rect())))
                self.update()

        def mouseDoubleClickEvent(self, event):  # noqa: N802
            self.accept_shot()

        # ---- 键盘 ----
        def keyPressEvent(self, event):  # noqa: N802
            key = event.key()
            if key == Qt.Key_Escape:
                self._finish(None)
            elif key in (Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space):
                self.accept_shot()
            else:
                super().keyPressEvent(event)

        def accept_shot(self) -> None:
            sel = self.sel.intersected(self.rect())
            if sel.width() < 12 or sel.height() < 12:
                # 选区退化（比如鼠标抖了一下）时，按「默认整屏」走，不给一张莫名其妙的小图
                sel = QRect(self.rect())
            image = self.canvas.toImage()
            dev = QRect(
                int(sel.x() * self.dpr), int(sel.y() * self.dpr),
                int(sel.width() * self.dpr), int(sel.height() * self.dpr),
            )
            buffer = QBuffer()
            buffer.open(QIODevice.WriteOnly)
            image.copy(dev).save(buffer, "PNG")
            self._finish(bytes(buffer.data()))

        def _finish(self, png) -> None:
            self.close()
            try:
                self.on_done(png)
            except Exception:  # noqa: BLE001
                log("截图：收尾失败 " + traceback.format_exc())

    # ---------------------------------------------------------- 窗口
    class Overlay(QWidget):
        def __init__(self) -> None:
            flags = Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool
            super().__init__(None, flags)
            self.setAttribute(Qt.WA_TranslucentBackground, True)
            self.setAttribute(Qt.WA_NoSystemBackground, True)
            self.setWindowTitle(TITLE)

            self._exiting = False
            self.last_shot = None
            self._last_saved = (None, None)
            self._save_timer = QTimer(self)
            self._save_timer.setSingleShot(True)
            self._save_timer.setInterval(600)
            self._save_timer.timeout.connect(self._persist_pos)

            self.view = QWebEngineView(self)
            self.view.setContextMenuPolicy(Qt.NoContextMenu)
            self.view.page().setBackgroundColor(QColor(0, 0, 0, 0))
            self.view.setStyleSheet("background: transparent;")

            box = QVBoxLayout(self)
            box.setContentsMargins(0, 0, 0, 0)
            box.addWidget(self.view)

            self.bridge = Bridge(self)
            self.channel = QWebChannel(self.view.page())
            self.channel.registerObject("host", self.bridge)
            self.view.page().setWebChannel(self.channel)

            # QWebChannel 的客户端脚本 + 挂到 window.xjNative
            qwc = QFile(":/qtwebchannel/qwebchannel.js")
            qwc.open(QIODevice.ReadOnly)
            qwc_src = bytes(qwc.readAll()).decode("utf-8")
            qwc.close()
            boot = (
                qwc_src
                + "\nnew QWebChannel(qt.webChannelTransport, function (ch) {"
                + "  window.xjNative = ch.objects.host;"
                + "  window.dispatchEvent(new Event('xj-native-ready'));"
                + "});\n"
                # 页面要知道自己在哪种渲染路径上：embed.js 据此给 <html> 加 xj-sw，
                # styles.css 在软件光栅下关掉 backdrop 模糊和装饰性循环动画。
                + "window.__XJ_RENDER__ = '" + ("hw" if HW_GL else "sw") + "';\n"
            )
            script = QWebEngineScript()
            script.setName("xj-channel")
            script.setInjectionPoint(QWebEngineScript.DocumentCreation)
            script.setWorldId(QWebEngineScript.MainWorld)
            script.setRunsOnSubFrames(False)
            script.setSourceCode(boot)
            self.view.page().scripts().insert(script)

            self.resize(108, 108)
            self.place_initial()
            self.view.load(app_url())
            self.view.loadFinished.connect(self._on_load_finished)
            self.view.page().renderProcessTerminated.connect(self._on_render_crash)

        # ---- 几何 ----
        def _screen_rect(self):
            scr = self.screen() or QApplication.primaryScreen()
            return scr.availableGeometry()

        def place_initial(self) -> None:
            g = self._screen_rect()
            x, y = load_pos()
            if x is None or y is None:
                x = g.right() + 1 - self.width() - 12
                y = g.bottom() + 1 - self.height() - 48
            self.move(self._clamp_x(x), self._clamp_y(y))
            log(f"initial {self.width()}x{self.height()} @ {x},{y} workarea={g}")

        def _clamp_x(self, x: int) -> int:
            g = self._screen_rect()
            return max(g.left(), min(x, g.right() + 1 - self.width()))

        def _clamp_y(self, y: int) -> int:
            g = self._screen_rect()
            return max(g.top(), min(y, g.bottom() + 1 - self.height()))

        def _on_load_finished(self, ok: bool) -> None:
            log(f"loadFinished ok={ok}")
            if ok:
                self.apply_appearance()
                self.bridge.push_shell_info()
                return
            # 硬件渲染起不来（RDP / 无显卡 / 驱动不给面子）：切软件模式重开，别留个白窗
            if HW_GL:
                mark_gpu_failure("loadFinished ok=False")
                QApplication.quit()

        def _on_render_crash(self, status, code: int) -> None:
            log(f"renderProcessTerminated status={status} code={code}")
            if HW_GL:
                mark_gpu_failure(f"renderer {status}/{code}")
                QApplication.quit()

        def apply_appearance(self) -> None:
            """把设置里的头像 / 背景推给页面（页面侧 XJ.app.applyAppearance 落地）。"""
            try:
                self.view.page().runJavaScript(appearance_js())
                cfg = settings().get("appearance") or {}
                log(
                    "appearance applied: avatar=%s background=%s dim=%s"
                    % (
                        os.path.basename(str(cfg.get("avatar") or "")) or "-",
                        os.path.basename(str(cfg.get("background") or "")) or "-",
                        cfg.get("dim"),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                log(f"外观应用失败：{exc}")

        def apply_size(self, w: int, h: int) -> None:
            """右下角锚定：变大向左上长，位置不动。"""
            w = max(MIN_W, min(MAX_W, w))
            h = max(MIN_H, min(MAX_H, h))
            if (w, h) == (self.width(), self.height()):
                return
            geo = self.geometry()
            right, bottom = geo.x() + geo.width(), geo.y() + geo.height()
            self.resize(w, h)
            self.move(self._clamp_x(right - w), self._clamp_y(bottom - h))
            log(f"resize {w}x{h} @ {self.x()},{self.y()}")

        def moveEvent(self, event):  # noqa: N802
            super().moveEvent(event)
            self._save_timer.start()

        def _persist_pos(self) -> None:
            pos = (self.x(), self.y())
            if pos != self._last_saved:
                self._last_saved = pos
                save_pos(*pos)

        # ---- 拖动 ----
        def start_drag(self) -> None:
            hwnd = int(self.winId())
            user32.ReleaseCapture()
            user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)

        def toggle(self) -> None:
            if self.isVisible():
                self.hide()
            else:
                self.show()
                self.raise_()
                self.activateWindow()

        # ---- 截图提问（默认整屏，可拖选小区域）----
        def capture(self) -> None:
            if getattr(self, "_capturing", False):
                return
            self._capturing = True
            self._was_visible = self.isVisible()
            # 先把自己藏起来，否则会拍进截图里（对应设计稿的 WDA_EXCLUDEFROMCAPTURE）
            self.hide()
            QTimer.singleShot(240, self._grab_and_show)

        def _grab_and_show(self) -> None:
            try:
                screens = QApplication.screens()
                if not screens:
                    raise RuntimeError("没有可用屏幕")
                rects = [s.geometry() for s in screens]
                vx = min(r.x() for r in rects)
                vy = min(r.y() for r in rects)
                vw = max(r.x() + r.width() for r in rects) - vx
                vh = max(r.y() + r.height() for r in rects) - vy
                dpr = screens[0].devicePixelRatio() or 1.0

                canvas = QPixmap(int(vw * dpr), int(vh * dpr))
                canvas.setDevicePixelRatio(dpr)
                canvas.fill(QColor(0, 0, 0))
                painter = QPainter(canvas)
                for screen, r in zip(screens, rects):
                    shot = screen.grabWindow(0)
                    painter.drawPixmap(
                        int((r.x() - vx) * dpr), int((r.y() - vy) * dpr),
                        int(r.width() * dpr), int(r.height() * dpr),
                        shot, 0, 0, shot.width(), shot.height(),
                    )
                painter.end()

                primary = QApplication.primaryScreen().geometry()
                if settings().get("capture_mode") == "region":
                    # 框选模式：先给一个居中的 60% 框，省得每次都从零拖
                    width = int(primary.width() * 0.6)
                    height = int(primary.height() * 0.6)
                    default_sel = QRect(
                        primary.x() - vx + (primary.width() - width) // 2,
                        primary.y() - vy + (primary.height() - height) // 2,
                        width,
                        height,
                    )
                else:
                    default_sel = QRect(primary.x() - vx, primary.y() - vy,
                                        primary.width(), primary.height())
                self._capture_window = CaptureOverlay(
                    canvas, QPoint(vx, vy), default_sel, dpr, self._on_capture_done
                )
                self._capture_window.show()
                self._capture_window.raise_()
                self._capture_window.activateWindow()
                self._capture_window.setFocus()
                log(f"screenshot armed ({vw}x{vh} @ {vx},{vy})")
                if os.environ.get("XJ_CAPTURE_SELFTEST"):
                    # 自动化自测：不等按键，1.5s 后自己按「默认整屏」确认
                    QTimer.singleShot(1500, self._capture_window.accept_shot)
            except Exception:  # noqa: BLE001
                self._capturing = False
                log("截图失败 " + traceback.format_exc())
                if self._was_visible:
                    self.show()

        def _on_capture_done(self, png) -> None:
            self._capturing = False
            self._capture_window = None
            if self._was_visible:
                self.show()
                self.raise_()
            if not png:
                log("screenshot cancelled")
                return
            log(f"screenshot confirmed ({len(png)} bytes)")
            self.last_shot = png
            self.show_shot_card(png)

        def show_shot_card(self, png: bytes) -> None:
            """把截图推进页面里的「截图提问」卡（预览 → 可改可优化 → 发送）。"""
            try:
                import base64 as _b64
                session_id = pick_session()
                title = ""
                if session_id:
                    try:
                        with urllib.request.urlopen(dsh_base() + "/xj/state", timeout=4) as resp:
                            data = json.loads(resp.read().decode("utf-8"))
                        for item in data.get("sessions") or []:
                            if item.get("id") == session_id:
                                title = item.get("title") or ""
                                break
                    except Exception:  # noqa: BLE001
                        pass
                width, height = shot_size(png)
                payload = {
                    "dataUrl": "data:image/png;base64," + _b64.b64encode(png).decode("ascii"),
                    "width": width,
                    "height": height,
                    "sessionTitle": title,
                }
                meta = {"width": width, "height": height, "sessionTitle": title}
                js = (
                    "window.XJShot && XJShot.open("
                    + json.dumps(payload["dataUrl"])
                    + ","
                    + json.dumps(meta)
                    + ")"
                )
                self.view.page().runJavaScript(js)
                log("shot card shown")
            except Exception:  # noqa: BLE001
                log("卡片打开失败 " + traceback.format_exc())

        def post_shot(self, png: bytes, text: str) -> None:
            """卡片点「发送」后走这里：POST /xj/prompt，结果回推页面。"""
            ok, message = post_screenshot(png, text)
            if ok:
                self.bridge.shotOk.emit(message)
            else:
                self.bridge.shotErr.emit(message)

        def polish(self, text: str) -> None:
            ok, message = polish_prompt(text, self.last_shot)
            if ok:
                self.bridge.polishOk.emit(message)
            else:
                self.bridge.polishErr.emit(message)

        def _mark_toolwindow(self) -> None:
            try:
                hwnd = int(self.winId())
                ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW)
            except Exception:
                pass

        def showEvent(self, event):  # noqa: N802
            super().showEvent(event)
            self._mark_toolwindow()

        def request_exit(self) -> None:
            if self._exiting:
                return
            self._exiting = True
            self._persist_pos()
            clear_pid()
            log("=== exit ===")
            QApplication.quit()

    # ---------------------------------------------------------- 设置窗
    class SettingsDialog(QDialog):
        r"""托盘「设置…」。值写进 %APPDATA%\ojingjing\settings.json，下次启动继续用。"""

        def __init__(self) -> None:
            super().__init__()
            cfg = settings()
            self.setWindowTitle("哦鲸鲸 · 设置")
            self.setWindowFlag(Qt.WindowStaysOnTopHint, True)
            self.setMinimumWidth(440)

            form = QFormLayout()
            self.port = QSpinBox()
            self.port.setRange(1024, 65535)
            self.port.setValue(int(cfg.get("port") or 43120))
            form.addRow("DSH 端口", self.port)

            self.mode = QComboBox()
            self.mode.addItem("整屏（拍主屏，回车就发）", "screen")
            self.mode.addItem("框选（先给 60% 起始框，自己拖）", "region")
            index = self.mode.findData(str(cfg.get("capture_mode") or "screen"))
            self.mode.setCurrentIndex(index if index >= 0 else 0)
            form.addRow("截图默认", self.mode)

            self.hot_toggle = QKeySequenceEdit(QKeySequence(str(cfg.get("hotkey_toggle") or "")))
            form.addRow("显隐热键", self.hot_toggle)
            self.hot_capture = QKeySequenceEdit(QKeySequence(str(cfg.get("hotkey_capture") or "")))
            form.addRow("截图热键", self.hot_capture)

            # ---- 渲染方式：决定是「看得见」还是「更顺」
            self.render = QComboBox()
            self.render.addItem("软件（默认，最稳，CPU 光栅）", "sw")
            self.render.addItem("硬件（GPU 合成，滚动更顺）", "hw")
            render_pref = str(cfg.get("render") or "sw")
            render_index = self.render.findData("hw" if render_pref == "hw" else "sw")
            self.render.setCurrentIndex(render_index if render_index >= 0 else 0)
            form.addRow("渲染方式", self.render)
            render_hint = QLabel(
                "当前进程：" + ("硬件" if HW_GL else "软件")
                + "。改完要重启哦鲸鲸才生效，保存时会问你要不要现在重启。"
            )
            render_hint.setStyleSheet("color:rgba(255,255,255,0.45);")
            render_hint.setWordWrap(True)
            form.addRow("", render_hint)

            self.autostart = QCheckBox("开机自动启动（写 HKCU\\...\\Run）")
            self.autostart.setChecked(is_autostart())
            form.addRow("", self.autostart)
            self.exit_dsh = QCheckBox("DSH 关掉后自动退出（约 1 分钟）")
            self.exit_dsh.setChecked(bool(cfg.get("exit_with_dsh")))
            form.addRow("", self.exit_dsh)

            # ---- 外观：自定义头像 / 背景
            appearance = cfg.get("appearance") or {}
            self.avatar_path = str(appearance.get("avatar") or "")
            self.bg_path = str(appearance.get("background") or "")

            look = QGroupBox("外观（头像 / 背景，只在本机用，不上传）")
            look_form = QFormLayout(look)

            self.avatar_label = QLabel(os.path.basename(self.avatar_path) or "内置角色头像")
            self.avatar_label.setStyleSheet("color:rgba(255,255,255,0.6);")
            avatar_row = QHBoxLayout()
            avatar_row.addWidget(self.avatar_label, 1)
            btn_avatar = QPushButton("选择…")
            btn_avatar_bad = QPushButton("清除")
            avatar_row.addWidget(btn_avatar)
            avatar_row.addWidget(btn_avatar_bad)
            look_form.addRow("头像", avatar_row)

            self.bg_label = QLabel(os.path.basename(self.bg_path) or "无（玻璃底）")
            self.bg_label.setStyleSheet("color:rgba(255,255,255,0.6);")
            bg_row = QHBoxLayout()
            bg_row.addWidget(self.bg_label, 1)
            btn_bg = QPushButton("选择…")
            btn_bg_bad = QPushButton("清除")
            bg_row.addWidget(btn_bg)
            bg_row.addWidget(btn_bg_bad)
            look_form.addRow("背景", bg_row)

            try:
                dim_value = int(round(float(appearance.get("dim", 0.6)) * 100))
            except Exception:  # noqa: BLE001
                dim_value = 45
            self.dim = QSlider(Qt.Horizontal)
            self.dim.setRange(0, 90)
            self.dim.setValue(max(0, min(90, dim_value)))
            self.dim_label = QLabel(f"{self.dim.value()}%")
            self.dim_label.setMinimumWidth(40)
            dim_row = QHBoxLayout()
            dim_row.addWidget(self.dim, 1)
            dim_row.addWidget(self.dim_label)
            look_form.addRow("背景压暗", dim_row)
            self.dim.valueChanged.connect(lambda value: self.dim_label.setText(f"{value}%"))

            def pick_avatar() -> None:
                file_name, _ = QFileDialog.getOpenFileName(
                    self, "选一张头像", str(Path(self.avatar_path).parent if self.avatar_path else ""),
                    "图片 (*.png *.jpg *.jpeg *.webp *.gif *.bmp)")
                if file_name:
                    self.avatar_path = file_name
                    self.avatar_label.setText(os.path.basename(file_name))

            def pick_bg() -> None:
                file_name, _ = QFileDialog.getOpenFileName(
                    self, "选一张背景", str(Path(self.bg_path).parent if self.bg_path else ""),
                    "图片 (*.png *.jpg *.jpeg *.webp *.gif *.bmp)")
                if file_name:
                    self.bg_path = file_name
                    self.bg_label.setText(os.path.basename(file_name))

            btn_avatar.clicked.connect(pick_avatar)
            btn_bg.clicked.connect(pick_bg)

            def clear_avatar() -> None:
                self.avatar_path = ""
                self.avatar_label.setText("内置角色头像")

            def clear_bg() -> None:
                self.bg_path = ""
                self.bg_label.setText("无（玻璃底）")

            btn_avatar_bad.clicked.connect(clear_avatar)
            btn_bg_bad.clicked.connect(clear_bg)

            vision = cfg.get("vision") or {}
            self.vision_base = QLineEdit(str(vision.get("base_url") or ""))
            self.vision_base.setPlaceholderText("https://api.openai.com/v1")
            self.vision_key = QLineEdit(str(vision.get("api_key") or ""))
            self.vision_key.setEchoMode(QLineEdit.Password)
            self.vision_model = QLineEdit(str(vision.get("model") or ""))
            self.vision_model.setPlaceholderText("gpt-4o-mini")
            box = QGroupBox("视觉模型（只给「✨ 优化」用，留空就关掉）")
            box_form = QFormLayout(box)
            box_form.addRow("Base URL", self.vision_base)
            box_form.addRow("API Key", self.vision_key)
            box_form.addRow("模型", self.vision_model)

            hint = QLabel("热键改完立即生效；端口改了会重新加载页面；渲染方式要重启哦鲸鲸。")
            hint.setStyleSheet("color: rgba(255,255,255,0.55);")

            buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
            buttons.button(QDialogButtonBox.Save).setText("保存")
            buttons.button(QDialogButtonBox.Cancel).setText("取消")
            buttons.accepted.connect(self.accept)
            buttons.rejected.connect(self.reject)
            restore = buttons.addButton("恢复默认", QDialogButtonBox.ResetRole)

            def reset() -> None:
                self.port.setValue(43120)
                self.mode.setCurrentIndex(0)
                self.hot_toggle.setKeySequence(QKeySequence("Ctrl+Shift+Space"))
                self.hot_capture.setKeySequence(QKeySequence("Ctrl+Shift+A"))
                self.autostart.setChecked(False)
                self.exit_dsh.setChecked(False)
                self.render.setCurrentIndex(0)
                self.avatar_path = ""
                self.avatar_label.setText("内置角色头像")
                self.bg_path = ""
                self.bg_label.setText("无（玻璃底）")
                self.dim.setValue(45)
                self.vision_base.clear()
                self.vision_key.clear()
                self.vision_model.clear()

            restore.clicked.connect(reset)

            layout = QVBoxLayout(self)
            layout.addLayout(form)
            layout.addWidget(look)
            layout.addWidget(box)
            layout.addWidget(hint)
            layout.addWidget(buttons)

            self.setStyleSheet(
                "QDialog{background:#1F2A44;}"
                "QLabel{color:#FFFFFF;}"
                "QLineEdit,QSpinBox,QComboBox,QKeySequenceEdit{"
                "background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);"
                "border-radius:6px;padding:4px 6px;color:#FFFFFF;}"
                "QGroupBox{border:1px solid rgba(255,255,255,0.12);border-radius:8px;"
                "margin-top:10px;padding:8px;color:#FFFFFF;}"
                "QPushButton{background:rgba(255,255,255,0.1);border:none;border-radius:6px;"
                "padding:6px 14px;color:#FFFFFF;}"
                "QPushButton:hover{background:rgba(124,194,255,0.28);}"
            )

        def values(self) -> dict:
            return {
                "port": int(self.port.value()),
                "capture_mode": self.mode.currentData(),
                "hotkey_toggle": self.hot_toggle.keySequence().toString(),
                "hotkey_capture": self.hot_capture.keySequence().toString(),
                "autostart": bool(self.autostart.isChecked()),
                "exit_with_dsh": bool(self.exit_dsh.isChecked()),
                "render": self.render.currentData(),
                "vision": {
                    "base_url": self.vision_base.text().strip(),
                    "api_key": self.vision_key.text().strip(),
                    "model": self.vision_model.text().strip(),
                },
                "appearance": {
                    "avatar": self.avatar_path,
                    "background": self.bg_path,
                    "dim": round(self.dim.value() / 100, 2),
                },
            }

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    overlay = Overlay()

    # 自测钩子：XJ_TEST_OPEN_DSH=<延时ms> 时，启动后自动触发一次「打开 Harness」，
    # 用于不点界面也能验证 open_dsh 链路（诊断结果写在日志里）。不设该变量则不生效。
    _test_open = os.environ.get("XJ_TEST_OPEN_DSH")
    if _test_open:
        try:
            _test_delay = int(_test_open)
        except ValueError:
            _test_delay = 3000
        QTimer.singleShot(_test_delay, overlay.bridge.open_dsh)
        log(f"test hook: open_dsh 将在 {_test_delay}ms 后自动触发")

    def icon() -> QIcon:
        custom = custom_icon_path()
        if custom is not None and Path(custom).is_file():
            return QIcon(str(custom))
        for path in ICON_CANDIDATES:
            if path.exists():
                return QIcon(str(path))
        return QIcon()

    tray = QSystemTrayIcon(icon(), app)
    tray.setToolTip("哦鲸鲸 · DSH 悬浮窗")
    menu = QMenu()
    act_toggle = QAction("显示 / 隐藏哦鲸鲸", menu)
    act_toggle.triggered.connect(overlay.toggle)
    act_shot = QAction(f"截图提问（{settings().get('hotkey_capture')}）", menu)
    act_shot.triggered.connect(overlay.capture)
    act_dsh = QAction("打开 Harness", menu)
    act_dsh.triggered.connect(overlay.bridge.open_dsh)

    def open_settings() -> None:
        before = dict(settings())
        dialog = SettingsDialog()
        if dialog.exec() != QDialog.Accepted:
            return
        new_cfg = dialog.values()
        save_settings(new_cfg)
        set_autostart(bool(new_cfg.get("autostart")))
        reload_hotkeys()
        act_shot.setText(f"截图提问（{new_cfg.get('hotkey_capture')}）")
        overlay.apply_appearance()
        try:
            tray.setIcon(icon())
        except Exception as exc:  # noqa: BLE001
            log(f"刷新托盘图标失败：{exc}")
        if str(before.get("port")) != str(new_cfg.get("port")):
            log("port changed -> reload page")
            overlay.view.load(app_url())
        if str(before.get("render") or "auto") != str(new_cfg.get("render") or "auto"):
            label = {"auto": "自动", "hw": "硬件", "sw": "软件"}.get(str(new_cfg.get("render")), "自动")
            ask = QMessageBox()
            ask.setWindowTitle("渲染方式已改")
            ask.setIcon(QMessageBox.Question)
            ask.setText(f"渲染方式已改为「{label}」，要重启哦鲸鲸才生效。")
            ask.setInformativeText("现在重启会先关掉当前窗口，再按新方式拉起（约两秒）。")
            ask.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
            ask.button(QMessageBox.Yes).setText("现在重启")
            ask.button(QMessageBox.No).setText("稍后（下次启动生效）")
            if ask.exec() == QMessageBox.Yes:
                _RESTART["pending"] = True
                _RESTART["force_sw"] = None
                log(f"render 改为 {new_cfg.get('render')} -> 重启")
                overlay.request_exit()

    act_settings = QAction("设置…", menu)
    act_settings.triggered.connect(open_settings)

    act_reset = QAction("重置位置", menu)
    act_reset.triggered.connect(lambda: (POS_PATH.unlink(missing_ok=True), overlay.place_initial()))

    def restart_now() -> None:
        _RESTART["pending"] = True
        _RESTART["force_sw"] = None
        log("托盘：重新启动")
        overlay.request_exit()

    act_restart = QAction("重新启动", menu)
    act_restart.triggered.connect(restart_now)
    act_quit = QAction("退出哦鲸鲸", menu)
    act_quit.triggered.connect(overlay.request_exit)
    for act in (act_toggle, act_shot, act_dsh, act_settings):
        menu.addAction(act)
    menu.addSeparator()
    menu.addAction(act_reset)
    menu.addAction(act_restart)
    menu.addAction(act_quit)
    tray.setContextMenu(menu)
    tray.activated.connect(lambda reason: overlay.toggle() if reason == QSystemTrayIcon.Trigger else None)
    tray.show()

    # DSH 心跳看门狗：连不上约 1 分钟、且用户勾了「DSH 关掉后自动退出」就自己退出
    dsh_misses = {"n": 0}

    def watch_dsh() -> None:
        try:
            with urllib.request.urlopen(dsh_base() + "/xj/state", timeout=2) as resp:
                resp.read(1)
            dsh_misses["n"] = 0
        except Exception:  # noqa: BLE001
            dsh_misses["n"] += 1
            if dsh_misses["n"] == 4:
                log("DSH 连不上（约 1 分钟）")
            if settings().get("exit_with_dsh") and dsh_misses["n"] >= 4:
                log("按设置退出：DSH 已经不在了")
                overlay.request_exit()

    dsh_watch = QTimer()
    dsh_watch.timeout.connect(watch_dsh)
    dsh_watch.start(15000)

    # ---- 全局热键：默认 Ctrl+Shift+Space 显隐 / Ctrl+Shift+A 截图
    #      单独线程收消息；主线程改完设置用 PostThreadMessage(HOTKEY_RELOAD) 叫它重注册
    def register_hotkeys() -> tuple[bool, bool]:
        user32.UnregisterHotKey(None, HOTKEY_TOGGLE)
        user32.UnregisterHotKey(None, HOTKEY_CAPTURE)
        cfg = settings()
        toggle = parse_hotkey(str(cfg.get("hotkey_toggle") or "")) or (MOD_CONTROL | MOD_SHIFT, VK_SPACE)
        capture = parse_hotkey(str(cfg.get("hotkey_capture") or "")) or (MOD_CONTROL | MOD_SHIFT, VK_A)
        ok_toggle = bool(user32.RegisterHotKey(None, HOTKEY_TOGGLE, toggle[0], toggle[1]))
        ok_capture = bool(user32.RegisterHotKey(None, HOTKEY_CAPTURE, capture[0], capture[1]))
        if not ok_toggle:
            log(f"warn: {cfg.get('hotkey_toggle')} 注册失败（可能被占用）")
        if not ok_capture:
            log(f"warn: {cfg.get('hotkey_capture')} 注册失败（可能被占用）")
        ready = [
            str(cfg.get("hotkey_toggle")) if ok_toggle else "",
            str(cfg.get("hotkey_capture")) if ok_capture else "",
        ]
        ready = [item for item in ready if item]
        if ready:
            log("hotkey ready: " + " / ".join(ready))
        return ok_toggle, ok_capture

    def reload_hotkeys() -> None:
        if _hotkey_tid:
            user32.PostThreadMessageW(_hotkey_tid, HOTKEY_RELOAD, 0, 0)

    def hotkey_loop() -> None:
        global _hotkey_tid
        _hotkey_tid = kernel32.GetCurrentThreadId()
        register_hotkeys()
        msg = MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == HOTKEY_RELOAD:
                log("hotkey reload")
                register_hotkeys()
                continue
            if msg.message == WM_HOTKEY:
                log("hotkey hit " + ("toggle" if msg.wParam == HOTKEY_TOGGLE else "capture"))
                if msg.wParam == HOTKEY_TOGGLE:
                    overlay.bridge.toggleRequested.emit()
                elif msg.wParam == HOTKEY_CAPTURE:
                    overlay.bridge.captureRequested.emit()

    overlay.bridge.toggleRequested.connect(overlay.toggle)
    overlay.bridge.captureRequested.connect(overlay.capture)

    # 卡片上的「发送 / 优化」结果回到页面（页面负责 loading 与文案）
    def _call(query_builder) -> None:
        try:
            overlay.view.page().runJavaScript(query_builder)
        except Exception:  # noqa: BLE001
            log("回推页面失败")

    overlay.bridge.shotOk.connect(
        lambda msg: _call("window.XJShot && XJShot.done(true, " + json.dumps(msg) + ")")
    )
    overlay.bridge.shotErr.connect(
        lambda msg: _call("window.XJShot && XJShot.done(false, " + json.dumps(msg) + ")")
    )
    overlay.bridge.polishOk.connect(
        lambda msg: _call("window.XJShot && XJShot.polished(" + json.dumps(msg) + ")")
    )
    overlay.bridge.polishErr.connect(
        lambda msg: _call("window.XJShot && XJShot.polishFailed(" + json.dumps(msg) + ")")
    )
    log("hotkey thread started")
    threading.Thread(target=hotkey_loop, daemon=True).start()

    # 调试钩子：XJ_SETTINGS_SHOT=xx.png —— 只渲染设置窗并截一张，给评审看
    shot_target = os.environ.get("XJ_SETTINGS_SHOT")
    if shot_target:
        def snap_settings() -> None:
            dialog = SettingsDialog()
            dialog.show()
            dialog.raise_()

            def save_and_quit() -> None:
                try:
                    dialog.grab().save(shot_target)
                    log(f"settings shot -> {shot_target}")
                except Exception:  # noqa: BLE001
                    log("settings shot failed " + traceback.format_exc())
                QApplication.quit()

            QTimer.singleShot(700, save_and_quit)

        QTimer.singleShot(400, snap_settings)

    overlay.show()
    log(
        f"hwnd={int(overlay.winId())} qt={sys.version.split()[0]} "
        f"render={'hw' if HW_GL else 'sw'} pref={RENDER_PREF}"
    )
    rc = app.exec()
    if _RESTART["pending"]:
        relaunch(_RESTART["force_sw"])
    sys.exit(rc)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("fatal " + traceback.format_exc())
        raise
