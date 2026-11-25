"""Проверки аккаунтов: регистрация по коду приглашения, вход, пароли, инструменты хозяина.
Запуск: /opt/poker/.venv/bin/python test_accounts.py   (его же запускает test_engine.py в конце)
Работает на временной пустой базе — настоящие аккаунты не трогает."""
import asyncio
import os
import tempfile

os.environ["POKER_DATA"] = tempfile.mkdtemp(prefix="poker-test-")   # до import profiles/server!
os.environ.pop("POKER_DEV", None)

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


def main():
    asyncio.run(run())
    print("accounts ok")


if __name__ == "__main__":
    main()
