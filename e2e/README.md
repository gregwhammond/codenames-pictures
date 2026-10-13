# End-to-end tests

These tests start the real server, open four (or more) phone-sized browsers, and play whole games by tapping, the way four people would. After every move they compare all the phones with each other and with the rules. They find bugs and report them; they do not fix them. What they have found so far is in [BUGS.md](BUGS.md).

Nothing here is needed to run or deploy the game, and the Go module has no new dependencies.

## Install

You need Go (with cgo, for the race detector) and Node 18 or newer. It was built and run with Go from `/usr/local/go/bin`, Node 26.4 and Playwright 1.56.1 on macOS.

```sh
cd e2e
npm install
npx playwright install chromium webkit    # skips anything already downloaded
```

## Run

```sh
npm test                 # everything, headless: about 7 minutes
npm run test:games       # the six full games only: under a minute
npm run test:edge        # the awkward moments (leaving, slow replies, reloads…)
npm run test:layout      # layout on seven screen sizes, with screenshots
npm run test:soak        # ten random games back to back
npm run report           # open the HTML report of the last run
```

Add Playwright's own options after `--`, for example one test on one engine:

```sh
npm test -- tests/full-game.spec.js -g "assassin" --project=iphone-webkit
```

Each run builds the server with `go build -race` and starts it on `127.0.0.1:8791`. It never uses port 8080. Set `E2E_PORT` to use another port; two runs on different ports do not get in each other's way.

### What a green run looks like

```
  200 passed (6.6m)
```

In the list above that line, `✓` is a test that passed and `✘` is an **expected failure**: a test that shows a known bug of the app. Playwright counts both as passed. A real failure is listed again at the end under `failed`, with its message, and the run exits with an error.

The numbers at the time of writing:

| Project | Screen | Runs | Tests | of which expected failures |
|---|---|---|---|---|
| `android-chromium` | 360x780 | every spec | 60 | 19 |
| `iphone-webkit` | 390x844 | every spec | 60 | 18 |
| `large-chromium` | 430x932 | layout only | 16 | 2 |
| `large-webkit` | 430x932 | layout only | 16 | 2 |
| `landscape-chromium` | 780x360 | layout only | 16 | 5 |
| `landscape-webkit` | 844x390 | layout only | 16 | 4 |
| `landscape-large-webkit` | 932x430 | layout only | 16 | 3 |
| **Total** | | | **200** | **53** |

### Settings

| Variable | Meaning |
|---|---|
| `E2E_PORT` | Port for the server under test. Default 8791. 8080 is refused. |
| `E2E_WORKERS` | Tests run at once. Default 3. Each test opens at least four browsers. |
| `E2E_SEED` | Replay the random choices of a failed test (the failure prints its seed). |
| `E2E_SHOW_BUGS=1` | Report known app bugs as ordinary failures, with traces and video. |
| `E2E_STRICT=1` | Turn off every allowance for a known problem (see "Known problems the harness steps around"). On WebKit, tests that close the menu then fail. |
| `E2E_STRICT_RACES=1` | Fail on a data race even if it is on the known list. |
| `E2E_RACE_HUNT=1` | Include the race hunt (see below). |
| `E2E_TRACE=0`, `E2E_VIDEO=0` | Record no trace or no video. Faster; less to look at after a failure. |
| `E2E_BOT_LOG=1` | Print every move the bot makes. |
| `E2E_GO` | Path to the `go` command. Default: `/usr/local/go/bin/go` if it exists, else `go`. |
| `WATCH=1` | Watch mode (below). `E2E_SLOWMO` sets the delay per action in ms, default 250. |
| `SOAK_GAMES`, `SOAK_SEED`, `SOAK_PHONES`, `SOAK_RELOAD` | Soak settings (below). |

## Watch it play

```sh
npm run watch                               # the six full games
npm run watch -- -g "assassin"              # one of them
WATCH=1 npx playwright test tests/edge.spec.js -g "3a" --project=android-chromium
```

This opens four real Chromium windows side by side and slows every action down. It runs one test at a time with no time limit. Window placement works in Chromium only.

## Soak with a seed

```sh
npm run test:soak
SOAK_GAMES=30 npm run test:soak
SOAK_SEED=1211036763 SOAK_GAMES=10 npx playwright test tests/soak.spec.js --project=android-chromium
```

The soak plays `SOAK_GAMES` random games in one room (default 10). Now and then a random phone reloads, peeks at a card or opens the menu. Between games it alternates *Play again* and *Switch teams* with everyone reseated at random. Every move is checked like any other.

It always prints its seed and the command that replays it. A seed replays the harness's choices: who taps, which kind of card, the clue numbers, the reloads. It does not replay the deal, because the server shuffles each board itself. `SOAK_PHONES` (4 to 12) adds guessers and watchers; `SOAK_RELOAD` is the chance of a reload after each move (default 0.06).

## Reading the results

- **The report.** `npm run report` opens the HTML report. With a port other than 8791 the report is in `playwright-report-<port>`: `npx playwright show-report playwright-report-8794`.
- **A failed test** prints what went wrong, naming the rule and the phone, for example `[agreement.revealed] Ben: room YVCY: Ben and Ada disagree on revealed: at index 5: false vs true`. It also prints a line with its seed and the command to run it again.
- **What is kept on failure**, in `test-results/port-<port>/<test>/`: a screenshot of every phone, and for each phone a trace (`trace-2-Ben.zip`) and a video (`video-2-Ben.webm`). Open a trace with `npx playwright show-trace <file>`. The report links all of them, with the bot's move list (`bot-moves.txt`) and anything the pages logged (`page-problems.json`).
- **Layout screenshots** are written on every run to `screenshots/<project>/<screen>/<seat>.jpg`, 574 pictures and about 120 MB, with the measurements behind them in `screenshots/<project>/_measurements/`. They are for you to look through; the folder is ignored by git.
- **The server's output** is in `test-results/server/server-<port>.log`.
- **Data races.** The server runs under Go's race detector. At the end of a run its log is scanned. A race that is not on the known list fails the run and prints the report. A known one prints a banner starting `[e2e] KNOWN DATA RACE(S)` and does not fail the run.

### The race hunt

```sh
npm run race-hunt
```

The ordinary tests make one move at a time, so the server never has two requests at once and the race detector has nothing to see. The race hunt puts twelve phones at one table and has seven guessers tap *Guess this picture* at the same moment, three times. That is how the data race in BUGS.md shows up. The script runs it on Chromium in strict mode, so it fails while the race exists and passes once it is fixed. It is left out of `npm test` because what it provokes depends on timing.

## How it is built

```
playwright.config.js    the server, the projects (screen sizes), timeouts
lib/server.js           port, paths, build-and-start command, race-report scan, known races
lib/global-teardown.js  fails the run on a data race
lib/table.js            the `table` fixture: phones, error collectors, check(), setupRoom()
lib/player.js           one phone: every action as a real tap; holding and delaying requests
lib/invariants.js       the rules every phone must satisfy after every move
lib/bot.js              plays through the phones to a chosen ending; a small model of the rules
lib/known-bug.js        how a test marks a known app bug
lib/edge-helpers.js     helpers for edge.spec.js
lib/layout-helpers.js   measuring a page and judging its layout
lib/rng.js              seeded random numbers
tests/full-game.spec.js six games from the home screen to a rematch
tests/edge.spec.js      leaving, slow replies, reloads, second tabs, sheets left open
tests/touch.spec.js     taps on the dimmed area beside a sheet
tests/layout.spec.js    every screen on seven screen sizes
tests/soak.spec.js      random games back to back
tests/harness.spec.js   checks on the harness: each rule fires on a doctored snapshot
tests/selftest.spec.js  checks on the harness: a phone that is lied to is caught
tests/race-hunt.spec.js opt-in: simultaneous guesses
```

**Phones.** Each phone is its own browser context, so it has its own storage, identity and event stream, like a separate device. Contexts use touch, the phone's screen size, reduced motion (the app's stylesheet then has no animations to wait for) and no service worker.

**Actions.** Everything a test does to the game is a tap or a keystroke on the page the server serves. Nothing calls the HTTP API behind the app's back. After a tap the harness waits for the effect to show on that phone. If a toast appears instead, or nothing happens at all, the action fails and says so.

**State.** The app keeps its state in a top-level `ui` object, which the tests can read without any change to the app. One snapshot of a phone holds that state and the facts of the page (tiles, classes, buttons, sheets), read in one go so they belong together.

**The check.** `table.check()` runs after every action. First it waits for the phones to settle: no request in flight, nobody offline, and everyone agreeing on players, turn, phase, clue, counters, log, the 24 pictures and what is revealed. Then it asserts the rest once, on every phone: no key where there should be none (JSON, tiles, labels, zoom sheet, viewer), the full key where there should be one, 24 cards and 9/8/6/1, the scores, which phone has which control, and that revealed cards and the log only grow. The full list with a sentence each is `INVARIANTS` in `lib/invariants.js`.

**Page problems.** Every phone records JavaScript errors, console errors, failed requests, HTTP errors and any request to `/api/rooms/null/`. A test fails on anything recorded that it did not declare with `table.expectError()` or `table.allowError()`.

**The bot.** It reads the key from a spymaster's phone, so it can aim: `bot.guess('own')`, `'opponent'`, `'neutral'`, `'assassin'`. After each move it compares the game with what the rules say should have happened.

**Known app bugs.** A test that shows a bug asserts the correct behaviour inside `knownBug()`. It counts as an expected failure only if it fails with the message that bug is known to produce. If it fails some other way, or passes, the run fails: the first means something else broke, the second means the bug is fixed and the wrapper should come off.

### Known problems the harness steps around

Each has its own test, and `E2E_STRICT=1` turns the allowance off.

- **`table.known.backdropTap`** (WebKit). A tap beside the menu does not close it there, so `closeMenu()` presses Escape instead. See `tests/touch.spec.js`.
- **`table.known.vibrate`** (Chromium). One console line about `navigator.vibrate` is let through. See test 15 in `tests/edge.spec.js`.
- **`KNOWN_RACES`** in `lib/server.js`. The clue-log data race prints a banner and does not fail the run.

## Adding a scenario

Put a test in the spec it belongs to, or a new file in `tests/`.

```js
const { test, expect } = require('../lib/table');

test('a guess on a slow connection still lands', async ({ table, bot }) => {
  // Ada: Orange spymaster, Ben: Orange guesser, Cy: Purple spymaster, Dee: Purple guesser.
  const [ada, ben, cy, dee] = await table.setupRoom();

  await bot.clue(2);                              // whoever's turn it is; checked
  const { index } = await bot.guess('own');       // a tap on the right phone; checked
  expect(index).toBeGreaterThanOrEqual(0);

  // By hand, on a named phone. The starting team is random, so ask who is on.
  const { guessers, hidden, turn } = await bot.look();
  const phone = guessers[0];
  const slow = await phone.delayPost('guess', 500);   // this phone's reply arrives late
  await phone.guess(hidden[turn][0]);
  await table.check('after a guess on a slow connection');
  expect(slow.requests).toHaveLength(1);
});
```

Things to know:

- **Call `table.check('…')` after anything that changes the game** if you did it by hand. `bot` moves, `table.setupRoom()` and `table.step()` already do.
- **Do not sleep.** Wait for what you expect: `expect(locator)…`, `expect.poll(…)`, or the waiting built into each action. To make a race happen, hold a request with `phone.holdPost('guess')`, do the other thing, then `release()`.
- **An action that should be refused:** pass `{ wait: false }`, then assert on the toast (`phone.expectToast('…')`) or on what did not change.
- **A page problem you expect:** declare it first with `table.expectError({ kind: 'http', status: 409, phone: ben })`. The test fails if it then does not happen.
- **More phones or other seats:** `table.setupRoom({ phones: 6, seats: [...] })`, or `table.addPhone('Eve')` later and `eve.joinByLink()`.
- **If the test shows an app bug,** do not weaken it. Assert the correct behaviour inside `knownBug(table, { id, title, where, shows }, async () => { … })` as the last thing in the test, and add the bug to BUGS.md.

The methods of `Table`, `Player` and `Bot` are documented where they are defined.

## What it cannot cover

- **Real devices.** These are desktop Chromium and desktop WebKit with a phone's screen size and touch switched on. WebKit here is not iOS Safari. Safe-area insets, the on-screen keyboard covering the clue form, browser toolbars that change the screen height, installing to the home screen, the wake lock and real vibration are not exercised. One finding (taps beside a sheet in WebKit) needs checking on an iPhone for this reason.
- **Anything a browser allows only after a real tap.** Reading the page from a test, and recording a trace, both count as a tap to the browser. So a feature that is blocked until the user has touched the page (vibration, sharing, the clipboard) can look fine here and fail on a phone. Test 15 shows the one case that was found, on phones opened with `{ trace: false }`.
- **Press-and-hold and pinch.** The full-screen viewer is opened with a held mouse button or a right-click, not a held finger. Pinch, double-tap and swipe inside the viewer are not tested.
- **Real networks.** Requests can be held, delayed or failed one at a time, which is enough to force a particular order of events. Packet loss, a connection that drops and comes back, and a phone going to sleep are not simulated.
- **More than one server, restarts, and the six-hour room sweep.**
- **The deal.** The server shuffles with its own randomness, so a seed cannot bring back a particular board.
- **Fonts.** Layout was measured with this Mac's system fonts. A real Android phone may differ by a few pixels, which matters for the long-clue thresholds in BUGS.md.
- **Concurrency by default.** The ordinary tests make one move at a time. Only the race hunt makes the server do several things at once.

## Notes for whoever maintains this

- **`trace` and `video` are off in the config on purpose.** The table fixture records one trace and one video per phone itself and keeps them only when the test fails. Do not pass `--trace` or set `trace` in the config: the two recorders clash ("Tracing has been already started"), and with the fixture's own trace switched off a failing test hung until its time limit (Playwright 1.56.1, Node 26.4).
- **No retries.** A test that fails once has failed.
- **Layout thresholds are per project.** `KNOWN_CLUE_OVERFLOW` in `tests/layout.spec.js` lists, for each screen size, the clue lengths that overflow. A new project needs its own entry.
- **Output folders** (`node_modules`, `test-results`, `playwright-report*`, `screenshots`) are ignored by git and by the Docker build.
