"""Профили игроков, фото и статистика за всё время.

Хранится на диске (в отличие от стола), поэтому переживает перезапуск:
  /opt/poker/data/poker.db      база SQLite: профили и статистика
  /opt/poker/data/avatars/      фото профилей (уже уменьшенные, формат WebP)

Профиль = ник + секретный ключ. Ключ хранится в браузере игрока (localStorage) —
так сервер узнаёт, что это тот же человек, без отдельного пароля. В базе лежит
только «отпечаток» ключа (sha256), сам ключ — нет.
"""
import hashlib
import io
import re
import secrets
import sqlite3
import time
from pathlib import Path

from PIL import Image, ImageOps

DATA = Path(__file__).resolve().parent / "data"
AVATARS = DATA / "avatars"
DB_PATH = DATA / "poker.db"
AVATAR_SIZE = 160                       # фото уменьшаются до 160×160
MAX_UPLOAD = 4 * 1024 * 1024            # до 4 МБ
NAME_RE = re.compile(r"^[\w .\-]{2,16}$")
Image.MAX_IMAGE_PIXELS = 40_000_000     # защита от «картинок-бомб»

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,      -- ник маленькими буквами: «Вася» и «вася» — один и тот же ник
    secret   TEXT NOT NULL,              -- sha256 от ключа профиля
    avatar   TEXT NOT NULL DEFAULT '',
    created  REAL NOT NULL
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
db = sqlite3.connect(DB_PATH)
db.row_factory = sqlite3.Row
db.executescript(SCHEMA)
db.execute("INSERT OR IGNORE INTO settings VALUES ('stats_since', ?)", (str(time.time()),))
db.commit()


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


def by_secret(secret):
    if not secret or len(secret) > 100:
        return None
    return db.execute("SELECT * FROM profiles WHERE secret = ?", (digest(secret),)).fetchone()


def by_id(pid):
    return db.execute("SELECT * FROM profiles WHERE id = ?", (pid,)).fetchone()


def save_profile(name, secret=None):
    """Новый профиль (нет ключа) или смена ника (есть ключ). Возвращает (профиль, ключ, ошибка)."""
    name = clean_name(name)
    if not NAME_RE.match(name):
        return None, None, "Nickname: 2–16 characters — letters, digits, space, dot, dash, underscore."
    me = by_secret(secret)
    taken = db.execute("SELECT id FROM profiles WHERE name_key = ?", (name.casefold(),)).fetchone()
    if taken and (me is None or taken["id"] != me["id"]):
        return None, None, "That nickname is taken."
    if me:
        db.execute("UPDATE profiles SET name = ?, name_key = ? WHERE id = ?", (name, name.casefold(), me["id"]))
        db.commit()
        return by_id(me["id"]), secret, None
    secret = secrets.token_urlsafe(24)
    cur = db.execute("INSERT INTO profiles (name, name_key, secret, created) VALUES (?, ?, ?, ?)",
                     (name, name.casefold(), digest(secret), time.time()))
    db.execute("INSERT INTO stats (pid) VALUES (?)", (cur.lastrowid,))
    db.commit()
    return by_id(cur.lastrowid), secret, None


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
