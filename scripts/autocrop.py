#!/usr/bin/env python3
"""Heuristic auto-crop proposals for picture tiles (Pillow + numpy only).

Usage:
    python3 scripts/autocrop.py IDS...            # update these records in art/crops
    python3 scripts/autocrop.py --all             # update every record
    python3 scripts/autocrop.py --all --dry-run --sheet out.jpg
    python3 scripts/autocrop.py --images DIR --sheet out.jpg [--per-page 30]

Records: only crops with status "auto" (and not in legacy mode) are changed.
Adjusted, approved and rejected crops are never touched. Extra scenes found in
a source become new "auto" crops named <id>-b, <id>-c ...

--images proposes for a folder of pictures without touching any record and
writes contact sheets (OUT.jpg, or OUT-01.jpg, OUT-02.jpg ... when there are
more pictures than --per-page): each picture with its primary box (red),
extra scenes (cyan), fit marked in yellow, the interest heat map and the tile
previews.

How it works (all on a copy about 384 px on the long side):
  1. paper/background colours are estimated from the border and masked out;
  2. text (rows or columns of dark strokes separated by clean gaps) is
     detected in tiles and penalised;
  3. an interest map is made from edges, colour, contrast against the paper
     and spectral-residual saliency;
  4. square windows from 100% down to 45% of the short side are scored with an
     integral image: interest captured - area cost - text - interest cut at
     the window edges;
  5. when no square captures enough of the picture, "fit" is proposed;
  6. further non-overlapping squares separated by a low-interest gap and
     scoring close to the primary become extra scenes (rare).
"""
import argparse
import math
import pathlib
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import croplib  # noqa: E402

ENGINE = "autocrop v1"
WORK = 384            # long side of the working copy
MIN_FRAC = 0.40       # smallest window, as a fraction of the short side
N_SIZES = 12
MAX_BOXES = 4

# window score weights
NOISE_FLOOR = 0.12    # interest below this x its 99th percentile counts as none
AREA_COST = 0.30      # regions less dense than AREA_COST x average are cropped away
CUT_COST = 0.08       # per unit of (edge band density / average density)
TEXT_COST = 0.6       # per unit of text fraction inside the window
CENTRE_COST = 0.15    # per unit of (interest centroid offset / window side)
TOP_BIAS = 0.08       # tall pictures: penalty per unit of window distance from the top
TOP_BIAS_FULL = 1.0   # ... from the subject's top, when the subject is taller than the window
TOP_BIAS_WIDE = 0.04  # the same for wide pictures
FIT_CAPTURE = 0.65    # below this captured interest (and wide enough) -> fit
FIT_ASPECT = 1.3
EXTRA_RATIO = 0.7     # extra scene must score >= this x the primary
EXTRA_MIN_FRAC = 0.35 # extra scene side >= this x the picture's short side
GUTTER = 0.4          # gutter between scenes: density below this x the average
GUTTER_PEAK = 1.0     # ... and (ends aside) 95% of it below this x the average
PANEL_SHARE = 0.15    # each side of a gutter holds at least this share of interest
SCENE_MIN_SCORE = 0.4 # a scene's own score (as a picture of its own) at least this
EXTRA_SHARE = 0.6     # an extra scene holds >= this x the main scene's interest
                      # (0.4 let in head/legs splits, ground patches, moons ...)
EXTRA_COVER = 0.5     # a new extra is not added when an existing crop covers
                      # more than this share of the smaller of the two boxes
EXTRA_COVER_REJECTED = 0.1  # ... or this share, for a rejected crop


# ---------------------------------------------------------------- basics

def _box(a, r):
    """Mean filter with a (2r+1)^2 square, edges replicated."""
    r = int(r)
    if r < 1:
        return a
    k = 2 * r + 1
    p = np.pad(a, r, mode="edge")
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def _box1d(a, r, axis):
    r = int(r)
    if r < 1:
        return a
    k = 2 * r + 1
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis)
    zpad = [(0, 0), (0, 0)]
    zpad[axis] = (1, 0)
    c = np.pad(c, zpad)
    if axis == 0:
        return (c[k:] - c[:-k]) / k
    return (c[:, k:] - c[:, :-k]) / k


def _blur(a, sigma):
    """Approximate Gaussian blur: three box passes."""
    r = max(0, int(round(sigma * 0.9)))
    for _ in range(3):
        a = _box(a, r)
    return a


def _lab(rgb):
    """sRGB floats 0..1 (H, W, 3) -> CIE Lab (D65)."""
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    x = (c @ np.array([0.4124, 0.3576, 0.1805])) / 0.95047
    y = c @ np.array([0.2126, 0.7152, 0.0722])
    z = (c @ np.array([0.0193, 0.1192, 0.9505])) / 1.08883

    def f(t):
        return np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)
    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


def _norm(a, pct=98):
    hi = np.percentile(a, pct)
    return np.clip(a / hi, 0, 1) if hi > 1e-9 else np.zeros_like(a)


def _work(im, long_side=WORK):
    im = im.convert("RGB")
    w, h = im.size
    s = long_side / max(w, h)
    if s < 1:
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BOX)
    return np.asarray(im, dtype=np.float64) / 255.0


# ---------------------------------------------------------------- features

def _backgrounds(lab, tex):
    """Background colours: dominant flat colours of the outer border, plus
    paper-like (light, low chroma) colours of a ring further in."""
    h, w, _ = lab.shape
    short = min(h, w)
    bw = max(2, int(short * 0.04))
    outer = np.zeros((h, w), bool)
    outer[:bw], outer[-bw:], outer[:, :bw], outer[:, -bw:] = True, True, True, True
    ring = np.zeros((h, w), bool)
    a, b = int(short * 0.08), int(short * 0.16)
    ring[a:h - a, a:w - a] = True
    ring[b:h - b, b:w - b] = False
    colours = []
    for region, need, paperlike in ((outer, 0.30, False), (ring, 0.22, True)):
        px = lab[region & (tex < 6)]
        n_all = max(1, int(region.sum()))
        for _ in range(3):
            if len(px) < n_all * need:
                break
            med = np.median(px, axis=0)
            d = np.linalg.norm(px - med, axis=1)
            near = d < 12
            if near.sum() < n_all * need:
                break
            med = np.median(px[near], axis=0)
            ok = not paperlike or (med[0] > 55 and math.hypot(med[1], med[2]) < 30)
            if ok and all(np.linalg.norm(med - c) > 6 for c in colours):
                colours.append(med)
            px = px[~near]
    return colours


def _text_map(ink, sizes=(28, 60, 110)):
    """Tile score 0..1 for rows (or columns) of strokes between clean gaps."""
    h, w = ink.shape
    out = np.zeros((h, w))
    for t in sizes:
        if t * 2 > max(h, w):
            continue
        step = t // 2
        for transpose in (False, True):
            ik = ink.T if transpose else ink
            H, W = ik.shape
            tw = min(W, t * 3)  # tiles are wider than tall along the text direction
            acc = np.zeros((H, W))
            for y0 in sorted(set(range(0, max(1, H - t + 1), step)) | {max(0, H - t)}):
                for x0 in sorted(set(range(0, max(1, W - tw + 1), step)) | {max(0, W - tw)}):
                    tile = ik[y0:y0 + t, x0:x0 + tw]
                    if tile.mean() < 0.03:
                        continue
                    score = _text_tile(tile, y0 == 0, y0 + t >= H, 0.47 if transpose else 0.52)
                    if score > 0:
                        # mark only the parts of the tile whose lines match
                        # the tile's own: a figure beside a column of text
                        # shares the tile but not its line pattern
                        p = tile.mean(axis=1)
                        for a in range(0, tw, t):
                            b = min(tw, a + t)
                            q = tile[:, a:b].mean(axis=1)
                            if b - a < t // 2 or q.mean() < 0.03 or (
                                    q.std() > 1e-9 and np.corrcoef(p, q)[0, 1] < 0.6):
                                continue
                            sl = acc[y0:y0 + t, x0 + a:x0 + b]
                            np.maximum(sl, score, out=sl)
            np.maximum(out, acc.T if transpose else acc, out=out)
    return out


def _across_ratio(a):
    """Share of gradient running across the tile's rows (letter stems)."""
    gy, gx = np.gradient(a)
    across = np.abs(gx).sum()
    return across / (across + np.abs(gy).sum() + 1e-9)


def _text_block(tile, p, min_ratio):
    """Several evenly spaced lines of small print: the row profile repeats
    with a period of a few pixels, and the ink is mostly letter stems."""
    t, tw = tile.shape
    fill = tile.mean()
    if not 0.08 < fill < 0.5:
        return False
    if np.count_nonzero(tile.mean(axis=0) > 0.03) < 0.7 * tw:
        return False
    pc = p - p.mean()
    var = (pc * pc).sum()
    if var < 1e-9:
        return False
    ac = np.correlate(pc, pc, "full")[t - 1:] / var
    hi = int(t / 2.5)
    if hi < 5:
        return False
    if hi < 8:
        return False
    lag = 8 + int(np.argmax(ac[8:hi + 1]))  # hatching repeats faster than lines
    if ac[lag] < 0.45 or ac[lag // 2] > ac[lag] - 0.4:
        return False
    # the gaps between lines are nearly empty
    if np.percentile(p, 15) > 0.45 * p.max():
        return False
    return _across_ratio(tile) >= min_ratio


def _text_tile(tile, top_edge, bottom_edge, min_ratio):
    t, tw = tile.shape
    p = tile.mean(axis=1)
    pmax = p.max()
    if pmax < 0.12:
        return 0.0
    if _text_block(tile, p, min_ratio):
        return 1.0
    # relative thresholds, so a stray vertical stroke (an initial, a border)
    # crossing the lines does not hide the gaps between them
    occ = p > 0.45 * pmax
    empty = p < 0.2 * pmax
    runs = []
    y = 0
    while y < t:
        if occ[y]:
            y1 = y
            while y1 < t and not empty[y1]:
                y1 += 1
            y0 = y
            while y0 > 0 and not empty[y0 - 1]:
                y0 -= 1
            runs.append((y0, y1))
            y = y1 + 1
        else:
            y += 1
    good = 0
    for y0, y1 in dict.fromkeys(runs):
        hgt = y1 - y0
        bounded_top = y0 > 0 or top_edge
        bounded_bot = y1 < t or bottom_edge
        if not (bounded_top and bounded_bot) or hgt < 4 or hgt > 0.6 * t:
            continue
        band = tile[y0:y1]
        colp = band.mean(axis=0)
        col = colp > 0.15
        strokes = int(np.count_nonzero(col[1:] & ~col[:-1]))
        # letters: many separate strokes per line height, ink filling a
        # moderate part of the band, spread along the whole tile width
        need = max(3, 0.9 * tw / max(hgt, 1))
        spread = np.count_nonzero(colp > 0.04) / tw
        fill = band.mean()
        if strokes >= need and spread > 0.6 and 0.15 < fill < 0.6:
            # letter stems run across the line; hatching runs along it
            if _across_ratio(band) < min_ratio:
                continue
            good += hgt
    return min(1.0, good / (0.45 * t))


def _saliency(L):
    """Spectral-residual saliency on a 64 px copy, returned at L's size."""
    h, w = L.shape
    s = 64 / max(h, w)
    small = np.asarray(Image.fromarray(L.astype(np.float32)).resize(
        (max(8, round(w * s)), max(8, round(h * s))), Image.BILINEAR), dtype=np.float64)
    f = np.fft.fft2(small)
    amp = np.log(np.abs(f) + 1e-9)
    res = amp - _box(amp, 1)
    sal = np.abs(np.fft.ifft2(np.exp(res + 1j * np.angle(f)))) ** 2
    sal = _blur(sal, 2)
    big = np.asarray(Image.fromarray(sal.astype(np.float32)).resize((w, h), Image.BILINEAR), dtype=np.float64)
    return _norm(big, 99)


def _ink(lab, lref):
    """Dark, low-chroma strokes (text candidates)."""
    return ((lab[..., 0] < lref - 22) & (np.hypot(lab[..., 1], lab[..., 2]) < 35)).astype(np.float64)


def _features(rgb, fine=None):
    """Feature maps of a working copy; `fine` is an optional copy at about
    twice the size, used to find small print."""
    h, w, _ = rgb.shape
    short = min(h, w)
    lab = _lab(rgb)
    L = lab[..., 0]
    # local texture: std of L in a 5x5 window
    m = _box(L, 2)
    tex = np.sqrt(np.maximum(_box(L * L, 2) - m * m, 0))
    bgs = _backgrounds(lab, tex)
    paper = np.zeros((h, w))
    dist = np.full((h, w), 60.0)
    near = []
    for c in bgs:
        d = np.linalg.norm(lab - c, axis=-1)
        dist = np.minimum(dist, d)
        near.append(_box(((d < 12) & (tex < 8)).astype(np.float64), 3) > 0.05)
    # the step between two background colours (a page against the scanner
    # bed, a mount around a print) is an edge, but not a subject
    bgstep = np.zeros((h, w))
    for i in range(len(near)):
        for j in range(i + 1, len(near)):
            bgstep = np.maximum(bgstep, near[i] & near[j])
    if bgs:
        colour = np.clip((20 - dist) / 10, 0, 1)
        flat = np.clip((14 - _blur(tex, 1.5)) / 8, 0, 1)
        paper = _blur(colour * flat, 1)
    # nearest background colour for chroma and contrast terms
    light = [c for c in bgs if c[0] > 55]
    ref = light[0] if light else (bgs[0] if bgs else np.median(lab.reshape(-1, 3), axis=0))
    chroma = np.hypot(lab[..., 1] - ref[1], lab[..., 2] - ref[2])
    contrast = np.clip(dist / 45, 0, 1) if bgs else np.clip(np.linalg.norm(lab - ref, axis=-1) / 45, 0, 1)

    gy, gx = np.gradient(_box(L, 1))
    edge = _norm(_blur(np.hypot(gx, gy) * (1 - bgstep), 2))
    sal = _saliency(L)

    # text: dark, low-chroma ink relative to the paper lightness
    lref = ref[0] if light else np.percentile(L, 90)
    text = _text_map(_ink(lab, lref), (60, 110))
    if fine is not None and fine.shape[0] > h * 1.5:
        small = _text_map(_ink(_lab(fine), lref), (28, 56))
        small = np.asarray(Image.fromarray(small.astype(np.float32)).resize((w, h), Image.BILINEAR))
        text = np.maximum(text, small)
    else:
        text = np.maximum(text, _text_map(_ink(lab, lref), (28,)))
    text = _blur(text, max(1, short / 80))

    interest = (0.35 * edge + 0.2 * _norm(chroma) + 0.3 * contrast + 0.15 * sal)
    interest *= (1 - _blur(bgstep, 1.5))
    interest *= (1 - 0.9 * paper)
    interest *= (1 - 0.9 * np.clip(text, 0, 1))
    card = _card_mask(lab)
    text = np.maximum(text, card)  # a crop should not show the colour card either
    interest *= (1 - card)
    interest = _blur(interest, max(1, short / 60))
    interest *= (1 - card)
    # faint, even interest (paper grain, show-through) is not a subject
    interest = np.maximum(interest - NOISE_FLOOR * np.percentile(interest, 99), 0)
    return {"interest": interest, "text": text, "paper": paper, "backgrounds": bgs, "card": card}


def _patches(row):
    """Number of flat patches (>= 1.5% of the row) of clearly different
    colour along a row of Lab pixels."""
    n = len(row)
    cut = np.flatnonzero(np.linalg.norm(np.diff(row, axis=0), axis=-1) > 8)
    bounds = np.r_[0, cut + 1, n]
    means, lengths = [], []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a >= max(3, 0.015 * n):
            seg = row[a:b]
            if seg.std(axis=0).max() < 5:
                means.append(seg.mean(axis=0))
                lengths.append(b - a)
    distinct = [m for i, m in enumerate(means) if i == 0 or np.linalg.norm(m - means[i - 1]) > 10]
    # printed patches are all about the same width
    if len(lengths) < 2 or np.std(lengths) > 0.75 * np.mean(lengths):
        return 0
    return len(distinct)


def _card_mask(lab):
    """Colour cards and grey scales photographed beside the picture: a strip
    near an edge made of flat patches of different colours. Returns a mask
    covering the strip and everything between it and the edge."""
    h, w, _ = lab.shape
    mask = np.zeros((h, w))
    for transpose in (False, True):
        a = lab.transpose(1, 0, 2) if transpose else lab
        H, W, _ = a.shape
        zone = max(3, int(H * 0.2))
        vert = np.linalg.norm(np.diff(a, axis=0), axis=-1)       # (H-1, W)
        horiz = np.linalg.norm(np.diff(a, axis=1), axis=-1)      # (H, W-1)
        flat_v = (vert < 4).mean(axis=1)                         # per row
        spread = a.std(axis=1).max(axis=-1)                      # colour variety along the row
        steps = (horiz > 12).mean(axis=1)                        # patch boundaries
        good = np.zeros(H, bool)
        good[:-1] = (flat_v > 0.88) & (spread[:-1] > 14) & (steps[:-1] > 0.03) & (steps[:-1] < 0.15)
        for top in (True, False):
            rows = range(zone) if top else range(H - 1, H - 1 - zone, -1)
            run, first, last = 0, None, None
            for y in rows:
                if good[y]:
                    run += 1
                    first = y if first is None else first
                    last = y
                elif run >= max(6, H // 50) and first is not None:
                    break
                else:
                    run, first, last = 0, None, None
            if run >= max(6, H // 50) and last is not None:
                # plateaus along the strip: at least 5 patches
                lo, hi = min(first, last), max(first, last)
                if hi - lo > 0.1 * H or _patches(a[(lo + hi) // 2]) < 8:
                    continue
                # a printed strip looks the same all the way across its height
                if np.linalg.norm(a[lo + 1] - a[hi - 1], axis=-1).mean() > 6:
                    continue
                y0, y1 = (0, max(first, last) + 2) if top else (min(first, last) - 1, H)
                m = mask.T if transpose else mask
                m[y0:y1, :] = 1
    return mask


def heatmap(im):
    """Interest map of an RGB picture: PIL 'L' image, same size, 0..255."""
    f = _features(_work(im), _work(im, 2 * WORK))["interest"]
    f = f / f.max() if f.max() > 0 else f
    small = Image.fromarray((f * 255).astype(np.uint8), "L")
    return small.resize(im.size, Image.BILINEAR)


# ---------------------------------------------------------------- search

def _integral(a):
    return np.pad(a.cumsum(0).cumsum(1), ((1, 0), (1, 0)))


def _integrals(interest, text):
    h, w = interest.shape
    yy, xx = np.mgrid[0:h, 0:w]
    return (_integral(interest), _integral(text),
            _integral(interest * (xx + 0.5)), _integral(interest * (yy + 0.5)))


def _rect(ii, x0, y0, x1, y1):
    return ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]


def _windows(interest, text, region=None, max_side=None, min_side=None, ints=None, local=False):
    """Scored square windows inside region (x0, y0, x1, y1), as rows
    (x, y, side, score, captured). Scores are relative to the whole picture,
    or with local=True to the region, as if it were a picture of its own."""
    h, w = interest.shape
    x0r, y0r, x1r, y1r = region or (0, 0, w, h)
    short = min(h, w)
    ii, it, ix, iy = ints or _integrals(interest, text)
    if local:
        total = _rect(ii, x0r, y0r, x1r, y1r) + 1e-9
        ex0, ey0, ex1, ey1, rw, rh = x0r, y0r, x1r, y1r, x1r - x0r, y1r - y0r
    else:
        total = interest.sum() + 1e-9
        ex0, ey0, ex1, ey1, rw, rh = 0, 0, w, h, w, h
    dens = total / (rw * rh)
    top = max_side or min(x1r - x0r, y1r - y0r)
    low = min_side or MIN_FRAC * short
    # vertical extent of the subject: rows with strong interest somewhere
    rmax = (interest * (1 - np.clip(text, 0, 1)))[ey0:ey1, ex0:ex1].max(axis=1)
    strong = np.flatnonzero(rmax > 0.3 * (rmax.max() + 1e-12))
    subj_top = ey0 + (int(strong[0]) if len(strong) else 0)
    subj_h = (int(strong[-1]) - int(strong[0]) + 1) if len(strong) else 0
    rows = []
    for f in np.linspace(1.0, min(1.0, low / top), N_SIZES):
        s = max(4, int(round(top * f)))
        if s > x1r - x0r or s > y1r - y0r:
            continue
        step = max(1, s // 24)
        xs = np.unique(np.r_[np.arange(x0r, x1r - s + 1, step), x1r - s])
        ys = np.unique(np.r_[np.arange(y0r, y1r - s + 1, step), y1r - s])
        X, Y = np.meshgrid(xs, ys)
        X, Y = X.ravel(), Y.ravel()
        inside = _rect(ii, X, Y, X + s, Y + s)
        cap = inside / total
        # interest centred in the window: a subject is not pushed to one side
        cx = _rect(ix, X, Y, X + s, Y + s) / (inside + 1e-9) - (X + s / 2)
        cy = _rect(iy, X, Y, X + s, Y + s) / (inside + 1e-9) - (Y + s / 2)
        off = np.hypot(cx, cy) / s
        taller = rh > rw * 1.05 and subj_h > 0.95 * s
        txt = _rect(it, X, Y, X + s, Y + s) / (s * s)
        b = max(2, s // 30)
        cut = np.zeros(len(X))
        for side in range(4):
            if side == 0:    # left
                val = _rect(ii, X, Y, X + b, Y + s); at_edge = X == ex0
            elif side == 1:  # right
                val = _rect(ii, X + s - b, Y, X + s, Y + s); at_edge = X + s == ex1
            elif side == 2:  # top
                val = _rect(ii, X, Y, X + s, Y + b); at_edge = Y == ey0
            else:            # bottom
                val = _rect(ii, X, Y + s - b, X + s, Y + s); at_edge = Y + s == ey1
            d = np.minimum(val / (b * s) / dens, 3.0)
            cut += np.where(at_edge, 0, d)
        area = s * s / (rw * rh)
        # heads and skies are usually at the top: a slight upward preference
        # a figure taller than the square keeps its head: in a tall picture
        # the window is anchored at the subject's top rather than on its
        # busiest part
        if taller:
            off = np.abs(cx) / s
            up = TOP_BIAS_FULL * np.maximum(Y - subj_top, 0) / rh
        else:
            up = (TOP_BIAS if rh > rw * 1.05 else TOP_BIAS_WIDE) * (Y - ey0) / rh
        score = cap - AREA_COST * area - CUT_COST * cut - TEXT_COST * txt - up - CENTRE_COST * off
        rows.append(np.stack([X, Y, np.full(len(X), s), score, cap], axis=1))
    return np.concatenate(rows) if rows else np.zeros((0, 5))


def _panels(interest, region=None, depth=0):
    """Split the picture along low-interest gutters (recursive XY cut)."""
    h, w = interest.shape
    x0, y0, x1, y1 = region or (0, 0, w, h)
    sub = interest[y0:y1, x0:x1]
    need = PANEL_SHARE * interest.sum()  # each part holds this much interest
    best = None
    for axis in (0, 1):  # 0: cut between columns, 1: between rows
        prof = sub.mean(axis=axis)
        n = len(prof)
        if n < 8:
            continue
        prof = _box1d(prof[None, :], 1, 1)[0]
        tot = prof.sum() + 1e-12
        per = sub.shape[axis]  # profile values are means over this many pixels
        low = prof < GUTTER * prof.mean()
        k = 0
        while k < n:
            if not low[k]:
                k += 1
                continue
            a = k
            while k < n and low[k]:
                k += 1
            b = k
            if a == 0 or b == n or b - a < max(2, 0.008 * n):
                continue
            share = min(prof[:a].sum(), prof[b:].sum()) / tot
            if min(prof[:a].sum(), prof[b:].sum()) * per < need or (best is not None and share <= best[0]):
                continue
            # the cleanest line of the gutter must be clear all along: a
            # figure reaching across it (an arm, a tail) leaves a peak
            seg = prof[a:b]
            flat = np.flatnonzero(seg <= seg.min() + 0.05 * prof.mean())
            c = a + (int(flat[0]) + int(flat[-1])) // 2  # middle of the cleanest stretch
            line = sub[:, c] if axis == 0 else sub[c, :]
            end = len(line) // 16  # the picture's own edges and frame may cross it
            if np.percentile(line[end:len(line) - end], 95) > GUTTER_PEAK * sub.mean():
                continue
            best = (share, axis, c)
    if best is None or depth >= 3:
        return [(x0, y0, x1, y1)]
    _, axis, c = best
    if axis == 0:
        parts = [(x0, y0, x0 + c, y1), (x0 + c, y0, x1, y1)]
    else:
        parts = [(x0, y0, x1, y0 + c), (x0, y0 + c, x1, y1)]
    return [p for part in parts for p in _panels(interest, part, depth + 1)]


def _iou(a, b):
    ax, ay, as_ = a[:3]
    bx, by, bs = b[:3]
    iw = max(0, min(ax + as_, bx + bs) - max(ax, bx))
    ih = max(0, min(ay + as_, by + bs) - max(ay, by))
    inter = iw * ih
    return inter / (as_ * as_ + bs * bs - inter)


def _overlap(a, b):
    ax, ay, as_ = a[:3]
    bx, by, bs = b[:3]
    return min(ax + as_, bx + bs) > max(ax, bx) and min(ay + as_, by + bs) > max(ay, by)


def _nms(win, keep, iou_max=0.5, exclude=()):
    order = np.argsort(-win[:, 3])
    chosen = []
    for i in order:
        wv = win[i]
        if any(_iou(wv, c) > iou_max for c in chosen) or any(_iou(wv, c) > 0.8 for c in exclude):
            continue
        chosen.append(wv)
        if len(chosen) >= keep:
            break
    return chosen


def _content_box(rgb):
    """The picture without flat padding (rows or columns of one plain colour,
    such as the white added to square a picture), as (x0, y0, x1, y1)."""
    h, w, _ = rgb.shape
    q = np.round(rgb * 255)

    def plain(line, ref):
        return (np.abs(line - ref).max() <= 10) if line.size else False

    x0, y0, x1, y1 = 0, 0, w, h
    while y0 < y1 - 1 and plain(q[y0, x0:x1], q[0, 0]):
        y0 += 1
    while y1 - 1 > y0 and plain(q[y1 - 1, x0:x1], q[h - 1, w - 1]):
        y1 -= 1
    while x0 < x1 - 1 and plain(q[y0:y1, x0], q[0, 0]):
        x0 += 1
    while x1 - 1 > x0 and plain(q[y0:y1, x1 - 1], q[h - 1, w - 1]):
        x1 -= 1
    if (x1 - x0) < 0.2 * w or (y1 - y0) < 0.2 * h or min(x1 - x0, y1 - y0) < 8:
        return 0, 0, w, h
    return x0, y0, x1, y1


def propose(im, min_side_px=0):
    """Crop proposal for an RGB picture (see module docstring).

    Proposals depend only on the picture's content, not on its resolution:
    an 800 px copy and the full-size original give the same boxes (up to
    resampling noise at the thresholds). A
    min_side_px above 0 additionally drops extra scenes smaller than that
    many source pixels (which does make extras depend on resolution).

    Returns {"mode": "crop"|"fit", "boxes": [{"box", "score"}], "candidates":
    [box...], "confidence"}. boxes[0] is the primary square crop (also given
    in fit mode, as the crop to use if the picture is switched to crop mode);
    boxes[1:] are extra, non-overlapping scenes (never in fit mode).
    candidates are alternative squares, not repeating boxes. All boxes are
    fractions of the picture and square in pixels.
    """
    rgb = _work(im)
    h, w, _ = rgb.shape
    W, H = im.size
    scale = W / w
    feats = _features(rgb, _work(im, 2 * WORK))
    interest, text = feats["interest"], feats["text"]
    ints = _integrals(interest, text)
    content = _content_box(rgb)
    cx0, cy0, cx1, cy1 = content
    # padding is not part of the picture: the content box is scored as the
    # whole picture
    win = _windows(interest, text, content, min(cx1 - cx0, cy1 - cy0),
                   MIN_FRAC * min(cx1 - cx0, cy1 - cy0), ints, local=True)
    best = win[np.argmax(win[:, 3])]
    chosen = [best]

    # confidence: margin over the best clearly different window
    alt = [wv for wv in _nms(win, 12, 0.3) if _iou(wv, best) < 0.3]
    alt_score = alt[0][3] if alt else best[3] - 0.5
    confidence = float(np.clip((best[3] - alt_score) / max(abs(best[3]), 1e-6) / 1.2, 0, 1))

    # separate scenes: panels split by low-interest gutters, each holding a
    # good square of its own
    total = interest.sum() + 1e-12
    min_side = max((min_side_px or 0) / scale, EXTRA_MIN_FRAC * min(cx1 - cx0, cy1 - cy0))
    scenes = []
    for (x0, y0, x1, y1) in _panels(interest):
        share = interest[y0:y1, x0:x1].sum() / total
        side = min(x1 - x0, y1 - y0)
        if share < PANEL_SHARE or side < min_side:
            continue
        pw = _windows(interest, text, (x0, y0, x1, y1), side, max(min_side, MIN_FRAC * side), ints, local=True)
        if len(pw):
            wv = pw[np.argmax(pw[:, 3])].copy()
            wv[4] *= share  # captured share of the whole picture
            scenes.append(wv)
    # a scene counts when it is a good crop of its own panel, about as good
    # as the best scene, and not much less important than the main one
    top_own = max((wv[3] for wv in scenes), default=0)
    scenes = [wv for wv in scenes if wv[3] >= max(SCENE_MIN_SCORE, EXTRA_RATIO * top_own)]
    scenes.sort(key=lambda wv: -wv[4])
    scenes = [wv for wv in scenes if wv[4] >= EXTRA_SHARE * scenes[0][4]] if scenes else []
    if len(scenes) >= 2:
        chosen = scenes[:MAX_BOXES]
        best = chosen[0]

    # fit when no square holds enough of the picture (text does not count)
    aspect = max(cx1 - cx0, cy1 - cy0) / min(cx1 - cx0, cy1 - cy0)
    mode = "crop"
    if len(chosen) == 1 and aspect >= FIT_ASPECT:
        pic = interest * (1 - np.clip(text, 0, 1))
        x, y, s = (int(v) for v in best[:3])
        if pic[y:y + s, x:x + s].sum() < FIT_CAPTURE * (pic.sum() + 1e-12):
            mode = "fit"

    def to_box(wv):
        x, y, s = (float(v) for v in wv[:3])
        box = croplib.square_box((x + s / 2) * scale, (y + s / 2) * scale, s * scale, W, H)
        return {k: float(v) for k, v in box.items()}

    cands = _nms(win, 6, 0.5, exclude=chosen)
    return {
        "mode": mode,
        "boxes": [{"box": to_box(c), "score": round(float(c[3]), 4)} for c in chosen],
        "candidates": [to_box(c) for c in cands[:5]],
        "confidence": round(confidence, 3),
    }


# ---------------------------------------------------------------- records


def _box_iou(a, b):
    if not a or not b:
        return 0.0
    iw = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    ih = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = iw * ih
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def _box_cover(a, b):
    """Intersection over the smaller box's area: 1 when one box holds the other."""
    if not a or not b:
        return 0.0
    iw = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    ih = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    small = min(a["w"] * a["h"], b["w"] * b["h"])
    return iw * ih / small if small > 0 else 0.0


def _blocks_extra(crop, box):
    """True when an existing crop rules out a new extra at box: it covers half
    of the smaller box (a fit or legacy crop covers the whole picture), or,
    when rejected, a tenth of it."""
    limit = EXTRA_COVER_REJECTED if crop.get("status") == "rejected" else EXTRA_COVER
    return _box_cover(_crop_box(crop), box) > limit


def _crop_box(crop):
    if crop.get("mode") == "crop":
        return crop.get("box")
    return {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}  # fit / legacy show the whole picture


def _auto_fields(crop, mode, entry, prop, candidates):
    crop["mode"] = mode
    crop["box"] = entry["box"] if mode == "crop" else None
    crop["auto"] = {"box": crop["box"], "engine": ENGINE, "score": entry["score"],
                    "confidence": prop["confidence"]}
    if mode == "fit":
        crop["auto"]["mode"] = "fit"
    crop["candidates"] = candidates


def update_record(record, im=None, proposal=None):
    """Fill auto-crop proposals into a croplib record in place; returns it.

    Crops that are adjusted, approved or rejected, or in legacy mode, are left
    alone. The first crop, if "auto", gets the primary proposal. Extra scenes
    update matching "auto" extras or become new "auto" crops; a new one is
    never added where an existing crop covers half of it or it covers half
    of that crop, nor anywhere inside a fit crop (which shows the whole
    picture) or on a tenth of a rejected crop;
    "auto" extras the proposal no longer supports are removed. `proposal` may
    pass in an already computed propose() result.
    """
    crops = record["crops"]
    if proposal is None:
        if im is None:
            im = croplib.open_source(record)
        proposal = propose(im)
    prop = proposal
    boxes = prop["boxes"]
    first = crops[0]
    if first.get("status") == "auto" and first.get("mode") != "legacy" and boxes:
        cands = list(prop["candidates"])
        if prop["mode"] == "fit":
            cands = [boxes[0]["box"]] + cands
        _auto_fields(first, prop["mode"], boxes[0], prop, cands)

    def is_auto_extra(c):
        return c is not first and c.get("status") == "auto" and c.get("mode") != "legacy"

    extras = boxes[1:] if (prop["mode"] == "crop" and first.get("mode") != "legacy") else []
    auto_extras = [c for c in crops if is_auto_extra(c)]
    kept = set()
    new = []
    for e in extras:
        match = max(auto_extras, key=lambda c: _box_iou(_crop_box(c), e["box"]), default=None)
        if match is not None and id(match) not in kept and _box_iou(_crop_box(match), e["box"]) > 0.3:
            kept.add(id(match))
            _auto_fields(match, "crop", e, prop, [])
        else:
            new.append(e)
    # drop stale auto extras
    record["crops"] = crops = [c for c in crops if not is_auto_extra(c) or id(c) in kept]
    used = {c["tile"] for c in crops}
    for e in new:
        if any(_blocks_extra(c, e["box"]) for c in crops):
            continue
        i = 1
        while croplib.extra_tile_name(record["id"], i) in used:
            i += 1
        name = croplib.extra_tile_name(record["id"], i)
        used.add(name)
        crop = {"tile": name, "status": "auto"}
        _auto_fields(crop, "crop", e, prop, [])
        crops.append(crop)
    return record


# ---------------------------------------------------------------- contact sheet

RED, CYAN, YELLOW = (230, 30, 30), (0, 190, 230), (250, 200, 0)


def _cell(name, im, prop, heat, cw=320):
    """One contact-sheet cell: picture with boxes, heat map and tiles."""
    th = ImageOps.contain(im, (cw - 90, 240))
    sx = th.width / im.width
    pic = th.copy()
    d = ImageDraw.Draw(pic)
    for i, b in enumerate(prop["boxes"]):
        l, t, r, bt = croplib.box_to_px(b["box"], im.width, im.height)
        col = RED if i == 0 else CYAN
        if prop["mode"] == "fit" and i == 0:
            col = (255, 150, 150)
        for k in range(2):
            d.rectangle((l * sx + k, t * sx + k, r * sx - 1 - k, bt * sx - 1 - k), outline=col)
    if prop["mode"] == "fit":
        d.rectangle((0, 0, pic.width - 1, pic.height - 1), outline=YELLOW, width=4)
    cell = Image.new("RGB", (cw, 360), (40, 40, 40))
    cell.paste(pic, (0, 0))
    hm = ImageOps.contain(heat, (86, 120)).convert("RGB")
    cell.paste(hm, (cw - 88, 0))
    tiles = []
    if prop["mode"] == "fit":
        tiles.append(croplib.fit_square(im, 96))
    for b in prop["boxes"][: (1 if prop["mode"] == "fit" else MAX_BOXES)]:
        tiles.append(im.crop(croplib.box_to_px(b["box"], im.width, im.height)).resize((96, 96), Image.LANCZOS))
    for i, t in enumerate(tiles[:3]):
        cell.paste(t, (2 + i * 100, 246))
    d = ImageDraw.Draw(cell)
    label = f"{name}  {prop['mode']}  c={prop['confidence']:.2f}  n={len(prop['boxes'])}"
    d.text((4, 346), label, fill=(255, 255, 255))
    return cell


def contact_sheets(items, out, per_page=30, cols=6):
    """items: [(name, im, proposal, heat)]. Writes one or more JPEGs."""
    out = pathlib.Path(out)
    pages = [items[i:i + per_page] for i in range(0, len(items), per_page)] or [[]]
    paths = []
    for p, page in enumerate(pages):
        rows = max(1, math.ceil(len(page) / cols))
        sheet = Image.new("RGB", (cols * 324, rows * 364), (20, 20, 20))
        for i, it in enumerate(page):
            sheet.paste(_cell(*it), ((i % cols) * 324, (i // cols) * 364))
        path = out if len(pages) == 1 else out.with_name(f"{out.stem}-{p + 1:02d}{out.suffix}")
        path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(path, "JPEG", quality=85)
        paths.append(path)
    return paths


# ---------------------------------------------------------------- CLI

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def _run_images(folder, sheet, per_page, min_side):
    items, stats = [], {"n": 0, "fit": 0, "extra": 0, "t": 0.0}
    for path in sorted(pathlib.Path(folder).iterdir()):
        if path.suffix.lower() not in IMAGE_EXT:
            continue
        im = croplib.flatten(croplib.open_rgba(path))
        t0 = time.perf_counter()
        prop = propose(im, min_side)
        stats["t"] += time.perf_counter() - t0
        stats["n"] += 1
        stats["fit"] += prop["mode"] == "fit"
        stats["extra"] += len(prop["boxes"]) > 1
        print(f"{path.name}\t{prop['mode']}\tboxes={len(prop['boxes'])}\tconf={prop['confidence']:.2f}")
        if sheet:
            small = ImageOps.contain(im, (600, 600))
            items.append((path.stem, small, prop, heatmap(small)))
    n = max(1, stats["n"])
    print(f"{stats['n']} pictures: fit {stats['fit']} ({100 * stats['fit'] / n:.1f}%), "
          f"extras {stats['extra']} ({100 * stats['extra'] / n:.1f}%), "
          f"{1000 * stats['t'] / n:.0f} ms per picture")
    if sheet:
        for p in contact_sheets(items, sheet, per_page):
            print(f"wrote {p}")


def _run_records(ids, all_, dry, sheet, per_page, min_side):
    if all_:
        records = croplib.load_all_records()
    else:
        records = [croplib.load_record(croplib.record_path(i)) for i in ids]
    items, changed = [], 0
    for rec in records:
        try:
            im = croplib.open_source(rec)
        except OSError as err:
            print(f"error: {rec['id']}: {err}", file=sys.stderr)
            continue
        prop = propose(im, min_side)
        before = [dict(c) for c in rec["crops"]]
        update_record(rec, im, proposal=prop)
        if rec["crops"] != before:
            changed += 1
            if not dry:
                croplib.save_record(rec)
        tiles = ", ".join(f"{c['tile']}:{c['mode']}/{c['status']}" for c in rec["crops"])
        print(f"{rec['id']}\t{prop['mode']}\tconf={prop['confidence']:.2f}\t{tiles}")
        if sheet:
            small = ImageOps.contain(im, (600, 600))
            items.append((rec["id"], small, prop, heatmap(small)))
    print(f"{len(records)} records, {changed} {'would change' if dry else 'changed'}")
    if sheet:
        for p in contact_sheets(items, sheet, per_page):
            print(f"wrote {p}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="record ids to update")
    ap.add_argument("--all", action="store_true", help="update every record in art/crops")
    ap.add_argument("--dry-run", action="store_true", help="do not save records")
    ap.add_argument("--images", metavar="DIR", help="propose for a folder of pictures (no records)")
    ap.add_argument("--sheet", metavar="OUT.jpg", help="write contact sheet(s)")
    ap.add_argument("--per-page", type=int, default=30)
    ap.add_argument("--min-side", type=int, default=0,
                    help="smallest extra crop in source pixels (default 0: extras depend on content only)")
    args = ap.parse_args(argv)
    if args.images:
        _run_images(args.images, args.sheet, args.per_page, args.min_side)
    elif args.ids or args.all:
        _run_records(args.ids, args.all, args.dry_run, args.sheet, args.per_page, args.min_side)
    else:
        ap.error("give record ids, --all, or --images DIR")


if __name__ == "__main__":
    main()
