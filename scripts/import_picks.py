#!/usr/bin/env python3
"""Import Greg's accepted picks as originals plus crop records.

Usage:
    python3 scripts/import_picks.py --picks PICKS [--sources PATH] [--bundles DIR]
        [--fetch] [--min-side 1200] [--refresh] [--dry-run] [--only S014,S020-03]

PICKS is a JSON file {"S014": {"imgs": [...], "skip": [...], "swap": [...]}, ...}
or a directory of per-collection documents (S014.json, each with imgs/skip/swap,
possibly wrapped in another object or a JSON string).

For every index in "imgs" the picture id is <collection>-<index:02d>
(S014-05). When the index is also in "swap", the entry's "suggest" picture
(title/url/note) is used instead of the original entry.

Getting the picture:
  --fetch   download the full-size file from the entry's url (Wikimedia
            Commons "File:" pages are resolved through the MediaWiki API,
            direct image links are downloaded, other pages via og:image);
  otherwise, or when fetching fails, the bundle image (--bundles DIR holding
  Snnn.json maps of index -> data URI) is used. Swapped entries have no bundle
  image, so they need --fetch.

Files are saved as originals/<id>.<ext> (the exact bytes, never re-encoded;
originals/ is git-ignored). A new record art/crops/<id>.json is created with
a "fit" placeholder crop that autocrop.update_record fills with proposals.

Existing files and records are kept. With --refresh a picture that differs
from the stored original replaces it (the old file is moved to
originals/replaced/, never deleted) and the record's source is updated; its
approved/adjusted crops become "adjusted" so they get looked at again, and
rejected crops stay rejected. A bundle image never replaces an existing
original (it is the low-resolution copy), and never re-points a record whose
original is missing (e.g. a fresh checkout): that pick fails until --fetch
gets the real file.

When a pick names another picture than its record was made from (the index
was marked swap after import), it is reported as "entry changed"; with
--refresh the new picture gets a fresh record (autocrop proposals only) and
the old original and record are moved to originals/replaced/.

Met images.metmuseum.org preview renditions are upgraded to /original/; picks
that still end up low resolution after taking a page's og:image are listed so
they can be sourced by hand.

--dry-run reads and downloads but writes nothing.
"""
import argparse
import base64
import binascii
import hashlib
import html.parser
import http.client
import io
import json
import os
import pathlib
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import croplib  # noqa: E402
from PIL import Image  # noqa: E402

# Full-size scans from Commons can be very large; they are only read here.
Image.MAX_IMAGE_PIXELS = 600_000_000

DEFAULT_SOURCES = pathlib.Path(
    "/mnt/project-files/analysis/picture-clusters/fantastical-sources/sources_numbered.json")
USER_AGENT = ("CodenamesPicturesImport/1.0 (personal board game picture import; "
              "python-urllib/%d.%d)" % sys.version_info[:2])
if os.environ.get("IMPORT_CONTACT"):
    USER_AGENT += " contact: " + os.environ["IMPORT_CONTACT"]
TIMEOUT = 30
RETRIES = 3
BACKOFF = 1.5
MAX_BYTES = 250 * 1024 * 1024
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".gif", ".bmp"}
FORMAT_EXT = {"JPEG": "jpg", "PNG": "png", "TIFF": "tif", "WEBP": "webp",
              "GIF": "gif", "BMP": "bmp", "JPEG2000": "jp2"}
PICTURE_ID_RE = re.compile(r"^(S\d+)-(\d+)$")
COLLECTION_RE = re.compile(r"^S\d+$")

_sleep = time.sleep  # replaced in tests


class FetchError(Exception):
    pass


def originals_dir():
    return croplib.REPO / "originals"


def picture_id(cid, index):
    return f"{cid}-{int(index):02d}"


# ---------- picks, sources, bundles ----------

def _unwrap(doc, cid=None, depth=0):
    """Find the {imgs, skip, swap} object inside a possibly wrapped document."""
    if depth > 4:
        return None
    if isinstance(doc, str):
        try:
            doc = json.loads(doc)
        except ValueError:
            return None
    if not isinstance(doc, dict):
        return None
    if isinstance(doc.get("imgs"), list):
        return doc
    if cid and cid in doc:
        found = _unwrap(doc[cid], None, depth + 1)
        if found:
            return found
    for key in ("value", "data", "picks", "doc", "state"):
        if key in doc:
            found = _unwrap(doc[key], cid, depth + 1)
            if found:
                return found
    for v in doc.values():
        if isinstance(v, (dict, str)):
            found = _unwrap(v, cid, depth + 1)
            if found:
                return found
    return None


def _clean_pick(p):
    def ints(xs):
        out = []
        for x in xs or []:
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                pass
        return out
    return {"imgs": ints(p.get("imgs")), "skip": ints(p.get("skip")), "swap": ints(p.get("swap"))}


def load_picks(path):
    """{collection id: {imgs, skip, swap}} from a file or a directory."""
    path = pathlib.Path(path)
    picks = {}
    if path.is_dir():
        for f in sorted(path.rglob("*.json")):
            cid = f.stem
            if not COLLECTION_RE.match(cid):
                continue
            with open(f, encoding="utf-8") as fh:
                p = _unwrap(json.load(fh), cid)
            if p is None:
                print(f"warning: {f}: no imgs list found, skipped", file=sys.stderr)
                continue
            picks[cid] = _clean_pick(p)
        return picks
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    if isinstance(doc, dict) and not isinstance(doc.get("imgs"), list):
        for cid, v in doc.items():
            if not COLLECTION_RE.match(str(cid)):
                continue
            p = _unwrap(v, cid)
            if p is not None:
                picks[cid] = _clean_pick(p)
    if not picks:
        raise ValueError(f"{path}: no picks found")
    return picks


def load_sources(path):
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    if isinstance(doc, dict):
        doc = doc.get("collections") or doc.get("sources") or list(doc.values())
    return {c["id"]: c for c in doc if isinstance(c, dict) and "id" in c}


class Bundles:
    """Lazily loaded Snnn.json maps of image index -> data URI."""

    def __init__(self, folder):
        self.files = {}
        if folder:
            for f in sorted(pathlib.Path(folder).rglob("*.json")):
                if COLLECTION_RE.match(f.stem):
                    self.files.setdefault(f.stem, []).append(f)
        self.cache = {}

    def get(self, cid, index):
        if cid not in self.cache:
            merged = {}
            for f in self.files.get(cid, []):
                try:
                    with open(f, encoding="utf-8") as fh:
                        doc = json.load(fh)
                except (OSError, ValueError) as err:
                    print(f"warning: bundle {f}: {err}", file=sys.stderr)
                    continue
                if isinstance(doc, list):
                    doc = {str(i): v for i, v in enumerate(doc)}
                if isinstance(doc, dict):
                    for k, v in doc.items():
                        merged.setdefault(str(k), v)
            self.cache[cid] = merged
        uri = self.cache[cid].get(str(index))
        if not uri:
            return None
        return decode_data_uri(uri)


def decode_data_uri(uri):
    if not isinstance(uri, str) or not uri.startswith("data:") or "," not in uri:
        return None
    head, data = uri.split(",", 1)
    try:
        if head.endswith(";base64"):
            return base64.b64decode(data, validate=False)
        return urllib.parse.unquote_to_bytes(data)
    except (binascii.Error, ValueError):
        return None


# ---------- images ----------

def image_info(data):
    """(ext, (w, h) after EXIF orientation) for image bytes, or raise ValueError."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()  # must come straight after open
        with Image.open(io.BytesIO(data)) as im:
            fmt = im.format
            w, h = im.size
            try:
                orient = im.getexif().get(0x0112)
            except Exception:  # noqa: BLE001 - broken EXIF is not fatal
                orient = None
    except Exception as err:  # noqa: BLE001
        raise ValueError(f"not a readable image ({err})") from None
    ext = FORMAT_EXT.get(fmt)
    if not ext:
        raise ValueError(f"unsupported image format {fmt}")
    if orient in (5, 6, 7, 8):
        w, h = h, w
    return ext, (w, h)


# ---------- network ----------

def _request(url, accept=None):
    """GET url with retries; returns (bytes, content type, final url)."""
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    last = None
    for attempt in range(RETRIES):
        if attempt:
            _sleep(delay)
        delay = BACKOFF * (2 ** attempt)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise FetchError(f"{url}: larger than {MAX_BYTES >> 20} MB")
                # read(n) returns short data, without an error, when the
                # connection drops before Content-Length bytes arrived.
                clen = (resp.headers.get("Content-Length") or "").strip()
                if clen.isdigit() and not resp.headers.get("Content-Encoding") and len(data) < int(clen):
                    raise http.client.IncompleteRead(data, int(clen) - len(data))
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                return data, ctype, resp.geturl() if hasattr(resp, "geturl") else url
        except urllib.error.HTTPError as err:
            last = f"HTTP {err.code}"
            if err.code not in (408, 425, 429, 500, 502, 503, 504):
                break
            retry_after = err.headers.get("Retry-After") if err.headers else None
            if retry_after and retry_after.isdigit():
                delay = min(60, max(delay, int(retry_after)))
        except FetchError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError, ValueError,
                http.client.HTTPException) as err:
            # HTTPException covers IncompleteRead, BadStatusLine, LineTooLong.
            last = str(getattr(err, "reason", err)) or type(err).__name__
    raise FetchError(f"{url}: {last}")


def commons_file_title(url):
    """(api url, 'File:...') for a MediaWiki file page URL, else None."""
    u = urllib.parse.urlsplit(url)
    host = u.netloc.lower()
    if not (host.endswith("wikimedia.org") or host.endswith("wikipedia.org")) or host == "upload.wikimedia.org":
        return None
    title = None
    if u.path.startswith("/wiki/"):
        title = urllib.parse.unquote(u.path[len("/wiki/"):])
    else:
        q = urllib.parse.parse_qs(u.query)
        if q.get("title"):
            title = q["title"][0]
    if not title:
        return None
    ns, sep, name = title.partition(":")
    if not sep or ns.lower() not in ("file", "image", "datei", "fichier", "archivo"):
        return None
    return f"https://{host}/w/api.php", "File:" + name.replace("_", " ")


def resolve_commons(api, title):
    params = urllib.parse.urlencode({
        "action": "query", "prop": "imageinfo", "iiprop": "url|size|mime",
        "titles": title, "format": "json"})
    data, _, _ = _request(f"{api}?{params}", accept="application/json")
    try:
        doc = json.loads(data.decode("utf-8"))
        pages = doc["query"]["pages"]
    except (ValueError, KeyError, TypeError):
        raise FetchError(f"{title}: unexpected API response") from None
    for page in (pages.values() if isinstance(pages, dict) else pages):
        infos = page.get("imageinfo") or []
        if infos and infos[0].get("url"):
            info = infos[0]
            mime = info.get("mime") or ""
            if mime and not mime.startswith("image/"):
                raise FetchError(f"{title}: not an image ({mime})")
            if mime in ("image/svg+xml", "image/vnd.djvu"):
                raise FetchError(f"{title}: unsupported image type {mime}")
            return info["url"]
    raise FetchError(f"{title}: file not found on {urllib.parse.urlsplit(api).netloc}")


_MET_RENDITIONS = ("/web-large/", "/mobile-large/", "/web-additional/")


def original_from_thumb(url):
    """Thumbnail/preview URL -> the original file URL.

    upload.wikimedia.org thumbnails lose their /thumb/ and size parts; Met
    images.metmuseum.org renditions (web-large etc., ~800px) become /original/.
    """
    u = urllib.parse.urlsplit(url)
    if u.netloc.lower() == "images.metmuseum.org":
        for part in _MET_RENDITIONS:
            if part in u.path:
                return urllib.parse.urlunsplit(u._replace(path=u.path.replace(part, "/original/", 1)))
        return url
    if u.netloc.lower() != "upload.wikimedia.org" or "/thumb/" not in u.path:
        return url
    path = u.path.replace("/thumb/", "/", 1).rsplit("/", 1)[0]
    return urllib.parse.urlunsplit((u.scheme, u.netloc, path, "", ""))


class _MetaImage(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = {}

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image") and a.get("content"):
                self.found.setdefault(key, a["content"])
        elif tag == "link" and "image_src" in a.get("rel", "").lower() and a.get("href"):
            self.found.setdefault("image_src", a["href"])


def page_image(html_bytes, base):
    p = _MetaImage()
    try:
        p.feed(html_bytes.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - malformed HTML
        pass
    for key in ("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "image_src"):
        if key in p.found:
            return urllib.parse.urljoin(base, p.found[key].strip())
    return None


def _check_image(data, url):
    try:
        image_info(data)
    except ValueError as err:
        raise FetchError(f"{url}: {err}") from None
    return data


def _fetch_image(img_url):
    data, ctype, _ = _request(img_url)
    if ctype and not ctype.startswith("image/") and ctype != "application/octet-stream":
        raise FetchError(f"{img_url}: not an image ({ctype})")
    return _check_image(data, img_url)


def via_page_image(entry_url, img_url):
    """True when img_url came from a web page's og:image (maybe a preview size)."""
    if not img_url or not entry_url or commons_file_title(entry_url):
        return False
    return img_url not in (entry_url, original_from_thumb(entry_url))


def fetch(url):
    """Download the full-size picture for an entry url; returns (bytes, url)."""
    if not url or not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise FetchError(f"no usable url ({url!r})")
    commons = commons_file_title(url)
    if commons:
        img_url = resolve_commons(*commons)
        data, _, _ = _request(img_url)
        return _check_image(data, img_url), img_url
    best = original_from_thumb(url)
    if best != url:
        try:
            return _fetch_image(best), best
        except FetchError:
            pass  # no full-size rendition there; try the url as given
    data, ctype, final = _request(url)
    ext = pathlib.PurePosixPath(urllib.parse.urlsplit(url).path).suffix.lower()
    if ctype.startswith("image/") or (ext in IMAGE_EXTS and not ctype.startswith("text/")):
        return _check_image(data, url), url
    if ctype in ("text/html", "application/xhtml+xml") or data.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
        img_url = page_image(data, final or url)
        if not img_url:
            raise FetchError(f"{url}: page has no og:image")
        commons = commons_file_title(img_url)
        if commons:
            img_url = resolve_commons(*commons)
        best = original_from_thumb(img_url)
        try:
            return _fetch_image(best), best
        except FetchError:
            if best == img_url:
                raise
        # The full-size rendition is not there; take the page's own image.
        return _fetch_image(img_url), img_url
    raise FetchError(f"{url}: not an image ({ctype or 'unknown type'})")


# ---------- files and records ----------

def _write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def existing_original(pid, record):
    """The stored original for a picture id, or None."""
    if record:
        p = croplib.REPO / record.get("source", "")
        if record.get("source") and p.is_file():
            return p
    matches = [p for p in sorted(originals_dir().glob(f"{pid}.*"))
               if p.is_file() and p.suffix.lower() in IMAGE_EXTS | {".jp2"}]
    if record and record.get("source_sha256"):
        for p in matches:
            if croplib.sha256_file(p) == record["source_sha256"]:
                return p
    return matches[0] if matches else None


def _meta(cid, index, entry, collection, obtained, image_url):
    meta = {
        "collection": cid,
        "index": index,
        "title": entry.get("title"),
        "source_url": entry.get("url"),
        "licence": collection.get("licence"),
        "note": entry.get("note"),
    }
    if image_url:
        meta["image_url"] = image_url
    if obtained:
        meta["obtained"] = obtained
    return meta


def new_record(pid, path, size, meta):
    return {
        "id": pid,
        "source": path.relative_to(croplib.REPO).as_posix(),
        "source_sha256": croplib.sha256_file(path),
        "source_size": list(size),
        "rotate": 0,
        "meta": meta,
        "crops": [{"tile": pid, "mode": "fit", "box": None, "status": "auto"}],
    }


_autocrop = None


def autocrop_module():
    """autocrop, or False when it cannot be imported (warned once)."""
    global _autocrop
    if _autocrop is None:
        try:
            import autocrop  # noqa: PLC0415
            _autocrop = autocrop if hasattr(autocrop, "update_record") else False
        except Exception as err:  # noqa: BLE001
            print(f"warning: autocrop unavailable ({err}); records keep a 'fit' placeholder", file=sys.stderr)
            _autocrop = False
    return _autocrop


def run_autocrop(record, stats):
    mod = autocrop_module()
    if not mod:
        stats["autocrop_missing"].append(record["id"])
        return record
    try:
        out = mod.update_record(record)
        return out if isinstance(out, dict) else record
    except Exception as err:  # noqa: BLE001 - keep the placeholder
        print(f"warning: {record['id']}: autocrop failed ({err}); keeping the placeholder", file=sys.stderr)
        stats["autocrop_missing"].append(record["id"])
        return record


def mark_for_review(record):
    for c in record["crops"]:
        if c.get("status") in ("approved", "adjusted"):
            c["status"] = "adjusted"


# ---------- import ----------

def _only_filter(only):
    if not only:
        return None
    return {s.strip() for s in only.split(",") if s.strip()}


def selected(only, cid, pid):
    return only is None or cid in only or pid in only


def plan(picks, sources, only):
    """(cid, index, pid, entry, swapped, collection) or an error string per pick."""
    items = []
    for cid in sorted(picks):
        p = picks[cid]
        swap = set(p["swap"])
        coll = sources.get(cid)
        for index in sorted(set(p["imgs"])):
            pid = picture_id(cid, index)
            if not selected(only, cid, pid):
                continue
            if coll is None:
                items.append((cid, index, pid, None, False, None, f"collection {cid} not in sources"))
                continue
            images = coll.get("images") or []
            if not 0 <= index < len(images):
                items.append((cid, index, pid, None, False, coll, f"index {index} out of range ({len(images)} images)"))
                continue
            entry = images[index]
            swapped = index in swap
            if swapped:
                if not isinstance(entry.get("suggest"), dict):
                    items.append((cid, index, pid, None, True, coll, "in swap but has no suggest entry"))
                    continue
                entry = entry["suggest"]
            items.append((cid, index, pid, entry, swapped, coll, None))
    return items


def acquire(cid, index, entry, swapped, bundles, do_fetch):
    """(bytes, 'fetch'|'bundle', image url) or raise FetchError with the reasons."""
    reasons = []
    if do_fetch:
        try:
            data, img_url = fetch(entry.get("url"))
            return data, "fetch", img_url
        except FetchError as err:
            reasons.append(f"fetch failed: {err}")
        except Exception as err:  # noqa: BLE001 - any network surprise: use the bundle
            reasons.append(f"fetch failed: {type(err).__name__}: {err}")
    if swapped:
        reasons.append("swapped picture has no bundle image" + ("" if do_fetch else " (use --fetch)"))
    else:
        data = bundles.get(cid, index)
        if data:
            try:
                image_info(data)
                return data, "bundle", None
            except ValueError as err:
                reasons.append(f"bundle image unusable: {err}")
        else:
            reasons.append("no bundle image" + ("" if bundles.files else " (no --bundles given)"))
    raise FetchError("; ".join(reasons))


def new_stats():
    return {k: [] for k in ("imported", "replaced", "present", "fetched", "bundle",
                            "records_created", "records_updated", "record_mismatch",
                            "low_res", "failed", "autocrop_missing", "kept_differs",
                            "entry_changed", "page_image")}


def entry_changed(record, entry):
    """True when the record was made from another picture than entry (a swap)."""
    if not record or not isinstance(record.get("meta"), dict):
        return False
    old = record["meta"].get("source_url")
    return bool(old and entry.get("url") and old != entry.get("url"))


def _set_aside(path, sha, suffix=None):
    """Move a file into originals/replaced/ (never deleted); returns the new path."""
    keep = originals_dir() / "replaced" / f"{path.stem}.{sha[:8]}{suffix or path.suffix}"
    keep.parent.mkdir(parents=True, exist_ok=True)
    os.replace(path, keep)
    return keep


def replace_entry(item, record, existing, bundles, args, stats):
    """--refresh for a pick whose entry changed: a new picture and a new record.

    The old original and the old record go to originals/replaced/; the old
    crops were drawn on another picture, so none of them are carried over.
    """
    cid, index, pid, entry, swapped, coll, _ = item
    try:
        data, how, img_url = acquire(cid, index, entry, swapped, bundles, args.fetch)
    except FetchError as err:
        stats["failed"].append((pid, f"entry changed (swap), new picture not available: {err}"))
        return
    ext, size = image_info(data)
    stats["fetched" if how == "fetch" else "bundle"].append(pid)
    if existing is not None:
        stats["replaced"].append(pid)
    stats["records_updated"].append(pid)
    if min(size) < args.min_side:
        stats["low_res"].append((pid, size))
    if how == "fetch" and via_page_image(entry.get("url"), img_url):
        stats["page_image"].append(pid)
    if args.dry_run:
        return
    old_sha = record.get("source_sha256") or "0" * 64
    if existing is not None:
        _set_aside(existing, croplib.sha256_file(existing))
    rpath = croplib.record_path(pid)
    keep = originals_dir() / "replaced" / f"{pid}.{old_sha[:8]}.record.json"
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_bytes(rpath.read_bytes())
    target = originals_dir() / f"{pid}.{ext}"
    _write_atomic(target, data)
    meta = _meta(cid, index, entry, coll, how, img_url)
    croplib.save_record(run_autocrop(new_record(pid, target, size, meta), stats))


def import_one(item, bundles, args, stats):
    cid, index, pid, entry, swapped, coll, error = item
    if error:
        stats["failed"].append((pid, error))
        return
    rpath = croplib.record_path(pid)
    record = croplib.load_record(rpath) if rpath.exists() else None
    existing = existing_original(pid, record)
    dry = args.dry_run

    if entry_changed(record, entry):
        # The pick now names another picture (e.g. marked swap after import).
        stats["entry_changed"].append(pid)
        if args.refresh:
            replace_entry(item, record, existing, bundles, args, stats)
        return

    if existing and not args.refresh:
        stats["present"].append(pid)
        ext, size = image_info(existing.read_bytes())
        if min(size) < args.min_side:
            stats["low_res"].append((pid, size))
        if record is None:
            stats["records_created"].append(pid)
            if not dry:
                rec = new_record(pid, existing, size, _meta(cid, index, entry, coll, None, None))
                croplib.save_record(run_autocrop(rec, stats))
        elif record.get("source_sha256") != croplib.sha256_file(existing):
            stats["record_mismatch"].append(pid)
        return

    try:
        data, how, img_url = acquire(cid, index, entry, swapped, bundles, args.fetch)
    except FetchError as err:
        if existing:
            stats["present"].append(pid)
            print(f"warning: {pid}: kept the stored original, refresh failed: {err}", file=sys.stderr)
        else:
            stats["failed"].append((pid, str(err)))
        return
    ext, size = image_info(data)
    sha = hashlib.sha256(data).hexdigest()
    if (how == "bundle" and existing is None and record is not None
            and record.get("source_sha256") != sha):
        # Only a fetched file or one already on disk may re-point a record;
        # the bundle preview must not stand in for the missing original.
        stats["failed"].append((pid, "only the bundle preview is available; the record expects a "
                                     "different original (run with --fetch)"))
        return
    stats["fetched" if how == "fetch" else "bundle"].append(pid)
    if how == "fetch" and via_page_image(entry.get("url"), img_url):
        stats["page_image"].append(pid)

    target = originals_dir() / f"{pid}.{ext}"
    if existing is not None:
        old_sha = croplib.sha256_file(existing)
        if old_sha == sha:
            stats["present"].append(pid)
            target = existing
        elif how == "bundle":
            # The bundle is the small preview; never let it replace an original.
            stats["present"].append(pid)
            stats["kept_differs"].append(pid)
            target = existing
            _, size = image_info(existing.read_bytes())
            sha = old_sha
        else:
            stats["replaced"].append(pid)
            if not dry:
                _set_aside(existing, old_sha)
                _write_atomic(target, data)
    else:
        stats["imported"].append(pid)
        if not dry:
            _write_atomic(target, data)

    if min(size) < args.min_side:
        stats["low_res"].append((pid, size))

    meta = _meta(cid, index, entry, coll, how, img_url)
    if record is None:
        stats["records_created"].append(pid)
        if not dry:
            croplib.save_record(run_autocrop(new_record(pid, target, size, meta), stats))
        return
    if record.get("source_sha256") == sha:
        return
    if not args.refresh:
        stats["record_mismatch"].append(pid)
        return
    stats["records_updated"].append(pid)
    if dry:
        return
    record["source"] = target.relative_to(croplib.REPO).as_posix()
    record["source_sha256"] = sha
    record["source_size"] = list(size)
    old_meta = record.get("meta") if isinstance(record.get("meta"), dict) else {}
    record["meta"] = {**old_meta, **{k: v for k, v in meta.items() if v is not None}}
    mark_for_review(record)
    croplib.save_record(run_autocrop(record, stats))


def run(args):
    if args.sources is None:
        if not DEFAULT_SOURCES.exists():
            raise SystemExit("error: --sources is required (default file not found)")
        args.sources = DEFAULT_SOURCES
    picks = load_picks(args.picks)
    sources = load_sources(args.sources)
    bundles = Bundles(args.bundles)
    only = _only_filter(args.only)
    items = plan(picks, sources, only)
    stats = new_stats()
    for item in items:
        try:
            import_one(item, bundles, args, stats)
        except Exception as err:  # noqa: BLE001 - report and carry on
            stats["failed"].append((item[2], f"{type(err).__name__}: {err}"))
    return items, stats


def report(items, stats, args, out=sys.stdout):
    def p(*a):
        print(*a, file=out)
    prefix = "[dry run] would have " if args.dry_run else ""
    p(f"{prefix}picks considered: {len(items)}")
    p(f"  imported (new originals): {len(stats['imported'])}")
    if stats["replaced"]:
        p(f"  replaced (--refresh): {len(stats['replaced'])}")
    p(f"  already present: {len(set(stats['present']))}")
    p(f"  source: fetched {len(stats['fetched'])}, bundle {len(stats['bundle'])}")
    p(f"  records created: {len(stats['records_created'])}, updated: {len(stats['records_updated'])}")
    if stats["kept_differs"]:
        p(f"  kept stored original (bundle image differs): {', '.join(stats['kept_differs'])}")
    if stats["entry_changed"]:
        tail = "replaced (old record kept in originals/replaced/)" if args.refresh \
            else "kept the old picture; run with --fetch --refresh to replace it"
        p(f"  entry changed since import (swap), {tail}: {', '.join(stats['entry_changed'])}")
    if stats["record_mismatch"]:
        p(f"  records whose sha differs from the original (run with --refresh): "
          f"{', '.join(stats['record_mismatch'])}")
    if stats["autocrop_missing"]:
        p(f"  records left with a 'fit' placeholder (no autocrop): {len(stats['autocrop_missing'])}")
    low = stats["low_res"]
    p(f"  low resolution (short side < {args.min_side}px): {len(low)}")
    for pid, (w, h) in low[:20]:
        p(f"    {pid}: {w}x{h}")
    if len(low) > 20:
        p(f"    ... and {len(low) - 20} more")
    rough = [pid for pid, _ in low if pid in set(stats["page_image"])]
    if rough:
        p(f"  low resolution, taken from a web page's preview image (source by hand): {', '.join(rough)}")
    p(f"  failed: {len(stats['failed'])}")
    for pid, why in stats["failed"]:
        p(f"    {pid}: {why}")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--picks", required=True, help="picks JSON file or directory of Snnn.json")
    ap.add_argument("--sources", type=pathlib.Path, default=None,
                    help=f"sources_numbered.json (default {DEFAULT_SOURCES})")
    ap.add_argument("--bundles", help="directory with Snnn.json bundles (index -> data URI)")
    ap.add_argument("--fetch", action="store_true", help="download full-size pictures")
    ap.add_argument("--min-side", type=int, default=1200, help="warn below this short side (px)")
    ap.add_argument("--refresh", action="store_true", help="replace originals that changed")
    ap.add_argument("--dry-run", action="store_true", help="write nothing")
    ap.add_argument("--only", help="comma list of collection or picture ids (S014,S020-03)")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    items, stats = run(args)
    report(items, stats, args)
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
