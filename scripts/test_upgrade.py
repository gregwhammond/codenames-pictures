#!/usr/bin/env python3
"""Tests for upgrade_originals.py.

Run: python3 scripts/test_upgrade.py

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


def picture(path, size, kind=0):
    im = Image.new("RGB", size, (230, 220, 200))
    d = ImageDraw.Draw(im)
    w, h = size
    if kind == 0:
        d.ellipse((w // 4, h // 4, 3 * w // 4, 3 * h // 4), fill=(20, 90, 200))
        d.rectangle((0, 0, w // 6, h // 6), fill=(120, 20, 0))
    else:
        d.rectangle((w // 2, 0, w, h // 2), fill=(30, 30, 30))
        d.polygon([(0, h), (w // 3, h // 3), (w // 2, h)], fill=(0, 120, 40))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        base = os.environ.get("CROP_TEST_TMP")
        if base:
            os.makedirs(base, exist_ok=True)
        self.repo = pathlib.Path(tempfile.mkdtemp(prefix="upgradetest-", dir=base))
        self.old_env = os.environ.get("CROP_REPO")
        os.environ["CROP_REPO"] = str(self.repo)
        import croplib
        self.croplib = importlib.reload(croplib)
        import upgrade_originals
        self.up = importlib.reload(upgrade_originals)
        self.big = self.repo / "big"
        self.raw = self.repo / "raw"

    def tearDown(self):
        if self.old_env is None:
            os.environ.pop("CROP_REPO", None)
        else:
            os.environ["CROP_REPO"] = self.old_env
        shutil.rmtree(self.repo, ignore_errors=True)

    def record(self, rid, src):
        rec = {
            "id": rid,
            "source": self.croplib.repo_relative(src),
            "source_sha256": self.croplib.sha256_file(src),
            "source_size": list(self.croplib.oriented_size(src)),
            "rotate": 0,
            "meta": {"collection": rid.split("-")[0], "index": int(rid.split("-")[1])},
            "crops": [{"tile": rid, "mode": "crop", "status": "approved",
                       "box": {"x": 0.0, "y": 0.0, "w": 0.75, "h": 1.0}}],
        }
        self.croplib.save_record(rec)
        return rec

    def run_up(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return self.up.main(["--from", str(self.big), "--raw", str(self.raw), *extra])

    def load(self, rid):
        return json.loads(self.croplib.record_path(rid).read_text())

    def test_bigger_copy_replaces_original_and_keeps_box(self):
        src = self.repo / "originals" / "S001-00.jpg"
        picture(src, (400, 300))
        before = self.record("S001-00", src)
        picture(self.big / "S001-00.png", (1600, 1200))
        self.run_up()
        after = self.load("S001-00")
        self.assertEqual(after["source"], "originals/S001-00.png")
        self.assertEqual(after["source_size"], [1600, 1200])
        self.assertEqual(after["crops"], before["crops"])
        self.assertFalse(src.exists())

    def test_different_picture_is_refused(self):
        src = self.repo / "originals" / "S001-00.jpg"
        picture(src, (400, 300))
        before = self.record("S001-00", src)
        picture(self.big / "S001-00.jpg", (1600, 1200), kind=1)
        self.run_up()
        self.assertEqual(self.load("S001-00"), before)

    def test_smaller_copy_is_ignored(self):
        src = self.repo / "originals" / "S001-00.jpg"
        picture(src, (400, 300))
        before = self.record("S001-00", src)
        picture(self.big / "S001-00.jpg", (200, 150))
        self.run_up()
        self.assertEqual(self.load("S001-00"), before)

    def test_dry_run_with_missing_original_writes_nothing(self):
        src = self.repo / "originals" / "S002-03.jpg"
        picture(src, (400, 300))
        before = self.record("S002-03", src)
        self.raw.mkdir()
        shutil.move(src, self.raw / "S002-3")
        picture(self.big / "S002-03.jpg", (1600, 1200))
        self.assertEqual(self.run_up("--dry-run"), 0)
        self.assertEqual(self.load("S002-03"), before)
        self.assertFalse(src.exists())

    def test_missing_original_is_restored_from_raw(self):
        src = self.repo / "originals" / "S002-03.jpg"
        picture(src, (400, 300))
        before = self.record("S002-03", src)
        self.raw.mkdir()
        shutil.move(src, self.raw / "S002-3")
        self.run_up()
        self.assertTrue(src.exists())
        self.assertEqual(self.load("S002-03"), before)


if __name__ == "__main__":
    unittest.main()
