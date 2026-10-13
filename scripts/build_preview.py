#!/usr/bin/env python3
"""Build a one-file playable preview of Goat Pic with a made-up game.

The page runs the real web/app.js and web/style.css against an in-page
stand-in for the server (scripts/preview/mock.js), so it needs no Go server
and works when opened from anywhere, such as an Artifact on a phone. A
panel at the bottom switches between the spymaster's and a guesser's view,
picks your team, and deals a new board.

    python3 scripts/build_preview.py [-o preview.html] [--cards 48] [--seed N] [--artifact]

--artifact leaves out the <html>/<head>/<body> wrapper, for publishing as a
Claude Artifact (which adds its own).
"""
import argparse
import base64
import pathlib
import random

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def build(out, count, seed, artifact=False):
    cards = sorted(p for p in (WEB / "cards").iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    rnd = random.Random(seed)
    picks = rnd.sample(cards, min(count, len(cards)))
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
    uris = [f"data:{mime[p.suffix.lower()]};base64,{base64.b64encode(p.read_bytes()).decode()}" for p in picks]
    images_js = "window.PREVIEW_IMAGES = [\n" + ",\n".join(f'"{u}"' for u in uris) + "\n];"

    html = (WEB / "index.html").read_text()
    css = (WEB / "style.css").read_text()
    mock = (ROOT / "scripts" / "preview" / "mock.js").read_text()
    app = (WEB / "app.js").read_text()

    # Inline everything; drop links the page can't reach without the server.
    html = html.replace('<link rel="stylesheet" href="/style.css">', f"<style>\n{css}\n</style>")
    html = html.replace('  <link rel="manifest" href="/manifest.webmanifest">\n', "")
    for line in ('  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">\n',
                 '  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">\n'):
        html = html.replace(line, "")
    html = html.replace("<title>Goat Pic</title>", "<title>Goat Pic Preview</title>")
    scripts = f"<script>\n{images_js}\n</script>\n<script>\n{mock}\n</script>\n<script>\n{app}\n</script>"
    assert '<script src="/app.js" defer></script>' in html
    html = html.replace('<script src="/app.js" defer></script>', scripts)
    if artifact:
        # Claude Artifacts wrap the page in their own document skeleton.
        for tag in ("<!doctype html>\n", '<html lang="en">\n', "<head>\n", "</head>\n", "<body>\n",
                    "</body>\n", "</html>\n", '  <meta charset="utf-8">\n',
                    '  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'):
            assert tag in html, tag
            html = html.replace(tag, "", 1)
    out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(uris)} pictures)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", type=pathlib.Path, default=pathlib.Path("preview.html"))
    ap.add_argument("--cards", type=int, default=48, help="pictures to include (24 or more)")
    ap.add_argument("--seed", type=int, default=None, help="pick the same pictures each time")
    ap.add_argument("--artifact", action="store_true", help="leave out the document wrapper (for Claude Artifacts)")
    args = ap.parse_args()
    build(args.out, max(24, args.cards), args.seed, args.artifact)
