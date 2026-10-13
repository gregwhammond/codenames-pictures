# Bugs found by the end-to-end tests

Found on branch `claude/board-4x6-nzoro9` at commit `ef2bfb4`, with Playwright 1.56.1 driving Chromium 141 at 360x780 and WebKit 26.0 at 390x844 against the real server built with the Go race detector. Nothing in the app was changed.

Every bug below was reproduced on both engines unless it says otherwise. Each has a test that asserts the correct behaviour and is recorded as an expected failure, so the suite stays green and the test starts failing the day the bug is fixed. To see them all fail with messages, screenshots, a trace and a video per phone:

```sh
cd e2e
npm run show-bugs        # E2E_SHOW_BUGS=1 on the edge, touch and layout specs
npm run report
```

Line numbers refer to the files at the commit above.

**The unmerged branch `claude/bug-fixes` may already fix some of these.** It was not checked out or run. Its diff changes only the server (`room.go`, `game.go`, `main.go`), not `web/`. From reading the diff:

- It copies the clue log into each view, which should fix the data race (bug 8).
- It remembers a spymaster who leaves mid-game, which should fix the lock bypass (bug 5).
- It lets that spymaster take the seat back on the server and adds a revision number to each view. Those are the server halves of bugs 4 and 6; the app would still need to use them.
- Everything else here is in `web/` or untouched by that branch.

## Confirmed bugs, most severe first

### 1. "Leave room" does not leave the room (`leave-race`, `leave-race-offline`)

**Severity: high.** It needs no bad luck or slow network: with nothing interfered with, 32 of 32 leaves (16 per engine) went wrong.

**What a player sees.** They tap *Leave room* and confirm. Their phone shows the home screen with a "Reconnecting…" banner that never goes away. Everyone still in the room sees them in the player list, unseated and greyed out, for good. Each such ghost uses one of the room's 12 places.

**Steps.** Four phones in the lobby. Ben taps *Leave room* and accepts the question.

**What happens.** The server removes Ben and tells his own event stream `gone`. The app answers `gone` by joining the room again (`rejoin()`), because the reply to the leave request has not been handled yet and the app still thinks it is in the room. Ben is added back as a new, unseated player. Then the leave reply arrives and the app goes home. Then the join reply arrives: the app stores the room and opens a stream for room code `null`, which fails and sets the offline banner. Recorded on Ben's phone: one `POST …/join` after the leave, then `GET /api/rooms/null/events?token=…` answered 404.

**Tests.** `tests/edge.spec.js`: *1a. a player who leaves on a slow connection is out of the room* and *1b. … ends on a working home screen*. Both hold the replies so the order is fixed.

**Where.** `web/app.js:157` (`gone` calls `rejoin()`), `web/app.js:904-907` (`await act('leave'); leaveLocal();`), `web/app.js:139-144` and `:154` (`rejoin()` then `connect()` with `ui.code` already `null`), `main.go:291-296` (the stream sends `gone`).

### 2. A half-typed clue is wiped when anything happens in the room (`clue-wiped`)

**Severity: high.** It needs no special timing, only a spymaster who picks the number before typing the word.

**What a player sees.** The spymaster taps a number, starts typing the clue, and the word vanishes. It happens whenever the room changes: someone joins, sits, reloads, or a phone that went to sleep reconnects.

**Steps.** Four phones in a game. The spymaster whose turn it is taps `3`, types `lantern`. A fifth phone opens the invite link and joins.

**What happens.** The word field is empty on the spymaster's phone. If the number is left alone, the word survives the same event (test 3b), so the cause is the number tap: it changes the buttons in the page directly, the saved copy of the form's markup no longer matches, and the next update replaces the whole form.

**Tests.** `tests/edge.spec.js`: *3a. a clue typed after picking a number survives another player joining*. Guard: *3b*.

**Where.** `web/app.js:862-869` (number tap edits the DOM, not the region cache), `web/app.js:241-244` (`region()` replaces `innerHTML` when the markup differs).

### 3. A spymaster who leaves cannot get the seat back, and nobody else can take it (`spymaster-seat-lost`)

**Severity: high for the game in progress.** It takes a deliberate *Leave room*, but then the game cannot be finished.

**What a player sees.** The spymaster leaves mid-game (or lands back on the home screen and joins again). They come back as a spectator. It is their team's turn to give a clue and no phone has the clue form. The menu offers them *Join Orange* and *Join Purple*, which are guesser seats. The only way on is *Back to lobby*, which throws the game away.

**Steps.** Four phones in a game, clue phase. The spymaster whose turn it is leaves, then joins again by typing the code.

**What happens.** Phase `clue`, same team's turn, three seated players and the returner watching. No `#clue-form` anywhere. The returner's menu has no spymaster seat. Seated players get no seat buttons at all, so a guesser cannot step up either.

**Tests.** `tests/edge.spec.js`: *4a. the spymaster can come back and the game goes on*. The test accepts either fix: the seat is kept, or the menu offers it.

**Where.** `room.go:224-232` (`Leave` drops the player and the seat), `web/app.js:517-521` (the in-game menu offers guesser seats only, and only to unseated players).

### 4. Taps are dropped without a word while another request is in flight (`busy-drop`, `busy-drop-leave`)

**Severity: medium.** It needs a reply that is slower than the event stream, which is ordinary on a weak mobile connection.

**What a player sees.** They make a guess. The board updates (the stream is quick) but the reply to their own request is still on its way. They tap a second picture and *Guess this picture*: the sheet closes as if it worked, nothing is revealed, nothing is said. The same with an enabled *End turn*: the turn does not pass. With *Leave room* it is worse: the phone goes to the home screen, but no leave request is sent, so the server keeps them in their seat and their team waits for a player who has gone.

**Steps.** Clue of 3. The guesser guesses one of their own cards; the reply is held back. Their phone shows the card revealed. They then (a) guess a second card, or (b) tap *End turn*, or (c) open the menu and leave.

**What happens.** (a) One guess request left the phone, not two; no toast. (b) No end-turn request left the phone; no toast. (c) No leave request left the phone; the others still list the player, seated.

**Tests.** `tests/edge.spec.js`: *2a*, *2b*, *2c*.

**Where.** `web/app.js:101` (`if (ui.busy) return;`), and for the leave `web/app.js:906-907` (`leaveLocal()` runs whether or not the request was sent).

### 5. A spymaster can leave, come back and guess with the key in their head (`spymaster-lock-bypass`)

**Severity: medium.** It is cheating, so it takes intent, but the server has a rule against exactly this and the rule does not hold.

**What a player sees.** A spymaster who has seen all 24 colours leaves, joins again from the invite link, opens the menu, taps *Join Orange* and is now a guesser in the same game.

**Steps.** Four phones in a game. The spymaster leaves, rejoins by link, taps *Join <own team>* in the menu.

**What happens.** The server accepts; the seat becomes `<team>/guesser`.

**Tests.** `tests/edge.spec.js`: *4b. a spymaster who has seen the key cannot come back as a guesser in the same game*.

**Where.** `room.go:145-148` (the lock looks at `p.Role` on the player record), `room.go:224-232` (`Leave` deletes that record, so the returner is a new player).

### 6. A phone's own late reply overwrites newer state (`stale-reply`)

**Severity: medium.** With one guesser per team it needs a slow reply. With several guessers tapping close together it shows without any help: in the race hunt (seven guessers at once, no network shaping) one or two of the twelve phones were left behind in 7 of the 8 bursts run on Chromium. The one burst run on WebKit left nobody behind.

**What a player sees.** Their board is one or more guesses behind everyone else's: a card the table has revealed is still face up for them, and their guess counter is wrong. It stays wrong until the next change in the room.

**Steps.** Five phones; Orange has guessers Ben and Eve; clue of 3. Ben guesses card A and his reply is held. Eve guesses card B. Ben's phone shows B revealed (stream). Ben's old reply arrives.

**What happens.** Ben's phone shows B unrevealed again, 3 guesses left where everyone else has 2. The cross-phone check reports disagreement on `revealed`, `log`, `remaining`, `guessesLeft` and `guessesMade`, all on Ben.

**Tests.** `tests/edge.spec.js`: *10. a late reply to an earlier guess does not undo a teammate's later guess on this phone*. Seen unprompted in `tests/race-hunt.spec.js`.

**Where.** `web/app.js:105` (`act()` applies the reply with `setRoom(view)`), `web/app.js:156` (so does the stream); the view carries no version (`room.go:306-312`).

### 7. Enter in the code field creates a new room (`enter-creates-room`)

**Severity: medium.** Typing a code and pressing the keyboard's Go key is the natural thing to do on a phone.

**What a player sees.** They type their name and the four-letter code, press Enter or Go, and land alone in a different, new room.

**Steps.** Ada creates a room. Ben opens `/`, types his name and Ada's code, presses Enter in the code field.

**What happens.** Ben is in a lobby with another code; Ada's list still has only Ada.

**Tests.** `tests/edge.spec.js`: *9. Enter in the code field joins the room whose code was typed*.

**Where.** `web/app.js:321` (`e.submitter?.value || 'create'`), `web/app.js:281` (*Create a new game* is the form's first submit button, so it is the one Enter uses).

### 8. Data race on the clue log in the server (`race-clue-log`)

**Severity: medium.** Nothing visibly broke in these runs, but two goroutines read and write the same memory without a lock, and the outcome of that is undefined: a garbled clue log sent to a phone, or a crashed request.

**What it is.** `View` gives each view the game's own `Log` slice. The view is turned into JSON after the room lock is released (for every event stream and every reply). A guess that lands at that moment writes to the same log.

**Seen.** Never in the ordinary suite, which makes one move at a time. Reported by the race detector in the server under test as soon as seven guessers tapped *Guess* together through the UI (`npm run race-hunt`; 1 to 6 reports in each of seven runs), and with unmodified copies of the sources in a Go test. One report, shortened:

```
WARNING: DATA RACE
Write at 0x00c00061ce68 by goroutine 120:
  main.(*Game).Guess()                  game.go:244
  main.(*Room).Guess()                  room.go:211
  main.(*Server).handleAction.func5()   main.go:243
  main.(*Room).Do()                     room.go:130
  main.(*Server).handleAction()         main.go:243

Previous read at 0x00c00061ce68 by goroutine 87:
  reflect.Value.IsNil()
  encoding/json.sliceEncoder.encode()
  …
  encoding/json.Marshal()
  main.(*Server).handleEvents.func1()   main.go:298
  main.(*Server).handleEvents()         main.go:314
```

The same write also races with `writeJSON` for a reply (`main.go:196`, called from `main.go:261`).

**Tests.** `tests/race-hunt.spec.js` (opt-in). The race is listed in `KNOWN_RACES` in `lib/server.js`, so an ordinary run prints a banner and does not fail if it appears; `E2E_STRICT_RACES=1` makes it fail.

**Where.** `room.go:338` (`Log: g.Log`), `main.go:298` and `main.go:260-261` (JSON encoding outside the lock), `game.go:244` (`Guess` appends to the log entry).

### 9. A long clue pushes the menu button off the screen (`long-clue-overflow`)

**Severity: medium.** While that clue is showing, nobody at the table can open the menu.

**What a player sees.** The clue word is shown in capitals in the score bar and does not shrink or wrap. When it is too long, the Purple score and then the ☰ button slide off the right edge. WebKit lets the page scroll sideways; Chromium's phone emulation zooms the whole page out instead.

**Measured.** Letters that overflow, of 8, 10, 12, 14 and 40 tried:

| Screen | Overflows at |
|---|---|
| 360x780 (Chromium) | 12, 14, 40 |
| 390x844 (WebKit) | 40 |
| 430x932 (both) | 40 |
| 780x360 landscape (Chromium) | 8, 10, 12, 14, 40 |
| 844x390 landscape (WebKit) | 10, 12, 14, 40 |
| 932x430 landscape (WebKit) | 12, 14, 40 |

"thunderstorm" is enough on a small Android phone, and "umbrella" on the same phone held sideways. The thresholds are for these words and this machine's fonts.

**Tests.** `tests/layout.spec.js`: *game, guess phase with a N-letter clue: the score bar and #menu stay on screen*. Screenshots: `screenshots/<project>/clue-<N>-letters/`.

**Where.** `web/style.css:180-182` (`.scorebar` grid, whose `1fr` track cannot shrink below its content), `web/style.css:201` (`.clue-word` is `inline-block` with no maximum width), `web/style.css:422` and `:431` (landscape column and its score bar), `web/app.js:446` and `:481` (the word, up to 40 letters).

### 10. Two tabs, one leaves: the other is thrown out of its seat (`two-tabs-leave`)

**Severity: low to medium.** Same cause as bug 1.

**What a player sees.** They have the game open twice (browser and installed app, say) and leave from one. The other stays on the game screen but as a spectator: new player, no seat. Their team has lost its guesser.

**Tests.** `tests/edge.spec.js`: *8b. a player with the game open in two tabs leaves from one of them*.

**Where.** `web/app.js:157`, `room.go:224-232` (`Leave` removes the player for every tab that shares the token).

### 11. Long names push the Purple team off the lobby screen (`long-name-lobby-overflow`)

**Severity: low.** It takes names of about 20 letters with no space.

**What a player sees.** The lobby becomes 451px wide whatever the phone, so on every upright phone the Purple seats are cut off on the right. WebKit scrolls sideways; Chromium zooms out. The same names fit in the menu sheet.

**Tests.** `tests/layout.spec.js`: *lobby with the longest names the form accepts (20 letters): both teams stay on screen*. Screenshots: `screenshots/<project>/long-names/`.

**Where.** `web/style.css:136` (`.teams` grid of `1fr 1fr`), `web/style.css:158` (`.seat-people`, no wrapping), `web/app.js:353` and `:276`.

### 12. A picture left open stays open over a new board (`zoom-across-deal`)

**Severity: low.** No key leaks.

**What a player sees.** At the end of a game they have a picture open in the zoom sheet. Someone taps *Play again*. Their sheet now shows whatever picture of the new board is in that position. Once their team is guessing it would offer *Guess this picture* for a card they never tapped.

**Tests.** `tests/edge.spec.js`: *6a*. Guard: *6b* (the full-screen viewer does close; both close on *Back to lobby*).

**Where.** `web/app.js:220` (`ui.selected` is cleared only when the view has no game).

### 13. A menu left open comes back by itself on the next deal (`menu-across-lobby`)

**Severity: low.**

**What a player sees.** They have the menu open when someone else sends everyone to the lobby. On the next deal the menu is covering their board again.

**Tests.** `tests/edge.spec.js`: *7*.

**Where.** `web/app.js:894` (only the phone that taps resets `ui.showMenu`), `web/app.js:217-228`.

### 14. The clue number is not reset by "Play again" (`clue-number-kept`)

**Severity: low.**

**What a player sees.** After *Play again* the clue form opens on the number they used last game, not on 1. Through the lobby it does reset (test 13b), so the reset is intended.

**Tests.** `tests/edge.spec.js`: *13a*. Guard: *13b*.

**Where.** `web/app.js:221`.

### 15. A connected player can be shown as away (`conns-by-token`)

**Severity: low.** It needs bug 1 and a second, stalled connection for the same player.

**What it is.** The server counts a player's open streams, but a stream that ends takes one off whichever player holds its token at that moment. After a leave and re-join that is a different player. A stream that was stalled during the leave is never told `gone`, quietly attaches to the new player, and takes one off their count when it closes.

**Seen.** Not through the UI. With a direct probe against a private copy of the race-built server: two streams for one token, one of them not reading; leave; the reading one re-joins and opens a new stream; the stalled one catches up (never told `gone`) and is closed. The player is then listed `connected: false` with a live stream. It happened 4 times out of 4 with a stalled stream, and 0 times in 2,400 tries without one.

**Tests.** None. Test 8b leaves `roster.connected` out of one waiting step because of it.

**Where.** `room.go:249-257` (`Unsubscribe` looks the player up by token), `main.go:291-302` (`send()` looks the token up again on every update).

### 16. Console error when a phone is loaded on its own turn (`vibrate-before-tap`)

**Severity: cosmetic.** Chromium only.

**What a player sees.** Nothing, apart from no buzz. A page loaded when it is already that phone's turn calls `navigator.vibrate()` before it has been tapped. Chrome refuses and logs "Blocked call to navigator.vibrate because user hasn't tapped on the frame…".

**Tests.** `tests/edge.spec.js`: *15*. The fixture lets this one console line through in every test (`table.known.vibrate`).

**Where.** `web/app.js:223`.

## Probable, not confirmed on a device

### A tap beside the menu or the zoom sheet does not close it on iPhone (`backdrop-tap-webkit`)

**If it is real: high for the menu.** The menu has no Close button and its sheet covers the ☰ button, so a player could leave it only by choosing one of its actions (*Back to lobby* ends the game) or by reloading.

**What was measured.** In Playwright's WebKit with touch input, a tap on the dimmed backdrop delivers `pointerdown`, `touchstart`, `pointerup`, `touchend` and no `click`, and the sheet stays open. The same tap does produce a click, and closes the sheet, once the backdrop or `#app` has a click listener of its own, or the backdrop has an `onclick` attribute. A listener on `document` alone, which is what the app has, is not enough. A mouse click works. Chromium's tap works.

**Why it is only probable.** That is the rule iOS Safari is documented to follow for elements that are not links, buttons or form controls. But Playwright's WebKit is a desktop build with touch switched on, not an iPhone, and it differs in at least one way: `cursor: pointer` is said to help on iOS and did not here. Open the menu on a real iPhone and tap beside it.

**Tests.** `tests/touch.spec.js`: *a tap beside the menu sheet closes it*, *a tap beside the zoom sheet closes it* (expected failures on `iphone-webkit` only).

**Where.** `web/app.js:832-854` (one click listener on `document`), `web/style.css:318` (the backdrops are plain `div`s), `web/app.js:505-530` (the menu has no close button).

## Design questions, not counted as bugs

- **A spectator can send everyone back to the lobby.** Anyone in the room can, after confirming; the server checks only that the token is in the room (`main.go:238-239`). A spectator can also join a team and tap the assassin, so refusing this one action would protect little. Test 14a records today's behaviour.
- **The only guesser of the team to move leaves.** The game waits. Nobody else at the table can guess, end the turn or take the seat. It carries on when that player, or anyone unseated, joins the team from the menu. Test 5 records it.

## Checked and found correct

- **Win detection.** All agents found, the assassin, and revealing the opponent's last agent each end the game with the right winner and reason (full-game tests 2 to 5, and the rules model after every bot move).
- **No key leak.** Guessers and spectators never get a team for an unrevealed card: not in the JSON, the tile classes, the aria-labels, the zoom sheet or the full-screen viewer. Checked after every move, after *Play again*, after swapping roles through the lobby, and for a spectator who joins mid-game (11a).
- **Reload keeps the seat.** Every role, in the clue phase, the guess phase, after game over and on a new board, comes back with the same id, seat and view (8a).
- **Duplicate spymaster.** The second phone to reach the server is refused with a toast and stays unseated (11b).
- **Zoom sheet in landscape.** It fits at 780x360, 844x390 and 932x430, with its buttons tappable. Not tried below 360px high.
- **Board and key frames.** 24 square tiles in 4 columns by 6 rows on all seven screen sizes; key frames painted for spymasters and at game over, absent for everyone else.
- **Clue typed without touching the number** survives a broadcast (3b). **The clue number** resets through the lobby (13b). **The full-screen viewer** closes on a new deal (6b).
