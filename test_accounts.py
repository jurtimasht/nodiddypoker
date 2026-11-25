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
    print("accounts ok")


if __name__ == "__main__":
    main()
