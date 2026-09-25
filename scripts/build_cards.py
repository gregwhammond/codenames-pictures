#!/usr/bin/env python3
"""Turn source pictures into small square card images for the web client.

Usage:
    python3 scripts/build_cards.py [SOURCE_DIR ...] [--out web/cards] [--size 400]

Every image in the source directories (default: art/source) is flattened onto a
white background, trimmed, made square, resized, and written as a JPEG named
after the source file. The output folder is emptied first so it always mirrors
the sources. Requires Pillow (`python3 -m pip install pillow`).
"""
import argparse
import pathlib

from PIL import Image, ImageChops, ImageFilter, ImageOps

EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def trim_white(im):
    """Remove plain white borders left over from earlier squaring."""
    diff = ImageChops.difference(im, Image.new("RGB", im.size, "white")).convert("L")
    bbox = diff.point(lambda v: 255 if v > 12 else 0).getbbox()
    return im.crop(bbox) if bbox else im


def square(im, size):
    """Crop near-square pictures to fill the card; put very wide or tall ones
    on a blurred copy of themselves so nothing important is cut off."""
    w, h = im.size
    if max(w, h) / min(w, h) <= 1.4:
        return ImageOps.fit(im, (size, size), method=Image.LANCZOS)
    bg = ImageOps.fit(im, (size, size), method=Image.LANCZOS).filter(ImageFilter.GaussianBlur(size / 20))
    bg = Image.blend(bg, Image.new("RGB", bg.size, "white"), 0.35)
    fg = ImageOps.contain(im, (size, size), method=Image.LANCZOS)
    bg.paste(fg, ((size - fg.width) // 2, (size - fg.height) // 2))
    return bg


def build(sources, out, size, quality):
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()

    count = 0
    for source in sources:
        for path in sorted(source.rglob("*")):
            if path.suffix.lower() not in EXTENSIONS:
                continue
            try:
                im = Image.open(path)
                im = ImageOps.exif_transpose(im).convert("RGBA")
            except Exception as err:  # noqa: BLE001 - skip anything unreadable
                print(f"skipping {path}: {err}")
                continue
            bbox = im.getchannel("A").getbbox()  # drop transparent padding
            if bbox:
                im = im.crop(bbox)
            flat = Image.new("RGB", im.size, "white")
            flat.paste(im, mask=im.split()[3])
            flat = square(trim_white(flat), size)
            name = path.stem.replace(" ", "_") + ".jpg"
            flat.save(out / name, "JPEG", quality=quality, optimize=True, progressive=True)
            count += 1
    print(f"wrote {count} cards to {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sources", nargs="*", type=pathlib.Path, default=[pathlib.Path("art/source")])
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("web/cards"))
    parser.add_argument("--size", type=int, default=400)
    parser.add_argument("--quality", type=int, default=78)
    args = parser.parse_args()
    build(args.sources, args.out, args.size, args.quality)


if __name__ == "__main__":
    main()
