#!/usr/bin/env python3
"""Tests for import_picks.py.

Run: python3 scripts/test_import.py

Each test works in a throwaway repo (CROP_REPO) under CROP_TEST_TMP (or the
system temp folder). The real-data test uses Greg's picks and bundles when
IMPORT_TEST_DATA points at a folder holding picks.json and artifact-files/
(and the sources file exists); otherwise it is skipped.
"""
import base64
import contextlib
import email.message
import http.client
import importlib
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from PIL import Image, ImageDraw  # noqa: E402

import croplib  # noqa: E402
import import_picks  # noqa: E402

DATA = pathlib.Path(os.environ.get(
    "IMPORT_TEST_DATA",
    "/tmp/claude-0/-home-claude-codenames-pictures/523c4ff9-6a22-5c1d-9959-b257bb969282/scratchpad"))
REAL_SOURCES = import_picks.DEFAULT_SOURCES


def jpeg_bytes(size, color=(200, 40, 40), fmt="JPEG"):
    im = Image.new("RGB", size, color)
    d = ImageDraw.Draw(im)
    w, h = size
    d.ellipse((w // 4, h // 4, 3 * w // 4, 3 * h // 4), fill=(20, 90, 200))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


def data_uri(data, mime="image/jpeg"):
    return f"data:{mime};base64," + base64.b64encode(data).decode()


class FakeResponse(io.BytesIO):
    def __init__(self, data, ctype, url):
        super().__init__(data)
        self.headers = email.message.Message()
        self.headers["Content-Type"] = ctype
        self._url = url

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def fake_urlopen(routes, calls=None):
    """routes: {url prefix: (bytes, content type) | Exception | callable}."""
    def opener(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if calls is not None:
            calls.append(url)
            assert "CodenamesPicturesImport" in req.get_header("User-agent")
            assert timeout
        for prefix, out in routes.items():
            if url.startswith(prefix):
                if callable(out) and not isinstance(out, Exception):
                    out = out(url)
                if isinstance(out, Exception):
                    raise out
                return FakeResponse(out[0], out[1], url)
        raise urllib.error.URLError("no route to " + url)
    return opener


class ImportTest(unittest.TestCase):
    def setUp(self):
        base = os.environ.get("CROP_TEST_TMP")
        if base:
            os.makedirs(base, exist_ok=True)
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="import-test-", dir=base))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.old_env = os.environ.get("CROP_REPO")
        os.environ["CROP_REPO"] = str(self.repo)
        importlib.reload(croplib)
        import_picks._sleep = lambda s: None
        # A small synthetic collection: 0 and 2 picked, 2 swapped.
        self.pics = {i: jpeg_bytes((300 + 10 * i, 200), (40 * i, 100, 150)) for i in range(4)}
        self.sources = self.tmp / "sources.json"
        self.sources.write_text(json.dumps([{
            "id": "S900", "licence": "Public domain (test)",
            "images": [
                {"title": "Zero", "url": "https://commons.wikimedia.org/wiki/File:Zero.jpg", "note": "n0"},
                {"title": "One", "url": "https://example.org/one.jpg", "note": "n1"},
                {"title": "Two", "url": "https://commons.wikimedia.org/wiki/File:Two.jpg", "note": "n2",
                 "suggest": {"title": "Two better", "url": "https://commons.wikimedia.org/wiki/File:Two_better.png",
                             "note": "swapped"}},
                {"title": "Twelve", "url": "https://example.org/x.jpg"},
            ] + [{"title": f"t{i}", "url": f"https://example.org/{i}.jpg"} for i in range(4, 13)],
        }]))
        self.picks = self.tmp / "picks.json"
        self.picks.write_text(json.dumps({"S900": {"imgs": [0, 2, 12], "skip": [1], "swap": [2]}}))
        self.bundles = self.tmp / "bundles" / "abc" / "img"
        self.bundles.mkdir(parents=True)
        (self.bundles / "S900.json").write_text(json.dumps(
            {"0": data_uri(self.pics[0]), "2": data_uri(self.pics[2]), "12": data_uri(self.pics[3])}))

    def tearDown(self):
        if self.old_env is None:
            os.environ.pop("CROP_REPO", None)
        else:
            os.environ["CROP_REPO"] = self.old_env
        importlib.reload(croplib)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_import(self, *extra):
        argv = ["--picks", str(self.picks), "--sources", str(self.sources),
                "--bundles", str(self.tmp / "bundles"), "--min-side", "250", *extra]
        args = import_picks.parse_args(argv)
        items, stats = import_picks.run(args)
        out = io.StringIO()
        import_picks.report(items, stats, args, out)
        return stats, out.getvalue()

    def files(self):
        return sorted(p.relative_to(self.repo).as_posix() for p in self.repo.rglob("*") if p.is_file())

    # ---------- basics ----------

    def test_picture_id(self):
        self.assertEqual(import_picks.picture_id("S014", 5), "S014-05")
        self.assertEqual(import_picks.picture_id("S014", "12"), "S014-12")
        self.assertEqual(import_picks.picture_id("S100", 123), "S100-123")

    def test_load_picks_directory_wrapped(self):
        d = self.tmp / "pickdir" / "nested"
        d.mkdir(parents=True)
        (d / "S001.json").write_text(json.dumps({"imgs": [0, 1], "skip": [2], "swap": [], "verdict": None}))
        (d / "S002.json").write_text(json.dumps({"key": "S002", "value": json.dumps({"imgs": ["3"], "swap": [3]})}))
        (d / "S003.json").write_text(json.dumps({"S003": {"data": {"imgs": [4]}}}))
        (d / "notes.json").write_text("{}")
        picks = import_picks.load_picks(self.tmp / "pickdir")
        self.assertEqual(picks["S001"], {"imgs": [0, 1], "skip": [2], "swap": []})
        self.assertEqual(picks["S002"], {"imgs": [3], "skip": [], "swap": [3]})
        self.assertEqual(picks["S003"]["imgs"], [4])
        self.assertEqual(set(picks), {"S001", "S002", "S003"})

    def test_bundle_import_swap_and_record(self):
        stats, out = self.run_import()
        # 0 and 12 from the bundle; 2 is swapped and has no bundle image without --fetch.
        self.assertEqual(sorted(stats["imported"]), ["S900-00", "S900-12"])
        self.assertEqual([p for p, _ in stats["failed"]], ["S900-02"])
        self.assertIn("--fetch", stats["failed"][0][1])
        self.assertEqual((self.repo / "originals" / "S900-00.jpg").read_bytes(), self.pics[0])
        self.assertEqual((self.repo / "originals" / "S900-12.jpg").read_bytes(), self.pics[3])
        rec = croplib.load_record(croplib.record_path("S900-00"))
        croplib.validate_record(rec)
        self.assertEqual(rec["source"], "originals/S900-00.jpg")
        self.assertEqual(rec["source_sha256"], croplib.sha256_file(self.repo / "originals" / "S900-00.jpg"))
        self.assertEqual(rec["source_size"], [300, 200])
        self.assertEqual(rec["rotate"], 0)
        self.assertEqual(rec["meta"]["collection"], "S900")
        self.assertEqual(rec["meta"]["index"], 0)
        self.assertEqual(rec["meta"]["title"], "Zero")
        self.assertEqual(rec["meta"]["licence"], "Public domain (test)")
        self.assertEqual(rec["meta"]["note"], "n0")
        self.assertEqual(rec["meta"]["obtained"], "bundle")
        self.assertEqual(rec["crops"][0]["tile"], "S900-00")
        self.assertTrue(all(c["status"] == "auto" for c in rec["crops"]))
        self.assertIn("imported (new originals): 2", out)
        self.assertIn("failed: 1", out)
        # (300+10*12 wide is not used: index 12 uses pics[3] = 330x200.)
        self.assertEqual(len(stats["low_res"]), 2)  # 200 < 250

    def test_swap_with_fetch_uses_suggest(self):
        calls = []
        api = json.dumps({"query": {"pages": {"7": {"title": "File:Two better.png", "imageinfo": [
            {"url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Two_better.png",
             "size": 1, "width": 300, "height": 200, "mime": "image/png"}]}}}}).encode()
        png = jpeg_bytes((400, 300), fmt="PNG")
        routes = {
            "https://commons.wikimedia.org/w/api.php": lambda url: (
                api if "Two+better" in url else json.dumps({"query": {"pages": {"-1": {"missing": ""}}}}).encode(),
                "application/json"),
            "https://upload.wikimedia.org/wikipedia/commons/a/ab/Two_better.png": (png, "image/png"),
        }
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes, calls)):
            stats, _ = self.run_import("--fetch", "--only", "S900-02,S900-00")
        self.assertEqual(stats["failed"], [])
        self.assertEqual(stats["imported"], ["S900-00", "S900-02"])
        self.assertEqual(stats["fetched"], ["S900-02"])
        self.assertEqual(stats["bundle"], ["S900-00"])  # fetch of Zero failed (missing), bundle used
        self.assertEqual((self.repo / "originals" / "S900-02.png").read_bytes(), png)
        rec = croplib.load_record(croplib.record_path("S900-02"))
        self.assertEqual(rec["source"], "originals/S900-02.png")
        self.assertEqual(rec["meta"]["title"], "Two better")
        self.assertEqual(rec["meta"]["note"], "swapped")
        self.assertEqual(rec["meta"]["source_url"], "https://commons.wikimedia.org/wiki/File:Two_better.png")
        self.assertEqual(rec["meta"]["obtained"], "fetch")
        self.assertFalse(croplib.record_path("S900-12").exists())  # not in --only

    def test_idempotent(self):
        self.run_import()
        before = {p: (self.repo / p).read_bytes() for p in self.files()}
        stats, out = self.run_import()
        self.assertEqual(stats["imported"], [])
        self.assertEqual(stats["records_created"], [])
        self.assertEqual(sorted(set(stats["present"])), ["S900-00", "S900-12"])
        self.assertEqual({p: (self.repo / p).read_bytes() for p in self.files()}, before)
        self.assertIn("already present: 2", out)

    def test_existing_record_not_overwritten(self):
        self.run_import("--only", "S900-00")
        rec = croplib.load_record(croplib.record_path("S900-00"))
        rec["crops"] = [{"tile": "S900-00", "mode": "crop", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.75},
                         "status": "approved"}]
        croplib.save_record(rec)
        self.run_import("--only", "S900-00")
        self.run_import("--only", "S900-00", "--refresh")  # bundle equals the stored file
        self.assertEqual(croplib.load_record(croplib.record_path("S900-00")), rec)

    def test_refresh_replaces_and_marks_for_review(self):
        self.run_import("--only", "S900-00")
        rec = croplib.load_record(croplib.record_path("S900-00"))
        rec["crops"] = [
            {"tile": "S900-00", "mode": "crop", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.75}, "status": "approved"},
            {"tile": "S900-00-b", "mode": "crop", "box": {"x": 0.5, "y": 0, "w": 0.5, "h": 0.75}, "status": "rejected"},
            {"tile": "S900-00-c", "mode": "fit", "box": None, "status": "adjusted"},
        ]
        croplib.save_record(rec)
        old = (self.repo / "originals" / "S900-00.jpg").read_bytes()
        big = jpeg_bytes((1500, 1000), (10, 200, 10))
        api = json.dumps({"query": {"pages": {"1": {"imageinfo": [
            {"url": "https://upload.wikimedia.org/x/Zero.jpg", "mime": "image/jpeg"}]}}}}).encode()
        routes = {"https://commons.wikimedia.org/w/api.php": (api, "application/json"),
                  "https://upload.wikimedia.org/x/Zero.jpg": (big, "image/jpeg")}

        # Without --refresh a present original is not even downloaded.
        calls = []
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes, calls)):
            stats, _ = self.run_import("--only", "S900-00", "--fetch")
        self.assertEqual(calls, [])
        self.assertEqual((self.repo / "originals" / "S900-00.jpg").read_bytes(), old)

        # Dry run with --refresh changes nothing.
        before = {p: (self.repo / p).read_bytes() for p in self.files()}
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            stats, _ = self.run_import("--only", "S900-00", "--fetch", "--refresh", "--dry-run")
        self.assertEqual(stats["replaced"], ["S900-00"])
        self.assertEqual({p: (self.repo / p).read_bytes() for p in self.files()}, before)

        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            stats, _ = self.run_import("--only", "S900-00", "--fetch", "--refresh")
        self.assertEqual(stats["replaced"], ["S900-00"])
        self.assertEqual(stats["records_updated"], ["S900-00"])
        self.assertEqual((self.repo / "originals" / "S900-00.jpg").read_bytes(), big)
        kept = list((self.repo / "originals" / "replaced").iterdir())
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].read_bytes(), old)  # never deleted
        rec2 = croplib.load_record(croplib.record_path("S900-00"))
        self.assertEqual(rec2["source_sha256"], croplib.sha256_file(self.repo / "originals" / "S900-00.jpg"))
        self.assertEqual(rec2["source_size"], [1500, 1000])
        status = {c["tile"]: c["status"] for c in rec2["crops"]}
        self.assertEqual(status["S900-00"], "adjusted")
        self.assertEqual(status["S900-00-b"], "rejected")
        self.assertEqual(status["S900-00-c"], "adjusted")
        self.assertEqual(rec2["meta"]["image_url"], "https://upload.wikimedia.org/x/Zero.jpg")

        # A later refresh whose fetch fails falls back to the bundle, which must
        # not replace the full-size original.
        with mock.patch("urllib.request.urlopen", fake_urlopen({})):
            stats, _ = self.run_import("--only", "S900-00", "--fetch", "--refresh")
        self.assertEqual((self.repo / "originals" / "S900-00.jpg").read_bytes(), big)
        self.assertEqual(stats["kept_differs"], ["S900-00"])
        self.assertEqual(croplib.load_record(croplib.record_path("S900-00")), rec2)

    def test_dry_run_writes_nothing(self):
        stats, out = self.run_import("--dry-run")
        self.assertEqual(self.files(), [])
        self.assertEqual(sorted(stats["imported"]), ["S900-00", "S900-12"])
        self.assertIn("[dry run]", out)

    def test_record_without_original_is_not_overwritten(self):
        # Records come from git; originals may be missing on another machine.
        self.run_import("--only", "S900-00")
        shutil.rmtree(self.repo / "originals")
        # A record made from the bundle: the bundle restores its original.
        stats, _ = self.run_import("--only", "S900-00")
        self.assertEqual(stats["imported"], ["S900-00"])
        self.assertEqual(stats["failed"], [])
        shutil.rmtree(self.repo / "originals")
        # A record made from a full-size file: the bundle must not stand in.
        rec = croplib.load_record(croplib.record_path("S900-00"))
        rec["source_sha256"] = "0" * 64
        rec["source_size"] = [2400, 1600]
        rec["crops"] = [{"tile": "S900-00", "mode": "crop", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.75},
                         "status": "approved"}]
        croplib.save_record(rec)
        for extra in ((), ("--refresh",), ("--fetch", "--refresh"), ("--fetch",)):
            with mock.patch("urllib.request.urlopen", fake_urlopen({})):
                stats, out = self.run_import("--only", "S900-00", *extra)
            self.assertEqual(stats["imported"], [], extra)
            self.assertEqual(stats["records_updated"], [], extra)
            self.assertEqual([p for p, _ in stats["failed"]], ["S900-00"], extra)
            self.assertIn("only the bundle preview is available", stats["failed"][0][1])
            self.assertFalse((self.repo / "originals").exists(), extra)
            self.assertEqual(croplib.load_record(croplib.record_path("S900-00")), rec, extra)
        with contextlib.redirect_stdout(io.StringIO()):
            code = import_picks.main(["--picks", str(self.picks), "--sources", str(self.sources),
                                      "--bundles", str(self.tmp / "bundles"), "--only", "S900-00"])
        self.assertEqual(code, 1)

    def test_swap_after_import(self):
        # S900-12 imported, then Greg marks it swap with a new suggestion.
        self.run_import("--only", "S900-12")
        rec = croplib.load_record(croplib.record_path("S900-12"))
        rec["crops"] = [{"tile": "S900-12", "mode": "crop", "box": {"x": 0, "y": 0, "w": 0.5, "h": 0.75},
                         "status": "approved"}]
        croplib.save_record(rec)
        old = (self.repo / "originals" / "S900-12.jpg").read_bytes()
        src = json.loads(self.sources.read_text())
        src[0]["images"][12]["suggest"] = {"title": "Better", "url": "https://example.org/better.jpg"}
        self.sources.write_text(json.dumps(src))
        self.picks.write_text(json.dumps({"S900": {"imgs": [12], "skip": [], "swap": [12]}}))

        stats, out = self.run_import()
        self.assertEqual(stats["entry_changed"], ["S900-12"])
        self.assertEqual(stats["present"], [])
        self.assertIn("entry changed", out)
        self.assertEqual(croplib.load_record(croplib.record_path("S900-12")), rec)

        new = jpeg_bytes((600, 400), (0, 0, 0))
        with mock.patch("urllib.request.urlopen", fake_urlopen({})):
            stats, _ = self.run_import("--fetch", "--refresh")  # fetch fails: nothing changes
        self.assertEqual([p for p, _ in stats["failed"]], ["S900-12"])
        self.assertEqual(croplib.load_record(croplib.record_path("S900-12")), rec)
        self.assertEqual((self.repo / "originals" / "S900-12.jpg").read_bytes(), old)

        with mock.patch("urllib.request.urlopen", fake_urlopen(
                {"https://example.org/better.jpg": (new, "image/jpeg")})):
            stats, _ = self.run_import("--fetch", "--refresh")
        self.assertEqual(stats["failed"], [])
        self.assertEqual(stats["records_updated"], ["S900-12"])
        self.assertEqual((self.repo / "originals" / "S900-12.jpg").read_bytes(), new)
        rec2 = croplib.load_record(croplib.record_path("S900-12"))
        croplib.validate_record(rec2)
        self.assertEqual(rec2["meta"]["title"], "Better")
        self.assertEqual(rec2["source_size"], [600, 400])
        self.assertNotIn("approved", [c["status"] for c in rec2["crops"]])  # old boxes not carried over
        kept = sorted(p.name for p in (self.repo / "originals" / "replaced").iterdir())
        self.assertEqual(len(kept), 2)
        self.assertTrue(any(k.endswith(".record.json") for k in kept))
        self.assertIn(old, [p.read_bytes() for p in (self.repo / "originals" / "replaced").iterdir()])
        # Settled: a rerun sees the new picture as present.
        stats, _ = self.run_import()
        self.assertEqual((stats["entry_changed"], stats["present"]), ([], ["S900-12"]))

    # ---------- network ----------

    def test_commons_title_parsing(self):
        f = import_picks.commons_file_title
        self.assertEqual(f("https://commons.wikimedia.org/wiki/File:AberdeenBestiaryFolio008rTigerDetail.jpg"),
                         ("https://commons.wikimedia.org/w/api.php", "File:AberdeenBestiaryFolio008rTigerDetail.jpg"))
        self.assertEqual(f("https://commons.wikimedia.org/wiki/File:Conradi_Gesneri_(Page_816)_BHL%2042.jpg")[1],
                         "File:Conradi Gesneri (Page 816) BHL 42.jpg")
        self.assertEqual(f("https://en.wikipedia.org/wiki/File:X.png")[0], "https://en.wikipedia.org/w/api.php")
        self.assertEqual(f("https://commons.wikimedia.org/w/index.php?title=File:Y.jpg")[1], "File:Y.jpg")
        self.assertIsNone(f("https://commons.wikimedia.org/wiki/Category:Aberdeen_Bestiary"))
        self.assertIsNone(f("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg"))
        self.assertIsNone(f("https://www.example.org/wiki/File:X.jpg"))
        self.assertEqual(
            import_picks.original_from_thumb(
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/800px-X.jpg"),
            "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg")

    def test_wikimedia_resolution_mocked(self):
        img = jpeg_bytes((2000, 1400))
        seen = []

        def api(url):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            seen.append(q)
            return json.dumps({"batchcomplete": "", "query": {
                "normalized": [{"from": "File:A_b.jpg", "to": "File:A b.jpg"}],
                "pages": {"123": {"ns": 6, "title": "File:A b.jpg", "imageinfo": [
                    {"size": len(img), "width": 2000, "height": 1400,
                     "url": "https://upload.wikimedia.org/wikipedia/commons/1/12/A_b.jpg",
                     "mime": "image/jpeg"}]}}}}).encode(), "application/json; charset=utf-8"

        routes = {"https://commons.wikimedia.org/w/api.php": api,
                  "https://upload.wikimedia.org/wikipedia/commons/1/12/A_b.jpg": (img, "image/jpeg")}
        calls = []
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes, calls)):
            data, url = import_picks.fetch("https://commons.wikimedia.org/wiki/File:A_b.jpg")
        self.assertEqual(data, img)
        self.assertEqual(url, "https://upload.wikimedia.org/wikipedia/commons/1/12/A_b.jpg")
        q = seen[0]
        self.assertEqual(q["action"], ["query"])
        self.assertEqual(q["prop"], ["imageinfo"])
        self.assertEqual(q["iiprop"], ["url|size|mime"])
        self.assertEqual(q["titles"], ["File:A b.jpg"])
        self.assertEqual(q["format"], ["json"])

    def test_fetch_errors_and_retries(self):
        # Missing file, non-image mime, HTML page with og:image, 503 retried, 404 not.
        missing = json.dumps({"query": {"pages": {"-1": {"title": "File:Nope.jpg", "missing": ""}}}}).encode()
        pdf = json.dumps({"query": {"pages": {"5": {"imageinfo": [
            {"url": "https://upload.wikimedia.org/doc.pdf", "mime": "application/pdf"}]}}}}).encode()
        with mock.patch("urllib.request.urlopen", fake_urlopen({
                "https://commons.wikimedia.org/w/api.php": (missing, "application/json")})):
            with self.assertRaisesRegex(import_picks.FetchError, "not found"):
                import_picks.fetch("https://commons.wikimedia.org/wiki/File:Nope.jpg")
        with mock.patch("urllib.request.urlopen", fake_urlopen({
                "https://commons.wikimedia.org/w/api.php": (pdf, "application/json")})):
            with self.assertRaisesRegex(import_picks.FetchError, "not an image"):
                import_picks.fetch("https://commons.wikimedia.org/wiki/File:Doc.pdf")

        img = jpeg_bytes((500, 500))
        page = b'<!DOCTYPE html><html><head><meta property="og:image" content="/media/big.jpg"></head></html>'
        with mock.patch("urllib.request.urlopen", fake_urlopen({
                "https://museum.example/object/1": (page, "text/html; charset=utf-8"),
                "https://museum.example/media/big.jpg": (img, "image/jpeg")})):
            data, url = import_picks.fetch("https://museum.example/object/1")
        self.assertEqual((data, url), (img, "https://museum.example/media/big.jpg"))

        with mock.patch("urllib.request.urlopen", fake_urlopen({
                "https://museum.example/object/2": (b"<html><head></head></html>", "text/html")})):
            with self.assertRaisesRegex(import_picks.FetchError, "og:image"):
                import_picks.fetch("https://museum.example/object/2")

        with mock.patch("urllib.request.urlopen", fake_urlopen({
                "https://museum.example/fake.jpg": (b"<html>login</html>", "image/jpeg")})):
            with self.assertRaisesRegex(import_picks.FetchError, "not a readable image"):
                import_picks.fetch("https://museum.example/fake.jpg")

        attempts = []

        def flaky(url):
            attempts.append(url)
            if len(attempts) < 3:
                return urllib.error.HTTPError(url, 503, "busy", {}, None)
            return img, "image/jpeg"

        with mock.patch("urllib.request.urlopen", fake_urlopen({"https://x.example/a.jpg": flaky})):
            data, _ = import_picks.fetch("https://x.example/a.jpg")
        self.assertEqual((data, len(attempts)), (img, 3))

        attempts.clear()

        def gone(url):
            attempts.append(url)
            return urllib.error.HTTPError(url, 404, "gone", {}, None)

        with mock.patch("urllib.request.urlopen", fake_urlopen({"https://x.example/b.jpg": gone})):
            with self.assertRaisesRegex(import_picks.FetchError, "HTTP 404"):
                import_picks.fetch("https://x.example/b.jpg")
        self.assertEqual(len(attempts), 1)

        attempts.clear()

        def down(url):
            attempts.append(url)
            return urllib.error.URLError("timed out")

        with mock.patch("urllib.request.urlopen", fake_urlopen({"https://x.example/c.jpg": down})):
            with self.assertRaisesRegex(import_picks.FetchError, "timed out"):
                import_picks.fetch("https://x.example/c.jpg")
        self.assertEqual(len(attempts), import_picks.RETRIES)

        with self.assertRaises(import_picks.FetchError):
            import_picks.fetch(None)

    def test_incomplete_read_retried_then_bundle(self):
        attempts = []

        def cut(url):
            attempts.append(url)
            return http.client.IncompleteRead(b"x" * 10, 1000)

        with mock.patch("urllib.request.urlopen", fake_urlopen({"https://x.example/d.jpg": cut})):
            with self.assertRaisesRegex(import_picks.FetchError, "x.example/d.jpg"):
                import_picks.fetch("https://x.example/d.jpg")
        self.assertEqual(len(attempts), import_picks.RETRIES)

        # Silent truncation (short body with Content-Length) is retried too.
        img = jpeg_bytes((500, 500))
        attempts.clear()

        def short(url):
            attempts.append(url)
            body = img[:100] if len(attempts) == 1 else img
            r = FakeResponse(body, "image/jpeg", url)
            r.headers["Content-Length"] = str(len(img))
            return r

        def opener(req, timeout=None):
            return short(req.full_url)

        with mock.patch("urllib.request.urlopen", opener):
            data, _ = import_picks.fetch("https://x.example/e.jpg")
        self.assertEqual((data, len(attempts)), (img, 2))

        # In an import, the pick falls back to the bundle instead of failing.
        with mock.patch("urllib.request.urlopen",
                        lambda req, timeout=None: (_ for _ in ()).throw(http.client.IncompleteRead(b""))):
            stats, _ = self.run_import("--only", "S900-00", "--fetch")
        self.assertEqual((stats["failed"], stats["bundle"]), ([], ["S900-00"]))

        # Any other surprise from fetch also falls back to the bundle.
        with mock.patch.object(import_picks, "fetch", side_effect=RuntimeError("boom")):
            data, how, _ = import_picks.acquire("S900", 12, {"url": "https://x"}, False,
                                                import_picks.Bundles(str(self.tmp / "bundles")), True)
        self.assertEqual((data, how), (self.pics[3], "bundle"))

    def test_met_original_rendition(self):
        f = import_picks.original_from_thumb
        self.assertEqual(f("https://images.metmuseum.org/CRDImages/dp/web-large/DP123.jpg"),
                         "https://images.metmuseum.org/CRDImages/dp/original/DP123.jpg")
        self.assertEqual(f("https://images.metmuseum.org/CRDImages/dp/original/DP123.jpg"),
                         "https://images.metmuseum.org/CRDImages/dp/original/DP123.jpg")
        self.assertEqual(f("https://example.org/web-large/a.jpg"), "https://example.org/web-large/a.jpg")

        big, small = jpeg_bytes((3000, 2000)), jpeg_bytes((800, 533))
        page = (b'<html><head><meta property="og:image" '
                b'content="https://images.metmuseum.org/CRDImages/dp/web-large/DP1.jpg"></head></html>')
        routes = {"https://www.metmuseum.org/art/collection/search/1": (page, "text/html"),
                  "https://images.metmuseum.org/CRDImages/dp/original/DP1.jpg": (big, "image/jpeg"),
                  "https://images.metmuseum.org/CRDImages/dp/web-large/DP1.jpg": (small, "image/jpeg")}
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            self.assertEqual(import_picks.fetch("https://www.metmuseum.org/art/collection/search/1"),
                             (big, "https://images.metmuseum.org/CRDImages/dp/original/DP1.jpg"))
        del routes["https://images.metmuseum.org/CRDImages/dp/original/DP1.jpg"]
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            self.assertEqual(import_picks.fetch("https://www.metmuseum.org/art/collection/search/1"),
                             (small, "https://images.metmuseum.org/CRDImages/dp/web-large/DP1.jpg"))
        # Direct preview links are upgraded as well, with the same fallback.
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            self.assertEqual(import_picks.fetch("https://images.metmuseum.org/CRDImages/dp/web-large/DP1.jpg")[0],
                             small)

        # A low-res picture that came from a page preview is listed for hand sourcing.
        src = json.loads(self.sources.read_text())
        src[0]["images"][12]["url"] = "https://www.metmuseum.org/art/collection/search/1"
        self.sources.write_text(json.dumps(src))
        with mock.patch("urllib.request.urlopen", fake_urlopen(routes)):
            stats, out = self.run_import("--only", "S900-12", "--fetch", "--min-side", "1200")
        self.assertEqual(stats["page_image"], ["S900-12"])
        self.assertIn("preview image (source by hand): S900-12", out)

    # ---------- real data ----------

    @unittest.skipUnless((DATA / "picks.json").exists() and (DATA / "artifact-files").is_dir()
                         and REAL_SOURCES.exists(), "real picks/bundles/sources not available")
    def test_real_bundle_import(self):
        only = "S001-00,S014-05,S003"
        args = import_picks.parse_args([
            "--picks", str(DATA / "picks.json"), "--bundles", str(DATA / "artifact-files"),
            "--only", only])
        items, stats = import_picks.run(args)
        picks = json.loads((DATA / "picks.json").read_text())
        expected = sorted({"S001-00", "S014-05"} | {f"S003-{i:02d}" for i in picks["S003"]["imgs"]})
        self.assertEqual(sorted(stats["imported"]), expected)
        self.assertEqual(stats["failed"], [])
        for pid in expected:
            orig = self.repo / "originals" / f"{pid}.jpg"
            accepted = DATA / "accepted" / f"{pid}.jpg"
            if accepted.exists():
                self.assertEqual(orig.read_bytes(), accepted.read_bytes(), pid)
            rec = croplib.load_record(croplib.record_path(pid))
            croplib.validate_record(rec)
            self.assertEqual(rec["source_sha256"], croplib.sha256_file(orig))
            with Image.open(orig) as im:
                self.assertEqual(rec["source_size"], list(im.size))
            self.assertTrue(rec["meta"]["licence"])
            self.assertTrue(all(c["status"] == "auto" for c in rec["crops"]))
            # Every tile renders.
            for c in rec["crops"]:
                self.assertEqual(croplib.render(rec, c, 64).size, (64, 64))
        # 800 px bundles are all below the 1200 px zoom target.
        self.assertEqual(len(stats["low_res"]), len(expected))
        stats2 = import_picks.run(args)[1]
        self.assertEqual(stats2["imported"], [])
        self.assertEqual(stats2["records_created"], [])


if __name__ == "__main__":
    with contextlib.suppress(SystemExit):
        unittest.main(verbosity=2)
