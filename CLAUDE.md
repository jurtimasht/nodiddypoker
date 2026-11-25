# CLAUDE.md — NoDiddyPoker

Instructions for Claude Code (and humans) working on this repository. Read `README.md` first: it has the file map and how to run things.

## What this is

Poker for a small group of friends (≈7 people, mostly PCs, sometimes phones). Play chips only, never real money.
Live at `https://alexandertarakanov.app/poker/`. Owner: Sanya. Two people push to this repo (Sanya's setup and a friend), so expect commits you didn't write.

## Golden rules

1. **Run the tests before every commit.** `python test_engine.py` (or `.venv/bin/python test_engine.py`) must end with `ВСЁ ХОРОШО`. It also runs `test_accounts.py`. Takes ~2–3 min.
2. **Add a test for every rule change** in `engine.py` (betting, pots, showdown, timers, seats). Chips must never appear or vanish.
3. **`git pull` before you start**, keep commits small, one topic per commit, clear English commit messages. Don't rewrite history on `main` (no force-push).
4. **No secrets or player data in git.** No passwords, invite codes, tokens, keys, `data/`, real `config.json`. `data/` and `.venv/` are in `.gitignore`.
5. **Nothing goes live by itself.** Pushing to `main` → the server tests the new version → Sanya presses **Update site** in the lobby. Don't try to deploy any other way. A broken `main` blocks everyone's updates, so keep it green.

## How the code is built

- **All game logic is on the server** (`engine.py`, `server.py`). The browser only shows state and sends actions. Never trust anything from the client: check turn, amounts and permissions on the server.
- `server.py`: aiohttp app — pages, `/api/*` (lobby, accounts, avatar, owner tools, chat, news), WebSocket for tables and lobby presence. Owner is detected only from the `X-Auth-User: site:<user>` header that nginx sets; locally `POKER_DEV=1` makes you owner.
- `engine.py`: `Table` with the full hand flow (NLHE / PLO4 / PLO5, pot limit, bomb pot, double board, side pots, equity, time banks, history). Each table has its own `seats` (7, or 2 for heads-up).
- `profiles.py`: SQLite in `data/` — accounts (scrypt passwords, session tokens), avatars, stats, lobby chat, news, settings. The DB connection is single-thread: only CPU-heavy work (password hashing, equity) goes to `asyncio.to_thread`.
- Amounts inside server texts are wrapped as `§123§` (`chips()`); the browser renders them as chips or BB.
- Table config: `config.example.json` (the live server uses its own copy outside the repo). Keep table `id`s stable — links and seated players depend on them.

## Frontend

- Plain HTML/CSS/JS in `static/`, no build step, no frameworks. Keep it that way unless there's a real reason.
- Cloudflare caches static files: the server adds `?v=<mtime>` to asset URLs in the HTML. Reference new JS/CSS the same way as existing ones.
- **Language:** English is the default. Russian comes from `static/i18n.js` (dictionary + patterns, applied on the page). When you add or change any visible English text — in HTML, JS or server messages — add its Russian translation there. Poker words stay English in both (Fold, Check, Call, Raise, Bet, All-in, Blind, Hold'em, Omaha, Bomb Pot, Heads-up, MTT, Quick seat, BB). Russian uses informal "ты". Text written by people (chat, owner news, nicknames) is never translated: put it inside `data-notr`.
- Check every UI change at 1440 px and 375 px (phone). On a phone in portrait the table shows "Turn your phone"; the lobby must fit 375 px with no sideways scroll; touch targets ≥ 44 px.
- Theme: dark purple/red, fonts Inter Tight (headings, numbers, buttons) + Inter (text), self-hosted in `static/`.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
POKER_DEV=1 POKER_DATA=/tmp/poker-data .venv/bin/python server.py   # http://127.0.0.1:5300/
```

`POKER_PORT` changes the port, `POKER_CONFIG` the config file, `POKER_DATA` the data folder (use a throwaway one).

## Style

- Code comments are in Russian (the owner is learning from them); keep that style in files that already use it. Identifiers, commit messages and README in English.
- Prefer small, readable functions over clever ones. Don't add dependencies without a good reason (it also changes `requirements.txt`, which the server reinstalls).
