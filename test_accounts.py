"""Проверки аккаунтов: регистрация по коду приглашения, вход, пароли, инструменты хозяина.
Запуск: /opt/poker/.venv/bin/python test_accounts.py   (его же запускает test_engine.py в конце)
Работает на временной пустой базе — настоящие аккаунты не трогает."""
import asyncio
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
    print("accounts ok")


if __name__ == "__main__":
    main()
