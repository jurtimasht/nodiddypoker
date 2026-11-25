# NoDiddyPoker

Poker for friends: three cash tables (NL Hold'em, PLO4, PLO5 double-board bomb pot), lobby with
accounts, photos, a Diddy leaderboard (who cracked the biggest all-in favourites), chat, hand history with replay, time banks, all-in equity.

Live at `https://alexandertarakanov.app/poker/`. Everyone has their own account (nickname + password,
works from any device). Creating an account needs an invite code; the owner sets it in the lobby.

## What is where

| File | What it does |
|---|---|
| `server.py` | Web server (aiohttp): pages, WebSocket for the tables, lobby API, online list |
| `engine.py` | All poker rules: dealing, betting (no limit / pot limit), side pots, bomb pot, double board, showdown, equity, timers, hand history |
| `profiles.py` | Accounts (nickname + password, logins per device, invite code), profile photos, all-time statistics (SQLite in `data/`) |
| `fair.py` | Provably fair shuffle: locked decks, seeds from players, proofs (see below) |
| `verify_hand.py` | Checks a downloaded proof of a hand. Written separately from the site's code |
| `tournament.py` | Tournaments (MTT): the "tournament director" — seating, blind levels, busts and places, moving players between tables, bots for test tournaments. No network or database inside, so it is fully tested |
| `test_mtt.py` | Tournament tests: whole tournaments of bots, start to finish (also run at the end of `test_engine.py`) |
| `test_engine.py` | Automatic tests for the rules (run them before every change) |
| `test_fair.py` | Tests for the fair shuffle (also run at the end of `test_engine.py`) |
| `test_accounts.py` | Tests for sign-up, login, passwords and owner tools (also run at the end of `test_engine.py`) |
| `static/table.*` | The table page (HTML / JS / CSS) |
| `static/fair.js` | The browser's side of the fair shuffle: makes the player's seed, verifies a hand |
| `static/throwables.js` | Things players throw at each other: drawings and animations |
| `static/lobby.*` | The lobby page |
| `static/admin.*` | The owner's page `/admin` (tournaments, players, news, invite code, Update site). Others get "not found" |
| `static/i18n.js` | English / Russian switch: dictionary and patterns for everything on screen |
| `static/` (rest) | Fonts, logo, images |
| `config.example.json` | Table settings (names, blinds, buy-ins, game type, `seats`: 7, or 2 for heads-up). The server uses its own copy in `/etc/poker/config.json` |

All the game logic is on the server. The browser only shows what the server sends.

## Provably fair shuffle

Cash tables only (tournaments use the system random generator). Inspired by CoinPoker's old decentralized RNG, with SHA-256.

1. **Lock.** The server shuffles 4 decks and seals every card: `salt = HMAC-SHA256(deck key, index)`, `commit = H("ndp/card", salt, card)`.
   One `root` hash of all 208 commits goes to every browser first.
2. **Commit.** Each browser makes `seed = H("ndp/phrase", phrase, 32 random bytes)` and sends only `H("ndp/seed", id, root, seat, seed)`.
   Who did not answer gets a seed from the server, fixed at the same moment and marked.
3. **Reveal.** Everyone sees all the hashes, then the browsers send the seeds. A browser refuses if the root changed or its own hash is not in the list.
   No seed within 1.5 s: the shuffle is thrown away, shown to everybody, and a new one starts without that player's seed.
4. **Shuffle.** `combined = H("ndp/combine", id, table, hand, root, seat, seed, seat, seed, ...)` (seats ascending) feeds a stream of 32-bit
   big-endian words `H("ndp/stream", combined, counter)`; numbers below n use rejection sampling. The first number picks 1 deck of 4,
   then Fisher-Yates from 51 down to 1 orders its cards.
5. **Deal.** Every seat has fixed places in the deck: `seat * hole_cards + k`. Boards come after all seats (empty ones too), one burn card before each street.
   So nobody can change the board by sitting out at the last moment.
6. **Proof.** After the hand: the 3 unused decks in full, the played deck's 52 commits, all seeds, and the cards you were allowed to see with their salts.
   Folded, burned and undealt cards stay sealed.

`H(tag, parts...)` is SHA-256 over every part with its 4-byte big-endian length in front; numbers are written as decimal text, ids / keys / hashes as raw bytes.

**Check a hand:** History, open a hand, **Verify the shuffle**. Or download the proof and run `python verify_hand.py proof.json`.

**What it does not prove.** The server deals, so it knows the cards; this shows that nobody steered the shuffle, not that nobody can peek.
A hand where all seeds came from the server proves nothing. A rigged deck among the 4 is caught 3 times out of 4 (per hand), not always.
Each thrown-away shuffle is listed in the proof: many of them is a bad sign. A server that chooses who is dealt in can't change the cards, but sees the deck before betting.

WebSocket messages: server `{"type":"fair","phase":"commit"|"reveal"|"ready"|"aborted","id",...}`, browser `{"type":"seed_commit"|"seed_reveal","id","value"}` (64 hex characters).

## Run it on your computer

You need Python 3.12+.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip install -r requirements.txt
POKER_DEV=1 .venv/bin/python server.py          # Windows (PowerShell): $env:POKER_DEV=1; .venv\Scripts\python server.py
```

Open http://127.0.0.1:5300/ — create an account, join a table. `POKER_DEV=1` makes you the "owner":
you don't need an invite code, and you see the owner tools (invite code, reset password, delete account).
To play against yourself, create a second account in a private window. Your local accounts and photos go to `data/` (not uploaded to GitHub).

## Tests

```bash
.venv/bin/python test_engine.py
```

It must end with `ВСЁ ХОРОШО` ("all good"). It plays thousands of random hands and checks that
no chips are lost, pots are split correctly, etc. Takes about 2–3 minutes.

## How changes go live

1. Make a branch, change things, run the tests.
2. Push to GitHub (a Pull Request into `main` is nice, so Sanya can read what changed).
3. The server looks at `main` on GitHub every 2 minutes. When there is a new version it runs the
   tests on it (nothing is installed yet).
4. Sanya sees the new version in the lobby — the list of changes and whether the tests passed —
   and presses **Update site**. The server waits until nobody is sitting at a table, installs the
   new version and restarts. If the site does not come up, it goes back to the previous version.

So nothing reaches the live site until the tests pass **and** Sanya presses the button.

Please don't put passwords, keys or player data into the repository.
