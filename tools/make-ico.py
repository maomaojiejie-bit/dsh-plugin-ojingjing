"""把角色图打包成 exe 的多尺寸图标 standalone-cs/icon.ico。

输入：ojingjing-widget/assets/icon-source.png（带透明背景的角色图）
输出：standalone-cs/icon.ico（16/24/32/48/64/256 六档，构建 C# 外壳时
      由 tools/build-shell-cs.mjs 用 csc 的 /win32icon 烧进 Ojingjing.exe，
      Explorer、任务栏、托盘（Icon.ExtractAssociatedIcon）都认它）

为什么单独一个脚本而不是每次构建现打：PIL 只在开发机上有，构建脚本
（csc 那条链）不该依赖 Python；换角色图后手动跑一次本脚本即可。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icon-source.png"
OUT = ROOT / "standalone-cs" / "icon.ico"
SIZES = [16, 24, 32, 48, 64, 256]


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"缺少 {SRC}（把角色图放到 assets/icon-source.png）")
    im = Image.open(SRC).convert("RGBA")
    # 内容裁切：跟头像一样去掉四周空白，图标在Explorer里才显大
    bbox = im.getbbox()
    if not bbox:
        raise SystemExit("图片是全透明的")
    im = im.crop(bbox)
    # 必须先把画布裁成正方形：Pillow 写 ICO 时按 thumbnail 保持宽高比，
    # 非正方形源会产出 16×15 / 32×30 这种信箱化帧（Explorer 里图标留白边）
    if im.width != im.height:
        side = min(im.width, im.height)
        left = (im.width - side) // 2
        top = (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side))
    # Pillow 写 ICO 时会按 sizes 各自重采样，256 档走 PNG 压缩（Vista+ 认）
    im.save(OUT, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"→ {OUT}（{len(SIZES)} 档：{'/'.join(str(s) for s in SIZES)}）")


if __name__ == "__main__":
    main()
