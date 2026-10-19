# -*- mode: python ; coding: utf-8 -*-

import os

# 脚本路径相对 spec 文件定位（SPECPATH 由 PyInstaller 注入）：
# 以前写死过绝对路径，仓库从「新建文件夹」搬走后 spec 就失效了。
SCRIPT = os.path.join(SPECPATH, "standalone-py", "ojingjing_py.py")

a = Analysis(
    [SCRIPT],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 与 Ojingjing.spec 同一份 excludes（浮窗只 import 六个 PySide6 模块）
    excludes=[
        "PySide6.Qt3DAnimation", "PySide6.Qt3DCore", "PySide6.Qt3DExtras", "PySide6.Qt3DInput",
        "PySide6.Qt3DLogic", "PySide6.Qt3DQuick", "PySide6.Qt3DRender",
        "PySide6.QtBluetooth", "PySide6.QtCharts", "PySide6.QtDataVisualization",
        "PySide6.QtDBus", "PySide6.QtDesigner", "PySide6.QtGraphs", "PySide6.QtHttpServer",
        "PySide6.QtLocation", "PySide6.QtMultimedia", "PySide6.QtMultimediaWidgets",
        "PySide6.QtNetworkAuth", "PySide6.QtNfc", "PySide6.QtOpenGL",
        "PySide6.QtPdf", "PySide6.QtPdfWidgets", "PySide6.QtQml", "PySide6.QtQuick",
        "PySide6.QtQuick3D", "PySide6.QtQuickControls2", "PySide6.QtQuickWidgets",
        "PySide6.QtRemoteObjects", "PySide6.QtScxml", "PySide6.QtSensors",
        "PySide6.QtSerialPort", "PySide6.QtSpatialAudio", "PySide6.QtSql",
        "PySide6.QtStateMachine", "PySide6.QtTextToSpeech", "PySide6.QtUiTools",
        "PySide6.QtWebEngineQuick", "PySide6.QtWebSockets", "PySide6.QtWebView",
        "PySide6.QtXml",
        "tkinter", "unittest", "pydoc", "doctest", "lib2to3",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='OjingjingDebug',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,  # bootloader 不能 strip：剥了符号表就找不到内嵌 PKG（PYI-38476）
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=True,
    upx=True,
    upx_exclude=[],
    name='OjingjingDebug',
)
