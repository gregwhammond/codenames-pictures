# Codenames Pictures

Play [Codenames Pictures](https://en.wikipedia.org/wiki/Codenames_(board_game)) live with friends, each person on their own phone. One person creates a game and shares the link or 4-letter room code, everyone picks a seat, and the board updates on every phone as soon as anyone plays.

It's built for **2 teams of 2** (one spymaster and one guesser per team). Teams can have extra guessers, and anyone else who joins can watch. It installs as an app on phones (a PWA): open the site, then use "Add to Home Screen".

## How to play

1. Split into **Red** and **Blue**. Each team has one **spymaster** and at least one **guesser**.
2. Only the spymasters see which pictures belong to which team (the coloured frames).
3. On your turn, your spymaster types a **one-word clue** and a number: how many pictures it points to.
4. Guessers tap a picture to zoom in, then tap **Guess this picture**. A correct guess lets you keep going, up to one more than the number. You can end the turn after at least one guess.
5. A beige bystander or the other team's picture ends your turn. The **black assassin** loses the game instantly.
6. The first team to find all their pictures wins. The team that goes first has 8 pictures, the other has 7.

A clue of **0** or **∞** gives unlimited guesses, as in the board game.

## Running it locally

You need [Go](https://go.dev/dl/) 1.22 or newer. There are no other dependencies.

```sh
go run .                # serves on http://localhost:8080
PORT=9000 go run .      # pick a port
go test ./...           # rules and server tests
```

To try it with several players on one computer, open the site in a few private windows. To try it on phones on the same Wi-Fi, open `http://<your-computer's-ip>:8080`. Installing as an app needs HTTPS, which any of the hosts below give you.

## Deploying

The server is a single small binary with the web app and pictures built in. Game state lives in memory, so run **one instance** (restarting it ends games in progress). Rooms are cleaned up after 6 hours without activity.

### Fly.io (recommended, cheapest)

```sh
fly launch --no-deploy        # accept the Dockerfile, pick a region near you
fly scale count 1             # keep a single instance; games live in memory
fly deploy
```

A single shared-cpu-1x machine with 256 MB is plenty. Fly can stop the machine when idle and start it on the next visit, which keeps cost near zero.

### Render, Railway, or any Docker host

Point the service at this repo and use the `Dockerfile`. The app listens on `$PORT` (default `8080`). Health check: `GET /api/health`.

### A plain server

```sh
CGO_ENABLED=0 GOOS=linux go build -o codenames-pictures .
./codenames-pictures -addr :8080
```

Put it behind a reverse proxy that provides HTTPS (for example Caddy). Live updates use Server-Sent Events, so turn off response buffering for `/api/rooms/*/events` if your proxy buffers (nginx: `proxy_buffering off;`).

## Changing the pictures

The pictures shipped with the app live in `web/cards/` as small square JPEGs, built from the originals in `art/source/`.

- **Swap the built-in set:** put your originals in `art/source/` (any size, any common format), then run
  ```sh
  python3 -m pip install pillow
  python3 scripts/build_cards.py            # or: python3 scripts/build_cards.py path/to/folder another/folder
  ```
  This trims borders, makes each picture square, and writes 400×400 JPEGs to `web/cards/`. Rebuild or redeploy afterwards.
- **Use a folder without rebuilding:** `./codenames-pictures -cards /path/to/pictures` serves pictures straight from a folder (square images work best).

You need at least 20 pictures; more gives more variety between games. `art/doodles-from-upstream/` holds the hand-drawn doodles from the project this was forked from, which aren't in the default set.

## How it works

| Piece | What it does |
|---|---|
| `game.go` | The rules: dealing 20 cards (8/7/4/1), clues, guesses, turn passing, winning. |
| `room.go` | Rooms, seats, and what each player is allowed to see (guessers never receive the key). |
| `main.go` | HTTP API (`POST /api/rooms/{code}/{action}`) and the live event stream (`GET /api/rooms/{code}/events`). |
| `web/` | The phone app: plain HTML, CSS and JavaScript with no build step, a service worker for offline loading, and the app manifest. |

Each browser keeps a private random token in local storage, so refreshing or reopening the app puts you back in your seat.

## Credits

Originally forked from [banool/codenames-pictures](https://github.com/banool/codenames-pictures), itself based on [jbowens/codenames](https://github.com/jbowens/codenames). The server and app were rewritten for live multiplayer on phones.
