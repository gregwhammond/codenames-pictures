#!/usr/bin/env python3
"""Crop Studio: a small local web tool to review and edit crop records.

Usage:
    python3 scripts/studio.py [--port 8765] [--lan]

By default it listens on 127.0.0.1 only. With --lan it listens on every
interface (so a phone or tablet on the same network can use it) and requires
a random token: open the printed URL once, after which a cookie carries it.

The studio only ever writes art/crops/<id>.json (through croplib.save_record).
Originals are never touched. Endpoints:

    GET  /                          the app (static files from tools/studio)
    GET  /api/records               every record + "version", "source_missing", "image_size"
    GET  /api/source/<id>.jpg       rotated original, max 1600 px (?small=1: 480 px, ?rotate=)
    GET  /api/heatmap/<id>.png      autocrop heat map overlay (404 when unavailable)
    GET  /api/tile/<id>/<tile>.jpg  exact 400 px render (?mode=&box=x,y,w,h&rotate=)
    POST /api/records/<id>          {"version": ..., "record": {...}} -> save, 409 on conflict
"""
import argparse
import collections
import hashlib
import hmac
import http.cookies
import http.server
import io
import json
import mimetypes
import pathlib
import secrets
import socket
import sys
import threading
import traceback
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import croplib  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402

# Match scripts/import_picks.py: museum scans fetched by the importer can be far
# above Pillow's default decompression-bomb limit (~179 MP), and one such file
# must not break the studio.
Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, 600_000_000)

STATIC_DIR = HERE.parent / "tools" / "studio"
SOURCE_MAX = 1600
SMALL_MAX = 480
HEAT_MAX = 800
MAX_BODY = 2 * 1024 * 1024
COOKIE = "studio_token"


class LRU:
    """A tiny thread-safe LRU cache."""

    def __init__(self, size):
        self.size = size
        self.data = collections.OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.size:
                self.data.popitem(last=False)
        return value


SOURCE_CACHE = LRU(96)      # encoded JPEG bytes of downscaled sources
FULL_CACHE = LRU(4)         # full-size opened sources, for exact tile renders
FULL_CACHE_MAX_PIXELS = 40_000_000  # bigger sources are not kept in FULL_CACHE
TILE_CACHE = LRU(256)       # encoded tile previews
HEAT_CACHE = LRU(64)        # encoded heat map PNGs
SIZE_CACHE = LRU(4096)      # (path, mtime) -> oriented size
SAVE_LOCK = threading.Lock()

_autocrop = None
_autocrop_failed = False


def get_autocrop():
    """Import the sibling autocrop script lazily; None when it is unavailable."""
    global _autocrop, _autocrop_failed
    if _autocrop is None and not _autocrop_failed:
        try:
            import autocrop  # noqa: F401
            _autocrop = autocrop
        except Exception:
            _autocrop_failed = True
    return _autocrop


# ---------- records ----------

def record_file(rid):
    return croplib.CROPS_DIR / f"{rid}.json"


def read_record(rid):
    """(record, version) for a record id, or (None, None) when missing."""
    path = record_file(rid)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None, None
    return json.loads(data), hashlib.sha256(data).hexdigest()


def oriented_size(record):
    """Size of the rotated original (what boxes are fractions of), read from
    the file header so EXIF orientation is respected; falls back to the record."""
    path = croplib.source_path(record)
    rot = record.get("rotate", 0)
    try:
        st = path.stat()
        key = (str(path), st.st_mtime_ns, st.st_size)
        size = SIZE_CACHE.get(key)
        if size is None:
            with Image.open(path) as im:
                w, h = im.size
                try:
                    orient = im.getexif().get(0x0112, 1)
                except Exception:
                    orient = 1
            size = SIZE_CACHE.put(key, (h, w) if orient in (5, 6, 7, 8) else (w, h))
    except Exception as e:  # unreadable, truncated, decompression bomb ...
        if not isinstance(e, FileNotFoundError):
            print(f"studio: cannot read size of {path}: {type(e).__name__}: {e}", file=sys.stderr)
        size = tuple(record.get("source_size") or (1, 1))
    w, h = size
    return [h, w] if rot in (90, 270) else [w, h]


def list_records():
    out = []
    if not croplib.CROPS_DIR.is_dir():
        return out
    for path in sorted(croplib.CROPS_DIR.glob("*.json")):
        if path.name.startswith("."):
            continue
        try:
            data = path.read_bytes()
            rec = json.loads(data)
        except (OSError, ValueError) as e:
            print(f"studio: skipping {path.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(rec, dict) or not isinstance(rec.get("source"), str):
            continue
        rec["version"] = hashlib.sha256(data).hexdigest()
        try:
            rec["source_missing"] = not croplib.source_path(rec).is_file()
            rec["image_size"] = oriented_size(rec)
        except Exception as e:  # one bad record must not break the whole list
            print(f"studio: {path.name}: {type(e).__name__}: {e}", file=sys.stderr)
            rec["source_missing"] = True
            size = rec.get("source_size")
            rec["image_size"] = list(size) if isinstance(size, list) and len(size) == 2 else [1, 1]
        out.append(rec)
    return out


IMMUTABLE = ("id", "source", "source_sha256", "source_size")


def check_update(rid, old, new):
    """Raise ValueError if `new` is not an acceptable edit of `old`."""
    if not isinstance(new, dict):
        raise ValueError("record must be an object")
    for key in IMMUTABLE:
        if new.get(key) != old.get(key):
            raise ValueError(f"{key} cannot be changed in the studio")
    croplib.validate_record(new)
    allowed = {croplib.extra_tile_name(rid, i) for i in range(25)}
    for c in new["crops"]:
        if c["tile"] not in allowed:
            raise ValueError(f"tile {c['tile']!r} must be {rid} or {rid}-b, -c ...")
        hist = c.get("history")
        if hist is not None and not isinstance(hist, list):
            raise ValueError(f"{c['tile']}: history must be a list")


def save(rid, version, record):
    """Returns (status, payload)."""
    with SAVE_LOCK:
        current, cur_version = read_record(rid)
        if current is None:
            return 404, {"error": f"no record {rid}"}
        if version != cur_version:
            return 409, {"error": "changed on disk", "record": current, "version": cur_version}
        record = {k: v for k, v in record.items()
                  if k not in ("version", "source_missing", "image_size")} if isinstance(record, dict) else record
        try:
            check_update(rid, current, record)
        except (ValueError, TypeError, KeyError) as e:
            return 400, {"error": str(e)}
        croplib.save_record(record)
        saved, new_version = read_record(rid)
        return 200, {"record": saved, "version": new_version}


# ---------- images ----------

def query_rotate(query, record):
    rot = query.get("rotate", [None])[0]
    if rot is None or rot == "":
        return record.get("rotate", 0)
    rot = int(rot)
    if rot not in croplib.ROTATIONS:
        raise ValueError("bad rotate")
    return rot


def encode(im, fmt, **kw):
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    return buf.getvalue()


def source_jpeg(record, rotate, small):
    key = (record["id"], record.get("source_sha256"), rotate, small)
    data = SOURCE_CACHE.get(key)
    if data is None:
        im = croplib.open_source(dict(record, rotate=rotate))
        m = SMALL_MAX if small else SOURCE_MAX
        if max(im.size) > m:
            im = ImageOps.contain(im, (m, m), method=Image.LANCZOS)
        data = SOURCE_CACHE.put(key, encode(im, "JPEG", quality=85 if not small else 80))
    return data


def full_source(record, rotate, legacy):
    key = (record["id"], record.get("source_sha256"), rotate, legacy)
    im = FULL_CACHE.get(key)
    if im is None:
        rec = dict(record, rotate=rotate)
        im = croplib.legacy_prepare(rec) if legacy else croplib.open_source(rec)
        if im.width * im.height <= FULL_CACHE_MAX_PIXELS:
            FULL_CACHE.put(key, im)
    return im


def parse_box(text):
    parts = [float(p) for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError("box needs x,y,w,h")
    box = dict(zip("xywh", parts))
    croplib.check_box(box)
    return box


def tile_jpeg(record, tile, query):
    rotate = query_rotate(query, record)
    crop = next((c for c in record["crops"] if c.get("tile") == tile), None)
    crop = dict(crop) if crop else {"tile": tile, "mode": "crop", "box": None}
    mode = query.get("mode", [crop.get("mode")])[0]
    if mode not in croplib.MODES:
        raise ValueError("bad mode")
    crop["mode"] = mode
    if "box" in query:
        crop["box"] = parse_box(query["box"][0])
    if mode == "crop":
        croplib.check_box(crop.get("box"))
    box = tuple(crop["box"][k] for k in "xywh") if mode == "crop" else None
    key = (record["id"], record.get("source_sha256"), rotate, mode, box)
    data = TILE_CACHE.get(key)
    if data is None:
        prepared = full_source(record, rotate, mode == "legacy")
        rec = dict(record, rotate=rotate)
        im = croplib.render(rec, crop, croplib.TILE_SIZE, prepared)
        data = TILE_CACHE.put(key, encode(im, "JPEG", quality=85))
    return data


def heat_png(record, rotate):
    ac = get_autocrop()
    if ac is None or not hasattr(ac, "heatmap"):
        return None
    key = (record["id"], record.get("source_sha256"), rotate)
    data = HEAT_CACHE.get(key)
    if data is not None:
        return data
    import numpy as np
    im = croplib.open_source(dict(record, rotate=rotate))
    if max(im.size) > HEAT_MAX:
        im = ImageOps.contain(im, (HEAT_MAX, HEAT_MAX), method=Image.LANCZOS)
    heat = ac.heatmap(im)
    if heat.size != im.size:
        heat = heat.resize(im.size, Image.BILINEAR)
    v = np.asarray(heat.convert("L"), dtype=np.float32) / 255.0
    # low = transparent blue, middle = yellow, high = red
    r = np.clip(v * 2, 0, 1)
    g = np.clip(2 - v * 2, 0, 1) * np.clip(v * 3, 0, 1)
    b = np.clip(1 - v * 3, 0, 1)
    a = np.clip((v - 0.2) / 0.8, 0, 1) ** 1.3 * 0.8
    rgba = (np.dstack([r, g, b, a]) * 255).astype(np.uint8)
    return HEAT_CACHE.put(key, encode(Image.fromarray(rgba, "RGBA"), "PNG", optimize=False))


# ---------- HTTP ----------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CropStudio/1"
    token = None          # set when --lan
    allowed_hosts = None  # set when bound to localhost (DNS rebinding guard)
    quiet = False

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)

    # responses

    def send(self, status, body, ctype, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if getattr(self, "_set_cookie", None):
            self.send_header("Set-Cookie", self._set_cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, status, obj):
        self.send(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8",
                  {"Cache-Control": "no-store"})

    def error(self, status, msg):
        self.json(status, {"error": msg})

    # access control

    def authorised(self, query):
        host = (self.headers.get("Host") or "").lower()
        if self.allowed_hosts is not None and host not in self.allowed_hosts:
            self.error(403, "bad host")
            return False
        if self.token is None:
            return True
        given = query.get("token", [None])[0]
        if given and hmac.compare_digest(given, self.token):
            # Lax, not Strict: a link followed from a web mail/chat page is a
            # cross-site navigation, and Strict would drop the cookie on the
            # redirect to "/". POSTs stay protected by the Origin and
            # application/json checks in _post.
            self._set_cookie = f"{COOKIE}={self.token}; Path=/; HttpOnly; SameSite=Lax"
            return True
        cookies = http.cookies.SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            pass
        c = cookies.get(COOKIE)
        if c and hmac.compare_digest(c.value, self.token):
            return True
        self.send(401, b"Crop Studio: open the URL with ?token=... printed by studio.py\n",
                  "text/plain; charset=utf-8")
        return False

    def parse(self):
        u = urllib.parse.urlsplit(self.path)
        return urllib.parse.unquote(u.path), urllib.parse.parse_qs(u.query), u

    def run(self, fn):
        try:
            fn()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never kill the server thread silently
            traceback.print_exc()
            try:
                self.error(500, f"{type(e).__name__}: {e}")
            except Exception:
                pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.run(self._get)

    def do_POST(self):
        self.run(self._post)

    def _get(self):
        path, query, u = self.parse()
        if not self.authorised(query):
            return
        if "token" in query and not path.startswith("/api/"):
            # Drop the token from the address bar once the cookie is set.
            rest = [(k, v) for k, vs in query.items() if k != "token" for v in vs]
            loc = u.path + ("?" + urllib.parse.urlencode(rest) if rest else "")
            self.send(303, b"", "text/plain", {"Location": loc or "/", "Cache-Control": "no-store"})
            return
        if path == "/api/records":
            return self.json(200, list_records())
        parts = path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "source"] and parts[3].endswith(".jpg"):
            return self.image(parts[3][:-4], query, "source")
        if len(parts) == 4 and parts[1:3] == ["api", "heatmap"] and parts[3].endswith(".png"):
            return self.image(parts[3][:-4], query, "heat")
        if len(parts) == 5 and parts[1:3] == ["api", "tile"] and parts[4].endswith(".jpg"):
            return self.image(parts[3], query, "tile", parts[4][:-4])
        if path.startswith("/api/"):
            return self.error(404, "not found")
        return self.static(path)

    def image(self, rid, query, kind, tile=None):
        if not croplib.TILE_RE.match(rid) or (tile is not None and not croplib.TILE_RE.match(tile)):
            return self.error(400, "bad id")
        try:
            record, _ = read_record(rid)
        except ValueError:
            return self.error(500, "record is not valid JSON")
        if record is None:
            return self.error(404, "no such record")
        if not croplib.source_path(record).is_file():
            return self.error(404, "source missing")
        try:
            rotate = query_rotate(query, record)
            if kind == "source":
                data, ctype = source_jpeg(record, rotate, query.get("small", ["0"])[0] == "1"), "image/jpeg"
            elif kind == "tile":
                data, ctype = tile_jpeg(record, tile, query), "image/jpeg"
            else:
                try:
                    data = heat_png(record, rotate)
                except Exception as e:
                    print(f"studio: heat map failed for {rid}: {e}", file=sys.stderr)
                    data = None
                if data is None:
                    return self.error(404, "heat map unavailable")
                ctype = "image/png"
        except ValueError as e:
            return self.error(400, str(e))
        # URLs carry v=<sha> and rotate, so the bytes for a URL never change.
        cache = "private, max-age=86400" if "v" in query else "no-cache"
        self.send(200, data, ctype, {"Cache-Control": cache})

    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        if "\x00" in rel:
            return self.error(404, "not found")
        root = STATIC_DIR.resolve()
        target = (root / rel).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            return self.error(404, "not found")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    def _post(self):
        path, query, _ = self.parse()
        if not self.authorised(query):
            return
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlsplit(origin).netloc.lower() != (self.headers.get("Host") or "").lower():
            return self.error(403, "cross-origin request")
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.error(415, "send application/json")
        parts = path.split("/")
        if len(parts) != 4 or parts[1:3] != ["api", "records"]:
            return self.error(404, "not found")
        rid = parts[3]
        if not croplib.TILE_RE.match(rid):
            return self.error(400, "bad id")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.error(400, "bad length")
        if length <= 0 or length > MAX_BODY:
            return self.error(413 if length > MAX_BODY else 400, "bad body size")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return self.error(400, "body is not JSON")
        if not isinstance(body, dict) or "record" not in body:
            return self.error(400, "expected {version, record}")
        try:
            status, payload = save(rid, body.get("version"), body["record"])
        except ValueError:
            return self.error(500, "record on disk is not valid JSON")
        self.json(status, payload)


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent
            return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())


def make_server(port=8765, lan=False, token=None, quiet=False):
    """Build (but do not start) the server. Returns (server, url)."""
    host = "0.0.0.0" if lan else "127.0.0.1"

    class H(Handler):
        pass

    H.quiet = quiet
    if lan:
        H.token = token or secrets.token_urlsafe(16)
    srv = http.server.ThreadingHTTPServer((host, port), H)
    srv.daemon_threads = True
    real_port = srv.server_address[1]
    if lan:
        url = f"http://{lan_ip()}:{real_port}/?token={H.token}"
    else:
        H.allowed_hosts = {f"{h}:{real_port}" for h in ("127.0.0.1", "localhost", "[::1]")}
        url = f"http://127.0.0.1:{real_port}/"
    return srv, url


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true",
                    help="listen on all interfaces and require a token (for phones/tablets)")
    ap.add_argument("--quiet", action="store_true", help="do not log requests")
    args = ap.parse_args(argv)
    srv, url = make_server(args.port, args.lan, quiet=args.quiet)
    n = len(list(croplib.CROPS_DIR.glob("*.json"))) if croplib.CROPS_DIR.is_dir() else 0
    print(f"Crop Studio: {n} records in {croplib.CROPS_DIR}")
    print(f"Open {url}")
    if args.lan:
        print("Anyone on your network with this link can edit crops. Ctrl-C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
