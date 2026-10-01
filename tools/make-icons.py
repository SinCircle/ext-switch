"""生成插件图标（icons/icon{16,32,48,128}.png）。

用法：
  uv run --with pillow python tools/make-icons.py
  uv run --with pillow python tools/make-icons.py --sheet icons/_sheet.png   # 出对照图，肉眼验

图形：深色圆角方块里放一个白色拨杆开关，杆在右边＝「开」。
为什么不是拼图块：拼图块是「扩展」的通用符号，跟本插件「开关扩展」这件事没关系，
而且四个凸起缩到 16px 会糊。拨杆只有两个形状（胶囊 + 圆点），16px 上仍然一笔看得清。

图标不跟随浏览器主题反色，所以底色自己给（#17171b）——纯白描边的图标在浅色工具栏上
会消失。深色工具栏上底色跟工具栏接近，但白色拨杆本身就够显眼，轮廓读得出来。

为什么要超采样：圆角和圆形直接按目标尺寸画会有锯齿。统一在 SUPERSAMPLE 倍的画布上
画、再用 LANCZOS 缩回去，四档尺寸共用同一套比例参数。
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8

INK = (23, 23, 27, 255)     # #17171b 底板
KNOB = (255, 255, 255, 255)

# 全部取画布的整分数，缩回 16px 时正好落在整数像素边界上，不会缩出半透明灰边。
TILE_RADIUS = 1 / 4
TRACK_W = 33 / 50          # 胶囊宽
TRACK_H = 19 / 50          # 胶囊高
GAP = 1 / 20               # 圆点离胶囊内壁的缝


def draw_icon(size):
    """按目标尺寸画一张，返回 RGBA 图。所有几何都按 size 的比例算。"""
    if size < 8:                      # 极小尺寸不超采样没有意义，但也别越界
        raise ValueError(size)
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=TILE_RADIUS * s, fill=INK)

    track_w, track_h = TRACK_W * s, TRACK_H * s
    x0 = (s - track_w) / 2
    y0 = (s - track_h) / 2
    x1, y1 = x0 + track_w, y0 + track_h
    d.rounded_rectangle([x0, y0, x1, y1], radius=track_h / 2, fill=KNOB)

    gap = GAP * s
    r = (track_h - 2 * gap) / 2
    cx = x1 - gap - r
    cy = y0 + track_h / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=INK)

    return img.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="另出一张对照图（大图 + 各档实物尺寸）给肉眼验")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        draw_icon(size).save(path)
        print(f"{path.relative_to(OUT.parent)}  {size}x{size}")

    if args.sheet:
        pad, big = 16, 128
        w = pad + big + pad + sum(SIZES) + pad * (len(SIZES) + 1)
        h = pad * 2 + big
        sheet = Image.new("RGBA", (w, h), (250, 250, 249, 255))
        sheet.alpha_composite(draw_icon(big), (pad, pad))
        x = pad + big + pad
        for size in SIZES:
            # 竖直居中，方便跟大图比形状是否一致
            sheet.alpha_composite(draw_icon(size), (x, (h - size) // 2))
            x += size + pad
        sheet.save(args.sheet)
        print(f"对照图 {args.sheet}")


if __name__ == "__main__":
    main()
