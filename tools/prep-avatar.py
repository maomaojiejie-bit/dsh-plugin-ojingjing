"""把用户给的角色图处理成哦鲸鲸的头像素材。

输入：ojingjing-widget/assets/icon-source.png（带透明背景的角色图，614 左右）
输出：
  app/src/avatar.webp  320×320，方图、透明背景（WebP q95：比等价 PNG 小 ~78%，
                       320px 缩到界面上的 40–108px 显示，肉眼看不出差别）
  app/src/avatar.js    data URL 版本（页面里直接 new Image / img.src / CSS
                       background-image 都能用，不受 file:// 与 /xj/static
                       路径差异影响；Chromium 全支持 WebP）

只做裁切/缩放/方形对齐，不改画风。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icon-source.png"
OUT_WEBP = ROOT / "app" / "src" / "avatar.webp"
LEGACY_PNG = ROOT / "app" / "src" / "avatar.png"
OUT_JS = ROOT / "app" / "src" / "avatar.js"
SIZE = 320
QUALITY = 95


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"缺少 {SRC}（把角色图放到 assets/icon-source.png）")
    im = Image.open(SRC).convert("RGBA")
    bbox = im.getbbox()
    if not bbox:
        raise SystemExit("图片是全透明的")

    left, top, right, bottom = bbox
    # 头肩像：以脸部为中心取方形 —— 取内容宽度的 0.95，中心略偏上
    side = int(max(right - left, bottom - top) * 0.74)
    cx = (left + right) // 2
    cy = top + int((bottom - top) * 0.56)
    x = max(0, min(im.width - side, cx - side // 2))
    y = max(0, min(im.height - side, cy - side // 2))
    crop = im.crop((x, y, x + side, y + side))

    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    scaled = crop.resize((SIZE, SIZE), Image.LANCZOS)
    out.alpha_composite(scaled)
    out.save(OUT_WEBP, "WEBP", quality=QUALITY, method=6)

    # 旧版本输出的是 PNG，留着只会有两份素材，清掉
    if LEGACY_PNG.exists():
        LEGACY_PNG.unlink()

    import base64

    b64 = base64.b64encode(OUT_WEBP.read_bytes()).decode("ascii")
    OUT_JS.write_text(
        "// 由 tools/prep-avatar.py 生成，别手改\n"
        "window.XJ = window.XJ || {};\n"
        f'XJ.avatarData = "data:image/webp;base64,{b64}";\n',
        encoding="utf-8",
    )
    print(f"crop {crop.size} from {bbox} -> {OUT_WEBP} ({OUT_WEBP.stat().st_size} B)")
    print(f"avatar.js {OUT_JS.stat().st_size} B")


if __name__ == "__main__":
    main()
