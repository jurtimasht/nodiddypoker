"""Покер для друзей — сервер. Несколько постоянных столов (кэш-игра), список — в config.json.

Адреса (nginx добавляет спереди /poker; общего пароля больше нет — у каждого свой аккаунт):
  /                 лобби: вход / регистрация (по коду приглашения), ник, фото, таблица лидеров
  /table?t=<id>     страница стола
  /ws?t=<id>        «живая» связь со столом (WebSocket)
  /api/...          лобби: аккаунт, фото, лидеры, инструменты хозяина
  /avatar/<файл>    фото профилей
  /static/...       стили и скрипты страниц

Настройки столов (название, блайнды, минимальный вход, время на ход): /etc/poker/config.json
Столы живут в памяти: после перезапуска службы столы пустые, все садятся заново.
Один игрок может сидеть только за одним столом.
"""
import asyncio
import json
import math
import os
from collections import deque
import re
import secrets
import time
from pathlib import Path

from aiohttp import WSMsgType, web

import profiles
import tournament
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

cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
# Список столов. Старый формат (один стол без "tables") тоже понимаем.
TABLE_CFG = cfg.get("tables") or [{"id": "main", "name": "Main", "small_blind": cfg["small_blind"],
                                   "big_blind": cfg["big_blind"], "min_buyin": cfg["min_buyin"]}]
TABLES = {}
for tc in TABLE_CFG:
    t = Table(tc["id"], tc["small_blind"], tc["big_blind"], tc["min_buyin"],
              tc.get("max_buyin", cfg.get("max_buyin", 1_000_000)), tc.get("turn_seconds", cfg.get("turn_seconds", 10)),
              game=tc.get("game", "nlhe"), bomb_bb=tc.get("bomb_bb", 0), double_board=tc.get("double_board", False),
              seats=tc.get("seats", cfg.get("seats", 7)))     # мест за столом: 7, у heads-up — 2
    t.name = tc.get("name", tc["id"])
    t.buyins = tc.get("buyins", cfg.get("buyins"))   # варианты входа/докупки, например [10000, 15000, 20000]
    t.chat = deque(maxlen=60)              # последние сообщения чата этого стола (в памяти, как и стол)
    t.equity_task = None
    t.fair = True                          # честная перемешка: секреты игроков + доказательство (fair.py)
    t.on_hand_end = profiles.record_hand   # после каждой раздачи — в статистику за всё время (общую для всех столов)
    TABLES[t.code] = t
DEFAULT_TABLE = next(iter(TABLES))
connections = set()
outbox = []                     # (стол, сообщение) — разослать всем за этим столом (например, новое в чате)
lobby_outbox = []               # сообщение — разослать всем, у кого открыто лобби (общий чат)
LOBBY_CHAT_PER_MINUTE = 20      # не больше 20 сообщений в минуту от одного человека (со всех вкладок)
lobby_chat_times = {}           # pid -> времена последних сообщений
THROWABLES = ("clap", "poop")   # чем можно кинуть в соперника (рисунки — в throwables.js, те же названия)
THROW_PAUSE = 1.5               # кидать не чаще раза в 1,5 с (со всех вкладок)
last_throws = {}                # pid -> когда кинул последний раз


# ---------- турнир (MTT): один активный турнир, им управляет директор (tournament.py) ----------
MTT = None                      # директор текущего (или последнего законченного) турнира
mtt_recorded = set()            # у каких турниров итоги уже записаны в базу


def mtt_live():
    return MTT is not None and MTT.status in ("running", "paused")


def all_tables(active_only=False):
    """Все столы: кэш + столы турнира. active_only — только если турнир сейчас идёт (не закончен)."""
    extra = list(MTT.tables.values()) if MTT is not None and (mtt_live() or not active_only) else []
    return list(TABLES.values()) + extra


def find_table(code):
    return TABLES.get(code) or (MTT.tables.get(code) if MTT is not None else None)


def mtt_save(state):
    profiles.mtt_save_state(state["tid"], state)


def mtt_load():
    """При запуске сервера: поднять активный турнир из базы (идущий — встанет на паузу и продолжится сам через 5 мин)."""
    global MTT
    row = profiles.mtt_active()
    if row is None:
        return
    if row["state"]:
        MTT = tournament.Director.restore(row["state"], time.time(), save=mtt_save)
    else:
        MTT = tournament.Director(row["id"], row["name"], row["config"], save=mtt_save)
        MTT.starts_at = row["starts_at"]
    print(f"tournament {row['id']} loaded: {MTT.status}", flush=True)


def table_of_pid(pid, cash_only=False):
    """За каким столом сидит профиль (или None). Турнир — только пока он идёт."""
    for t in (TABLES.values() if cash_only else all_tables(active_only=True)):
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


# ---------- какие вкладки «держат» место за столом ----------
# Игрок «онлайн», пока хоть одна вкладка держит его место: p.connections — сколько вкладок держат
# (стол + лобби), p.table_conns — из них вкладок со столом. Раньше эти числа меняли руками ±1 в семи местах;
# теперь вкладка только говорит, какое место держит (hold), а числа каждый раз пересчитываются с нуля (recount).
_touched = set()                # места, которые вкладки только что отпустили (их тоже пересчитать)


def held_by(conn):
    """Какие места держит эта вкладка. Вкладка стола — своё место на этом столе.
    Вкладка лобби — ВСЕ места этого профиля (кэш-столы и идущий турнир): пока лобби открыто, игрок «на сайте»."""
    if conn.lobby:
        if conn.profile is None:
            return []
        pid = conn.profile["id"]
        return [p for t in all_tables(active_only=True) for p in t.players() if p.pid == pid and t.seats[p.seat] is p]
    return [conn.player] if conn.player is not None else []


def hold(conn, p):
    """Вкладка conn теперь держит место p (None — ничего не держит). Числа пересчитает recount()."""
    if conn.player is not None and conn.player is not p:
        _touched.add(conn.player)
    conn.player = p
    if p is not None:
        _touched.add(p)


def recount():
    """Пересчитать connections / table_conns у всех людей за столами по открытым вкладкам.
    Число стало 0 — запоминаем, когда (через KICK_AFTER встанет из-за кэш-стола)."""
    total, at_table = {}, {}
    for conn in connections:
        for p in held_by(conn):
            total[id(p)] = total.get(id(p), 0) + 1
            if not conn.lobby:
                at_table[id(p)] = at_table.get(id(p), 0) + 1
    people = {id(p): p for t in all_tables() for p in t.players()}
    people.update((id(p), p) for p in _touched)
    _touched.clear()
    now = time.time()
    for key, p in people.items():
        if p.bot:
            continue                    # бот всегда «за столом»
        n = total.get(key, 0)
        if n > 0:
            p.offline_since = None
        elif p.connections > 0:
            p.offline_since = now       # только что закрыл последнюю вкладку
        p.connections = n
        p.table_conns = at_table.get(key, 0)


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
            data = {**conn.table.view(conn.player), "owner": conn.owner, "table_name": conn.table.name}
            if conn.table.mtt and MTT is not None:
                data["mtt"] = tournament.table_banner(MTT, conn.table, conn.profile["id"] if conn.profile else None,
                                                      time.time())
            await send(conn, data)


async def send_fair_notes(table):
    """Шаги честной перемешки — всем за этим столом."""
    while table.fair_notes:
        note = table.fair_notes.pop(0)
        for conn in list(connections):
            if conn.table is table and not conn.lobby and conn.profile is not None:
                await send(conn, note)


# ---------- сообщения от браузера ----------
QUIET = ("seed_commit", "seed_reveal")      # после них стол не меняется: рассылать его всем незачем


def clean_name(value):
    return " ".join(str(value or "").split())[:16]


def throw(table, p, item, seat):
    """Игрок p кидает предмет в соседа: все за столом увидят полёт. Возвращает ошибку или None."""
    if item not in THROWABLES or type(seat) is not int or not 0 <= seat < len(table.seats):
        return "You can't throw that."
    if table.seats[p.seat] is not p:                # стол его уже высадил, а вкладка ещё открыта
        return "Take a seat first."
    target = table.seats[seat]
    if target is None or target is p:
        return "There is nobody to throw at."
    now = time.time()
    if now - last_throws.get(p.pid, 0) < THROW_PAUSE:
        return "Slow down 🙂"
    last_throws[p.pid] = now
    outbox.append((table, {"type": "throw", "item": item, "from": p.seat, "to": seat}))
    return None


def handle(conn, data):
    """Обрабатывает одно сообщение. Возвращает (ошибка, сообщение_только_этому_игроку).
    После любого сообщения — пересчёт, какие места держат вкладки."""
    try:
        return _handle(conn, data)
    finally:
        recount()


def _handle(conn, data):
    kind = data.get("type")
    p = conn.player
    table = conn.table

    if kind == "hello":
        conn.profile = profiles.by_secret(str(data.get("profile") or ""))
        if conn.profile is None:                # не вошёл (или вход устарел) — браузер отправит в лобби
            return None, {"type": "auth"}
        conn.lobby = bool(data.get("lobby"))
        token = str(data.get("token") or "")
        pid = conn.profile["id"]
        if not conn.lobby:
            # Вкладка стола: своё место ищем по профилю НА ЭТОМ столе (ключ места — запасной путь).
            # Место за другим столом окно не уводит: за несколькими столами можно сидеть сразу.
            if p is None:
                here = next((x for x in table.players() if x.pid == pid), None)
                if here is None and token:
                    here = next((x for x in table.players()
                                 if x.pid in (None, pid) and secrets.compare_digest(x.token, token)), None)
                if here is not None:
                    hold(conn, here)
                elif table.mtt and mtt_live():
                    # окно стола турнира, а игрок за другим столом этого турнира (пересадка) — открыть его стол
                    e = MTT.find(pid=pid)
                    if e is not None and e.status == "playing" and e.table != table.code and e.table in MTT.tables:
                        return None, {"type": "elsewhere", "table": e.table}
            return None, {"type": "chat_history", "items": list(table.chat), "me": profiles.public(conn.profile)}
        # Вкладка лобби: держит место (по ключу места или, в турнире, по профилю), чтобы игрок не «ушёл с сайта»
        found = None
        if token and p is None:
            for t in all_tables():
                player = next((x for x in t.players() if secrets.compare_digest(x.token, token)), None)
                if player is not None:
                    found = (t, player)
                    break
        if found is None and p is None and mtt_live():
            # Турнир: место ищем и по профилю — после перезапуска сервера, со второго устройства, после пересадки
            e = MTT.find(pid=pid)
            if e is not None and e.status == "playing":
                found = (MTT.tables[e.table], e.player)
        if found:
            conn.table = found[0]
            hold(conn, found[1])
        return None, {"type": "presence", "seated": conn.player is not None,
                      "table": conn.table.code if conn.player else None}

    # ---------- общий чат лобби ----------
    if kind == "lobby_chat_history" and conn.lobby:
        return None, {"type": "lobby_chat_history", "items": profiles.lobby_chat_recent(), "owner": conn.owner}
    if kind == "lobby_chat" and conn.lobby:
        now = time.time()
        if now - conn.last_chat < 0.7:
            return "Slow down 🙂", None
        pid = conn.profile["id"]
        recent = [x for x in lobby_chat_times.get(pid, []) if now - x < 60]
        if len(recent) >= LOBBY_CHAT_PER_MINUTE:
            return "Too many messages — wait a minute 🙂", None
        msg = profiles.lobby_chat_add(pid, data.get("text"))
        if msg is None:
            return None, None
        conn.last_chat = now
        lobby_chat_times[pid] = recent + [now]
        lobby_outbox.append({"type": "lobby_chat", "msg": msg})
        return None, None
    if kind == "lobby_chat_delete" and conn.lobby:
        if not conn.owner:
            return "Only the owner can delete messages.", None
        try:
            msg_id = int(data.get("id"))
        except (TypeError, ValueError):
            return None, None
        if profiles.lobby_chat_delete(msg_id):
            lobby_outbox.append({"type": "lobby_chat_deleted", "id": msg_id})
        return None, None

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

    if kind == "sit" and table.mtt:
        return "This is a tournament table — register in the lobby (MTT tab).", None
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
        hold(conn, player)
        return None, {"type": "token", "token": token}

    if conn.lobby:                          # из лобби за столом не играют
        return None, None

    if p is None:
        return "Take a seat first.", None
    if table.seats[p.seat] is not p:
        # Вкладка помнит место, где его уже нет (вылетел, пересажен, убран из пульта) — забываем его
        detach(conn)
        return "Take a seat first.", None

    if kind in QUIET:
        table.seed_message(p, kind, data.get("id"), data.get("value"))
        return None, None
    if kind == "act":
        return table.act(p, str(data.get("action")), data.get("amount", 0)), None
    if table.mtt and kind in ("rebuy", "rebuy_skip", "leave"):
        return "In a tournament you can't leave the table or rebuy here — use Sit out.", None
    if kind == "rebuy":
        return table.rebuy(p, data.get("amount")), None
    if kind == "rebuy_skip":
        table.skip_rebuy(p)
        return None, None
    if kind == "show":
        card = data.get("card")
        return table.show(p, card if isinstance(card, int) else -1), None
    if kind == "throw":
        return throw(table, p, data.get("item"), data.get("seat")), None
    if kind == "away":
        p.away = bool(data.get("value"))
        p.timeouts = 0
        if p.away and table.running and table.actor == p.seat:
            table.act(p, "check" if p.bet >= table.current_bet else "fold")
        return None, None
    if kind == "leave":
        table.leave(p)
        hold(conn, None)
        return None, {"type": "token", "token": ""}
    return "Unknown command.", None


async def ws_handler(request):
    if len(connections) >= MAX_CONNECTIONS:
        raise web.HTTPServiceUnavailable()

    # heartbeat: каждые 25 секунд проверяем, что связь жива (и Cloudflare её не закрывает)
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=4096)
    await ws.prepare(request)
    conn = Conn(ws)
    conn.table = find_table(request.query.get("t", "")) or TABLES[DEFAULT_TABLE]
    # nginx пишет "site:sanya", если открыто с входом сайта (это хозяин); у остальных заголовка нет
    conn.owner = is_owner(request)
    connections.add(conn)

    async def need_login():                 # кто не вошёл за 10 секунд — отключаем
        await asyncio.sleep(10)
        if conn.profile is None:
            await ws.close()
    guard = asyncio.create_task(need_login())
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
            if conn.profile is None and data.get("type") != "hello":
                continue                    # без входа — только «hello» с ключом входа
            if conn.table:
                conn.table.last_activity = time.time()
            try:
                error, private = handle(conn, data)
            except Exception as exc:        # ошибка в коде не должна обрывать связь игроку
                print(f"error: {exc!r}", flush=True)
                error, private = "Something went wrong on the server.", None
            if private:
                await send(conn, private)
            if conn.profile is None:
                await ws.close()
                break
            while outbox:
                where, note = outbox.pop(0)
                for other in list(connections):
                    if other.table is where and not other.lobby:
                        await send(other, note)
            while lobby_outbox:
                note = lobby_outbox.pop(0)
                for other in list(connections):
                    if other.lobby and other.profile is not None:
                        await send(other, note)
            if error:
                await send(conn, {"type": "error", "text": error})
            if conn.table:
                await send_fair_notes(conn.table)
            if data.get("type") not in QUIET:
                await broadcast(conn.table)
            if data.get("type") == "hello" and conn.table and conn.table.shuffle and not conn.lobby:
                await send(conn, conn.table.shuffle.note())     # зашёл посреди перемешки — увидит её; секрет за него в этот раз делает сервер
    finally:
        guard.cancel()
        connections.discard(conn)
        hold(conn, None)
        recount()                                     # закрыл последнюю вкладку сайта — через 15 секунд встанет
        await broadcast(conn.table)
    return ws


# ---------- страницы ----------
def page(name):
    # К адресам стилей и скриптов дописываем «версию» (время изменения файла).
    # Поменялся файл — поменялся адрес, и браузер с Cloudflare точно возьмут новый, а не старую копию.
    html = (STATIC / name).read_text(encoding="utf-8")
    def versioned(match):
        file = match.group(1)
        return f'"static/{file}?v={int((STATIC / file).stat().st_mtime)}"'
    html = re.sub(r'"static/([a-z]+\.(?:css|js|webmanifest))"', versioned, html)
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


# ---------- обновление сайта с GitHub (кнопка хозяина в лобби) ----------
# Саму проверку и установку делает /usr/local/sbin/poker-updater (root, по таймеру).
# Сервер покера только показывает его отчёт и по кнопке кладёт файл-запрос.
UPDATE_STATUS = profiles.DATA / "update-status.json"
UPDATE_REQUEST = profiles.DATA / "update-request"


def update_status():
    try:
        st = json.loads(UPDATE_STATUS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"missing": True}
    st["requested"] = UPDATE_REQUEST.exists()
    return st


async def api_update(request):
    if not is_owner(request):
        return web.json_response({"error": "Only the owner can update the site."}, status=403)
    if request.content_type != "application/json":      # защита от подделанных запросов с чужих сайтов
        raise web.HTTPBadRequest()
    data = await request.json()
    st = update_status()
    avail = st.get("available") or {}
    if avail.get("tests") != "passed" or avail.get("sha") != data.get("sha"):
        return web.json_response({"error": "This version is not tested and ready yet."}, status=409)
    UPDATE_REQUEST.write_text(json.dumps({"sha": avail["sha"], "at": time.time()}), encoding="utf-8")
    return web.json_response({"ok": True, "update": update_status()})


def lobby_data(request):
    me = me_from(request)
    if me is None:                               # не вошёл — только форма входа, без лидеров и списка онлайн
        return {"me": None, "owner": is_owner(request), "need_invite": not is_owner(request)}
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
        "mine_name": mine.name if mine else None,  # его название (стол турнира — не из списка кэш-столов)
        "mine_mtt": bool(mine and mine.mtt),
        "online": online_list(),                     # кто сейчас на сайте
        "update": update_status() if is_owner(request) else None,   # обновления с GitHub — только хозяину
        "leaders": profiles.leaderboard(),          # рейтинг Diddy
        "since": profiles.diddy_since(),
        "news": profiles.news_list(),
    }


def admin_data():
    return {"invite": profiles.invite_code(), "players": profiles.all_players()}


async def admin_page(request):
    """Страница владельца. Остальным — «не найдено»: про неё не нужно даже знать."""
    if not is_owner(request):
        raise web.HTTPNotFound()
    return page("admin.html")


async def api_admin_state(request):
    if not is_owner(request):
        return err("Only the owner can do this.", 403)
    me = me_from(request)
    return web.json_response({"admin": admin_data(), "news": profiles.news_list(50), "update": update_status(),
                              "me": profiles.public(me) if me else None},
                             headers={"Cache-Control": "private, no-store"})


async def api_lobby(request):
    return web.json_response(lobby_data(request), headers={"Cache-Control": "private, no-store"})


# ---------- служебный адрес для обновлялки ----------
# Обновлялка на этом же сервере спрашивает: жив ли сайт и сколько человек сидит за столами
# (чтобы не перезапускать сайт посреди раздачи). Отвечаем только ей: запрос с самого сервера
# напрямую, не через nginx/Cloudflare. Никаких ников и личных данных — только число.
LOCAL_HOSTS = ("127.0.0.1", "::1")


def from_this_server(request):
    if request.remote not in LOCAL_HOSTS:
        return False
    if any(h in request.headers for h in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For")):
        return False                                  # пришло через Cloudflare/прокси — значит, от посетителя
    host = request.host.rsplit(":", 1)[0].strip("[]")
    return host in ("127.0.0.1", "localhost", "::1")


async def api_health(request):
    if not from_this_server(request):
        raise web.HTTPNotFound()
    seated = sum(len(t.players()) for t in all_tables(active_only=True))   # и участники идущего турнира
    return web.json_response({"ok": True, "seated": seated}, headers={"Cache-Control": "no-store"})


# ---------- аккаунты: регистрация, вход, выход, пароль ----------
# Защита от подбора паролей: не больше нескольких неудачных попыток за 10 минут —
# с одного адреса и на один ник. Хранится в памяти (после перезапуска — заново).
FAIL_WINDOW = 10 * 60
fails = {}


def client_ip(request):
    return (request.headers.get("CF-Connecting-IP") or request.headers.get("X-Real-IP")
            or request.remote or "?")


def too_many(*keys, limit):
    now = time.time()
    for key in keys:
        fails[key] = [t for t in fails.get(key, []) if now - t < FAIL_WINDOW]
        if len(fails[key]) >= limit:
            return True
    return False


def failed(*keys):
    for key in keys:
        fails.setdefault(key, []).append(time.time())
    if len(fails) > 5000:                    # не копим мусор
        now = time.time()
        for key in [k for k, v in fails.items() if not v or now - v[-1] > FAIL_WINDOW]:
            del fails[key]


async def json_body(request):
    if request.content_type != "application/json":      # защита от подделанных запросов с чужих сайтов
        raise web.HTTPBadRequest()
    try:
        data = await request.json()
    except ValueError:
        raise web.HTTPBadRequest()
    if not isinstance(data, dict):
        raise web.HTTPBadRequest()
    return data


def err(text, status=400):
    return web.json_response({"error": text}, status=status)


SLOW_DOWN = "Too many attempts. Wait 10 minutes and try again."


async def api_register(request):
    data = await json_body(request)
    ip = "reg:" + client_ip(request)
    if too_many(ip, limit=10):
        return err(SLOW_DOWN, 429)
    prof, token, error = await profiles.register(data.get("name"), data.get("password"),
                                                data.get("invite"), is_owner(request))
    if error:
        if "invite" in error:
            failed(ip)                       # угадывание кода приглашения — тоже попытка
        return err(error)
    return web.json_response({"token": token, "me": profiles.public(prof)})


async def api_login(request):
    data = await json_body(request)
    ip, name = "ip:" + client_ip(request), "name:" + profiles.clean_name(data.get("name")).casefold()
    if too_many(ip, limit=20) or too_many(name, limit=8):
        return err(SLOW_DOWN, 429)
    prof, token, error = await profiles.login(data.get("name"), data.get("password"))
    if error:
        failed(ip, name)
        return err(error, 401)
    return web.json_response({"token": token, "me": profiles.public(prof)})


async def api_logout(request):
    await json_body(request)
    profiles.logout(request.headers.get("X-Profile", ""))
    return web.json_response({"ok": True})


async def api_password(request):
    data = await json_body(request)
    me = me_from(request)
    if me is None:
        return err("Log in first.", 401)
    key = f"pw:{me['id']}"
    if too_many(key, limit=8):
        return err(SLOW_DOWN, 429)
    error = await profiles.change_password(me["id"], data.get("old"), data.get("new"),
                                            request.headers.get("X-Profile", ""))
    if error:
        failed(key)
        return err(error)
    return web.json_response({"ok": True})


async def api_profile(request):
    """Сменить ник (вход — ключ в заголовке X-Profile)."""
    data = await json_body(request)
    me = me_from(request)
    if me is None:
        return err("Log in first.", 401)
    if table_of_pid(me["id"]):
        return err("You can change your nickname after you leave the table.", 409)
    error = profiles.rename(me["id"], data.get("name"))
    if error:
        return err(error)
    return web.json_response({"me": profiles.public(profiles.by_id(me["id"]))})


# ---------- инструменты хозяина: код приглашения, сброс пароля, удаление аккаунта ----------
async def api_news(request):
    """Новости в лобби: пишет, закрепляет и удаляет только хозяин."""
    if not is_owner(request):
        return err("Only the owner can do this.", 403)
    data = await json_body(request)
    action = data.get("action")
    if action == "post":
        if profiles.news_add("owner", data.get("text"), pinned=bool(data.get("pin"))) is None:
            return err("Write something first.")
        return web.json_response({"news": profiles.news_list()})
    try:
        news_id = int(data.get("id"))
    except (TypeError, ValueError):
        return err("No such news.", 404)
    ok = (profiles.news_pin(news_id, bool(data.get("pin"))) if action == "pin"
          else profiles.news_delete(news_id) if action == "delete" else None)
    if ok is None:
        return err("Unknown action.")
    if not ok:
        return err("No such news.", 404)
    return web.json_response({"news": profiles.news_list()})


# ---------- API турнира ----------
def mtt_view(request, admin=False):
    me = me_from(request)
    return tournament.public_view(MTT, time.time(), me["id"] if me else None, admin=admin) if MTT is not None else None


async def api_mtt(request):
    """Вкладка MTT в лобби: текущий турнир, прошлые, таблица лидеров турниров."""
    me = me_from(request)
    if me is None:
        return err("Log in first.", 401)
    past = []
    for t in profiles.mtt_list(10):
        if t["status"] != "finished" or (MTT is not None and t["id"] == MTT.tid):
            continue
        rows = profiles.mtt_results(t["id"])
        mine = next((r for r in rows if r["pid"] == me["id"]), None)
        past.append({"id": t["id"], "name": t["name"], "ended": t["ended"], "started": t["started"], "test": t["test"],
                     "players": len(rows), "winner": next((r["name"] for r in rows if r["place"] == 1), None),
                     "places": [{"place": r["place"], "name": r["name"], "points": r["points"], "trophy": r["trophy"],
                                 "prize": r["prize"]} for r in rows],
                     "pool": sum(r["paid"] for r in rows),
                     "me": {"place": mine["place"], "points": mine["points"], "trophy": mine["trophy"],
                            "prize": mine["prize"], "paid": mine["paid"]} if mine else None})
    return web.json_response({"active": mtt_view(request), "past": past, "leaders": profiles.mtt_leaderboard()},
                             headers={"Cache-Control": "private, no-store"})


async def api_mtt_card(request):
    """Карточка одного турнира: текущего (из памяти) или законченного (из базы). Только для вошедших игроков.
    Черновики и отменённые не показываем. Внутри — только ник, аватар, стек, стол, ребаи, место и приз."""
    me = me_from(request)
    if me is None:
        return err("Log in first.", 401)
    tid = int(request.match_info["tid"])
    headers = {"Cache-Control": "private, no-store"}
    if MTT is not None and MTT.tid == tid and MTT.status != "cancelled":
        return web.json_response(tournament.card_view(MTT, time.time(), me["id"]), headers=headers)
    row = profiles.mtt_get(tid)
    if row is None or row["status"] != "finished":
        return err("No such tournament.", 404)

    def avatar_of(pid):
        p = profiles.by_id(pid)
        return profiles.avatar_url(p["avatar"]) if p else None
    view = tournament.past_card(row, profiles.mtt_results(tid), me["id"], avatar_of)
    return web.json_response(view, headers=headers)


async def api_mtt_player(request):
    """Запись, отмена записи, ребай. Только для текущего турнира."""
    me = me_from(request)
    if me is None:
        return err("Log in first.", 401)
    await json_body(request)
    try:
        tid = int(request.match_info["tid"])
    except ValueError:
        raise web.HTTPNotFound()
    if MTT is None or MTT.tid != tid:
        return err("This tournament is not open.", 404)
    action = request.match_info["action"]
    if too_many("mtt:" + str(me["id"]), limit=30):
        return err(SLOW_DOWN, 429)
    failed("mtt:" + str(me["id"]))            # считаем каждый вызов: не больше 30 за 10 минут
    late = MTT.status in ("running", "paused")
    if action in ("register", "rebuy") and late and table_of_pid(me["id"], cash_only=True):
        return err("Leave your cash table first.", 409)
    if action == "register":
        error = MTT.register(me["id"], me["name"], profiles.avatar_url(me["avatar"]))
    elif action == "unregister":
        error = MTT.unregister(me["id"])
    elif action == "rebuy":
        error = MTT.rebuy(pid=me["id"])
    else:
        raise web.HTTPNotFound()
    if error:
        return err(error, 409)
    MTT.maybe_save(time.time(), force=True)
    await mtt_after_tick()
    return web.json_response({"active": mtt_view(request)})


async def api_mtt_admin_get(request):
    if not is_owner(request):
        return err("Only the owner can do this.", 403)
    rows = profiles.mtt_list(30, drafts=True)
    for r in rows:
        r.pop("state", None)                          # снимок большой и пульту не нужен
        if r["status"] == "finished":
            r["results"] = profiles.mtt_results(r["id"])
    return web.json_response({"active": mtt_view(request, admin=True), "list": rows,
                              "defaults": tournament.default_config(), "templates": tournament.TEMPLATES},
                             headers={"Cache-Control": "private, no-store"})


async def api_mtt_admin(request):
    """Пульт хозяина: создать, изменить черновик, открыть регистрацию, старт, пауза, отмена, убрать игрока…"""
    global MTT
    if not is_owner(request):
        return err("Only the owner can do this.", 403)
    data = await json_body(request)
    action = data.get("action")
    now = time.time()
    try:
        tid = int(data.get("id")) if data.get("id") is not None else None
    except (TypeError, ValueError):
        return err("No such tournament.", 404)
    starts_at = data.get("starts_at")
    if starts_at is not None and (isinstance(starts_at, bool) or not isinstance(starts_at, (int, float))
                                  or not math.isfinite(starts_at) or not now - 86400 <= starts_at <= now + 366 * 86400):
        return err("Bad start time.")
    if action in ("create", "update"):
        name = " ".join(str(data.get("name") or "").split())[:40]
        if not name:
            return err("Give the tournament a name.")
        cfg, error = tournament.validate_config(data.get("config") or {})
        if error:
            return err(error)
        if action == "create":
            tid = profiles.mtt_create(name, cfg, test=cfg["test"], starts_at=starts_at)
        else:
            row = profiles.mtt_get(tid)
            if row is None or row["status"] != "draft":
                return err("Only a draft can be changed.", 409)
            profiles.mtt_update(tid, name=name, config=cfg, test=int(cfg["test"]), starts_at=starts_at)
        return web.json_response({"id": tid, "list": profiles.mtt_list(30, drafts=True)})
    if action == "delete":
        # Черновик — стираем совсем. Законченный или отменённый — убираем из всех списков (итоги остаются в рейтинге).
        # Идущий (регистрация, игра, пауза) удалить нельзя: сначала Cancel.
        row = profiles.mtt_get(tid)
        if row is None or row["status"] == "deleted":
            return err("No such tournament.", 404)
        live = MTT is not None and MTT.tid == tid and MTT.status in profiles.MTT_ACTIVE
        if row["status"] in profiles.MTT_ACTIVE or live:
            return err("Cancel the tournament first.", 409)
        if row["status"] == "draft":
            profiles.mtt_delete(tid)
        else:
            profiles.mtt_hide(tid)
            if MTT is not None and MTT.tid == tid:
                MTT = None                     # законченный турнир больше не показываем в лобби
        return web.json_response({"list": profiles.mtt_list(30, drafts=True)})
    if action == "open":
        row = profiles.mtt_get(tid)
        if row is None or row["status"] != "draft":
            return err("Only a draft can be opened.", 409)
        if MTT is not None and MTT.status in ("registration", "running", "paused"):
            return err("Another tournament is already open — finish or cancel it first.", 409)
        MTT = tournament.Director(tid, row["name"], row["config"], save=mtt_save)
        MTT.starts_at = row["starts_at"]
        MTT.maybe_save(now, force=True)
        return web.json_response({"active": mtt_view(request, admin=True)})
    if MTT is None or MTT.tid != tid:
        return err("This tournament is not open.", 404)
    if action == "start":
        if MTT.status == "registration" and len(MTT.entries) >= 2:
            for e in MTT.entries:           # записавшиеся встают из-за кэш-столов (после своей раздачи)
                if e.pid is not None:
                    leave_cash_for_tournament(e.pid)
        error = MTT.start(now)
    elif action == "pause":
        error = MTT.pause(now)
    elif action == "next_level":
        error = MTT.next_level(now)
    elif action == "resume":
        error = MTT.resume(now)
    elif action == "cancel":
        error = MTT.cancel(now)
    elif action == "kick":
        error = MTT.kick(pid=data.get("pid"), name=data.get("name"))
    elif action == "extend_reg":
        level = data.get("level")
        if isinstance(level, bool) or not isinstance(level, int) or not MTT.level + 1 <= level <= len(MTT.cfg["levels"]):
            error = "Pick a level from the current one to the last."
        else:
            MTT.cfg["late_reg_level"] = level
            MTT.dirty = MTT.urgent = True
            error = None
    elif action == "add_bots":
        n = data.get("n")
        error = MTT.add_bots(n) if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 20 else "From 1 to 20 bots."
    elif action == "remove_bots":
        error = MTT.remove_bots()
    elif action == "starts_at":
        MTT.starts_at = starts_at
        MTT.dirty = MTT.urgent = True
        error = None
    else:
        return err("Unknown action.")
    if error:
        return err(error, 409)
    MTT.maybe_save(now, force=True)
    await mtt_after_tick()
    return web.json_response({"active": mtt_view(request, admin=True)})


async def api_admin(request):
    if not is_owner(request):
        return err("Only the owner can do this.", 403)
    data = await json_body(request)
    action = data.get("action")
    if action == "invite":
        error = profiles.set_invite_code(data.get("code"))
        if error:
            return err(error)
        return web.json_response({"admin": admin_data()})
    try:
        target = profiles.by_id(int(data.get("id")))
    except (TypeError, ValueError):
        target = None
    if target is None:
        return err("No such player.", 404)
    if action == "reset_password":
        temp = await profiles.reset_password(target["id"])
        return web.json_response({"password": temp, "name": target["name"], "admin": admin_data()})
    if action == "delete":
        if table_of_pid(target["id"]):
            return err("This player is seated at a table — wait until they leave.", 409)
        profiles.delete_profile(target["id"])
        for conn in list(connections):       # открытые вкладки этого игрока — закрыть
            if conn.profile and conn.profile["id"] == target["id"]:
                conn.profile = None
                await conn.ws.close()
        return web.json_response({"admin": admin_data()})
    return err("Unknown action.")


async def api_avatar(request):
    me = me_from(request)
    if me is None:
        return web.json_response({"error": "Log in first."}, status=401)
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
    for t in all_tables():                       # если сидит за столом — новое фото сразу видно всем
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
    if path.parent != STATIC or not path.is_file() or path.suffix not in (".js", ".css", ".svg", ".webp", ".png", ".woff2", ".webmanifest"):
        raise web.HTTPNotFound()
    headers = {"Cache-Control": "private, no-store"}
    if path.suffix == ".webmanifest":                # «На экран Домой»: описание приложения (иконка, без адресной строки)
        headers["Content-Type"] = "application/manifest+json"
    return web.FileResponse(path, headers=headers)


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


# ---------- турнир: после каждого такта директора ----------
def detach(conn):
    """Вкладка больше не «держит» игрока (его нет на этом месте)."""
    hold(conn, None)


def seated_somewhere(p):
    return any(t.seats[p.seat] is p for t in all_tables() if p.seat < len(t.seats))
def leave_cash_for_tournament(pid):
    """Записался в турнир, а на старте сидит за кэш-столом: встаёт после своей раздачи (решение Саши)."""
    t = table_of_pid(pid, cash_only=True)
    if t is None:
        return
    p = next(x for x in t.players() if x.pid == pid)
    t.leave(p)
    for conn in list(connections):
        if conn.player is p:
            hold(conn, None)
    recount()


async def mtt_after_tick():
    """Пересадки, рассадка на старте, конец турнира: сказать браузерам и записать итоги."""
    moved = list(MTT.moves)
    MTT.moves.clear()
    for p, code in moved:
        new = MTT.tables.get(code)
        if new is None or p.pid is None:
            continue
        for conn in list(connections):
            if not conn.profile or conn.profile["id"] != p.pid:
                continue
            if conn.lobby:
                hold(conn, p)                       # вкладка лобби теперь «держит» место в турнире
                conn.table = new
                await send(conn, {"type": "mtt_seat", "table": code})
            elif conn.table is not new and (conn.player is p or (conn.table is not None and conn.table.mtt)):
                # окно этого места или окно стола турнира переходит само; кэш-окна игрока не трогаем
                await send(conn, {"type": "elsewhere", "table": code})
    # Вылетел, убран из пульта или пересажен: старые вкладки больше не держат его прежнее место
    for conn in list(connections):
        p = conn.player
        if p is None or conn.table is None or not conn.table.mtt:
            continue
        if conn.table.seats[p.seat] is not p and not (conn.lobby and seated_somewhere(p)):
            detach(conn)
    recount()
    # Стол закрыли (слияние), а на нём остались зрители или вылетевшие — переводим их за оставшийся стол
    live_tables = list(MTT.tables.values())
    if live_tables:
        biggest = max(live_tables, key=lambda t: len(t.players()))
        for conn in list(connections):
            if conn.table is not None and conn.table.mtt and not conn.lobby and conn.table not in live_tables \
                    and conn.table.code.startswith(f"m{MTT.tid}-"):
                conn.table = biggest
                await send(conn, {"type": "elsewhere", "table": biggest.code})
    if MTT.status in ("finished", "cancelled") and MTT.tid not in mtt_recorded:
        mtt_recorded.add(MTT.tid)
        if MTT.status == "finished":
            profiles.mtt_record_results(MTT.tid, MTT.results(), test=MTT.cfg["test"])
            win = MTT.alive()[0] if MTT.alive() else None
            if win is not None and not MTT.cfg["test"]:
                prize = next((r["prize"] for r in MTT.results() if r["place"] == 1), 0)
                money = f" and ${prize / 100:,.2f}".replace(".00", "") if prize else ""
                profiles.news_add("tournament", f"{win.name} won the tournament {MTT.name}{money}", pid=win.pid)
        MTT.maybe_save(time.time(), force=True)
    for t in MTT.tables.values():
        await broadcast(t)


# ---------- таймер: ходы по времени и следующая раздача (на всех столах) ----------
async def ticker(_app):
    async def loop():
        while True:
            await asyncio.sleep(0.25)
            if MTT is not None:
                try:
                    if MTT.tick(time.time()):
                        await mtt_after_tick()
                except Exception as exc:        # ошибка директора не должна останавливать сервер
                    print(f"tournament error: {exc!r}", flush=True)
            for table in all_tables():
                try:
                    changed = table.tick()
                    await send_fair_notes(table)
                    if changed:
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
    if MTT is None:
        mtt_load()                     # турнир, который шёл до перезапуска
    app = web.Application(client_max_size=profiles.MAX_UPLOAD + 1024)
    app.add_routes([
        web.get("/", lobby_page),
        web.get("/table", table_page),
        web.get("/admin", admin_page),
        web.get("/api/admin/state", api_admin_state),
        web.get("/api/lobby", api_lobby),
        web.get("/api/health", api_health),
        web.post("/api/register", api_register),
        web.post("/api/login", api_login),
        web.post("/api/logout", api_logout),
        web.post("/api/password", api_password),
        web.post("/api/profile", api_profile),
        web.post("/api/admin", api_admin),
        web.post("/api/news", api_news),
        web.get("/api/mtt", api_mtt),
        web.get("/api/mtt/admin", api_mtt_admin_get),
        web.get(r"/api/mtt/{tid:\d{1,9}}", api_mtt_card),
        web.post("/api/mtt/admin", api_mtt_admin),
        web.post("/api/mtt/{tid}/{action}", api_mtt_player),
        web.post("/api/avatar", api_avatar),
        web.delete("/api/avatar", api_avatar),
        web.post("/api/stats/reset", api_reset_stats),
        web.post("/api/update", api_update),
        web.get("/avatar/{name}", avatar_file),
        web.get("/ws", ws_handler),
        web.get("/static/{name}", static_file),
    ])
    app.cleanup_ctx.append(ticker)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=HOST, port=PORT, access_log=None)
