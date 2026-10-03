# Codenames Pictures

Play [Codenames Pictures](https://en.wikipedia.org/wiki/Codenames_(board_game)) live with friends, each person on their own phone. One person creates a game and shares the link or 4-letter room code, everyone picks a seat, and the board updates on every phone as soon as anyone plays.

It's built for **2 teams of 2** (one spymaster and one guesser per team). Teams can have extra guessers, and anyone else who joins can watch. It installs as an app on phones (a PWA): open the site, then use "Add to Home Screen".

## How to play

1. Split into **Orange** and **Purple**. Each team has one **spymaster** and at least one **guesser**.
2. Only the spymasters see which pictures belong to which team (the coloured frames).
3. On your turn, your spymaster types a **one-word clue** and a number: how many pictures it points to.
4. Guessers tap a picture to zoom in, then tap **Guess this picture**. Press and hold any picture to see it full screen and pinch to zoom into the detail. A correct guess lets you keep going, up to one more than the number. You can end the turn after at least one guess.
5. A beige bystander or the other team's picture ends your turn. The **black assassin** loses the game instantly.
6. The first team to find all their pictures wins. The team that goes first has 9 pictures, the other has 8.

The board is always 25 pictures in a 5×5 grid: 9 for the starting team, 8 for the other, 7 bystanders and 1 assassin.

A clue of **0** or **∞** gives unlimited guesses, as in the board game.

## Running it locally

You need [Go](https://go.dev/dl/) 1.22 or newer. There are no other dependencies.

```sh
go run .                # serves on http://localhost:8080
PORT=9000 go run .      # pick a port
go test ./...           # rules and server tests
```

To try it with several players on one computer, open the site in a few private windows. To try it on phones on the same Wi-Fi, open `http://<your-computer's-ip>:8080`. Installing as an app needs HTTPS, which any of the hosts below give you.

### Developing

Run `go run . -dev` and open http://localhost:8080/dev for a harness that shows four phone-sized frames side by side, one per seat, each with its own identity (`?dev=1` to `?dev=4`, kept apart in local storage). **New game** creates a room and seats all four players; **Start** begins the game from the orange spymaster's phone; **New board** (top right) deals fresh cards in the same room, keeping the seats; the size select and **Landscape** change the phone shape; **Reset** forgets the dev identities and returns every frame to the home screen. The harness is only served with `-dev`.

## Deploying

The server is a single small binary with the web app and pictures built in. Game state lives in memory, so run **one instance** (restarting it ends games in progress). Rooms are cleaned up after 6 hours without activity.

### Render (easiest, free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gregwhammond/codenames-pictures)

Click the button, sign in with GitHub, and approve. Render builds the `Dockerfile` using `render.yaml` and gives you an `https://….onrender.com` address to share. It redeploys on every push to `master`. The free plan sleeps after about 15 minutes with nobody connected, so the first visit after that takes about a minute to wake up, and any game in progress is lost.

### Fly.io

```sh
fly launch --no-deploy        # accept the Dockerfile, pick a region near you
fly scale count 1             # keep a single instance; games live in memory
fly deploy
```

A single shared-cpu-1x machine with 256 MB is plenty. Fly can stop the machine when idle and start it on the next visit, which keeps cost near zero.

### Railway or any other Docker host

Point the service at this repo and use the `Dockerfile`. The app listens on `$PORT` (default `8080`). Health check: `GET /api/health`.

### A plain server

```sh
CGO_ENABLED=0 GOOS=linux go build -o codenames-pictures .
./codenames-pictures -addr :8080
```

Put it behind a reverse proxy that provides HTTPS (for example Caddy). Live updates use Server-Sent Events, so turn off response buffering for `/api/rooms/*/events` if your proxy buffers (nginx: `proxy_buffering off;`).

## Changing the pictures

Every picture has an **original** that is never edited and a **crop record** in `art/crops/<id>.json` that says how to cut it into square tiles. The build turns each *approved* crop into a 400 px tile in `web/cards/` and a zoom version (up to 1200 px) in `cards-large/`. File names carry a hash of the crop, so phones pick up a changed crop straight away. Install the tools once with `python3 -m pip install pillow numpy`.

- **Accepted pictures from the Fantastical Sources page:** export the picks, then on a machine that can reach the picture hosts run
  ```sh
  python3 scripts/import_picks.py --picks picks.json --bundles path/to/img --fetch
  ```
  Full-size originals go to `originals/` (git-ignored, so back that folder up). Each gets a crop record with automatic proposals from `scripts/autocrop.py`, occasionally several crops when one source holds separate scenes.
- **Review the crops:** `python3 scripts/studio.py` opens Crop Studio on http://127.0.0.1:8765. Drag and resize boxes, try other proposals, rotate, add or remove boxes, and approve. Add `--lan` to use it from a phone on the same Wi-Fi (the printed link carries a one-time token).
- **Pictures in `art/source/`:** run `python3 scripts/make_legacy_records.py` to give new files a record that keeps the classic treatment (trimmed, squared, or letterboxed on a blurred background).
- **Build:** `python3 scripts/build_cards.py` writes the tiles, and `--check` reports anything out of date. If an original is missing, the build skips that record and deletes nothing. Commit `art/crops/`, `web/cards/` and `cards-large/`, then redeploy.
- **Use a folder without rebuilding:** `./codenames-pictures -cards /path/to/pictures` serves pictures straight from a folder (square images work best).

You need at least 25 pictures; more gives more variety between games. Two crops of the same source are never dealt onto one board. `art/doodles-from-upstream/` holds the hand-drawn doodles from the project this was forked from, which aren't in the default set.

## How it works

| Piece | What it does |
|---|---|
| `game.go` | The rules: dealing 25 cards (9/8/7/1), clues, guesses, turn passing, winning. |
| `room.go` | Rooms, seats, and what each player is allowed to see (guessers never receive the key). |
| `main.go` | HTTP API (`POST /api/rooms/{code}/{action}`) and the live event stream (`GET /api/rooms/{code}/events`). |
| `web/` | The phone app: plain HTML, CSS and JavaScript with no build step, a service worker for offline loading, and the app manifest. |

Each browser keeps a private random token in local storage, so refreshing or reopening the app puts you back in your seat.

## Credits

Originally forked from [banool/codenames-pictures](https://github.com/banool/codenames-pictures), itself based on [jbowens/codenames](https://github.com/jbowens/codenames). The server and app were rewritten for live multiplayer on phones.
