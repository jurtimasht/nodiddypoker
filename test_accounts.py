"""Проверки аккаунтов: регистрация по коду приглашения, вход, пароли, инструменты хозяина.
Запуск: /opt/poker/.venv/bin/python test_accounts.py   (его же запускает test_engine.py в конце)
Работает на временной пустой базе — настоящие аккаунты не трогает."""
import asyncio
import time
import os
import tempfile

os.environ["POKER_DATA"] = tempfile.mkdtemp(prefix="poker-test-")   # до import profiles/server!
os.environ.pop("POKER_DEV", None)
# Столы — из примера в репозитории (9 столов: #1, #2 на 7 мест и Heads-up на 2), а не из настроек сервера
os.environ["POKER_CONFIG"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.example.json")

from aiohttp.test_utils import TestClient, TestServer   # noqa: E402

import server   # noqa: E402

OWNER = {"X-Auth-User": "site:sanya"}


async def run():
    server.fails.clear()
    async with TestClient(TestServer(server.make_app())) as c:
        async def post(path, body, token="", headers=None):
            r = await c.post(path, json=body, headers={"X-Profile": token, **(headers or {})})
            return r.status, await r.json()

        async def me(token, headers=None):
            r = await c.get("/api/lobby", headers={"X-Profile": token, **(headers or {})})
            return (await r.json())["me"]

        # без кода приглашения регистрироваться нельзя; хозяину код не нужен
        st, _ = await post("/api/register", {"name": "Fox", "password": "secret1", "invite": "x"})
        assert st == 400
        st, r = await post("/api/register", {"name": "Owner", "password": "ownerpw1"}, headers=OWNER)
        assert st == 200, r
        # код задаёт только хозяин
        assert (await post("/api/admin", {"action": "invite", "code": "royal flush"}))[0] == 403
        assert (await post("/api/admin", {"action": "invite", "code": "Royal Flush"}, headers=OWNER))[0] == 200
        # страница Admin и её данные — только хозяину; лобби инструменты хозяина больше не отдаёт
        assert (await c.get("/admin")).status == 404
        assert (await c.get("/admin", headers=OWNER)).status == 200
        assert (await c.get("/api/admin/state")).status == 403
        r = await c.get("/api/admin/state", headers=OWNER)
        assert r.status == 200 and (await r.json())["admin"]["invite"] == "Royal Flush"
        r = await c.get("/api/lobby", headers=OWNER)
        assert "admin" not in await r.json()
        st, r = await post("/api/register", {"name": "Fox", "password": "123", "invite": "royal flush"})
        assert st == 400 and "Password" in r["error"]
        st, r = await post("/api/register", {"name": "Fox", "password": "secret1", "invite": " ROYAL  flush "})
        assert st == 200, r
        t1 = r["token"]
        assert (await post("/api/register", {"name": "fox", "password": "secret1", "invite": "royal flush"}))[0] == 400
        # вход с другого устройства — тот же аккаунт
        assert (await post("/api/login", {"name": "Fox", "password": "nope"}))[0] == 401
        st, r = await post("/api/login", {"name": "FOX", "password": "secret1"})
        assert st == 200 and r["me"]["name"] == "Fox" and r["token"] != t1
        t2 = r["token"]
        assert (await me(t1))["id"] == (await me(t2))["id"]
        assert await me("") is None and await me("bogus") is None
        # не вошёл — лобби пустое, без лидеров
        r = await (await c.get("/api/lobby")).json()
        assert set(r) == {"me", "owner", "need_invite"}
        # смена пароля: это устройство остаётся, другие выходят
        assert (await post("/api/password", {"old": "x", "new": "newpass1"}, t1))[0] == 400
        assert (await post("/api/password", {"old": "secret1", "new": "newpass1"}, t1))[0] == 200
        assert await me(t1) and await me(t2) is None
        assert (await post("/api/login", {"name": "Fox", "password": "newpass1"}))[0] == 200
        # инструменты хозяина: не хозяину — нельзя
        fox = (await me(t1))["id"]
        assert (await post("/api/admin", {"action": "reset_password", "id": fox}, t1))[0] == 403
        st, r = await post("/api/admin", {"action": "reset_password", "id": fox}, headers=OWNER)
        assert st == 200 and await me(t1) is None
        st, r = await post("/api/login", {"name": "Fox", "password": r["password"]})
        assert st == 200
        t3 = r["token"]
        assert (await post("/api/logout", {}, t3))[0] == 200 and await me(t3) is None
        st, r = await post("/api/login", {"name": "Fox", "password": "newpass1"})
        assert st == 401                        # старый пароль после сброса не работает
        assert (await post("/api/admin", {"action": "delete", "id": fox}, headers=OWNER))[0] == 200
        assert (await post("/api/register", {"name": "Fox", "password": "secret1", "invite": "royal flush"}))[0] == 200
        # подбор пароля: после 8 неудач на ник — пауза
        server.fails.clear()
        codes = [(await post("/api/login", {"name": "Fox", "password": f"bad{i}"}))[0] for i in range(9)]
        assert codes[:8] == [401] * 8 and codes[8] == 429, codes
        # запрос не-JSON (подделка с чужого сайта) — отказ
        assert (await c.post("/api/login", data={"name": "Fox", "password": "secret1"})).status == 400
        # WebSocket без входа — сервер просит войти и закрывает связь
        ws = await c.ws_connect("/ws?t=" + server.DEFAULT_TABLE)
        await ws.send_json({"type": "hello", "profile": "bogus"})
        assert (await ws.receive_json())["type"] == "auth"
        await ws.close()
    server.fails.clear()


async def lobby_chat():
    """Общий чат лобби: пишут только вошедшие, 200 символов, не чаще раза в 0,7 с, хранится в базе, удаляет хозяин."""
    server.fails.clear()
    async with TestClient(TestServer(server.make_app())) as c:
        async def account(name, headers=None):
            r = await c.post("/api/register", json={"name": name, "password": "secret12", "invite": "Royal Flush"},
                             headers=headers or {})
            return (await r.json())["token"]

        async def lobby(token, headers=None):
            ws = await c.ws_connect("/ws", headers=headers or {})
            await ws.send_json({"type": "hello", "lobby": True, "profile": token})
            assert (await ws.receive_json())["type"] == "presence"
            return ws

        async def next_of(ws, kind):
            for _ in range(10):
                m = await ws.receive_json(timeout=3)
                if m["type"] == kind:
                    return m
            raise AssertionError(kind)

        fox = await account("ChatFox")
        boss = await account("ChatBoss", OWNER)
        a = await lobby(fox)
        b = await lobby(boss, OWNER)
        await a.send_json({"type": "lobby_chat_history"})
        hist = await next_of(a, "lobby_chat_history")
        assert hist["owner"] is False
        start = len(hist["items"])
        await a.send_json({"type": "lobby_chat", "text": "  hi   <b>all</b> " + "x" * 300})
        got = await next_of(b, "lobby_chat")                     # видят все, у кого открыто лобби
        assert got["msg"]["name"] == "ChatFox" and got["msg"]["text"].startswith("hi <b>all</b> x")
        assert len(got["msg"]["text"]) == 200
        await a.send_json({"type": "lobby_chat", "text": "too fast"})
        assert (await next_of(a, "error"))["text"].startswith("Slow down")
        assert len(server.profiles.lobby_chat_recent()) == start + 1          # хранится в базе
        mid = got["msg"]["id"]
        await a.send_json({"type": "lobby_chat_delete", "id": mid})          # не хозяин — нельзя
        assert "owner" in (await next_of(a, "error"))["text"]
        await b.send_json({"type": "lobby_chat_delete", "id": mid})
        assert (await next_of(a, "lobby_chat_deleted"))["id"] == mid
        assert len(server.profiles.lobby_chat_recent()) == start
        # с не-лобби соединения писать в чат лобби нельзя (ничего не сохраняется)
        t = await c.ws_connect("/ws")
        await t.send_json({"type": "hello", "profile": fox})
        await t.send_json({"type": "lobby_chat", "text": "from a table"})
        await asyncio.sleep(0.2)
        assert len(server.profiles.lobby_chat_recent()) == start
        # хранятся только последние 200; удалённый аккаунт уносит свои сообщения
        fid = server.profiles.by_name("ChatFox")["id"]
        for i in range(205):
            server.profiles.lobby_chat_add(fid, f"m{i}")
        recent = server.profiles.lobby_chat_recent()
        assert len(recent) == 200 and recent[-1]["text"] == "m204"
        server.profiles.delete_profile(fid)
        assert server.profiles.lobby_chat_recent() == []
        for ws in (a, b, t):
            await ws.close()


async def news():
    """Новости: «новый игрок» и «новый №1» пишутся сами; хозяин пишет, закрепляет одну, удаляет."""
    server.fails.clear()
    P = server.profiles
    async with TestClient(TestServer(server.make_app())) as c:
        async def post(body, headers=None, token=""):
            r = await c.post("/api/news", json=body, headers={"X-Profile": token, **(headers or {})})
            return r.status, await r.json()

        r = await c.post("/api/register", json={"name": "NewsOwl", "password": "secret12"}, headers=OWNER)
        owl = (await r.json())["token"]
        r = await c.get("/api/lobby", headers={"X-Profile": owl})
        items = (await r.json())["news"]
        assert items[0]["kind"] == "player" and items[0]["text"] == "NewsOwl joined NoDiddyPoker"
        assert (await post({"action": "post", "text": "hi"}, token=owl))[0] == 403       # не хозяин
        st, res = await post({"action": "post", "text": "  Friday 21:00 — Bomb Pot  ", "pin": True}, OWNER)
        assert st == 200 and res["news"][0]["pinned"] and res["news"][0]["text"] == "Friday 21:00 — Bomb Pot"
        first = res["news"][0]["id"]
        st, res = await post({"action": "post", "text": "second pinned", "pin": True}, OWNER)
        assert [n["text"] for n in res["news"] if n["pinned"]] == ["second pinned"]          # закреплена только одна
        assert (await post({"action": "post", "text": "   "}, OWNER))[0] == 400
        st, res = await post({"action": "pin", "id": first, "pin": True}, OWNER)
        assert res["news"][0]["id"] == first
        st, res = await post({"action": "delete", "id": first}, OWNER)
        assert st == 200 and all(n["id"] != first for n in res["news"])
        assert (await post({"action": "delete", "id": first}, OWNER))[0] == 404
        # новый №1 после раздачи
        owl_id = P.by_name("NewsOwl")["id"]
        P.reset_stats()
        hand = {"players": [{"pid": owl_id, "seat": 0, "stack": 1000, "end": 1500}], "winners": [0], "pot": 1000}
        before = len(P.news_list(100))
        P.record_hand(hand)                                   # выиграл, но никого не переехал — новости нет (рейтинг только Diddy)
        assert len(P.news_list(100)) == before
        hand["badbeats"] = [{"seat": 1, "equity": 84, "by": {0: 1.0}}]
        P.record_hand(hand)
        newest = [n for n in P.news_list() if not n["pinned"]][0]
        assert newest["kind"] == "leader" and newest["text"] == "NewsOwl is the new #1 on the Diddy leaderboard (2.5)", newest
        before = len(P.news_list(100))
        P.record_hand(hand)                                   # всё ещё №1 — новой записи нет
        assert len(P.news_list(100)) == before
        P.delete_profile(owl_id)                              # события о нём уходят вместе с аккаунтом
        assert not [n for n in P.news_list(100) if "NewsOwl" in n["text"]]


async def diddy():
    """Diddy factor: очки за силу bad beat'а, делёж, места, обнуление, что видно в лобби."""
    P = server.profiles
    assert [P.diddy_points(e) for e in (69, 79, 89, 99)] == [100, 200, 300, 400]
    assert P.diddy_points(80, .5) == 105 and P.diddy_points(69, 1 / 3) == 33
    assert [P.diddy_factor(x) for x in (0, 100, 105, 155, 1234)] == [0, 1.0, 1.1, 1.6, 12.3]
    server.fails.clear()
    async with TestClient(TestServer(server.make_app())) as c:
        ids, tokens = {}, {}
        for name in ("DiddyA", "DiddyB", "DiddyC"):
            r = await c.post("/api/register", json={"name": name, "password": "secret12", "invite": "Royal Flush"})
            tokens[name] = (await r.json())["token"]
            ids[name] = P.by_name(name)["id"]
        a, b, d = ids.values()
        P.reset_stats()
        since = P.diddy_since()

        def play(*beats, pids=(a, b, d)):
            """Раздача на троих (места 0, 1, 2); beats — (шансы жертвы, {место: доля})."""
            P.record_hand({"players": [{"pid": p, "seat": s, "stack": 1000, "end": 1000} for s, p in enumerate(pids)],
                           "winners": [0], "pot": 500,
                           "badbeats": [{"seat": 2, "equity": e, "by": by} for e, by in beats]})

        def board():
            return {x["name"]: (x["diddy"], x["badbeats"], x["sickest"]) for x in P.leaderboard()}
        play()
        assert set(board().values()) == {(0, 0, 0)} and P.current_leader() is None      # все с нулём, первого нет
        play((79, {0: 1.0}))
        assert board()["DiddyA"] == (2.0, 1, 79) and P.current_leader()["id"] == a
        play((89, {0: .5, 1: .5}))                                    # поделили банк — поделили очки
        assert board()["DiddyA"] == (3.5, 2, 89) and board()["DiddyB"] == (1.5, 1, 89)
        play((69, {1: 1.0}), (99, {1: 1.0}))                          # за раздачу переехал двоих
        assert board()["DiddyB"] == (6.5, 3, 99) and board()["DiddyC"] == (0, 0, 0)
        assert [x["name"] for x in P.leaderboard("diddy")] == ["DiddyB", "DiddyA", "DiddyC"]
        was = board()
        play((99, {0: 1.0, 1: 1.0, 5: 1.0}), pids=(None, -7, d))      # без аккаунта, бот, неизвестное место — мимо
        assert board() == was
        # ничья по очкам: у кого больше bad beat'ов, тот выше; порядок не скачет — и новостей нет
        P.reset_stats()
        play((79, {0: 1.0}))
        play((69, {1: 1.0}), (69, {1: 1.0}))
        assert [x["name"] for x in P.leaderboard("diddy")][:2] == ["DiddyB", "DiddyA"]
        news = len(P.news_list(100))
        play(); play()
        assert len(P.news_list(100)) == news
        # лобби: рейтинг Diddy, по порядку Diddy, дата — с начала Diddy
        r = await (await c.get("/api/lobby", headers={"X-Profile": tokens["DiddyA"]})).json()
        assert [x["name"] for x in r["leaders"]][:2] == ["DiddyB", "DiddyA"], r["leaders"]
        assert r["since"] == P.diddy_since() > since
        # прибыль в базе по-прежнему копится
        P.record_hand({"players": [{"pid": a, "seat": 0, "stack": 1000, "end": 1700}], "winners": [0], "pot": 900})
        row = P.db.execute("SELECT profit, best_pot FROM stats WHERE pid = ?", (a,)).fetchone()
        assert (row["profit"], row["best_pot"]) == (700, 900)
        P.reset_stats()
        assert P.leaderboard() == [] and P.current_leader() is None
        for pid in ids.values():
            P.delete_profile(pid)


def old_database():
    """База до Diddy factor: столбцы дописываются, старые числа остаются; второй запуск ничего не портит."""
    import pathlib
    import sqlite3
    P = server.profiles
    path = pathlib.Path(tempfile.mkdtemp(prefix="poker-old-")) / "poker.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
        CREATE TABLE stats (pid INTEGER PRIMARY KEY, hands INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
            profit INTEGER NOT NULL DEFAULT 0, best_pot INTEGER NOT NULL DEFAULT 0, last REAL NOT NULL DEFAULT 0);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings VALUES ('stats_since', '1000.0');
        INSERT INTO stats VALUES (7, 120, 30, -4500, 9000, 55.0);""")
    con.close()
    real, P.DB_PATH = P.DB_PATH, path
    try:
        for _ in range(2):
            db = P.open_db()
            assert tuple(db.execute("SELECT * FROM stats").fetchone()) == (7, 120, 30, -4500, 9000, 55.0, 0, 0, 0)
            since = dict(db.execute("SELECT key, value FROM settings").fetchall())
            assert since["stats_since"] == "1000.0" and float(since["diddy_since"]) > 1000
            db.close()
    finally:
        P.DB_PATH = real


def mtt_storage():
    """Турниры в базе: настройки, снимок, итоги; таблица лидеров без пробных; удалённый аккаунт — обезличен."""
    import tournament
    P = server.profiles
    tid = P.mtt_create("Friday", tournament.default_config(stack=1000, seats=4), test=False, status="registration")
    assert P.mtt_active()["id"] == tid and P.mtt_get(tid)["config"]["stack"] == 1000
    a = P.by_name("ChatBoss") or P.by_name("Owner")
    d = tournament.Director(tid, "Friday", P.mtt_get(tid)["config"], save=lambda st: P.mtt_save_state(tid, st),
                            bot_delay=(0, 0))
    d.register(a["id"], a["name"])
    d.register(-5, "Ghost")
    d.start(0.0)
    d.maybe_save(1.0, force=True)
    row = P.mtt_get(tid)
    assert row["status"] == "running" and row["state"]["entries"][0]["chips"] == 1000
    r = tournament.Director.restore(row["state"], 10.0)
    assert r.status == "paused" and r.chips_in_play() == 2000
    P.mtt_record_results(tid, [{"pid": a["id"], "name": a["name"], "place": 1, "points": 10, "trophy": 1, "rebuys": 0,
                                "prize": 5000, "paid": 2500},
                               {"pid": -5, "name": "Ghost", "place": 2, "points": 6, "trophy": 0, "rebuys": 0,
                                "prize": 0, "paid": 2500}])
    P.mtt_update(tid, status="finished")
    assert P.mtt_active() is None
    test_tid = P.mtt_create("Bots", {}, test=True, status="finished")
    P.mtt_record_results(test_tid, [{"pid": a["id"], "name": a["name"], "place": 1, "points": 99, "trophy": 1, "rebuys": 0}],
                         test=True)
    lb = P.mtt_leaderboard()
    me = next(x for x in lb if x["id"] == a["id"])
    assert me["points"] == 10 and me["trophies"] == 1 and me["played"] == 1, me   # пробный не считается
    assert me["won"] == 5000 and me["profit"] == 2500, me                           # деньги: выиграл $50, итог +$25
    # Delete законченного: пропадает из списков, рейтинг и деньги игроков те же
    before = P.mtt_leaderboard()
    assert P.mtt_hide(tid) and P.mtt_get(tid)["status"] == "deleted"
    assert all(t["id"] != tid for t in P.mtt_list(50) + P.mtt_list(50, drafts=True))
    assert P.mtt_leaderboard() == before and P.mtt_results(tid)
    assert not P.mtt_hide(tid), "дважды — нет"
    draft = P.mtt_create("Draft", {}, status="draft")
    assert all(t["id"] != draft for t in P.mtt_list())
    P.mtt_delete(draft)
    assert P.mtt_get(draft) is None
    P.delete_profile(a["id"])
    assert P.mtt_results(tid)[0]["name"] == "Deleted player" and P.mtt_results(tid)[0]["pid"] is None
    assert not [x for x in P.mtt_leaderboard() if x["id"] == a["id"]]


async def mtt_server():
    """Турнир на сервере: права, статусы, запись, health, нельзя в кэш во время турнира, место ищется по профилю."""
    import tournament
    server.fails.clear()
    server.MTT = None
    for t in server.TABLES.values():                 # прошлые тесты могли оставить кого-то за кэш-столом
        for p in t.players():
            t.remove_player(p)
    async with TestClient(TestServer(server.make_app())) as c:
        async def admin(body, headers=OWNER):
            r = await c.post("/api/mtt/admin", json=body, headers=headers)
            return r.status, await r.json()

        async def account(name):
            r = await c.post("/api/register", json={"name": name, "password": "secret12", "invite": "Royal Flush"})
            return (await r.json())["token"]

        tok = await account("MttAnn")
        tok2 = await account("MttBob")
        # не хозяин — нельзя ничего
        assert (await c.get("/api/mtt/admin", headers={"X-Profile": tok})).status == 403
        r = await c.get("/api/mtt/admin", headers=OWNER)
        assert (await r.json())["templates"]["regular"]["levels"][0]["ante"] > 0, "шаблоны для формы — с анте с 1-го уровня"
        assert (await admin({"action": "create", "name": "x", "config": {}}, {"X-Profile": tok}))[0] == 403
        assert (await c.get("/api/mtt")).status == 401                       # без входа
        # плохие настройки
        st, r = await admin({"action": "create", "name": "Bad", "config": {"seats": 12}})
        assert st == 400 and "seats" in r["error"]
        cfg = tournament.default_config(stack=1000, seats=3, level_seconds=60, turn_seconds=15)
        st, r = await admin({"action": "create", "name": "Friday", "config": cfg})
        assert st == 200
        tid = r["id"]
        assert (await admin({"action": "start", "id": tid}))[0] == 404            # черновик ещё не открыт
        st, r = await admin({"action": "update", "id": tid, "name": "Friday night", "config": cfg})
        assert st == 200
        st, r = await admin({"action": "open", "id": tid})
        assert st == 200 and r["active"]["status"] == "registration" and r["active"]["name"] == "Friday night"
        st, r = await admin({"action": "create", "name": "Other", "config": cfg})
        st, r = await admin({"action": "open", "id": r["id"]})
        assert st == 409, "второй активный турнир нельзя"
        assert (await admin({"action": "add_bots", "id": tid, "n": 3}))[0] == 409, "боты только в пробном"

        async def player(action, token):
            r = await c.post(f"/api/mtt/{tid}/{action}", json={}, headers={"X-Profile": token})
            return r.status, await r.json()
        assert (await player("register", tok))[0] == 200
        assert (await player("register", tok))[0] == 409
        assert (await player("unregister", tok))[0] == 200
        assert (await player("register", tok))[0] == 200
        assert (await player("register", tok2))[0] == 200
        r = await c.get("/api/mtt", headers={"X-Profile": tok})
        view = (await r.json())["active"]
        assert view["entrants"] == 2 and view["me"]["status"] == "registered"
        assert all(x["pid"] is None for x in view["players"]), "игрокам pid других не показываем"
        assert (await admin({"action": "start", "id": tid}))[0] == 200
        assert server.MTT.status == "running" and server.profiles.mtt_get(tid)["status"] == "running"
        assert (await player("unregister", tok))[0] == 409
        assert (await admin({"action": "delete", "id": tid}))[0] == 409, "идущий турнир удалить нельзя — сначала Cancel"
        assert (await admin({"action": "delete", "id": tid}, {"X-Profile": tok}))[0] == 403, "удалять может только хозяин"
        # health считает участников турнира — Update site подождёт конца
        r = await c.get("/api/health")
        assert (await r.json())["seated"] == 2
        ann = server.profiles.by_name("MttAnn")["id"]
        t = server.table_of_pid(ann)
        assert t is not None and t.mtt and t.on_hand_end is None, "статистика кэша для турнира не пишется"
        # броски работают и за столом турнира (только тут же, сообщение уходит этому столу)
        me_p = next(p for p in t.players() if p.pid == ann)
        target = next(p for p in t.players() if p is not me_p)
        server.last_throws.clear()
        assert server.throw(t, me_p, "clap", target.seat) is None
        assert server.outbox and server.outbox[-1][0] is t
        server.outbox.clear()
        # стол кэша: открыл вкладку — сервер отправит на стол турнира (место ищется по профилю, без ключа)
        ws = await c.ws_connect("/ws?t=1")
        await ws.send_json({"type": "hello", "profile": tok})
        msg = await ws.receive_json(timeout=3)
        assert msg == {"type": "elsewhere", "table": t.code}, msg
        await ws.close()
        ws = await c.ws_connect(f"/ws?t={t.code}")
        await ws.send_json({"type": "hello", "profile": tok})
        for _ in range(5):
            m = await ws.receive_json(timeout=3)
            if m["type"] == "state":
                assert m["mtt"]["name"] == "Friday night" and m["mtt"]["left"] == 2 and m["you"] is not None
                break
        else:
            raise AssertionError("нет состояния стола турнира")
        await ws.send_json({"type": "leave"})
        for _ in range(5):
            m = await ws.receive_json(timeout=3)
            if m["type"] == "error":
                assert "tournament" in m["text"]
                break
        else:
            raise AssertionError("встать из-за стола турнира нельзя")
        await ws.close()
        # сесть за кэш, будучи в турнире, нельзя
        ws = await c.ws_connect("/ws?t=1")
        await ws.send_json({"type": "hello", "profile": tok2})
        bob_table = (await ws.receive_json(timeout=3))
        assert bob_table["type"] == "elsewhere"
        await ws.close()
        assert (await admin({"action": "pause", "id": tid}))[0] == 200 and server.MTT.status == "paused"
        assert (await admin({"action": "pause", "id": tid}))[0] == 409
        assert (await admin({"action": "resume", "id": tid}))[0] == 200
        assert (await admin({"action": "extend_reg", "id": tid, "level": 99}))[0] == 409
        # «перезапуск сервера»: турнир поднимается из базы на паузе и сам продолжится через 5 минут
        server.MTT.maybe_save(time.time(), force=True)
        server.MTT = None
        server.mtt_load()
        assert server.MTT.tid == tid and server.MTT.status == "paused" and server.MTT.auto_resume_at
        assert server.MTT.chips_in_play() == 2000 and server.table_of_pid(ann) is not None
        assert (await admin({"action": "cancel", "id": tid}))[0] == 200
        r = await c.get("/api/health")
        assert (await r.json())["seated"] == 0, "отменённый турнир не держит Update site"
        assert server.table_of_pid(ann) is None
        assert server.profiles.mtt_get(tid)["status"] == "cancelled"
        # Delete отменённого: пропадает из списков игроков и админки, карточка — 404
        assert (await admin({"action": "delete", "id": tid}, {"X-Profile": tok}))[0] == 403
        st, r = await admin({"action": "delete", "id": tid})
        assert st == 200 and all(t["id"] != tid for t in r["list"])
        assert server.profiles.mtt_get(tid)["status"] == "deleted" and server.MTT is None
        r = await c.get("/api/mtt", headers={"X-Profile": tok})
        j = await r.json()
        assert j["active"] is None and all(t["id"] != tid for t in j["past"])
        assert (await c.get(f"/api/mtt/{tid}", headers={"X-Profile": tok})).status == 404
        assert (await admin({"action": "delete", "id": tid}))[0] == 404
        # пробный турнир с ботами
        st, r = await admin({"action": "create", "name": "Bots", "config": {**cfg, "test": True}})
        bid = r["id"]
        assert (await admin({"action": "open", "id": bid}))[0] == 200
        assert (await admin({"action": "add_bots", "id": bid, "n": 3}))[0] == 200
        assert server.MTT.find(name="Bot#1") is not None
        assert (await admin({"action": "remove_bots", "id": bid}))[0] == 200 and not server.MTT.entries
        assert (await admin({"action": "cancel", "id": bid}))[0] == 200
    server.MTT = None


def stale_seat():
    """Вкладка помнит место, где игрока уже нет (вылетел/пересажен/ушёл), — ходить за нового игрока нельзя."""
    t = __import__("engine").Table("stale", 5, 10, min_buyin=10, max_buyin=10_000)
    a, _ = t.add_player("ta", "Alice", 100)
    conn = server.Conn(None)
    conn.profile = {"id": -1, "name": "Alice"}
    conn.table, conn.player = t, a
    a.connections = a.table_conns = 1
    t.remove_player(a)                                    # Alice встала/вылетела, на её место садится Carol
    c, _ = t.add_player("tc", "Carol", 100)
    b, _ = t.add_player("tb", "Bob", 100)
    for p in (b, c):
        p.connections = p.table_conns = 1
    assert c.seat == a.seat
    assert t.start_hand()
    while t.actor != c.seat:                              # дождаться хода Carol
        t.act(t.seats[t.actor], "call" if not t.options(t.seats[t.actor])["check"] else "check")
    assert t.act(a, "fold") is not None and t.options(a) is None, "движок: чужой ход не проходит"
    error, _ = server.handle(conn, {"type": "act", "action": "fold"})
    assert error == "Take a seat first." and conn.player is None and a.connections == 0
    assert t.running and t.actor == c.seat and not c.folded, "ход Carol на месте"


async def mtt_inputs():
    """Плохие числа от хозяина: NaN/бесконечность во времени старта, огромные стеки, блайнды и очки."""
    import tournament
    assert tournament.validate_config({"stack": float("inf")})[1]
    assert tournament.validate_config({"stack": 1e400})[1]
    assert tournament.validate_config({"levels": [{"sb": 1, "bb": 10 ** 12, "ante": 0}]})[1]
    assert tournament.validate_config({"points": [10 ** 20]})[1]
    server.MTT = None
    async with TestClient(TestServer(server.make_app())) as c:
        for bad in ("NaN", "Infinity", 1e300, 1.0):
            body = '{"action": "create", "name": "x", "config": {}, "starts_at": %s}' % bad
            r = await c.post("/api/mtt/admin", data=body, headers={**OWNER, "Content-Type": "application/json"})
            assert r.status == 400, (bad, r.status)
    server.MTT = None


def seats_from_config():
    """Число мест берётся из конфига: heads-up — 2, остальные — 7. Старые номера столов 1/2/3 на месте."""
    seats = {t.name: len(t.seats) for t in server.TABLES.values()}
    assert len(seats) == 9 and seats["Hold'em Heads-up"] == 2 and seats["Bomb Pot #2"] == 7, seats
    assert [server.TABLES[i].name for i in ("1", "2", "3")] == ["Hold'em #1", "Omaha #1", "Bomb Pot #1"]


async def health():
    """/api/health: число сидящих — только для запроса с самого сервера, не через Cloudflare."""
    async with TestClient(TestServer(server.make_app())) as c:
        r = await c.get("/api/health")
        assert r.status == 200 and await r.json() == {"ok": True, "seated": 0}
        t = next(iter(server.TABLES.values()))
        p, error = t.add_player("health-test", "Bob", t.min_buyin, 999)
        assert p, error
        r = await c.get("/api/health")
        assert (await r.json())["seated"] == 1
        t.remove_player(p)
        for h in ({"CF-Connecting-IP": "1.2.3.4"}, {"X-Real-IP": "1.2.3.4"}, {"X-Forwarded-For": "1.2.3.4"},
                  {"Host": "alexandertarakanov.app"}):
            r = await c.get("/api/health", headers=h)
            assert r.status == 404, h


async def throws():
    """Броски предметов: только сидящий, только в другого сидящего, не чаще раза в 1,5 с; видят все за этим столом."""
    server.fails.clear()
    server.last_throws.clear()
    t, t2 = list(server.TABLES.values())[:2]
    async with TestClient(TestServer(server.make_app())) as c:
        async def next_of(ws, kind):
            for _ in range(60):
                m = await ws.receive_json(timeout=3)
                if m["type"] == kind:
                    return m
                assert m["type"] != "throw", m               # лишних бросков быть не должно
            raise AssertionError(kind)

        async def join(name, sit=True, table=t):
            r = await c.post("/api/register", json={"name": name, "password": "secret12", "invite": "Royal Flush"})
            ws = await c.ws_connect(f"/ws?t={table.code}")
            await ws.send_json({"type": "hello", "profile": (await r.json())["token"]})
            await next_of(ws, "chat_history")
            if sit:
                await ws.send_json({"type": "sit", "buyin": t.buyins[0] if t.buyins else t.min_buyin})
                await next_of(ws, "token")
            return ws

        async def refused(ws, text, **data):
            await ws.send_json({"type": "throw", **data})
            assert text in (await next_of(ws, "error"))["text"], data

        a, b = await join("ThrowA"), await join("ThrowB")
        w = await join("ThrowW", sit=False)
        other = await join("ThrowO", sit=False, table=t2)
        seat = {p.name: p.seat for p in t.players()}
        sa, sb = seat["ThrowA"], seat["ThrowB"]
        free = next(i for i, p in enumerate(t.seats) if p is None)

        async def lands(thrower, item, src, dst):                    # бросок видят все за столом, и зритель тоже
            await thrower.send_json({"type": "throw", "item": item, "seat": dst})
            for ws in (a, b, w):
                assert await next_of(ws, "throw") == {"type": "throw", "item": item, "from": src, "to": dst}

        for bad in ("x", "", None, ["clap"], {"a": 1}):
            await refused(a, "can't throw", item=bad, seat=sb)
        for bad in ("1", None, True, 1.0, -1, 99, [sb]):
            await refused(a, "can't throw", item="clap", seat=bad)
        await refused(a, "nobody", item="clap", seat=sa)             # в себя нельзя
        await refused(a, "nobody", item="clap", seat=free)           # в пустое место нельзя
        await refused(w, "Take a seat", item="clap", seat=sb)        # зритель не кидает
        await lands(a, "clap", sa, sb)                               # отказы выше паузу не включают
        await refused(a, "Slow down", item="poop", seat=sb)          # слишком часто
        await lands(b, "poop", sb, sa)                               # у другого игрока своя пауза
        server.last_throws.clear()                                   # пауза прошла — снова можно
        await lands(a, "poop", sa, sb)
        await other.send_json({"type": "chat", "text": "hi"})        # за другим столом бросков не видно
        await next_of(other, "chat")
        server.last_throws.clear()
        pa, t.seats[sa] = t.seats[sa], None                          # стол высадил, а вкладка ещё открыта
        assert server.throw(t, pa, "clap", sb) == "Take a seat first."
        t.seats[sa] = pa
        assert not server.outbox
        for ws in (a, b, w, other):
            await ws.close()


async def fair_shuffle():
    """Честная перемешка через WebSocket: двое присылают секреты, зритель и лобби — нет; раздача и доказательство."""
    import fair
    import verify_hand
    server.fails.clear()
    tables = [t for t in server.TABLES.values() if not t.players() and len(t.seats) == 7 and not t.bomb_bb]
    t = tables[-1]
    assert all(x.fair for x in server.TABLES.values())
    async with TestClient(TestServer(server.make_app())) as c:
        async def join(name, sit=True, lobby=False):
            r = await c.post("/api/register", json={"name": name, "password": "secret12", "invite": "Royal Flush"})
            ws = await c.ws_connect(f"/ws?t={t.code}")
            await ws.send_json({"type": "hello", "lobby": lobby, "profile": (await r.json())["token"]})
            await next_of(ws, "presence" if lobby else "chat_history")
            if sit:
                await ws.send_json({"type": "sit", "buyin": t.buyins[0] if t.buyins else t.min_buyin})
                await next_of(ws, "token")
            return ws

        async def next_of(ws, kind, phase=None):
            for _ in range(200):
                m = await ws.receive_json(timeout=8)
                if m["type"] == kind and phase in (None, m.get("phase")):
                    return m
            raise AssertionError(kind)

        a, b = await join("FairA"), await join("FairB")
        w, lob = await join("FairW", sit=False), await join("FairL", sit=False, lobby=True)
        seats = {p.name: p.seat for p in t.players()}
        mine = {}
        for ws, name in ((a, "FairA"), (b, "FairB"), (w, None)):
            note = await next_of(ws, "fair", "commit")
            seed = fair.H("ndp/phrase", "x", bytes(32))
            seat = seats.get(name, 0)
            value = fair.seed_hash(bytes.fromhex(note["id"]), bytes.fromhex(note["root"]), seat, seed).hex()
            if name is None:            # зритель участвовать не может
                await ws.send_json({"type": "seed_commit", "id": note["id"], "value": value})
                assert "Take a seat" in (await next_of(ws, "error"))["text"]
                continue
            mine[name] = (ws, note, seed, value)
        for ws, note, seed, value in mine.values():
            await ws.send_json({"type": "seed_commit", "id": note["id"], "value": {"bad": 1}})     # мусор ничего не ломает
            await ws.send_json({"type": "seed_commit", "id": note["id"], "value": value})
        for name, (ws, note, seed, value) in mine.items():
            m = await next_of(ws, "fair", "reveal")
            assert m["id"] == note["id"] and m["root"] == note["root"]
            assert m["hashes"][str(seats[name])] == {"hash": value, "by": "player"} and "seeds" not in m
        for ws, note, seed, value in mine.values():
            await ws.send_json({"type": "seed_reveal", "id": note["id"], "value": seed.hex()})
        for ws in (a, b, w):
            m = await next_of(ws, "fair", "ready")
            assert set(m["seeds"]) == {str(s) for s in seats.values()}
        for _ in range(60):
            if t.running:
                break
            await asyncio.sleep(.1)
        assert t.running and t.shuffle_played.fingerprint() == m["fp"]
        assert set(t.shuffle_played.by.values()) == {"player"}
        await a.send_json({"type": "leave"})                     # раздача кончилась: доказательство — каждому своё
        await next_of(a, "token")
        assert not t.running
        for ws, sees in ((b, t.hole_count), (w, 0)):
            await ws.send_json({"type": "history_hand", "no": t.hand_no})
            proof = (await next_of(ws, "history_hand"))["hand"]["proof"]
            assert len(proof["open"]) == sees, (sees, proof["open"], proof["seen"])
            assert not any(ok is False for _, ok, _ in verify_hand.verify(proof))
        await lob.send_json({"type": "seed_commit", "id": note["id"], "value": value})             # из лобби — мимо
        for ws in (a, b, w, lob):
            await ws.close()


def main():
    asyncio.run(run())
    asyncio.run(health())
    seats_from_config()
    asyncio.run(lobby_chat())
    asyncio.run(news())
    asyncio.run(throws())
    asyncio.run(diddy())
    old_database()
    mtt_storage()
    asyncio.run(mtt_server())
    stale_seat()
    asyncio.run(mtt_inputs())
    asyncio.run(fair_shuffle())
    print("accounts ok")


if __name__ == "__main__":
    main()
