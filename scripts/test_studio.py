#!/usr/bin/env python3
"""Tests for the Crop Studio server (scripts/studio.py) and its web UI.

Run: python3 scripts/test_studio.py

The server runs in a thread against a throwaway repo (CROP_REPO). Set
CROP_TEST_TMP to choose where the temp folders go. The browser test drives
headless Chromium through the node "playwright" package when it is available
(skipped otherwise); set STUDIO_SHOTS=<dir> to keep its screenshots.
"""
import hashlib
import http.client
import importlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import types
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


def make_repo(root):
    """A small repo: one crop record with suggestions, one legacy record,
    one big picture, one record whose source is missing."""
    import croplib

    def rec(rid, src, size, crops, rotate=0):
        p = root / src
        return {"id": rid, "source": src,
                "source_sha256": croplib.sha256_file(p) if p.exists() else "0" * 64,
                "source_size": list(size), "rotate": rotate, "crops": crops}

    picture(root / "originals/S001-01.jpg", (900, 600))
    picture(root / "art/source/old.png", (500, 500), (30, 160, 60))
    picture(root / "originals/S001-02.jpg", (2400, 1200), (90, 90, 200))
    auto = {"x": 0.2, "y": 0.1, "w": 0.5, "h": 0.75}
    records = [
        rec("S001-01", "originals/S001-01.jpg", (900, 600), [{
            "tile": "S001-01", "mode": "crop", "box": dict(auto), "status": "auto",
            "auto": {"box": dict(auto), "engine": "test", "score": 0.7},
            "candidates": [{"box": {"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.6}, "score": 0.5}],
        }]),
        rec("old", "art/source/old.png", (500, 500),
            [{"tile": "old", "mode": "legacy", "box": None, "status": "approved", "auto": None}]),
        rec("S001-02", "originals/S001-02.jpg", (2400, 1200), [{
            "tile": "S001-02", "mode": "crop", "box": {"x": 0.25, "y": 0, "w": 0.5, "h": 1.0}, "status": "adjusted"}]),
        rec("S001-03", "originals/S001-03.jpg", (800, 800), [{
            "tile": "S001-03", "mode": "fit", "box": None, "status": "auto"}]),
    ]
    (root / "art/crops").mkdir(parents=True, exist_ok=True)
    for r in records:
        croplib.save_record(r)


class StudioBase(unittest.TestCase):
    lan = False
    token = None

    @classmethod
    def setUpClass(cls):
        base = os.environ.get("CROP_TEST_TMP")
        if base:
            os.makedirs(base, exist_ok=True)
        cls.repo = pathlib.Path(tempfile.mkdtemp(prefix="studiotest-", dir=base))
        cls.old_env = os.environ.get("CROP_REPO")
        os.environ["CROP_REPO"] = str(cls.repo)
        import croplib
        cls.croplib = importlib.reload(croplib)
        import studio
        cls.studio = importlib.reload(studio)
        make_repo(cls.repo)
        cls.srv, cls.url = cls.studio.make_server(0, lan=cls.lan, token=cls.token, quiet=True)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        if cls.old_env is None:
            os.environ.pop("CROP_REPO", None)
        else:
            os.environ["CROP_REPO"] = cls.old_env
        shutil.rmtree(cls.repo, ignore_errors=True)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        conn.close()
        return res.status, dict(res.getheaders()), payload

    def get_json(self, path):
        status, _, body = self.request("GET", path)
        return status, json.loads(body)

    def record_bytes(self, rid):
        return (self.repo / "art/crops" / f"{rid}.json").read_bytes()


class ApiTest(StudioBase):
    def records(self):
        status, recs = self.get_json("/api/records")
        self.assertEqual(status, 200)
        return {r["id"]: r for r in recs}

    def test_list(self):
        recs = self.records()
        self.assertEqual(sorted(recs), ["S001-01", "S001-02", "S001-03", "old"])
        r = recs["S001-01"]
        self.assertEqual(r["version"], hashlib.sha256(self.record_bytes("S001-01")).hexdigest())
        self.assertFalse(r["source_missing"])
        self.assertTrue(recs["S001-03"]["source_missing"])
        self.assertEqual(r["image_size"], [900, 600])
        self.assertEqual(r["crops"][0]["auto"]["engine"], "test")

    def test_source_image(self):
        status, hdrs, body = self.request("GET", "/api/source/S001-01.jpg")
        self.assertEqual(status, 200)
        self.assertEqual(hdrs["Content-Type"], "image/jpeg")
        self.assertEqual(Image.open(io.BytesIO(body)).size, (900, 600))
        _, _, body = self.request("GET", "/api/source/S001-01.jpg?rotate=90&v=abc")
        self.assertEqual(Image.open(io.BytesIO(body)).size, (600, 900))
        _, _, body = self.request("GET", "/api/source/S001-02.jpg")
        self.assertEqual(Image.open(io.BytesIO(body)).size, (1600, 800))
        _, _, body = self.request("GET", "/api/source/S001-02.jpg?small=1")
        self.assertEqual(max(Image.open(io.BytesIO(body)).size), 480)
        self.assertEqual(self.request("GET", "/api/source/S001-03.jpg")[0], 404)
        self.assertEqual(self.request("GET", "/api/source/nope.jpg")[0], 404)
        self.assertEqual(self.request("GET", "/api/source/S001-01.jpg?rotate=45")[0], 400)

    def test_tile_preview(self):
        status, _, body = self.request("GET", "/api/tile/old/old.jpg?mode=legacy")
        self.assertEqual(status, 200)
        self.assertEqual(Image.open(io.BytesIO(body)).size, (400, 400))
        status, _, body = self.request("GET", "/api/tile/S001-01/S001-01.jpg?mode=crop&box=0.1,0.1,0.4,0.6")
        self.assertEqual(status, 200)
        self.assertEqual(Image.open(io.BytesIO(body)).size, (400, 400))
        status, _, _ = self.request("GET", "/api/tile/S001-01/S001-01.jpg?mode=fit")
        self.assertEqual(status, 200)
        self.assertEqual(self.request("GET", "/api/tile/S001-01/S001-01.jpg?mode=crop&box=0.8,0,0.5,0.5")[0], 400)
        self.assertEqual(self.request("GET", "/api/tile/S001-01/S001-01.jpg?mode=zoom")[0], 400)

    def test_heatmap(self):
        old = self.studio._autocrop, self.studio._autocrop_failed
        try:
            self.studio._autocrop = None
            self.studio._autocrop_failed = True
            self.assertEqual(self.request("GET", "/api/heatmap/S001-01.png")[0], 404)
            fake = types.SimpleNamespace(heatmap=lambda im: im.convert("L"))
            self.studio._autocrop = fake
            status, hdrs, body = self.request("GET", "/api/heatmap/S001-01.png?rotate=90")
            self.assertEqual(status, 200)
            self.assertEqual(hdrs["Content-Type"], "image/png")
            im = Image.open(io.BytesIO(body))
            self.assertEqual((im.mode, im.size), ("RGBA", (533, 800)))  # 600x900 capped at 800 px

            def broken(im):
                raise RuntimeError("boom")
            self.studio._autocrop = types.SimpleNamespace(heatmap=broken)
            self.assertEqual(self.request("GET", "/api/heatmap/S001-02.png")[0], 404)
        finally:
            self.studio._autocrop, self.studio._autocrop_failed = old

    def post(self, rid, version, record, **kw):
        return self.request("POST", f"/api/records/{rid}", {"version": version, "record": record}, **kw)

    def test_save_and_conflict(self):
        recs = self.records()
        r = recs["S001-02"]
        version = r.pop("version")
        for k in ("source_missing", "image_size"):
            r.pop(k)
        r["crops"][0]["box"] = {"x": 0.1, "y": 0, "w": 0.5, "h": 1.0}
        r["crops"][0]["history"] = [{"box": {"x": 0.25, "y": 0, "w": 0.5, "h": 1.0}, "mode": "crop", "at": "2026-01-01T00:00:00Z"}]
        status, _, body = self.post("S001-02", version, r)
        self.assertEqual(status, 200, body)
        out = json.loads(body)
        on_disk = json.loads(self.record_bytes("S001-02"))
        self.assertEqual(on_disk["crops"][0]["box"]["x"], 0.1)
        self.assertEqual(out["version"], hashlib.sha256(self.record_bytes("S001-02")).hexdigest())
        self.assertEqual(out["record"], on_disk)

        # A second save with the old version is a conflict and changes nothing.
        before = self.record_bytes("S001-02")
        r["crops"][0]["status"] = "approved"
        status, _, body = self.post("S001-02", version, r)
        self.assertEqual(status, 409)
        out2 = json.loads(body)
        self.assertEqual(out2["version"], out["version"])
        self.assertEqual(out2["record"]["crops"][0]["status"], "adjusted")
        self.assertEqual(self.record_bytes("S001-02"), before)

        # With the new version it goes through; server-only keys are ignored.
        r["version"] = "ignored"
        r["source_missing"] = False
        status, _, body = self.post("S001-02", out["version"], r)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(self.record_bytes("S001-02"))["crops"][0]["status"], "approved")
        self.assertNotIn("version", json.loads(self.record_bytes("S001-02")))

    def test_validation(self):
        recs = self.records()
        r = recs["S001-01"]
        version = r.pop("version")
        r.pop("source_missing"), r.pop("image_size")
        before = self.record_bytes("S001-01")

        def bad(mutate, code=400):
            rec = json.loads(json.dumps(r))
            mutate(rec)
            status, _, body = self.post("S001-01", version, rec)
            self.assertEqual(status, code, body)
            self.assertEqual(self.record_bytes("S001-01"), before)

        bad(lambda x: x["crops"][0].update(status="great"))
        bad(lambda x: x["crops"][0].update(box={"x": 0.8, "y": 0, "w": 0.5, "h": 0.5}))
        bad(lambda x: x.update(rotate=45))
        bad(lambda x: x.update(source="../../etc/passwd"))
        bad(lambda x: x.update(source_sha256="f" * 64))
        bad(lambda x: x.update(source_size=[1, 1]))
        bad(lambda x: x.update(id="old"))
        bad(lambda x: x["crops"].append({"tile": "old", "mode": "fit", "status": "auto"}))
        bad(lambda x: x["crops"].append({"tile": "S001-01", "mode": "fit", "status": "auto"}))
        bad(lambda x: x.update(crops=[]))
        bad(lambda x: x["crops"][0].update(history="nope"))
        # extras named with the -b, -c scheme are fine
        ok = json.loads(json.dumps(r))
        ok["crops"].append({"tile": "S001-01-b", "mode": "crop", "status": "adjusted",
                            "box": {"x": 0.5, "y": 0.2, "w": 0.4, "h": 0.6}, "auto": None})
        status, _, body = self.post("S001-01", version, ok)
        self.assertEqual(status, 200, body)
        # restore for other tests
        self.croplib.save_record(json.loads(before))

    def test_bad_posts(self):
        self.assertIn(self.request("POST", "/api/records/..%2Fx", {"version": "", "record": {}})[0], (400, 404))
        self.assertEqual(self.request("POST", "/api/records/bad.id", {"version": "", "record": {}})[0], 400)
        self.assertEqual(self.request("POST", "/api/records/nope", {"version": "", "record": {"id": "nope"}})[0], 404)
        self.assertEqual(self.request("POST", "/api/records/old", b"not json")[0], 400)
        self.assertEqual(self.request("POST", "/api/records/old", b"{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/records/old", {"version": "", "record": {}},
                                      {"Origin": "http://evil.example"})[0], 403)
        self.assertFalse(any(p.name.startswith("..") for p in self.repo.rglob("*")))

    def test_static_and_traversal(self):
        status, hdrs, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Crop Studio", body)
        self.assertTrue(hdrs["Content-Type"].startswith("text/html"))
        self.assertEqual(self.request("GET", "/studio.js")[0], 200)
        for path in ("/../../scripts/studio.py", "/%2e%2e/%2e%2e/scripts/studio.py", "/..%2f..%2fscripts%2fcroplib.py",
                     "/api/source/..%2f..%2fx.jpg", "/api/tile/old/..%2f..%2fx.jpg", "/%00", "/etc/passwd",
                     "/api/heatmap/../../x.png"):
            status, _, body = self.request("GET", path)
            self.assertIn(status, (400, 404), path)
            self.assertNotIn(b"import", body, path)

    def test_huge_source_does_not_break_list(self):
        """A source over Pillow's decompression-bomb limit must not make
        /api/records fail (emulated by lowering the limit)."""
        from PIL import Image
        old = Image.MAX_IMAGE_PIXELS
        self.studio.SIZE_CACHE.data.clear()
        Image.MAX_IMAGE_PIXELS = 1000  # S001-02 (2400x1200) is now a "bomb"
        try:
            status, recs = self.get_json("/api/records")
        finally:
            Image.MAX_IMAGE_PIXELS = old
            self.studio.SIZE_CACHE.data.clear()
        self.assertEqual(status, 200)
        recs = {r["id"]: r for r in recs}
        self.assertEqual(set(recs), {"S001-01", "S001-02", "S001-03", "old"})
        self.assertEqual(recs["S001-02"]["image_size"], [2400, 1200])  # from source_size
        self.assertEqual(recs["S001-01"]["image_size"], [900, 600])

    def test_pixel_limit_raised(self):
        from PIL import Image
        self.assertGreaterEqual(Image.MAX_IMAGE_PIXELS, 600_000_000)

    def test_huge_sources_not_kept_in_full_cache(self):
        st = self.studio
        old = st.FULL_CACHE_MAX_PIXELS
        st.FULL_CACHE.data.clear()
        st.TILE_CACHE.data.clear()
        st.FULL_CACHE_MAX_PIXELS = 1_000_000  # S001-02 is 2.88 MP, S001-01 0.54 MP
        try:
            for rid in ("S001-02", "S001-01"):
                status, _, _ = self.request("GET", f"/api/tile/{rid}/{rid}.jpg?mode=crop&box=0,0,0.5,1&rotate=0"
                                            if rid == "S001-02" else f"/api/tile/{rid}/{rid}.jpg")
                self.assertEqual(status, 200)
            ids = {k[0] for k in st.FULL_CACHE.data}
            self.assertEqual(ids, {"S001-01"})
        finally:
            st.FULL_CACHE_MAX_PIXELS = old

    def test_host_check(self):
        status, _, _ = self.request("GET", "/api/records", headers={"Host": "evil.example:1234"})
        self.assertEqual(status, 403)


class LanTest(StudioBase):
    lan = True
    token = "sekrit-token_123"

    def test_token_required(self):
        self.assertIn("?token=sekrit-token_123", self.url)
        self.assertEqual(self.request("GET", "/api/records")[0], 401)
        self.assertEqual(self.request("GET", "/")[0], 401)
        self.assertEqual(self.request("GET", "/api/records?token=wrong")[0], 401)
        self.assertEqual(self.request("GET", "/api/records", headers={"Cookie": "studio_token=wrong"})[0], 401)
        self.assertEqual(self.request("POST", "/api/records/old", {"version": "", "record": {}})[0], 401)
        # any Host is fine in LAN mode
        status, hdrs, _ = self.request("GET", "/api/records?token=" + self.token, headers={"Host": "192.168.1.9:8765"})
        self.assertEqual(status, 200)
        cookie = hdrs["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        # Lax so a link followed from a web mail/chat page keeps the cookie
        # across the 303 below (Strict dropped it: 401 on the redirect).
        self.assertIn("SameSite=Lax", cookie)
        self.assertNotIn("SameSite=Strict", cookie)
        status, hdrs, _ = self.request("GET", "/?token=" + self.token)
        self.assertEqual(status, 303)
        self.assertEqual(hdrs["Location"], "/")
        self.assertIn("studio_token=", hdrs["Set-Cookie"])
        status, _, body = self.request("GET", "/", headers={"Cookie": "studio_token=" + self.token})
        self.assertEqual(status, 200)
        self.assertIn(b"Crop Studio", body)


# ---------- browser ----------

BROWSER_JS = r"""
const { chromium } = require('playwright');
const fs = require('fs');
const [url, repo, shots] = process.argv.slice(2);
const rec = (id) => JSON.parse(fs.readFileSync(`${repo}/art/crops/${id}.json`, 'utf8'));
const raw = (id) => fs.readFileSync(`${repo}/art/crops/${id}.json`, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameBox = (a, b) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
const assert = (c, m) => { if (!c) throw new Error('assertion failed: ' + m); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/studio-${name}.png`, fullPage: false }); };
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: scheme });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
    await page.goto(url);
    await page.waitForSelector('.tile');
    await page.waitForTimeout(400);
    await shot(page, `queue-${scheme}`);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('.tile');
  const n = await page.locator('.tile').count();
  assert(n === 4, 'four tiles, got ' + n);

  // open S001-01, drag its box right
  await page.click('.tile[data-tile="S001-01"]');
  await page.waitForSelector('#ov rect[stroke]');
  await page.waitForFunction(() => document.querySelector('#src').naturalWidth > 0);
  await shot(page, 'editor');
  const r = await page.locator('#src').boundingBox();
  const before = rec('S001-01').crops[0].box;
  const cx = r.x + (before.x + before.w / 2) * r.width, cy = r.y + (before.y + before.h / 2) * r.height;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 5, { steps: 5 });
  await page.mouse.move(cx + 60, cy + 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  let c = rec('S001-01').crops[0];
  assert(c.status === 'adjusted', 'adjusted after drag: ' + c.status);
  assert(c.box.x > before.x + 0.03, 'moved right');
  assert(Math.abs(c.box.w * 900 - c.box.h * 600) < 1.5, 'still square');
  assert(c.history.length === 1 && c.history[0].box.x === before.x && /Z$/.test(c.history[0].at), 'history');

  // resize from the bottom-right corner
  const b1 = c.box;
  await page.mouse.move(r.x + (b1.x + b1.w) * r.width - 1, r.y + (b1.y + b1.h) * r.height - 1);
  await page.mouse.down();
  await page.mouse.move(r.x + (b1.x + b1.w) * r.width - 80, r.y + (b1.y + b1.h) * r.height - 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved');
  c = rec('S001-01').crops[0];
  assert(c.box.w < b1.w - 0.05, 'smaller after resize');
  assert(Math.abs(c.box.x - b1.x) < 1e-4 && Math.abs(c.box.y - b1.y) < 1e-4, 'top-left anchored');
  assert(Math.abs(c.box.w * 900 - c.box.h * 600) < 1.5, 'square after resize');

  // keys: +, arrows, reset, try another, fit
  await page.keyboard.press('r');
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved');
  await page.waitForTimeout(900);
  c = rec('S001-01').crops[0];
  assert(c.status === 'auto' && c.box.x === 0.2, 'reset to auto');
  await page.keyboard.press('n');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Minus');
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved');
  c = rec('S001-01').crops[0];
  assert(c.status === 'adjusted' && c.box.w < 0.4, 'candidate + shrink: ' + JSON.stringify(c.box));

  // add a second box, see the overlap warning logic, then rotate
  await page.keyboard.press('a');
  await page.waitForTimeout(1000);
  c = rec('S001-01');
  assert(c.crops.length === 2 && c.crops[1].tile === 'S001-01-b' && c.crops[1].status === 'adjusted', 'added -b');
  await shot(page, 'editor-two-boxes');
  const pre = c.crops.map((x) => x.box);
  await page.click('#b-rotate');
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved');
  c = rec('S001-01');
  assert(c.rotate === 90, 'rotated');
  const want = { x: 1 - pre[0].y - pre[0].h, y: pre[0].x, w: pre[0].h, h: pre[0].w };
  for (const k of ['x', 'y', 'w', 'h']) assert(Math.abs(c.crops[0].box[k] - want[k]) < 1e-4, 'rotated box ' + k);
  const last = c.crops[0].history[c.crops[0].history.length - 1];
  assert(last.rotate === 0 && sameBox(last.box, pre[0]), 'history keeps the pre-rotation box and its rotation');
  // mouse wheel shrinks the active box (the new -b)
  const w0 = c.crops[1].box.w;
  const rr = await page.locator('#src').boundingBox();
  await page.mouse.move(rr.x + rr.width * (c.crops[0].box.x + 0.05), rr.y + rr.height * (c.crops[0].box.y + 0.05));
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved');
  assert(rec('S001-01').crops[1].box.w < w0 - 0.01, 'wheel shrinks');
  await page.waitForFunction(() => document.querySelector('#src').naturalHeight > document.querySelector('#src').naturalWidth);
  await shot(page, 'editor-rotated');

  // remove the extra box
  await page.click('.tabs button[data-tile="S001-01-b"]');
  await page.click('#b-remove');
  await page.waitForTimeout(1000);
  c = rec('S001-01');
  assert(c.crops[1].status === 'rejected' && c.crops[1].box, 'rejected keeps box');

  // conflict: someone edits the file behind our back
  const disk = rec('S001-01');
  disk.crops[0].status = 'approved';
  disk.meta = { title: 'Edited elsewhere' };
  fs.writeFileSync(`${repo}/art/crops/S001-01.json`, JSON.stringify(disk, null, 2));
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => /conflict/.test(document.querySelector('#save-state').textContent), null, { timeout: 5000 });
  assert(rec('S001-01').meta.title === 'Edited elsewhere', 'their edit kept');
  assert(await page.locator('#ed-meta').textContent() === 'Edited elsewhere', 'reloaded in page');

  // approve -> goes to next needing review (S001-02 is adjusted)
  await page.click('.tabs button[data-tile="S001-01"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.includes('S001-02'));
  await page.waitForTimeout(900);
  assert(rec('S001-01').crops[0].status === 'approved', 'approved');

  // a click with a little jitter on a box selects it but never moves it
  await page.waitForFunction(() => document.querySelector('#src').naturalWidth > 0 && document.querySelector('#ov rect[stroke]'));
  const r2 = await page.locator('#src').boundingBox();
  const b2 = rec('S001-02').crops[0].box;
  const before2 = raw('S001-02');
  const jx = r2.x + (b2.x + b2.w / 2) * r2.width, jy = r2.y + (b2.y + b2.h / 2) * r2.height;
  await page.mouse.move(jx, jy);
  await page.mouse.down();
  await page.mouse.move(jx + 2, jy + 1);
  await page.mouse.move(jx + 0.4, jy);
  await page.mouse.up();
  await page.waitForTimeout(1100);
  assert(raw('S001-02') === before2, 'jitter click changed the record');
  assert(await page.locator('#save-state').textContent() === 'Saved', 'jitter: nothing unsaved');

  // A -> B -> A while A's save is still in flight must not end in a false conflict
  const x0 = rec('S001-02').crops[0].box.x;
  const slow = async (route) => { if (route.request().method() === 'POST') await sleep(700); await route.continue(); };
  await page.route('**/api/records/**', slow);
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => { location.hash = '#/edit/S001-03/S001-03'; });
  await page.waitForFunction(() => document.querySelector('#ed-id').textContent === 'S001-03');
  await page.evaluate(() => { location.hash = '#/edit/S001-02/S001-02'; });
  await page.waitForFunction(() => document.querySelector('#ed-id').textContent === 'S001-02');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  await page.unroute('**/api/records/**', slow);
  const x2 = rec('S001-02').crops[0].box.x;
  assert(Math.abs(x2 - (x0 + 0.005)) < 1e-4, `both nudges saved: ${x0} -> ${x2}`);

  // a refused save (4xx) keeps the edit and asks before it is dropped
  const refuse = (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"nope"}' }) : route.continue());
  await page.route('**/api/records/**', refuse);
  const dialogs = [];
  const dismiss = (d) => { dialogs.push(d.message()); d.dismiss(); };
  page.on('dialog', dismiss);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => /Not saved: nope/.test(document.querySelector('#save-state').textContent), null, { timeout: 5000 });
  await page.evaluate(() => { location.hash = '#/edit/S001-03/S001-03'; });
  await page.waitForTimeout(300);
  assert(dialogs.length === 1, 'asked before dropping a refused edit');
  assert(await page.locator('#ed-id').textContent() === 'S001-02', 'stayed on the unsaved record');
  assert(await page.evaluate(() => location.hash) === '#/edit/S001-02/S001-02', 'hash restored');
  page.off('dialog', dismiss);
  await page.unroute('**/api/records/**', refuse);
  await page.keyboard.press('ArrowUp'); // next edit retries and succeeds
  await page.waitForTimeout(900);
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 5000 });
  await page.evaluate(() => { location.hash = '#/edit/S001-03/S001-03'; });
  await page.waitForFunction(() => document.querySelector('#ed-id').textContent === 'S001-03');
  assert(dialogs.length === 1, 'no question once saved');

  // legacy: an arrow key turns it into a centred crop box
  await page.goto(url + '#/edit/old/old');
  await page.waitForSelector('#pv400i:not([hidden])');
  await shot(page, 'editor-legacy');
  // wheel and plain clicks/taps on a legacy picture never convert it
  const legacyBefore = raw('old');
  const lr = await page.locator('#src').boundingBox();
  await page.mouse.move(lr.x + lr.width / 2, lr.y + lr.height / 2);
  await page.mouse.wheel(0, 3);
  await page.mouse.wheel(0, -120);
  const prevented = await page.evaluate(() => {
    const ev = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    document.querySelector('#ov').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert(!prevented, 'wheel over a legacy picture scrolls the page');
  await page.mouse.click(lr.x + 2, lr.y + 2);
  await page.mouse.click(lr.x + lr.width / 2, lr.y + lr.height / 2);
  await page.mouse.move(lr.x + 50, lr.y + 50);
  await page.mouse.down();
  await page.mouse.move(lr.x + 52, lr.y + 51);
  await page.mouse.up();
  await page.waitForTimeout(1100);
  assert(raw('old') === legacyBefore, 'legacy record untouched by wheel/click');
  assert(await page.locator('#pv400i:not([hidden])').count() === 1, 'still a legacy preview');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(1000);
  c = rec('old').crops[0];
  assert(c.mode === 'crop' && c.status === 'adjusted' && c.box.w === 1 && c.history[0].mode === 'legacy', 'legacy -> crop');

  // phone layout
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(url);
  await phone.waitForSelector('.tile');
  await shot(phone, 'queue-phone');
  await phone.goto(url + '#/edit/S001-02/S001-02');
  await phone.waitForSelector('#ov rect[stroke]');
  await phone.waitForTimeout(300);
  await shot(phone, 'editor-phone');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no horizontal scroll on phone');

  await browser.close();
  if (errors.length) throw new Error('page errors: ' + errors.join('\n'));
  console.log('browser ok');
})().catch((e) => { console.error(e); process.exit(1); });
"""


def node_playwright():
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        return None
    try:
        root = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not (pathlib.Path(root) / "playwright").is_dir():
        return None
    return node, root


class BrowserTest(StudioBase):
    def test_ui(self):
        found = node_playwright()
        if not found:
            self.skipTest("node playwright not available")
        node, root = found
        script = self.repo / "browser_test.js"
        script.write_text(BROWSER_JS)
        env = dict(os.environ, NODE_PATH=root)
        shots = os.environ.get("STUDIO_SHOTS", "")
        if shots:
            os.makedirs(shots, exist_ok=True)
        res = subprocess.run([node, str(script), self.url, str(self.repo), shots],
                             capture_output=True, text=True, env=env, timeout=180)
        if res.returncode != 0 and "Executable doesn't exist" in res.stderr:
            self.skipTest("playwright browser not installed")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)


if __name__ == "__main__":
    unittest.main()
