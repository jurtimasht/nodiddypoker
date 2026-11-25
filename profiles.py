"""Аккаунты игроков, фото и статистика за всё время.

Хранится на диске (в отличие от стола), поэтому переживает перезапуск:
  /opt/poker/data/poker.db      база SQLite: аккаунты, входы, статистика
  /opt/poker/data/avatars/      фото профилей (уже уменьшенные, формат WebP)
(для тестов папку можно поменять: POKER_DATA=путь)

Аккаунт = ник + пароль. Зарегистрироваться можно только с кодом приглашения
(его задаёт хозяин в лобби). Пароль хранится только как «отпечаток» scrypt — прочитать его нельзя.
После входа браузер получает ключ входа (хранится в localStorage). В базе лежит только
sha256 этого ключа. С каждого устройства — свой ключ; не заходил 30 дней — ключ перестаёт работать.
"""
import asyncio
import hashlib
import hmac
import io
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path

from PIL import Image, ImageOps

DATA = Path(os.environ.get("POKER_DATA") or Path(__file__).resolve().parent / "data")
AVATARS = DATA / "avatars"
DB_PATH = DATA / "poker.db"
AVATAR_SIZE = 160                       # фото уменьшаются до 160×160
MAX_UPLOAD = 4 * 1024 * 1024            # до 4 МБ
NAME_RE = re.compile(r"^[\w .\-]{2,16}$")
PASSWORD_MIN, PASSWORD_MAX = 6, 200
SESSION_DAYS = 30                       # сколько дней помнить вход без захода на сайт
Image.MAX_IMAGE_PIXELS = 40_000_000     # защита от «картинок-бомб»

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,      -- ник маленькими буквами: «Вася» и «вася» — один и тот же ник
    password TEXT NOT NULL,              -- отпечаток пароля (scrypt), сам пароль не хранится
    avatar   TEXT NOT NULL DEFAULT '',
    created  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token    TEXT PRIMARY KEY,           -- sha256 от ключа входа (сам ключ — только в браузере)
    pid      INTEGER NOT NULL REFERENCES profiles(id),
    created  REAL NOT NULL,
    used     REAL NOT NULL               -- когда последний раз заходил с этим ключом
);
CREATE TABLE IF NOT EXISTS stats (
    pid      INTEGER PRIMARY KEY REFERENCES profiles(id),
    hands    INTEGER NOT NULL DEFAULT 0, -- сыграно раздач
    wins     INTEGER NOT NULL DEFAULT 0, -- выиграно банков
    profit   INTEGER NOT NULL DEFAULT 0, -- итог в фишках за всё время
    best_pot INTEGER NOT NULL DEFAULT 0, -- самый большой выигранный банк
    last     REAL NOT NULL DEFAULT 0     -- когда последний раз играл
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

AVATARS.mkdir(parents=True, exist_ok=True)   # у разработчика папки data ещё нет — создаём


def open_db():
    con = sqlite3.connect(DB_PATH)
    cols = [r[1] for r in con.execute("PRAGMA table_info(profiles)")]
    if cols and "password" not in cols:
        # База старой версии (профили без паролей). Откладываем её в сторону и начинаем новую.
        con.close()
        old = DB_PATH.with_name(f"poker.db.old-{int(time.time())}")
        DB_PATH.rename(old)
        print(f"old database (profiles without passwords) moved to {old}", flush=True)
        con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    con.execute("INSERT OR IGNORE INTO settings VALUES ('stats_since', ?)", (str(time.time()),))
    con.commit()
    return con


db = open_db()


def digest(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def clean_name(value):
    return " ".join(str(value or "").split())


def public(row):
    if row is None:
        return None
    return {"id": row["id"], "name": row["name"], "avatar": avatar_url(row["avatar"])}


def avatar_url(file):
    return f"avatar/{file}" if file else ""


def by_id(pid):
    return db.execute("SELECT * FROM profiles WHERE id = ?", (pid,)).fetchone()


def by_name(name):
    return db.execute("SELECT * FROM profiles WHERE name_key = ?", (clean_name(name).casefold(),)).fetchone()


# ---------- пароли ----------
def hash_password(password):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${h.hex()}"


def password_ok(password, stored):
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got.hex(), h)
    except (ValueError, TypeError):
        return False


DUMMY_HASH = hash_password(secrets.token_hex(8))   # чтобы «нет такого ника» отвечал так же долго, как «не тот пароль»


def check_new_password(password):
    if not isinstance(password, str) or not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        return f"Password: at least {PASSWORD_MIN} characters."
    return None


# ---------- входы (ключ на каждое устройство) ----------
def new_session(pid):
    token = secrets.token_urlsafe(24)
    now = time.time()
    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (digest(token), pid, now, now))
    db.commit()
    return token


def by_secret(token):
    """Профиль по ключу входа (или None, если ключа нет или он устарел)."""
    if not token or len(token) > 100:
        return None
    key = digest(token)
    row = db.execute("SELECT pid, used FROM sessions WHERE token = ?", (key,)).fetchone()
    if row is None:
        return None
    now = time.time()
    if now - row["used"] > SESSION_DAYS * 86400:
        db.execute("DELETE FROM sessions WHERE token = ?", (key,))
        db.commit()
        return None
    if now - row["used"] > 3600:                     # отмечаем «заходил» не чаще раза в час
        db.execute("UPDATE sessions SET used = ? WHERE token = ?", (now, key))
        db.commit()
    return by_id(row["pid"])


def logout(token):
    if token:
        db.execute("DELETE FROM sessions WHERE token = ?", (digest(token),))
        db.commit()


def logout_everywhere(pid, keep=None):
    db.execute("DELETE FROM sessions WHERE pid = ? AND token != ?", (pid, digest(keep) if keep else ""))
    db.commit()


# ---------- код приглашения ----------
def invite_code():
    row = db.execute("SELECT value FROM settings WHERE key = 'invite'").fetchone()
    return row[0] if row else ""


def set_invite_code(code):
    code = " ".join(str(code or "").split())
    if not 4 <= len(code) <= 40:
        return "Invite code: 4–40 characters."
    db.execute("INSERT OR REPLACE INTO settings VALUES ('invite', ?)", (code,))
    db.commit()
    return None


def invite_ok(code):
    real = invite_code()
    given = " ".join(str(code or "").split())
    return bool(real) and hmac.compare_digest(given.casefold().encode(), real.casefold().encode())


# ---------- аккаунт ----------
# Проверка пароля медленная (так и задумано — против подбора), поэтому она идёт в отдельном потоке,
# а с базой работаем только в основном — функции ниже асинхронные (await profiles.login(...)).
async def slow_hash(password):
    return await asyncio.to_thread(hash_password, password)


async def slow_check(password, stored):
    return await asyncio.to_thread(password_ok, password, stored)


async def register(name, password, invite, owner=False):
    """Новый аккаунт. Возвращает (профиль, ключ входа, ошибка). Хозяину код приглашения не нужен."""
    if not owner and not invite_ok(invite):
        return None, None, "Wrong invite code. Ask the owner for it."
    name = clean_name(name)
    if not NAME_RE.match(name):
        return None, None, "Nickname: 2–16 characters — letters, digits, space, dot, dash, underscore."
    error = check_new_password(password)
    if error:
        return None, None, error
    if by_name(name):
        return None, None, "That nickname is taken."
    hashed = await slow_hash(password)
    try:
        cur = db.execute("INSERT INTO profiles (name, name_key, password, created) VALUES (?, ?, ?, ?)",
                         (name, name.casefold(), hashed, time.time()))
    except sqlite3.IntegrityError:
        return None, None, "That nickname is taken."
    db.execute("INSERT INTO stats (pid) VALUES (?)", (cur.lastrowid,))
    db.commit()
    return by_id(cur.lastrowid), new_session(cur.lastrowid), None


async def login(name, password):
    """Вход по нику и паролю. Возвращает (профиль, ключ входа, ошибка)."""
    me = by_name(name)
    ok = await slow_check(str(password or ""), me["password"] if me else DUMMY_HASH)
    if not me or not ok:
        return None, None, "Wrong nickname or password."
    return me, new_session(me["id"]), None


async def change_password(pid, old, new, keep_token):
    me = by_id(pid)
    if not await slow_check(str(old or ""), me["password"]):
        return "Your current password is wrong."
    error = check_new_password(new)
    if error:
        return error
    hashed = await slow_hash(new)
    db.execute("UPDATE profiles SET password = ? WHERE id = ?", (hashed, pid))
    db.commit()
    logout_everywhere(pid, keep=keep_token)          # на других устройствах — войти заново
    return None


async def reset_password(pid):
    """Хозяин сбрасывает пароль игроку: новый временный пароль, все входы закрыты."""
    temp = "-".join(secrets.token_hex(2) for _ in range(3))      # например 3f9a-0c1d-77be
    hashed = await slow_hash(temp)
    db.execute("UPDATE profiles SET password = ? WHERE id = ?", (hashed, pid))
    db.commit()
    logout_everywhere(pid)
    return temp


def rename(pid, name):
    name = clean_name(name)
    if not NAME_RE.match(name):
        return "Nickname: 2–16 characters — letters, digits, space, dot, dash, underscore."
    taken = by_name(name)
    if taken and taken["id"] != pid:
        return "That nickname is taken."
    db.execute("UPDATE profiles SET name = ?, name_key = ? WHERE id = ?", (name, name.casefold(), pid))
    db.commit()
    return None


def delete_profile(pid):
    me = by_id(pid)
    if me is None:
        return
    db.execute("DELETE FROM sessions WHERE pid = ?", (pid,))
    db.execute("DELETE FROM stats WHERE pid = ?", (pid,))
    db.execute("DELETE FROM profiles WHERE id = ?", (pid,))
    db.commit()
    if me["avatar"]:
        (AVATARS / me["avatar"]).unlink(missing_ok=True)


def all_players():
    """Для хозяина: все аккаунты (ник, когда создан, когда последний раз заходил)."""
    rows = db.execute("""SELECT p.id, p.name, p.avatar, p.created, MAX(s.used) AS seen
                         FROM profiles p LEFT JOIN sessions s ON s.pid = p.id
                         GROUP BY p.id ORDER BY p.name_key""").fetchall()
    return [{"id": r["id"], "name": r["name"], "avatar": avatar_url(r["avatar"]),
             "created": r["created"], "seen": r["seen"] or 0} for r in rows]


def make_avatar(data):
    """Любая картинка -> квадрат 160×160 WebP. Возвращает байты или None, если это не картинка.
    Перекодирование заодно убирает всё лишнее из файла (метаданные, скрытые вставки)."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img)        # фото с телефона — правильно повернуть
            img = ImageOps.fit(img.convert("RGB"), (AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
            out = io.BytesIO()
            img.save(out, "WEBP", quality=85)
            return out.getvalue()
    except Exception:
        return None


def set_avatar(pid, webp_bytes):
    old = by_id(pid)["avatar"]
    file = f"{pid}-{secrets.token_hex(6)}.webp"      # новое имя — браузер не покажет старое фото из памяти
    (AVATARS / file).write_bytes(webp_bytes)
    db.execute("UPDATE profiles SET avatar = ? WHERE id = ?", (file, pid))
    db.commit()
    if old:
        (AVATARS / old).unlink(missing_ok=True)
    return avatar_url(file)


def remove_avatar(pid):
    old = by_id(pid)["avatar"]
    db.execute("UPDATE profiles SET avatar = '' WHERE id = ?", (pid,))
    db.commit()
    if old:
        (AVATARS / old).unlink(missing_ok=True)


def record_hand(hand):
    """После каждой раздачи: +1 раздача всем участникам, итог, победы, самый большой банк."""
    now = time.time()
    for pl in hand["players"]:
        pid = pl.get("pid")
        if not pid:
            continue
        net = pl["end"] - pl["stack"]
        won = pl["seat"] in hand["winners"]
        db.execute("""UPDATE stats SET hands = hands + 1, wins = wins + ?, profit = profit + ?,
                      best_pot = MAX(best_pot, ?), last = ? WHERE pid = ?""",
                   (1 if won else 0, net, hand["pot"] if won else 0, now, pid))
    db.commit()


def leaderboard():
    rows = db.execute("""SELECT p.id, p.name, p.avatar, s.hands, s.wins, s.profit, s.best_pot, s.last
                         FROM profiles p JOIN stats s ON s.pid = p.id
                         WHERE s.hands > 0 ORDER BY s.profit DESC, s.hands DESC""").fetchall()
    return [{"id": r["id"], "name": r["name"], "avatar": avatar_url(r["avatar"]), "hands": r["hands"],
             "wins": r["wins"], "profit": r["profit"], "best_pot": r["best_pot"], "last": r["last"]} for r in rows]


def stats_since():
    return float(db.execute("SELECT value FROM settings WHERE key = 'stats_since'").fetchone()[0])


def reset_stats():
    db.execute("UPDATE stats SET hands = 0, wins = 0, profit = 0, best_pot = 0, last = 0")
    db.execute("UPDATE settings SET value = ? WHERE key = 'stats_since'", (str(time.time()),))
    db.commit()
