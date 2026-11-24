"""Покер для друзей — сервер. Несколько постоянных столов (кэш-игра), список — в config.json.

Адреса (nginx добавляет спереди /poker и пускает только после входа для покера):
  /                 лобби: ник, фото, таблица лидеров
  /table?t=<id>     страница стола
  /ws?t=<id>        «живая» связь со столом (WebSocket)
  /api/...          лобби: профиль, фото, лидеры
  /avatar/<файл>    фото профилей
  /static/...       стили и скрипты страниц

Настройки столов (название, блайнды, минимальный вход, время на ход): /etc/poker/config.json
Столы живут в памяти: после перезапуска службы столы пустые, все садятся заново.
Один игрок может сидеть только за одним столом.
"""
import asyncio
import json
import os
from collections import deque
import re
import secrets
import time
from pathlib import Path

from aiohttp import WSMsgType, web

import profiles
from engine import Table, equity

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
# Настройки столов. На сервере — /etc/poker/config.json; у разработчика на своём компьютере
# (если того файла нет) берётся config.example.json из этой папки. Можно указать свой: POKER_CONFIG=путь
CONFIG = Path(os.environ.get("POKER_CONFIG") or "/etc/poker/config.json")
if not CONFIG.exists():
    CONFIG = BASE / "config.example.json"
HOST, PORT = "127.0.0.1", int(os.environ.get("POKER_PORT", "5300"))
# POKER_DEV=1 — режим разработки на своём компьютере: ты считаешься хозяином (можно обнулять итоги и статистику).
# На сервере эта переменная не задана — хозяина определяет вход через сайт.
DEV = os.environ.get("POKER_DEV") == "1"
MAX_CONNECTIONS = 30

cfg = json.loads(CONFIG.read_text())
# Список столов. Старый формат (один стол без "tables") тоже понимаем.
TABLE_CFG = cfg.get("tables") or [{"id": "main", "name": "Main", "small_blind": cfg["small_blind"],
                                   "big_blind": cfg["big_blind"], "min_buyin": cfg["min_buyin"]}]
TABLES = {}
for tc in TABLE_CFG:
    t = Table(tc["id"], tc["small_blind"], tc["big_blind"], tc["min_buyin"],
              tc.get("max_buyin", cfg.get("max_buyin", 1_000_000)), tc.get("turn_seconds", cfg.get("turn_seconds", 10)),
              game=tc.get("game", "nlhe"), bomb_bb=tc.get("bomb_bb", 0), double_board=tc.get("double_board", False))
    t.name = tc.get("name", tc["id"])
    t.buyins = tc.get("buyins", cfg.get("buyins"))   # варианты входа/докупки, например [10000, 15000, 20000]
    t.chat = deque(maxlen=60)              # последние сообщения чата этого стола (в памяти, как и стол)
    t.equity_task = None
    t.on_hand_end = profiles.record_hand   # после каждой раздачи — в статистику за всё время (общую для всех столов)
    TABLES[t.code] = t
DEFAULT_TABLE = next(iter(TABLES))
connections = set()
outbox = []                     # (стол, сообщение) — разослать всем за этим столом (например, новое в чате)


def table_of_pid(pid):
    """За каким столом сидит профиль (или None)."""
    for t in TABLES.values():
        if any(p.pid == pid for p in t.players()):
            return t
    return None


class Conn:
    """Одна открытая вкладка браузера за столом."""
    def __init__(self, ws):
        self.ws = ws
        self.player = None      # если сидит за столом
        self.last_chat = 0.0    # когда писал в чат (защита от флуда)
        self.owner = False      # хозяин сайта (вошёл своим входом sanya) — только он может обнулять итоги
        self.profile = None     # профиль из лобби (ник, фото)
        self.lobby = False      # это вкладка лобби: только «я ещё на сайте», без игры
        self.table = None       # какой стол открыт в этой вкладке (у лобби — стол, где сидит игрок)


# ---------- отправка состояния всем за столом ----------
async def send(conn, data):
    try:
        await conn.ws.send_json(data)
    except (ConnectionError, RuntimeError):
        pass


async def broadcast(table=None):
    # каждый получает СВОЙ вид своего стола: свои карты видно, чужие — нет
    for conn in list(connections):
        if conn.lobby or conn.table is None:          # лобби стол не рисует
            continue
        if table is None or conn.table is table:
            await send(conn, {**conn.table.view(conn.player), "owner": conn.owner, "table_name": conn.table.name})


# ---------- сообщения от браузера ----------
def clean_name(value):
    return " ".join(str(value or "").split())[:16]


def handle(conn, data):
    """Обрабатывает одно сообщение. Возвращает (ошибка, сообщение_только_этому_игроку)."""
    kind = data.get("type")
    p = conn.player
    table = conn.table

    if kind == "hello":
        conn.profile = profiles.by_secret(str(data.get("profile") or ""))
        conn.lobby = bool(data.get("lobby"))
        token = str(data.get("token") or "")
        if token and p is None:
            for t in TABLES.values():
                player = next((x for x in t.players() if secrets.compare_digest(x.token, token)), None)
                if player is None:
                    continue
                if not conn.lobby and t is not table:
                    # сидит за другим столом — пусть браузер откроет тот стол
                    return None, {"type": "elsewhere", "table": t.code}
                conn.table = t
                conn.player = player
                player.connections += 1
                if not conn.lobby:
                    player.table_conns += 1
                player.offline_since = None
                break
        if conn.lobby:
            return None, {"type": "presence", "seated": conn.player is not None,
                          "table": conn.table.code if conn.player else None}
        return None, {"type": "chat_history", "items": list(table.chat), "me": profiles.public(conn.profile)}

    if table is None:                       # лобби, которое ни за каким столом не сидит
        return None, None

    if kind == "chat":
        text = " ".join(str(data.get("text") or "").split())[:200]
        if not text:
            return None, None
        now = time.time()
        if now - conn.last_chat < 0.7:
            return "Slow down 🙂", None
        conn.last_chat = now
        if p:
            msg = {"name": p.name, "seat": p.seat, "watcher": False, "text": text, "t": now}
        else:                                   # зритель: имя из его профиля
            name = conn.profile["name"] if conn.profile else "Guest"
            msg = {"name": name, "seat": None, "watcher": True, "text": text, "t": now}
        table.chat.append(msg)
        outbox.append((table, {"type": "chat", "msg": msg}))
        return None, None

    if kind == "history_list":
        return None, {"type": "history_list", "items": table.history_list(p)}
    if kind == "history_hand":
        try:
            no = int(data.get("no"))
        except (TypeError, ValueError):
            return "No such hand.", None
        hand = table.history_hand(no, p)
        if hand is None:
            return "That hand is no longer stored.", None
        return None, {"type": "history_hand", "hand": hand}

    if kind == "ledger_reset":
        if not conn.owner:
            return "Only the table owner can reset the results.", None
        who = p.name if p else (conn.profile["name"] if conn.profile else "Owner")
        table.reset_ledger(who)
        return None, None

    if kind == "sit":
        if p:
            return "You are already at the table.", None
        if conn.profile is None:
            return "Pick a nickname in the lobby first.", None
        other = table_of_pid(conn.profile["id"])
        if other is not None:
            return f"You are already sitting at {other.name}. Leave that table first.", None
        prof = profiles.by_id(conn.profile["id"])            # свежие данные (ник или фото могли поменяться)
        token = secrets.token_urlsafe(16)
        player, error = table.add_player(token, prof["name"], data.get("buyin"), prof["id"], profiles.avatar_url(prof["avatar"]))
        if error:
            return error, None
        player.connections = 1
        player.table_conns = 1
        conn.player = player
        return None, {"type": "token", "token": token}

    if conn.lobby:                          # из лобби за столом не играют
        return None, None

    if p is None:
        return "Take a seat first.", None

    if kind == "act":
        return table.act(p, str(data.get("action")), data.get("amount", 0)), None
    if kind == "rebuy":
        return table.rebuy(p, data.get("amount")), None
    if kind == "rebuy_skip":
        table.skip_rebuy(p)
        return None, None
    if kind == "show":
        card = data.get("card")
        return table.show(p, card if isinstance(card, int) else -1), None
    if kind == "away":
        p.away = bool(data.get("value"))
        p.timeouts = 0
        if p.away and table.running and table.actor == p.seat:
            table.act(p, "check" if p.bet >= table.current_bet else "fold")
        return None, None
    if kind == "leave":
        table.leave(p)
        p.connections -= 1
        p.table_conns -= 1
        conn.player = None
        return None, {"type": "token", "token": ""}
    return "Unknown command.", None


async def ws_handler(request):
    if len(connections) >= MAX_CONNECTIONS:
        raise web.HTTPServiceUnavailable()

    # heartbeat: каждые 25 секунд проверяем, что связь жива (и Cloudflare её не закрывает)
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=4096)
    await ws.prepare(request)
    conn = Conn(ws)
    conn.table = TABLES.get(request.query.get("t", ""), TABLES[DEFAULT_TABLE])
    # nginx пишет, кто вошёл: "site:sanya" (хозяин сайта) или "poker:nodiddypoker" (друзья)
    conn.owner = is_owner(request)
    connections.add(conn)
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            if conn.table:
                conn.table.last_activity = time.time()
            try:
                error, private = handle(conn, data)
            except Exception as exc:        # ошибка в коде не должна обрывать связь игроку
                print(f"error: {exc!r}", flush=True)
                error, private = "Something went wrong on the server.", None
            if private:
                await send(conn, private)
            while outbox:
                where, note = outbox.pop(0)
                for other in list(connections):
                    if other.table is where and not other.lobby:
                        await send(other, note)
            if error:
                await send(conn, {"type": "error", "text": error})
            await broadcast(conn.table)
    finally:
        connections.discard(conn)
        if conn.player:
            conn.player.connections -= 1
            if not conn.lobby:
                conn.player.table_conns -= 1
            if conn.player.connections <= 0:          # закрыл последнюю вкладку сайта — через 15 секунд встанет
                conn.player.offline_since = time.time()
        await broadcast(conn.table)
    return ws


# ---------- страницы ----------
def page(name):
    # К адресам стилей и скриптов дописываем «версию» (время изменения файла).
    # Поменялся файл — поменялся адрес, и браузер с Cloudflare точно возьмут новый, а не старую копию.
    html = (STATIC / name).read_text()
    def versioned(match):
        file = match.group(1)
        return f'"static/{file}?v={int((STATIC / file).stat().st_mtime)}"'
    html = re.sub(r'"static/([a-z]+\.(?:css|js))"', versioned, html)
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "private, no-store"})


async def lobby_page(_request):
    return page("lobby.html")


async def table_page(_request):
    return page("table.html")


# ---------- лобби: профиль, фото, лидеры ----------
def is_owner(request):
    return DEV or request.headers.get("X-Auth-User", "").startswith("site:")


def me_from(request):
    return profiles.by_secret(request.headers.get("X-Profile", ""))


def online_list():
    """Кто сейчас на сайте и где: играет за столом, смотрит стол или в лобби.
    Берём открытые вкладки с профилем; один человек — одна строка (самое «активное» место)."""
    people = {}
    rank = {"playing": 0, "away": 1, "watching": 2, "lobby": 3}
    for conn in list(connections):
        if not conn.profile:
            continue
        pid = conn.profile["id"]
        seat_table = table_of_pid(pid)
        if seat_table is not None:
            p = next(x for x in seat_table.players() if x.pid == pid)
            state, where = ("away" if p.away else "playing"), seat_table.name
        elif not conn.lobby and conn.table is not None:
            state, where = "watching", conn.table.name
        else:
            state, where = "lobby", ""
        old = people.get(pid)
        if old is None or rank[state] < rank[old["state"]]:
            people[pid] = {"id": pid, "state": state, "where": where}
    out = []
    for item in people.values():
        prof = profiles.public(profiles.by_id(item["id"]))   # свежие ник и фото
        if prof:
            out.append({**item, "name": prof["name"], "avatar": prof["avatar"]})
    return sorted(out, key=lambda x: (rank[x["state"]], x["name"].lower()))


def lobby_data(request):
    me = me_from(request)
    mine = table_of_pid(me["id"]) if me else None
    tables = [{"id": t.code, "name": t.name, "sb": t.sb, "bb": t.bb, "min_buyin": t.min_buyin, "buyins": t.buyins,
               "game": t.game, "bomb": t.bomb_bb * t.bb, "double_board": t.double_board,
               "seated": [{"name": p.name, "avatar": p.avatar} for p in t.players()], "seats": len(t.seats)}
              for t in TABLES.values()]
    return {
        "me": profiles.public(me),
        "owner": is_owner(request),
        "tables": tables,
        "mine": mine.code if mine else None,       # за каким столом сижу
        "online": online_list(),                     # кто сейчас на сайте
        "bb": TABLES[DEFAULT_TABLE].bb,             # для таблицы лидеров: итог в больших блайндах
        "leaders": profiles.leaderboard(),
        "since": profiles.stats_since(),
    }


async def api_lobby(request):
    return web.json_response(lobby_data(request), headers={"Cache-Control": "private, no-store"})


async def api_profile(request):
    """Создать профиль или сменить ник. Ключ профиля — в заголовке X-Profile."""
    try:
        data = await request.json()
    except ValueError:
        raise web.HTTPBadRequest()
    secret = request.headers.get("X-Profile", "")
    me = profiles.by_secret(secret)
    if me and table_of_pid(me["id"]):
        return web.json_response({"error": "You can change your nickname after you leave the table."}, status=409)
    prof, secret, error = profiles.save_profile(data.get("name"), secret if me else None)
    if error:
        return web.json_response({"error": error}, status=400)
    return web.json_response({"secret": secret, "me": profiles.public(prof)})


async def api_avatar(request):
    me = me_from(request)
    if me is None:
        return web.json_response({"error": "Pick a nickname first."}, status=403)
    if request.method == "DELETE":
        profiles.remove_avatar(me["id"])
        url = ""
    else:
        body = await request.read()
        if not body or len(body) > profiles.MAX_UPLOAD:
            return web.json_response({"error": "The photo must be under 4 MB."}, status=400)
        webp = await asyncio.to_thread(profiles.make_avatar, body)   # уменьшение — в отдельном потоке
        if webp is None:
            return web.json_response({"error": "That does not look like an image. Use JPG, PNG, WebP or GIF."}, status=400)
        url = profiles.set_avatar(me["id"], webp)
    for t in TABLES.values():                    # если сидит за столом — новое фото сразу видно всем
        for p in t.players():
            if p.pid == me["id"]:
                p.avatar = url
    await broadcast()
    return web.json_response({"me": profiles.public(profiles.by_id(me["id"]))})


async def api_reset_stats(request):
    if not is_owner(request):
        return web.json_response({"error": "Only the owner can reset the statistics."}, status=403)
    if request.content_type != "application/json":      # защита от подделанных запросов с чужих сайтов
        raise web.HTTPBadRequest()
    profiles.reset_stats()
    return web.json_response(lobby_data(request))


async def avatar_file(request):
    name = request.match_info["name"]
    if not re.fullmatch(r"\d+-[0-9a-f]{12}\.webp", name):
        raise web.HTTPNotFound()
    path = profiles.AVATARS / name
    if not path.is_file():
        raise web.HTTPNotFound()
    # имя файла меняется при каждой новой загрузке, поэтому браузер может хранить его долго
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=604800"})


async def static_file(request):
    name = request.match_info["name"]
    path = (STATIC / name).resolve()
    if path.parent != STATIC or not path.is_file() or path.suffix not in (".js", ".css", ".svg", ".webp", ".png", ".woff2"):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "private, no-store"})


# ---------- шансы при олл-ине ----------
async def update_equity(table):
    """Олл-ин: считаем шансы игроков для текущей доски. Считаем в отдельном потоке,
    чтобы стол не «замирал», пока идёт подсчёт (до флопа — 100 000 вариантов досок)."""
    need = table.equity_need()
    if need is None or table.equity_key == need:
        return False
    players = [p for p in table.active()]
    hands = [list(p.cards) for p in players]
    board = list(table.board)
    board2 = list(table.board2) if table.double_board else None
    v1, v2 = await asyncio.to_thread(table.calc_equity, hands, board, board2)
    if table.equity_need() != need:          # пока считали, доска уже поменялась
        return False
    table.set_equity({p.seat: value for p, value in zip(players, v1)},
                     {p.seat: value for p, value in zip(players, v2)} if v2 else None)
    return True


async def equity_then_broadcast(table):
    try:
        if await update_equity(table):
            await broadcast(table)
    except Exception as exc:
        print(f"equity error: {exc!r}", flush=True)


# ---------- таймер: ходы по времени и следующая раздача (на всех столах) ----------
async def ticker(_app):
    async def loop():
        while True:
            await asyncio.sleep(0.25)
            for table in TABLES.values():
                try:
                    if table.tick():
                        await broadcast(table)
                    # шансы считаем отдельной задачей, чтобы таймер стола не ждал подсчёта
                    if table.equity_need() not in (None, table.equity_key) and (table.equity_task is None or table.equity_task.done()):
                        table.equity_task = asyncio.create_task(equity_then_broadcast(table))
                except Exception as exc:        # ошибка не должна останавливать стол
                    print(f"timer error ({table.code}): {exc!r}", flush=True)
    task = asyncio.create_task(loop())
    yield
    task.cancel()


def make_app():
    app = web.Application(client_max_size=profiles.MAX_UPLOAD + 1024)
    app.add_routes([
        web.get("/", lobby_page),
        web.get("/table", table_page),
        web.get("/api/lobby", api_lobby),
        web.post("/api/profile", api_profile),
        web.post("/api/avatar", api_avatar),
        web.delete("/api/avatar", api_avatar),
        web.post("/api/stats/reset", api_reset_stats),
        web.get("/avatar/{name}", avatar_file),
        web.get("/ws", ws_handler),
        web.get("/static/{name}", static_file),
    ])
    app.cleanup_ctx.append(ticker)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=HOST, port=PORT, access_log=None)
