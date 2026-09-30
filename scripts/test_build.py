#!/usr/bin/env python3
"""Tests for build_cards.py and make_legacy_records.py.

Run: python3 scripts/test_build.py

Each test builds a throwaway repo in a temp folder and points croplib at it
with CROP_REPO. Set CROP_TEST_TMP to choose where the temp folders go.
"""
import contextlib
import importlib
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from PIL import Image, ImageDraw  # noqa: E402


def picture(path, size, color=(200, 40, 40)):
    im = Image.new("RGB", size, color)
    d = ImageDraw.Draw(im)
    w, h = size
    d.ellipse((w // 4, h // 4, 3 * w // 4, 3 * h // 4), fill=(20, 90, 200))
    d.rectangle((0, 0, w // 6, h // 6), fill=(250, 220, 0))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def size_of(path):
    with Image.open(path) as im:
        return im.size


def pixels(path):
    with Image.open(path) as im:
        return im.convert("RGB").tobytes()


class BuildTest(unittest.TestCase):
    def setUp(self):
        base = os.environ.get("CROP_TEST_TMP")
        if base:
            os.makedirs(base, exist_ok=True)
        self.repo = pathlib.Path(tempfile.mkdtemp(prefix="buildtest-", dir=base))
        self.old_env = os.environ.get("CROP_REPO")
        os.environ["CROP_REPO"] = str(self.repo)
        # Reload so module-level paths follow CROP_REPO.
        import croplib
        self.croplib = importlib.reload(croplib)
        import build_cards
        import make_legacy_records
        self.build = importlib.reload(build_cards)
        self.legacy = importlib.reload(make_legacy_records)

    def tearDown(self):
        if self.old_env is None:
            os.environ.pop("CROP_REPO", None)
        else:
            os.environ["CROP_REPO"] = self.old_env
        shutil.rmtree(self.repo, ignore_errors=True)

    # helpers

    def run_build(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.build.main(list(args))
        return code, out.getvalue() + err.getvalue()

    def add_record(self, rid, size=(900, 600), crops=None, rotate=0):
        src = self.repo / "originals" / f"{rid}.png"
        picture(src, size)
        record = {
            "id": rid,
            "source": f"originals/{rid}.png",
            "source_sha256": self.croplib.sha256_file(src),
            "source_size": list(size),
            "rotate": rotate,
            "crops": crops or [{"tile": rid, "mode": "crop", "status": "approved",
                                "box": {"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.75}}],
        }
        self.croplib.save_record(record)
        return record

    def tiles(self):
        return sorted(p.name for p in (self.repo / "web" / "cards").glob("*.jpg"))

    def large(self):
        return sorted(p.name for p in (self.repo / "cards-large").glob("*.jpg"))

    # tests

    def test_approved_only(self):
        self.add_record("A", crops=[
            {"tile": "A", "mode": "crop", "status": "approved", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.75}},
            {"tile": "A-b", "mode": "crop", "status": "auto", "box": {"x": 0.5, "y": 0, "w": 0.5, "h": 0.75}},
            {"tile": "A-c", "mode": "fit", "status": "rejected"},
            {"tile": "A-d", "mode": "fit", "status": "adjusted"},
        ])
        self.add_record("B", crops=[{"tile": "B", "mode": "fit", "status": "auto"}])
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual([n.split(".")[0] for n in self.tiles()], ["A"])
        self.assertEqual(self.tiles(), self.large())

    def test_crop_and_fit_modes(self):
        rec = self.add_record("C", size=(900, 600), crops=[
            {"tile": "C", "mode": "crop", "status": "approved", "box": {"x": 0.2, "y": 0.1, "w": 0.4, "h": 0.6}},
            {"tile": "C-b", "mode": "fit", "status": "approved"},
        ])
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        names = {c["tile"]: self.croplib.tile_filename(rec, c) for c in rec["crops"]}
        self.assertEqual(self.tiles(), sorted(names.values()))
        for name in names.values():
            self.assertEqual(size_of(self.repo / "web" / "cards" / name), (400, 400))
            w, h = size_of(self.repo / "cards-large" / name)
            self.assertEqual(w, h)
        # crop box is 360 px of source -> large clamps up to 400; fit covers 900 px
        self.assertEqual(size_of(self.repo / "cards-large" / names["C"]), (400, 400))
        self.assertEqual(size_of(self.repo / "cards-large" / names["C-b"]), (900, 900))
        # the fit tile shows the whole picture: blurred band at the top, picture in the middle
        with Image.open(self.repo / "web" / "cards" / names["C-b"]) as fit:
            fit = fit.convert("RGB")
        self.assertNotEqual(fit.getpixel((200, 10)), fit.getpixel((200, 200)))

    def test_extra_crops_and_rotation(self):
        rec = self.add_record("D", size=(600, 1200), rotate=90, crops=[
            {"tile": "D", "mode": "crop", "status": "approved", "box": {"x": 0, "y": 0, "w": 0.5, "h": 1}},
            {"tile": "D-b", "mode": "crop", "status": "approved", "box": {"x": 0.5, "y": 0, "w": 0.5, "h": 1}},
        ])
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual(len(self.tiles()), 2)
        self.assertEqual({n.split(".")[0] for n in self.tiles()}, {"D", "D-b"})
        a = pixels(self.repo / "web" / "cards" / self.croplib.tile_filename(rec, rec["crops"][0]))
        b = pixels(self.repo / "web" / "cards" / self.croplib.tile_filename(rec, rec["crops"][1]))
        self.assertNotEqual(a, b)
        self.assertEqual(size_of(self.repo / "cards-large" / self.croplib.tile_filename(rec, rec["crops"][0])),
                         (600, 600))

    def test_stale_files_deleted_and_rebuild_is_noop(self):
        rec = self.add_record("E")
        (self.repo / "web" / "cards").mkdir(parents=True)
        (self.repo / "cards-large").mkdir(parents=True)
        (self.repo / "web" / "cards" / "old.jpg").write_bytes(b"x")
        (self.repo / "cards-large" / "old.1234abcd.jpg").write_bytes(b"x")
        (self.repo / "web" / "cards" / "notes.txt").write_text("keep me")
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual(self.tiles(), [self.croplib.tile_filename(rec, rec["crops"][0])])
        self.assertEqual(self.large(), self.tiles())
        self.assertTrue((self.repo / "web" / "cards" / "notes.txt").exists())
        # change the box: new name, old one removed
        before = self.tiles()
        mtime = (self.repo / "web" / "cards" / before[0]).stat().st_mtime_ns
        code, log = self.run_build()
        self.assertIn("wrote 0 files", log)
        self.assertEqual((self.repo / "web" / "cards" / before[0]).stat().st_mtime_ns, mtime)
        rec["crops"][0]["box"] = {"x": 0.3, "y": 0.2, "w": 0.5, "h": 0.75}
        self.croplib.save_record(rec)
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual(len(self.tiles()), 1)
        self.assertNotEqual(self.tiles(), before)
        self.assertEqual(self.large(), self.tiles())

    def _built_pair(self):
        self.add_record("F")
        g = self.add_record("G")
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        (self.repo / "web" / "cards" / "stale.jpg").write_bytes(b"x")
        return g

    def test_missing_source_skips_and_deletes_nothing(self):
        g = self._built_pair()
        before_t, before_l = self.tiles(), self.large()
        (self.repo / g["source"]).unlink()
        # a new crop for G needs rendering but the source is gone
        g["crops"].append({"tile": "G-b", "mode": "fit", "status": "approved"})
        self.croplib.save_record(g)
        code, log = self.run_build()
        self.assertNotEqual(code, 0)
        self.assertIn("missing", log)
        self.assertIn("not deleting", log)
        self.assertEqual(self.tiles(), before_t)
        self.assertEqual(self.large(), before_l)
        self.assertIn("stale.jpg", self.tiles())

    def test_sha_mismatch_skips_and_deletes_nothing(self):
        g = self._built_pair()
        before_t = self.tiles()
        picture(self.repo / g["source"], (900, 600), color=(0, 255, 0))
        code, log = self.run_build()
        self.assertNotEqual(code, 0)
        self.assertIn("checksum", log)
        self.assertEqual(self.tiles(), before_t)

    def test_check_mode(self):
        rec = self.add_record("H")
        code, log = self.run_build("--check")
        self.assertEqual(code, 1)
        self.assertIn("missing", log)
        self.assertFalse((self.repo / "web" / "cards").exists() and self.tiles())
        self.assertEqual(self.run_build()[0], 0)
        code, log = self.run_build("--check")
        self.assertEqual(code, 0, log)
        (self.repo / "cards-large" / "junk.jpg").write_bytes(b"x")
        code, log = self.run_build("--check")
        self.assertEqual(code, 1)
        self.assertIn("stale", log)
        self.assertTrue((self.repo / "cards-large" / "junk.jpg").exists())
        (self.repo / "cards-large" / "junk.jpg").unlink()
        (self.repo / "web" / "cards" / self.croplib.tile_filename(rec, rec["crops"][0])).unlink()
        self.assertEqual(self.run_build("--check")[0], 1)
        # --check does not need the originals
        self.run_build()
        (self.repo / rec["source"]).unlink()
        self.assertEqual(self.run_build("--check")[0], 0)

    def test_duplicate_tile_across_records_is_error(self):
        self.add_record("I")
        self.add_record("J", crops=[{"tile": "I", "mode": "fit", "status": "approved"}])
        code, log = self.run_build()
        self.assertEqual(code, 2)
        self.assertIn("appears in both", log)
        self.assertEqual(self.run_build("--check")[0], 2)
        self.assertFalse((self.repo / "web" / "cards").exists())

    def test_legacy_records_and_build(self):
        src = self.repo / "art" / "source"
        picture(src / "wide one.png", (1000, 400))
        picture(src / "square.jpg", (500, 480))
        (src / "readme.txt").parent.mkdir(parents=True, exist_ok=True)
        (src / "readme.txt").write_text("not a picture")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.legacy.make_records(src), 0)
        recs = {r["id"]: r for r in self.croplib.load_all_records()}
        self.assertEqual(set(recs), {"wide_one", "square"})
        r = recs["wide_one"]
        self.assertEqual(r["source"], "art/source/wide one.png")
        self.assertEqual(r["source_size"], [1000, 400])
        self.assertEqual(r["crops"], [{"tile": "wide_one", "mode": "legacy", "box": None,
                                       "status": "approved", "auto": None}])
        # existing records are never overwritten
        r["crops"][0]["status"] = "rejected"
        self.croplib.save_record(r)
        with contextlib.redirect_stdout(io.StringIO()):
            self.legacy.make_records(src)
        self.assertEqual(self.croplib.load_record(self.croplib.record_path("wide_one"))["crops"][0]["status"],
                         "rejected")
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual([n.split(".")[0] for n in self.tiles()], ["square"])
        self.assertEqual(size_of(self.repo / "cards-large" / self.tiles()[0]), (480, 480))

    def legacy_run(self, src, *args, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.legacy.make_records(src, *args, **kw)
        return code, out.getvalue() + err.getvalue()

    def test_replaced_legacy_picture_is_refreshed(self):
        src = self.repo / "art" / "source"
        picture(src / "p1.png", (600, 400))
        picture(src / "p2.png", (500, 500))
        self.assertEqual(self.legacy_run(src)[0], 0)
        self.assertEqual(self.run_build()[0], 0)
        old = self.tiles()
        picture(src / "p1.png", (700, 300), color=(0, 0, 255))
        code, log = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("make_legacy_records.py", log)
        code, log = self.legacy_run(src)
        self.assertEqual(code, 0, log)
        self.assertIn("updated 1", log)
        rec = self.croplib.load_record(self.croplib.record_path("p1"))
        self.assertEqual(rec["source_sha256"], self.croplib.sha256_file(src / "p1.png"))
        self.assertEqual(rec["source_size"], [700, 300])
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        new = self.tiles()
        self.assertEqual(len(new), 2)
        self.assertNotEqual(sorted(n for n in new if n.startswith("p1.")),
                            sorted(n for n in old if n.startswith("p1.")))
        self.assertEqual(self.legacy_run(src)[1].count("updated 0"), 1)

    def test_replaced_picture_with_boxes_is_not_refreshed(self):
        src = self.repo / "art" / "source"
        picture(src / "q.png", (600, 400))
        self.legacy_run(src)
        rec = self.croplib.load_record(self.croplib.record_path("q"))
        rec["crops"][0].update(mode="crop", box={"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.75})
        self.croplib.save_record(rec)
        picture(src / "q.png", (600, 400), color=(0, 0, 255))
        code, log = self.legacy_run(src)
        self.assertIn("has crop boxes", log)
        self.assertEqual(self.croplib.load_record(self.croplib.record_path("q"))["source_sha256"],
                         rec["source_sha256"])
        code, log = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("Crop Studio", log)

    def test_deleted_picture_reported_and_pruned(self):
        src = self.repo / "art" / "source"
        picture(src / "p1.png", (600, 400))
        picture(src / "p2.png", (500, 500))
        self.add_record("elsewhere")  # lives in originals/, never pruned from art/source
        self.legacy_run(src)
        self.assertEqual(self.run_build()[0], 0)
        (src / "p2.png").unlink()
        code, log = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("--prune", log)
        code, log = self.legacy_run(src)
        self.assertEqual(code, 0)
        self.assertIn("run with --prune", log)
        self.assertTrue(self.croplib.record_path("p2").exists())
        code, log = self.legacy_run(src, prune=True)
        self.assertEqual(code, 0, log)
        self.assertFalse(self.croplib.record_path("p2").exists())
        self.assertTrue(self.croplib.record_path("p1").exists())
        self.assertTrue(self.croplib.record_path("elsewhere").exists())
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertEqual(sorted(n.split(".")[0] for n in self.tiles()), ["elsewhere", "p1"])

    def test_unrecorded_source_is_reported(self):
        src = self.repo / "art" / "source"
        picture(src / "p1.png", (600, 400))
        self.legacy_run(src)
        self.assertEqual(self.run_build()[0], 0)
        picture(src / "new one.png", (600, 400))
        code, log = self.run_build()
        self.assertEqual(code, 0, log)
        self.assertIn("art/source/new one.png", log)
        self.assertIn("make_legacy_records.py", log)
        code, log = self.run_build("--check")
        self.assertEqual(code, 1, log)
        self.legacy_run(src)
        self.assertEqual(self.run_build()[0], 0)
        code, log = self.run_build("--check")
        self.assertEqual(code, 0, log)
        self.assertNotIn("no crop record", log)

    def test_16bit_grey_is_scaled_not_clipped(self):
        import numpy as np
        grad = np.tile(np.linspace(0, 65535, 256).astype(np.uint16), (64, 1))
        for ext in ("png", "tif"):
            path = self.repo / f"g16.{ext}"
            Image.fromarray(grad).save(path)
            with Image.open(path) as im:
                self.assertTrue(im.mode.startswith("I"), im.mode)
            flat = np.asarray(self.croplib.flatten(self.croplib.open_rgba(path)).convert("L"))
            self.assertLess((flat == 255).mean(), 0.05)
            self.assertLessEqual(abs(int(flat[0, 128]) - 128), 2)
            self.assertEqual(int(flat[0, 0]), 0)
            self.assertEqual(int(flat[0, 255]), 255)
        # 32-bit I holding 16-bit data, and float 0..1
        for im in (Image.fromarray(grad.astype(np.int32), "I"),
                   Image.fromarray((grad / 65535.0).astype(np.float32), "F")):
            out = np.asarray(self.croplib.to_8bit(im))
            self.assertLessEqual(abs(int(out[0, 128]) - 128), 2, im.mode)
        # 8-bit images are untouched
        rgb = Image.new("RGB", (4, 4), (10, 20, 30))
        self.assertIs(self.croplib.to_8bit(rgb), rgb)


if __name__ == "__main__":
    unittest.main()
