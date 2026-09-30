"""Shared helpers for crop records: reading, writing and rendering tiles.

A crop record lives at art/crops/<id>.json and describes how to turn one
original picture into one or more square game tiles. The original is never
modified; everything editable lives in the record.

Record format (all boxes are fractions 0..1 of the *rotated* original):

    {
      "id": "S014-07",
      "source": "originals/S014-07.jpg",      # path relative to the repo root
      "source_sha256": "9f2c...",
      "source_size": [2400, 1650],            # pixel size before rotation
      "rotate": 0,                            # 0, 90, 180 or 270 (clockwise)
      "meta": {"title": "...", "source_url": "...", "licence": "..."},  # optional
      "crops": [
        {
          "tile": "S014-07",                  # tile name; extras use -b, -c ...
          "mode": "crop",                     # crop | fit | legacy
          "box": {"x": 0.31, "y": 0.12, "w": 0.52, "h": 0.756},  # null for fit/legacy
          "auto": {"box": {...}, "engine": "autocrop v1", "score": 0.8},  # optional
          "candidates": [{...}, {...}],       # optional other boxes to try
          "status": "approved",               # auto | adjusted | approved | rejected
          "history": [{"box": {...}, "mode": "crop", "at": "2026-10-02T19:10:00Z"}]
        }
      ]
    }

Tile files are named <tile>.<hash>.jpg, where the hash covers everything that
affects the pixels, so a new crop always gets a new file name (phones cache
tiles for 30 days). The 400 px tile goes to web/cards and the zoom version,
with the same file name, to cards-large.
"""
import hashlib
import json
import os
import pathlib
import re
import tempfile

from PIL import Image, ImageChops, ImageFilter, ImageOps

# CROP_REPO lets tests point everything at a temporary copy of the repo.
REPO = pathlib.Path(os.environ.get("CROP_REPO") or pathlib.Path(__file__).resolve().parent.parent)
CROPS_DIR = REPO / "art" / "crops"
TILES_DIR = REPO / "web" / "cards"
LARGE_DIR = REPO / "cards-large"

TILE_SIZE = 400
LARGE_SIZE = 1200
JPEG_QUALITY = 78
BUILD_VERSION = 1  # bump when rendering changes so every tile gets a new name

MODES = ("crop", "fit", "legacy")
STATUSES = ("auto", "adjusted", "approved", "rejected")
ROTATIONS = (0, 90, 180, 270)
TILE_RE = re.compile(r"^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$")
EXTRA_SUFFIX_RE = re.compile(r"-[b-z]$")  # S014-07-b is an extra crop of S014-07


def group_of(tile):
    """Source group of a tile name: extras share their source's group."""
    return EXTRA_SUFFIX_RE.sub("", tile)


def extra_tile_name(record_id, index):
    """Tile name for the index-th crop of a record (0 -> id, 1 -> id-b ...)."""
    if index == 0:
        return record_id
    if index > 24:
        raise ValueError("too many crops for one source")
    return f"{record_id}-{chr(ord('a') + index)}"


# ---------- records ----------

def record_path(record_id):
    return CROPS_DIR / f"{record_id}.json"


def load_record(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_all_records():
    if not CROPS_DIR.is_dir():
        return []
    return [load_record(p) for p in sorted(CROPS_DIR.glob("*.json"))]


def save_record(record):
    """Write a record atomically (write a temp file, then rename)."""
    validate_record(record)
    CROPS_DIR.mkdir(parents=True, exist_ok=True)
    path = record_path(record["id"])
    data = json.dumps(record, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=CROPS_DIR, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return path


def validate_record(record):
    """Raise ValueError if a record is malformed."""
    rid = record.get("id")
    if not isinstance(rid, str) or not TILE_RE.match(rid):
        raise ValueError(f"bad record id {rid!r}")
    if not isinstance(record.get("source"), str):
        raise ValueError(f"{rid}: missing source")
    if record.get("rotate", 0) not in ROTATIONS:
        raise ValueError(f"{rid}: rotate must be one of {ROTATIONS}")
    crops = record.get("crops")
    if not isinstance(crops, list) or not crops:
        raise ValueError(f"{rid}: needs at least one crop")
    seen = set()
    for c in crops:
        tile = c.get("tile")
        if not isinstance(tile, str) or not TILE_RE.match(tile):
            raise ValueError(f"{rid}: bad tile name {tile!r}")
        if tile in seen:
            raise ValueError(f"{rid}: duplicate tile {tile}")
        seen.add(tile)
        if c.get("mode") not in MODES:
            raise ValueError(f"{rid}/{tile}: bad mode {c.get('mode')!r}")
        if c.get("status") not in STATUSES:
            raise ValueError(f"{rid}/{tile}: bad status {c.get('status')!r}")
        if c["mode"] == "crop":
            check_box(c.get("box"), f"{rid}/{tile}")


def check_box(box, where="box"):
    if not isinstance(box, dict):
        raise ValueError(f"{where}: crop mode needs a box")
    try:
        x, y, w, h = (float(box[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"{where}: box needs numeric x, y, w, h") from None
    eps = 1e-6
    if w <= 0 or h <= 0 or x < -eps or y < -eps or x + w > 1 + eps or y + h > 1 + eps:
        raise ValueError(f"{where}: box {box} is outside the picture")


def rotated_size(record):
    w, h = record["source_size"]
    return (h, w) if record.get("rotate", 0) in (90, 270) else (w, h)


def square_box(cx, cy, side_px, width, height):
    """A square box (fractions) of side_px pixels centred near (cx, cy) px,
    clamped to stay inside a width x height picture."""
    side = max(1, min(side_px, width, height))
    x0 = min(max(cx - side / 2, 0), width - side)
    y0 = min(max(cy - side / 2, 0), height - side)
    return {"x": round(x0 / width, 5), "y": round(y0 / height, 5),
            "w": round(side / width, 5), "h": round(side / height, 5)}


def box_to_px(box, width, height):
    """Pixel rectangle (left, top, right, bottom) for a fractional box, made
    exactly square using the smaller of the two sides."""
    x, y = box["x"] * width, box["y"] * height
    side = min(box["w"] * width, box["h"] * height)
    side = max(1, int(round(side)))
    left = int(round(min(max(x, 0), width - side)))
    top = int(round(min(max(y, 0), height - side)))
    return left, top, left + side, top + side


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------- rendering ----------

def source_path(record):
    return REPO / record["source"]


def to_8bit(im):
    """Scale 16-bit and 32-bit greyscale (I;16*, I, F) down to mode L.
    A plain convert() would clip every value above 255 to white."""
    if im.mode not in ("I", "F") and not im.mode.startswith("I;16"):
        return im
    import numpy as np
    arr = np.asarray(im, dtype=np.float64)
    top = float(arr.max()) if arr.size else 0.0
    if im.mode.startswith("I;16") or 255 < top <= 65535:
        arr = arr / 257.0
    elif im.mode == "F" and 0 < top <= 1.0:
        arr = arr * 255.0
    elif top > 65535:
        arr = arr * (255.0 / top)
    return Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8), "L")


def open_rgba(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return to_8bit(im).convert("RGBA")


def flatten(im):
    """RGBA -> RGB on white."""
    flat = Image.new("RGB", im.size, "white")
    flat.paste(im, mask=im.split()[3])
    return flat


def open_source(record):
    """The original as RGB, with EXIF orientation and the record's rotation."""
    im = flatten(open_rgba(source_path(record)))
    rot = record.get("rotate", 0)
    if rot:
        im = im.rotate(-rot, expand=True)  # PIL rotates anticlockwise
    return im


def trim_white(im):
    """Remove plain white borders left over from earlier squaring."""
    diff = ImageChops.difference(im, Image.new("RGB", im.size, "white")).convert("L")
    bbox = diff.point(lambda v: 255 if v > 12 else 0).getbbox()
    return im.crop(bbox) if bbox else im


def legacy_square(im, size):
    """The original build_cards.py treatment: crop near-square pictures to
    fill, put very wide or tall ones on a blurred copy of themselves."""
    w, h = im.size
    if max(w, h) / min(w, h) <= 1.4:
        return ImageOps.fit(im, (size, size), method=Image.LANCZOS)
    return fit_square(im, size)


def fit_square(im, size):
    """Whole picture on a blurred, lightened copy of itself."""
    bg = ImageOps.fit(im, (size, size), method=Image.LANCZOS).filter(ImageFilter.GaussianBlur(size / 20))
    bg = Image.blend(bg, Image.new("RGB", bg.size, "white"), 0.35)
    fg = ImageOps.contain(im, (size, size), method=Image.LANCZOS)
    bg.paste(fg, ((size - fg.width) // 2, (size - fg.height) // 2))
    return bg


def legacy_prepare(record):
    """Legacy pipeline input: alpha-trimmed, flattened, white-trimmed."""
    im = open_rgba(source_path(record))
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    im = flatten(im)
    rot = record.get("rotate", 0)
    if rot:
        im = im.rotate(-rot, expand=True)
    return trim_white(im)


def natural_side(record, crop, prepared=None):
    """Source pixels along the side of the square a crop covers."""
    if crop["mode"] == "crop":
        w, h = rotated_size(record)
        l, t, r, b = box_to_px(crop["box"], w, h)
        return r - l
    im = prepared if prepared is not None else (
        legacy_prepare(record) if crop["mode"] == "legacy" else open_source(record))
    w, h = im.size
    if crop["mode"] == "legacy" and max(w, h) / min(w, h) <= 1.4:
        return min(w, h)
    return max(w, h)


def large_size(record, crop, prepared=None):
    """Zoom version size: the crop's own resolution, between 400 and 1200."""
    return max(TILE_SIZE, min(LARGE_SIZE, natural_side(record, crop, prepared)))


def render(record, crop, size, prepared=None):
    """Render one crop as a size x size RGB image. `prepared` may pass in an
    already opened source (open_source for crop/fit, legacy_prepare for legacy)."""
    mode = crop["mode"]
    if mode == "legacy":
        im = prepared if prepared is not None else legacy_prepare(record)
        return legacy_square(im, size)
    im = prepared if prepared is not None else open_source(record)
    if mode == "fit":
        out = fit_square(im, size)
    else:
        box = box_to_px(crop["box"], *im.size)
        out = im.crop(box).resize((size, size), Image.LANCZOS)
    return ImageOps.autocontrast(out, cutoff=0.5, preserve_tone=True)


def tile_hash(record, crop):
    key = {
        "v": BUILD_VERSION,
        "sha": record.get("source_sha256"),
        "rotate": record.get("rotate", 0),
        "mode": crop["mode"],
        "box": crop.get("box") if crop["mode"] == "crop" else None,
        "sizes": [TILE_SIZE, LARGE_SIZE, JPEG_QUALITY],
    }
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:8]


def tile_filename(record, crop):
    return f"{crop['tile']}.{tile_hash(record, crop)}.jpg"


def save_jpeg(im, path):
    im.save(path, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
