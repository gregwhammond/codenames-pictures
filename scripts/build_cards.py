#!/usr/bin/env python3
"""Build the game's picture tiles from the crop records in art/crops.

Usage:
    python3 scripts/build_cards.py           # build missing tiles, remove stale ones
    python3 scripts/build_cards.py --check   # report only; exit 1 if out of date

For every crop record (art/crops/<id>.json) and every crop in it whose status
is "approved", this writes

    web/cards/<tile>.<hash>.jpg     the 400 x 400 game tile
    cards-large/<tile>.<hash>.jpg   the zoom version (400 to 1200 px square)

The hash covers everything that affects the pixels, so an existing file is
never rewritten. Originals are only read, never changed.

If a record's original is missing or no longer matches the checksum in the
record, that record is skipped with a warning, and then nothing is deleted:
a run on a machine without the originals never wipes the deck. Otherwise
*.jpg files in web/cards and cards-large that no approved crop produces are
removed.

New, replaced or deleted pictures in art/source need their records brought
up to date first (the build warns when they are not):
    python3 scripts/make_legacy_records.py [--prune]

Requires Pillow (`python3 -m pip install pillow`).
"""
import argparse
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import croplib  # noqa: E402
import make_legacy_records  # noqa: E402

LEGACY_CMD = "python3 scripts/make_legacy_records.py"


class BuildError(Exception):
    pass


def warn(msg):
    print(f"warning: {msg}", file=sys.stderr)


def plan(records):
    """Return [(record, [approved crops])] and the set of expected file names.
    Raises BuildError on malformed records or duplicate tile names."""
    jobs, expected, owner, ids = [], set(), {}, set()
    for record in records:
        try:
            croplib.validate_record(record)
        except ValueError as err:
            raise BuildError(f"bad record: {err}") from None
        if record["id"] in ids:
            raise BuildError(f"two records have the id {record['id']!r}")
        ids.add(record["id"])
        crops = [c for c in record["crops"] if c["status"] == "approved"]
        for c in record["crops"]:
            tile = c["tile"]
            if tile in owner and owner[tile] != record["id"]:
                raise BuildError(f"tile {tile!r} appears in both {owner[tile]} and {record['id']}")
            owner[tile] = record["id"]
        if crops:
            jobs.append((record, crops))
            expected.update(croplib.tile_filename(record, c) for c in crops)
    return jobs, expected


def save_atomic(im, path):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".jpg")
    os.close(fd)
    try:
        croplib.save_jpeg(im, tmp)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def in_art_source(record):
    return record.get("source", "").startswith("art/source/")


def missing_hint(record):
    if in_art_source(record):
        return f"restore it, or run `{LEGACY_CMD} --prune` to drop the record"
    return f"restore it, or delete {croplib.record_path(record['id'])}"


def mismatch_hint(record):
    if in_art_source(record) and all(c["mode"] == "legacy" for c in record["crops"]):
        return f"run `{LEGACY_CMD}` to accept the new file"
    return (f"restore the original, or check the crops in the Crop Studio and delete "
            f"{croplib.record_path(record['id'])} to start again")


def unrecorded_sources(records):
    """Pictures in art/source that no record points at."""
    folder = croplib.REPO / "art" / "source"
    if not folder.is_dir():
        return []
    known = {r.get("source") for r in records}
    out = []
    for _, path in make_legacy_records.source_files(folder):
        rel = path.relative_to(croplib.REPO).as_posix()
        if rel not in known:
            out.append(rel)
    return out


def build_record(record, crops):
    """Render the missing files for one record. Returns (written, ok)."""
    todo = [c for c in crops
            if not (croplib.TILES_DIR / croplib.tile_filename(record, c)).exists()
            or not (croplib.LARGE_DIR / croplib.tile_filename(record, c)).exists()]
    src = croplib.source_path(record)
    if not src.is_file():
        warn(f"{record['id']}: source {record['source']} is missing; skipping ({missing_hint(record)})")
        return 0, False
    if croplib.sha256_file(src) != record.get("source_sha256"):
        warn(f"{record['id']}: source {record['source']} does not match the record's checksum; "
             f"skipping ({mismatch_hint(record)})")
        return 0, False
    if not todo:
        return 0, True
    legacy = any(c["mode"] == "legacy" for c in todo)
    other = any(c["mode"] != "legacy" for c in todo)
    prepared = {}
    if legacy:
        prepared["legacy"] = croplib.legacy_prepare(record)
    if other:
        prepared["other"] = croplib.open_source(record)
    written = 0
    for c in todo:
        im = prepared["legacy" if c["mode"] == "legacy" else "other"]
        name = croplib.tile_filename(record, c)
        for folder, size in ((croplib.TILES_DIR, croplib.TILE_SIZE),
                             (croplib.LARGE_DIR, croplib.large_size(record, c, im))):
            path = folder / name
            if not path.exists():
                save_atomic(croplib.render(record, c, size, im), path)
                written += 1
    return written, True


def existing(folder):
    return {p.name for p in folder.glob("*.jpg")} if folder.is_dir() else set()


def check(expected):
    problems = 0
    for folder in (croplib.TILES_DIR, croplib.LARGE_DIR):
        have = existing(folder)
        for name in sorted(expected - have):
            print(f"missing: {folder / name}")
            problems += 1
        for name in sorted(have - expected):
            print(f"stale:   {folder / name}")
            problems += 1
    if problems:
        print(f"{problems} problem(s); run python3 scripts/build_cards.py")
    else:
        print(f"up to date: {len(expected)} tiles")
    return problems == 0


def build(jobs, expected):
    croplib.TILES_DIR.mkdir(parents=True, exist_ok=True)
    croplib.LARGE_DIR.mkdir(parents=True, exist_ok=True)
    written, skipped = 0, []
    for record, crops in jobs:
        try:
            n, ok = build_record(record, crops)
        except Exception as err:  # noqa: BLE001 - one bad picture must not stop the build
            warn(f"{record['id']}: could not render: {err}; skipping")
            n, ok = 0, False
        written += n
        if not ok:
            skipped.append(record["id"])
    removed = 0
    if skipped:
        warn(f"{len(skipped)} record(s) skipped ({', '.join(skipped[:10])}"
             f"{' ...' if len(skipped) > 10 else ''}); not deleting any old tiles")
    else:
        for folder in (croplib.TILES_DIR, croplib.LARGE_DIR):
            for name in sorted(existing(folder) - expected):
                (folder / name).unlink()
                removed += 1
    print(f"{len(expected)} tiles: wrote {written} files, removed {removed} stale, skipped {len(skipped)} records")
    return not skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="write nothing; exit 1 if a tile is missing or a stale tile exists")
    args = parser.parse_args(argv)
    try:
        records = croplib.load_all_records()
        jobs, expected = plan(records)
    except (BuildError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    new = unrecorded_sources(records)
    if new:
        warn(f"{len(new)} picture(s) in art/source have no crop record and are not in the deck "
             f"({', '.join(new[:10])}{' ...' if len(new) > 10 else ''}); run `{LEGACY_CMD}`")
    if not expected:
        print("error: no approved crops in art/crops (run scripts/make_legacy_records.py?)", file=sys.stderr)
        return 2
    if args.check:
        return 0 if check(expected) and not new else 1
    return 0 if build(jobs, expected) else 1


if __name__ == "__main__":
    sys.exit(main())
