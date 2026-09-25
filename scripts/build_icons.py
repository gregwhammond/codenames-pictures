#!/usr/bin/env python3
"""Draw the app icons in web/icons (a tilted 3x3 grid of team-coloured tiles)."""
import pathlib

from PIL import Image, ImageDraw

BG = (29, 33, 48)
COLOURS = {
    "r": (229, 72, 60),
    "b": (47, 128, 228),
    "n": (217, 201, 163),
    "a": (21, 22, 27),
}
PATTERN = "rbnbrarnb"


def draw(size, padding, rounded):
    scale = 4  # draw big, then downsample for smooth edges
    s = size * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22) if rounded else 0, fill=BG)
    inner = s - 2 * padding * scale
    gap = inner * 0.06
    tile = (inner - 2 * gap) / 3
    tiles = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    td = ImageDraw.Draw(tiles)
    for i, key in enumerate(PATTERN):
        x = padding * scale + (i % 3) * (tile + gap)
        y = padding * scale + (i // 3) * (tile + gap)
        outline = (90, 90, 100) if key == "a" else None
        td.rounded_rectangle([x, y, x + tile, y + tile], radius=tile * 0.18, fill=COLOURS[key], outline=outline, width=scale * 2)
    tiles = tiles.rotate(-8, resample=Image.BICUBIC, center=(s / 2, s / 2))
    im.alpha_composite(tiles)
    return im.resize((size, size), Image.LANCZOS)


def main():
    out = pathlib.Path("web/icons")
    out.mkdir(parents=True, exist_ok=True)
    draw(192, 34, True).save(out / "icon-192.png")
    draw(512, 90, True).save(out / "icon-512.png")
    draw(512, 130, False).save(out / "icon-maskable-512.png")
    draw(180, 30, False).convert("RGB").save(out / "apple-touch-icon.png")


if __name__ == "__main__":
    main()
