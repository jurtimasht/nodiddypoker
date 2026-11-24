# NoDiddyPoker

Poker for friends: three cash tables (NL Hold'em, PLO4, PLO5 double-board bomb pot), lobby with
profiles, photos, an all-time leaderboard, chat, hand history with replay, time banks, all-in equity.

Live at `https://alexandertarakanov.app/poker/` (behind a login).

## What is where

| File | What it does |
|---|---|
| `server.py` | Web server (aiohttp): pages, WebSocket for the tables, lobby API, online list |
| `engine.py` | All poker rules: dealing, betting (no limit / pot limit), side pots, bomb pot, double board, showdown, equity, timers, hand history |
| `profiles.py` | Nicknames, profile photos, all-time statistics (SQLite in `data/`) |
| `test_engine.py` | Automatic tests for the rules (run them before every change) |
| `static/table.*` | The table page (HTML / JS / CSS) |
| `static/lobby.*` | The lobby page |
| `static/` (rest) | Fonts, logo, images |
| `config.example.json` | Table settings (names, blinds, buy-ins, game type). The server uses its own copy in `/etc/poker/config.json` |

All the game logic is on the server. The browser only shows what the server sends.

## Run it on your computer

You need Python 3.12+.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip install -r requirements.txt
POKER_DEV=1 .venv/bin/python server.py          # Windows (PowerShell): $env:POKER_DEV=1; .venv\Scripts\python server.py
```

Open http://127.0.0.1:5300/ — pick a nickname, join a table. Open a second browser window
(or a private window) to play against yourself. `POKER_DEV=1` makes you the "owner" so you can
also try the reset buttons. Your local players and photos go to `data/` (not uploaded to GitHub).

## Tests

```bash
.venv/bin/python test_engine.py
```

It must end with `ВСЁ ХОРОШО` ("all good"). It plays thousands of random hands and checks that
no chips are lost, pots are split correctly, etc. Takes about 2–3 minutes.

## How changes go live

1. Make a branch, change things, run the tests.
2. Open a Pull Request on GitHub. Sanya reviews it and merges it into `main`.
3. The server checks GitHub every minute. When `main` has a new version it runs the tests;
   if they pass it updates the site (it waits until nobody is sitting at a table, so a hand
   is never cut off). If the tests fail, the site stays on the old version.

Please don't put passwords, keys or player data into the repository.
