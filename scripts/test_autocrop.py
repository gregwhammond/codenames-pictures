#!/usr/bin/env python3
"""Tests for autocrop.py.

Run: python3 scripts/test_autocrop.py

Synthetic pictures check the proposals; the record tests check which crops
update_record may touch.
"""
import copy
import os
import pathlib
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from PIL import Image, ImageDraw  # noqa: E402

import autocrop  # noqa: E402
import croplib  # noqa: E402

PAPER = (232, 218, 186)


def creature(d, x0, y0, x1, y1, body=(170, 40, 40), spots=(30, 60, 160)):
    """A colourful blob with an outline, spots, legs and a head."""
    w, h = x1 - x0, y1 - y0
    d.ellipse((x0 + w * 0.1, y0 + h * 0.25, x1 - w * 0.1, y1 - h * 0.25), fill=body, outline=(20, 15, 10), width=4)
    for i in range(6):
        cx = x0 + w * (0.25 + 0.1 * i)
        cy = y0 + h * (0.4 + 0.08 * (i % 3))
        d.ellipse((cx - 10, cy - 10, cx + 10, cy + 10), fill=spots)
    for i in range(4):
        lx = x0 + w * (0.25 + 0.17 * i)
        d.line((lx, y1 - h * 0.3, lx - 8, y1 - 4), fill=(20, 15, 10), width=6)
    d.ellipse((x0, y0 + h * 0.08, x0 + w * 0.3, y0 + h * 0.38), fill=(220, 170, 60), outline=(20, 15, 10), width=4)
    d.ellipse((x0 + w * 0.08, y0 + h * 0.16, x0 + w * 0.14, y0 + h * 0.22), fill=(10, 10, 10))


def text_rows(d, x0, y0, x1, y1, line=30, size=15):
    """Rows of dark letter-like stems and arches, the way a script looks."""
    y = y0
    k = 0
    while y + size <= y1:
        x = x0
        while x < x1 - 12:
            n = 2 + (k * 7) % 4  # letters in this word
            for _ in range(n):
                if x > x1 - 8:
                    break
                d.rectangle((x, y, x + 2, y + size), fill=(40, 30, 25))
                d.rectangle((x + 6, y, x + 8, y + size), fill=(40, 30, 25))
                if k % 2:
                    d.rectangle((x, y, x + 8, y + 2), fill=(40, 30, 25))
                x += 12
                k += 1
            x += 10
        y += line


def contains(box, rect, w, h, tol=0.02):
    """box (fractions) contains rect (pixels) up to tol of the picture."""
    l, t, r, b = croplib.box_to_px(box, w, h)
    return (l <= rect[0] + tol * w and t <= rect[1] + tol * h
            and r >= rect[2] - tol * w and b >= rect[3] - tol * h)


def overlap_area(box, rect, w, h):
    l, t, r, b = croplib.box_to_px(box, w, h)
    iw = max(0, min(r, rect[2]) - max(l, rect[0]))
    ih = max(0, min(b, rect[3]) - max(t, rect[1]))
    return iw * ih


def boxes_overlap(a, b, w, h):
    return overlap_area(a, croplib.box_to_px(b, w, h), w, h) > 0


def is_square(box, w, h):
    return abs(box["w"] * w - box["h"] * h) <= 2


class ProposeTest(unittest.TestCase):
    def test_figure_beside_text(self):
        w, h = 900, 620
        im = Image.new("RGB", (w, h), PAPER)
        d = ImageDraw.Draw(im)
        fig = (50, 170, 400, 520)
        creature(d, *fig)
        text = (480, 40, 860, 580)
        text_rows(d, *text)
        t0 = time.perf_counter()
        p = autocrop.propose(im)
        self.assertLess(time.perf_counter() - t0, 3.0)
        self.assertEqual(p["mode"], "crop")
        box = p["boxes"][0]["box"]
        self.assertTrue(is_square(box, w, h))
        self.assertTrue(contains(box, fig, w, h, 0.05), (box, fig))  # feet may be trimmed a little
        text_area = (text[2] - text[0]) * (text[3] - text[1])
        self.assertLess(overlap_area(box, text, w, h), 0.1 * text_area, box)
        self.assertTrue(0 <= p["confidence"] <= 1)

    def test_two_separate_figures(self):
        w, h = 1100, 480
        im = Image.new("RGB", (w, h), PAPER)
        d = ImageDraw.Draw(im)
        a, b = (40, 80, 380, 420), (720, 70, 1060, 410)
        creature(d, *a)
        creature(d, *b, body=(40, 120, 60), spots=(200, 160, 20))
        p = autocrop.propose(im)
        self.assertEqual(p["mode"], "crop")
        self.assertEqual(len(p["boxes"]), 2, p)
        b0, b1 = p["boxes"][0]["box"], p["boxes"][1]["box"]
        self.assertFalse(boxes_overlap(b0, b1, w, h))
        for box in (b0, b1):
            self.assertTrue(is_square(box, w, h))
            side = croplib.box_to_px(box, w, h)
            self.assertGreaterEqual(side[2] - side[0], autocrop.EXTRA_MIN_FRAC * h)
        found = sorted(int(contains(box, r, w, h, 0.03)) for box in (b0, b1) for r in (a, b))
        self.assertEqual(found, [0, 0, 1, 1], (b0, b1))

    def test_extras_do_not_depend_on_resolution(self):
        # the same layout at half and double size gives the same boxes, so
        # refreshing an 800 px copy to the full-size original adds no extras
        w, h = 550, 240
        im = Image.new("RGB", (w, h), PAPER)
        d = ImageDraw.Draw(im)
        creature(d, 20, 40, 190, 210)
        creature(d, 360, 35, 530, 205, body=(40, 120, 60))
        small = autocrop.propose(im)
        big = autocrop.propose(im.resize((4 * w, 4 * h), Image.LANCZOS))
        self.assertEqual(len(small["boxes"]), 2)
        self.assertEqual(len(big["boxes"]), 2)
        for a, b in zip(small["boxes"], big["boxes"]):
            # resampling may move a box by one window-size step
            self.assertGreater(autocrop._box_iou(a["box"], b["box"]), 0.7, (a, b))
        # an explicit pixel floor still drops extras too small for a tile
        self.assertEqual(len(autocrop.propose(im, min_side_px=400)["boxes"]), 1)

    def test_wide_figure_not_split(self):
        w, h = 1100, 480
        im = Image.new("RGB", (w, h), PAPER)
        d = ImageDraw.Draw(im)
        # one long serpent across the whole picture
        pts = [(60 + i * 20, 240 + 90 * ((i % 10) / 5 - 1) * (1 if (i // 10) % 2 else -1)) for i in range(50)]
        d.line(pts, fill=(30, 110, 60), width=46, joint="curve")
        d.line(pts, fill=(200, 180, 40), width=10)
        creature(d, 900, 120, 1080, 360)
        p = autocrop.propose(im)
        self.assertEqual(len(p["boxes"]), 1, p)

    def test_heatmap(self):
        im = Image.new("RGB", (300, 200), PAPER)
        creature(ImageDraw.Draw(im), 100, 40, 260, 180)
        hm = autocrop.heatmap(im)
        self.assertEqual(hm.mode, "L")
        self.assertEqual(hm.size, im.size)
        self.assertGreater(hm.getpixel((180, 110)), hm.getpixel((20, 20)))

    def test_plain_and_tiny_pictures(self):
        for size in ((400, 400), (40, 900), (7, 5)):
            p = autocrop.propose(Image.new("RGB", size, PAPER))
            self.assertIn(p["mode"], ("crop", "fit"))
            self.assertGreaterEqual(len(p["boxes"]), 1)
            croplib.check_box(p["boxes"][0]["box"])


def crop(tile, status, mode="crop", box=None):
    c = {"tile": tile, "mode": mode, "status": status,
         "box": box if mode == "crop" else None}
    if mode == "crop" and box is None:
        c["box"] = {"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.8}
    return c


def B(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


def proposal(mode, *boxes):
    return {"mode": mode, "boxes": [{"box": b, "score": 0.5} for b in boxes],
            "candidates": [B(0.1, 0.1, 0.4, 0.8)], "confidence": 0.7}


LEFT, RIGHT, MID = B(0.0, 0.1, 0.4, 0.8), B(0.6, 0.1, 0.4, 0.8), B(0.3, 0.1, 0.4, 0.8)


def record(*crops):
    return {"id": "S001-02", "source": "originals/S001-02.jpg", "source_size": [1000, 500],
            "rotate": 0, "crops": list(crops)}


class UpdateRecordTest(unittest.TestCase):
    def test_auto_primary_filled(self):
        rec = record(crop("S001-02", "auto"))
        autocrop.update_record(rec, proposal=proposal("crop", MID))
        c = rec["crops"][0]
        self.assertEqual(c["box"], MID)
        self.assertEqual(c["mode"], "crop")
        self.assertEqual(c["auto"]["engine"], "autocrop v1")
        self.assertEqual(c["auto"]["box"], MID)
        self.assertEqual(c["auto"]["confidence"], 0.7)
        self.assertEqual(c["candidates"], [B(0.1, 0.1, 0.4, 0.8)])
        croplib.validate_record(rec)

    def test_fit_primary(self):
        rec = record(crop("S001-02", "auto"))
        autocrop.update_record(rec, proposal=proposal("fit", MID))
        c = rec["crops"][0]
        self.assertEqual((c["mode"], c["box"]), ("fit", None))
        self.assertEqual(c["candidates"][0], MID)  # the crop to try if switched to crop
        croplib.validate_record(rec)

    def test_locked_crops_untouched(self):
        for status in ("adjusted", "approved", "rejected"):
            rec = record(crop("S001-02", status, box=B(0.1, 0.2, 0.3, 0.6)))
            before = copy.deepcopy(rec)
            autocrop.update_record(rec, proposal=proposal("crop", MID))
            self.assertEqual(rec, before, status)
        rec = record(crop("S001-02", "auto", mode="legacy"))
        before = copy.deepcopy(rec)
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual(rec, before)  # legacy: untouched, and no extras added

    def test_extras_named_and_added(self):
        rec = record(crop("S001-02", "approved", box=LEFT))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual([c["tile"] for c in rec["crops"]], ["S001-02", "S001-02-b"])
        extra = rec["crops"][1]
        self.assertEqual((extra["status"], extra["mode"], extra["box"]), ("auto", "crop", RIGHT))
        croplib.validate_record(rec)
        # running again keeps the same extra instead of adding another
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual(len(rec["crops"]), 2)

    def test_extra_name_skips_used(self):
        rec = record(crop("S001-02", "approved", box=LEFT),
                     crop("S001-02-b", "approved", box=B(0.45, 0.0, 0.1, 0.2)))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual([c["tile"] for c in rec["crops"]], ["S001-02", "S001-02-b", "S001-02-c"])

    def test_no_extra_over_rejected(self):
        rec = record(crop("S001-02", "auto"), crop("S001-02-b", "rejected", box=B(0.58, 0.12, 0.4, 0.8)))
        before_rejected = copy.deepcopy(rec["crops"][1])
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual(len(rec["crops"]), 2)
        self.assertEqual(rec["crops"][1], before_rejected)

    def test_no_extra_inside_rejected(self):
        # a smaller extra wholly inside a rejected crop (IoU only 0.25)
        rec = record(crop("S001-02", "approved", box=B(0.0, 0.0, 0.5, 1.0)),
                     crop("S001-02-b", "rejected", box=B(0.5, 0.0, 0.5, 1.0)))
        before = copy.deepcopy(rec)
        autocrop.update_record(rec, proposal=proposal("crop", B(0.0, 0.0, 0.5, 1.0), B(0.55, 0.2, 0.25, 0.5)))
        self.assertEqual(rec, before)
        # ... or a fifth of it on one (a locked crop other than rejected allows that)
        rec = record(crop("S001-02", "approved", box=B(0.0, 0.0, 0.2, 0.4)),
                     crop("S001-02-b", "rejected", box=B(0.5, 0.0, 0.5, 1.0)))
        before = copy.deepcopy(rec)
        autocrop.update_record(rec, proposal=proposal("crop", B(0.0, 0.0, 0.2, 0.4), B(0.3, 0.2, 0.25, 0.5)))
        self.assertEqual(rec, before)
        rec["crops"][1]["status"] = "approved"
        autocrop.update_record(rec, proposal=proposal("crop", B(0.0, 0.0, 0.2, 0.4), B(0.3, 0.2, 0.25, 0.5)))
        self.assertEqual(len(rec["crops"]), 3)

    def test_no_extra_inside_locked_crop(self):
        # a small extra inside a larger approved crop box
        rec = record(crop("S001-02", "approved", box=B(0.0, 0.0, 0.5, 1.0)))
        autocrop.update_record(rec, proposal=proposal("crop", MID, B(0.1, 0.3, 0.2, 0.4)))
        self.assertEqual(len(rec["crops"]), 1)
        # a larger extra holding a smaller approved crop
        rec = record(crop("S001-02", "approved", box=B(0.7, 0.4, 0.1, 0.2)))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, RIGHT))
        self.assertEqual(len(rec["crops"]), 1)
        # an approved fit crop shows the whole picture: no extras at all
        rec = record(crop("S001-02", "approved", mode="fit"))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, B(0.7, 0.2, 0.3, 0.6)))
        self.assertEqual(len(rec["crops"]), 1)
        # a slight overlap with an approved crop is still fine
        rec = record(crop("S001-02", "approved", box=B(0.0, 0.1, 0.45, 0.8)))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, B(0.4, 0.1, 0.4, 0.8)))
        self.assertEqual([c["tile"] for c in rec["crops"]], ["S001-02", "S001-02-b"])

    def test_stale_auto_extras_removed(self):
        rec = record(crop("S001-02", "auto", box=LEFT),
                     crop("S001-02-b", "auto", box=RIGHT),
                     crop("S001-02-c", "approved", box=B(0.45, 0.0, 0.1, 0.2)),
                     crop("S001-02-d", "adjusted", box=B(0.45, 0.8, 0.1, 0.2)))
        autocrop.update_record(rec, proposal=proposal("crop", LEFT))
        self.assertEqual([c["tile"] for c in rec["crops"]], ["S001-02", "S001-02-c", "S001-02-d"])
        # a moved extra is updated in place, keeping its name
        rec = record(crop("S001-02", "auto", box=LEFT), crop("S001-02-b", "auto", box=RIGHT))
        moved = B(0.55, 0.12, 0.4, 0.8)
        autocrop.update_record(rec, proposal=proposal("crop", LEFT, moved))
        self.assertEqual([c["tile"] for c in rec["crops"]], ["S001-02", "S001-02-b"])
        self.assertEqual(rec["crops"][1]["box"], moved)

    def test_first_crop_never_removed(self):
        rec = record(crop("S001-02", "auto", box=LEFT))
        autocrop.update_record(rec, proposal=proposal("crop", MID))
        self.assertEqual(len(rec["crops"]), 1)
        self.assertEqual(rec["crops"][0]["tile"], "S001-02")

    def test_opens_source_by_default(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("CROP_TEST_TMP")) as tmp:
            repo = pathlib.Path(tmp)
            src = repo / "originals" / "X1.png"
            src.parent.mkdir(parents=True)
            w, h = 1100, 480
            im = Image.new("RGB", (w, h), PAPER)
            d = ImageDraw.Draw(im)
            creature(d, 40, 80, 380, 420)
            creature(d, 720, 70, 1060, 410, body=(40, 120, 60))
            im.save(src)
            rec = {"id": "X1", "source": "originals/X1.png", "source_size": [w, h], "rotate": 0,
                   "crops": [crop("X1", "auto")]}
            old = croplib.REPO
            croplib.REPO = repo
            try:
                autocrop.update_record(rec)
            finally:
                croplib.REPO = old
            self.assertEqual([c["tile"] for c in rec["crops"]], ["X1", "X1-b"])
            croplib.validate_record(rec)


if __name__ == "__main__":
    unittest.main()
