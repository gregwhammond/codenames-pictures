#!/usr/bin/env python3
"""Swap imported originals for bigger copies of the same pictures, keeping the crops.

Usage:
    python3 scripts/upgrade_originals.py --from DIR [--records DIR] [--raw DIR] [--dry-run]

For every crop record art/crops/S*.json, DIR is searched for <id>.<ext> (the
files import_picks.py --fetch saves). The copy is used only when it is larger
than the current original and shows the same picture: the same shape (within
2%) and the same picture once both are shrunk to 64 x 64 (their
brightness patterns correlate above 0.9). It is then
saved as originals/<id>.<ext> and the record's source, checksum and size are
updated; crop boxes are fractions of the picture, so they stay as they are.
--records DIR (records from that fetch) supplies the image_url it came from.

Records whose original is missing and has no bigger copy get it back from
--raw DIR, which holds the review-page downloads named <collection>-<index>
(S001-0), when that file matches the record's checksum.

Run python3 scripts/build_cards.py afterwards to remake the tiles.
"""
import argparse
import json
import pathlib
import shutil
import sys

from PIL import Image, ImageOps

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import croplib  # noqa: E402

SHAPE_TOLERANCE = 0.02
MIN_CORRELATION = 0.9  # of 64 x 64 greyscale copies; different pictures stay well below


def thumb(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        return croplib.flatten(im.convert("RGBA")).convert("L").resize((64, 64), Image.BILINEAR)


def same_picture(a, b):
    """True when files a and b show the same picture at any size."""
    wa, ha = croplib.oriented_size(a)
    wb, hb = croplib.oriented_size(b)
    if abs((wa / ha) / (wb / hb) - 1) > SHAPE_TOLERANCE:
        return False
    ta, tb = thumb(a).tobytes(), thumb(b).tobytes()
    n = len(ta)
    ma, mb = sum(ta) / n, sum(tb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ta, tb))
    va = sum((x - ma) ** 2 for x in ta)
    vb = sum((y - mb) ** 2 for y in tb)
    if va == 0 or vb == 0:
        return va == vb and ma == mb
    return cov / (va * vb) ** 0.5 >= MIN_CORRELATION


def find(folder, rid):
    if folder is None:
        return None
    hits = [p for p in folder.glob(rid + ".*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff")]
    # the biggest file when there are several, so the choice never depends on directory order
    return max(sorted(hits), key=lambda p: p.stat().st_size) if hits else None


def raw_copy(folder, record):
    if folder is None:
        return None
    meta = record.get("meta", {})
    p = folder / f"{meta.get('collection')}-{meta.get('index')}"
    if p.exists() and croplib.sha256_file(p) == record.get("source_sha256"):
        return p
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="src", required=True, type=pathlib.Path)
    ap.add_argument("--records", type=pathlib.Path)
    ap.add_argument("--raw", type=pathlib.Path)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    out = croplib.REPO / "originals"
    counts = {"upgraded": 0, "restored": 0, "kept": 0, "different": 0, "missing": 0}
    for path in sorted(croplib.CROPS_DIR.glob("S*.json")):
        record = croplib.load_record(path)
        rid = record["id"]
        current = croplib.source_path(record)
        base = current if current.exists() and croplib.sha256_file(current) == record.get("source_sha256") else None
        if base is None:
            raw = raw_copy(args.raw, record)
            if raw is not None:
                base = raw
                if not args.dry_run:
                    out.mkdir(exist_ok=True)
                    shutil.copyfile(raw, current)
                    base = current
                counts["restored"] += 1
        big = find(args.src, rid)
        if big is None or base is None:
            if base is None:
                counts["missing"] += 1
                print(f"{rid}: no original here", file=sys.stderr)
            else:
                counts["kept"] += 1
            continue
        w, h = croplib.oriented_size(big)
        if min(w, h) <= min(record["source_size"]):
            counts["kept"] += 1
            continue
        if not same_picture(base, big):
            counts["different"] += 1
            print(f"{rid}: the bigger copy is a different picture; kept the current one", file=sys.stderr)
            continue
        dest = out / f"{rid}{big.suffix.lower()}"
        if args.dry_run:
            counts["upgraded"] += 1
            continue
        out.mkdir(exist_ok=True)
        shutil.copyfile(big, dest)
        if dest != current and current.exists():
            current.unlink()
        record["source"] = croplib.repo_relative(dest)
        record["source_sha256"] = croplib.sha256_file(dest)
        record["source_size"] = [w, h]
        meta = record.setdefault("meta", {})
        meta["obtained"] = "full-size download"
        fetched = args.records / f"{rid}.json" if args.records else None
        if fetched and fetched.exists():
            url = json.loads(fetched.read_text()).get("meta", {}).get("image_url")
            if url:
                meta["image_url"] = url
        croplib.save_record(record)
        counts["upgraded"] += 1
    print(", ".join(f"{v} {k}" for k, v in counts.items()))
    return 1 if counts["missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
