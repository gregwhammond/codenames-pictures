#!/usr/bin/env python3
"""Keep the crop records in art/crops in step with the pictures in art/source.

Usage:
    python3 scripts/make_legacy_records.py [SOURCE_DIR]           # add / refresh
    python3 scripts/make_legacy_records.py --prune [SOURCE_DIR]   # also drop records of deleted pictures

A picture with no record gets one (art/crops/<id>.json) that keeps it exactly
as the old build made it: one approved crop in "legacy" mode. The id is the
file name without its extension, with spaces replaced by underscores.

Existing records are otherwise kept, so edits made later (for example in the
Crop Studio) survive. One exception: when a picture was replaced and its record
has only legacy crops (no box that could point at the wrong place), the
record's checksum and size are updated to the new file. A record with crop or
fit boxes is left alone and reported; check it in the Crop Studio, or delete
the record to start again.

Records whose picture in SOURCE_DIR is gone are reported; --prune deletes them.
"""
import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import croplib  # noqa: E402
from PIL import Image  # noqa: E402

EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def legacy_record(path):
    rid = path.stem.replace(" ", "_")
    with Image.open(path) as im:
        size = list(im.size)
    return {
        "id": rid,
        "source": path.relative_to(croplib.REPO).as_posix(),
        "source_sha256": croplib.sha256_file(path),
        "source_size": size,
        "rotate": 0,
        "crops": [{"tile": rid, "mode": "legacy", "box": None, "status": "approved", "auto": None}],
    }


def source_files(source_dir):
    """Yield (id, path) for every picture under source_dir, sorted."""
    for path in sorted(pathlib.Path(source_dir).resolve().rglob("*")):
        if path.is_file() and path.suffix.lower() in EXTENSIONS:
            yield path.stem.replace(" ", "_"), path


def refresh(record, path):
    """Point an all-legacy record at a replaced file. Returns True if changed."""
    sha = croplib.sha256_file(path)
    if record.get("source_sha256") == sha:
        return False
    if any(c["mode"] != "legacy" for c in record["crops"]):
        print(f"warning: {path} changed but record {record['id']} has crop boxes; not updating it "
              f"(check it in the Crop Studio, or delete {croplib.record_path(record['id'])} to start again)",
              file=sys.stderr)
        return False
    with Image.open(path) as im:
        size = list(im.size)
    record["source_sha256"] = sha
    record["source_size"] = size
    croplib.save_record(record)
    return True


def orphans(source_dir, present):
    """Records whose source lies under source_dir but whose file is gone."""
    try:
        prefix = source_dir.relative_to(croplib.REPO).as_posix().rstrip("/") + "/"
    except ValueError:
        return []
    if prefix == "./":
        prefix = ""
    return [r for r in croplib.load_all_records()
            if r.get("source", "").startswith(prefix) and r["source"] not in present
            and not croplib.source_path(r).is_file()]


def make_records(source_dir, prune=False):
    source_dir = pathlib.Path(source_dir).resolve()
    written = kept = refreshed = pruned = failed = 0
    seen, present = {}, set()
    for rid, path in source_files(source_dir):
        if rid in seen:
            print(f"error: {path} and {seen[rid]} would both be {rid!r}; skipping the second", file=sys.stderr)
            failed += 1
            continue
        seen[rid] = path
        try:
            rel = path.relative_to(croplib.REPO).as_posix()
            present.add(rel)
            rpath = croplib.record_path(rid)
            if rpath.exists():
                record = croplib.load_record(rpath)
                if record.get("source") != rel:
                    print(f"warning: {path} has the id {rid!r}, but that record is for {record.get('source')}; "
                          f"rename one of them", file=sys.stderr)
                    kept += 1
                elif refresh(record, path):
                    print(f"updated {rpath.name}: {rel} was replaced")
                    refreshed += 1
                else:
                    kept += 1
                continue
            croplib.save_record(legacy_record(path))
        except Exception as err:  # noqa: BLE001 - report and carry on
            print(f"error: {path}: {err}", file=sys.stderr)
            failed += 1
            continue
        written += 1
    try:
        gone = orphans(source_dir, present)
    except Exception as err:  # noqa: BLE001
        print(f"error: could not check for deleted pictures: {err}", file=sys.stderr)
        gone, failed = [], failed + 1
    for r in gone:
        rpath = croplib.record_path(r["id"])
        if prune:
            rpath.unlink()
            print(f"removed {rpath.name}: {r['source']} is gone")
            pruned += 1
        else:
            print(f"warning: {r['source']} is gone but {rpath} still exists; "
                  f"run with --prune to remove the record", file=sys.stderr)
    print(f"wrote {written} records, updated {refreshed}, kept {kept} existing, "
          f"pruned {pruned}, {failed} failed ({croplib.CROPS_DIR})")
    return failed


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?", type=pathlib.Path, default=croplib.REPO / "art" / "source",
                        help="folder of originals inside the repo (default: art/source)")
    parser.add_argument("--prune", action="store_true",
                        help="delete records whose picture in the folder no longer exists")
    args = parser.parse_args()
    sys.exit(1 if make_records(args.source, prune=args.prune) else 0)


if __name__ == "__main__":
    main()
