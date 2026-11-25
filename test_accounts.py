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
        P.record_hand(hand)
        newest = [n for n in P.news_list() if not n["pinned"]][0]
        assert newest["kind"] == "leader" and "NewsOwl is the new #1" in newest["text"], newest
        before = len(P.news_list(100))
        P.record_hand(hand)                                   # всё ещё №1 — новой записи нет
        assert len(P.news_list(100)) == before
        P.delete_profile(owl_id)                              # события о нём уходят вместе с аккаунтом
        assert not [n for n in P.news_list(100) if "NewsOwl" in n["text"]]


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
    P.mtt_record_results(tid, [{"pid": a["id"], "name": a["name"], "place": 1, "points": 10, "trophy": 1, "rebuys": 0},
                               {"pid": -5, "name": "Ghost", "place": 2, "points": 6, "trophy": 0, "rebuys": 0}])
    P.mtt_update(tid, status="finished")
    assert P.mtt_active() is None
    test_tid = P.mtt_create("Bots", {}, test=True, status="finished")
    P.mtt_record_results(test_tid, [{"pid": a["id"], "name": a["name"], "place": 1, "points": 99, "trophy": 1, "rebuys": 0}],
                         test=True)
    lb = P.mtt_leaderboard()
    me = next(x for x in lb if x["id"] == a["id"])
    assert me["points"] == 10 and me["trophies"] == 1 and me["played"] == 1, me   # пробный не считается
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
        # health считает участников турнира — Update site подождёт конца
        r = await c.get("/api/health")
        assert (await r.json())["seated"] == 2
        ann = server.profiles.by_name("MttAnn")["id"]
        t = server.table_of_pid(ann)
        assert t is not None and t.mtt and t.on_hand_end is None, "статистика кэша для турнира не пишется"
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


def main():
    asyncio.run(run())
    asyncio.run(health())
    seats_from_config()
    asyncio.run(lobby_chat())
    asyncio.run(news())
    mtt_storage()
    asyncio.run(mtt_server())
    stale_seat()
    asyncio.run(mtt_inputs())
    print("accounts ok")


if __name__ == "__main__":
    main()
