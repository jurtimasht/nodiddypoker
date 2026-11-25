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
| `tournament.py` | Tournaments (MTT): the "tournament director" — seating, blind levels, busts and places, moving players between tables, bots for test tournaments. No network or database inside, so it is fully tested |
| `test_mtt.py` | Tournament tests: whole tournaments of bots, start to finish (also run at the end of `test_engine.py`) |
| `test_engine.py` | Automatic tests for the rules (run them before every change) |
| `test_accounts.py` | Tests for sign-up, login, passwords and owner tools (also run at the end of `test_engine.py`) |
| `static/table.*` | The table page (HTML / JS / CSS) |
| `static/throwables.js` | Things players throw at each other: drawings and animations |
| `static/lobby.*` | The lobby page |
| `static/admin.*` | The owner's page `/admin` (tournaments, players, news, invite code, Update site). Others get "not found" |
| `static/i18n.js` | English / Russian switch: dictionary and patterns for everything on screen |
| `static/` (rest) | Fonts, logo, images |
| `config.example.json` | Table settings (names, blinds, buy-ins, game type, `seats`: 7, or 2 for heads-up). The server uses its own copy in `/etc/poker/config.json` |

All the game logic is on the server. The browser only shows what the server sends.

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
