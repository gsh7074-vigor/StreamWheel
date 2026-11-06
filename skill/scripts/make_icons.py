#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标：深底圆角方块 + 白色闪电，输出 16/32/48/128 四个尺寸。"""

import os
from PIL import Image, ImageDraw

SS = 8  # 超采样倍数，缩下来做抗锯齿
BG = (29, 29, 31, 255)
FG = (255, 255, 255, 255)

# 闪电多边形，坐标在 0~1 归一化空间
BOLT = [
    (0.575, 0.055),
    (0.215, 0.560),
    (0.455, 0.560),
    (0.385, 0.945),
    (0.795, 0.415),
    (0.545, 0.415),
]


def make(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.235)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    pts = [(x * s, y * s) for x, y in BOLT]
    d.polygon(pts, fill=FG)

    return img.resize((size, size), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.environ.get("SB_ICON_DIR")
    if not out:
        for cand in (os.path.join(here, "..", "extension", "icons"),
                     os.path.join(here, "..", "..", "extension", "icons")):
            c = os.path.normpath(cand)
            if os.path.isdir(os.path.dirname(c)):
                out = c
                break
    out = os.path.normpath(out or os.path.join(here, "..", "extension", "icons"))
    os.makedirs(out, exist_ok=True)

    for size in (16, 32, 48, 128):
        p = os.path.join(out, "icon%d.png" % size)
        make(size).save(p, "PNG", optimize=True)
        print("wrote", p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
