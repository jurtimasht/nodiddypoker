"""Турнир (MTT): «директор турнира».

Директор владеет несколькими обычными столами engine.Table в режиме mtt и ведёт турнир:
регистрация → старт (случайная рассадка) → уровни блайндов по времени → вылеты и места →
пересадки (баланс столов и слияние в финальный стол) → победитель.

Здесь нет сети, базы и aiohttp: время приходит параметром now, сохранение — через переданную функцию.
Поэтому весь турнир целиком проверяется тестом (test_mtt.py), в том числе турнир одних ботов.

Главное правило: игрока переносят только со стола, где СЕЙЧАС НЕТ раздачи (old.running == False).
Фишки игрока в любой момент = stack + total (total — сколько он уже положил в банк в текущей раздаче).
"""
import math
import random
import secrets
from collections import deque

from engine import Table, RANKS

# Уровни (SB / BB / Ante). Анте — классическое (платит каждый) и С ПЕРВОГО уровня (решение Саши):
# примерно 10–12,5% большого блайнда, круглыми числами.
def _levels(rows):
    return [{"sb": sb, "bb": bb, "ante": ante} for sb, bb, ante in rows]


TURBO_LEVELS = _levels([(25, 50, 5), (50, 100, 10), (75, 150, 20), (100, 200, 25), (150, 300, 40), (200, 400, 50),
                        (300, 600, 75), (400, 800, 100), (600, 1200, 150), (800, 1600, 200), (1000, 2000, 250),
                        (1500, 3000, 400), (2000, 4000, 500)])
REGULAR_LEVELS = _levels([(50, 100, 10), (100, 200, 25), (150, 300, 40), (200, 400, 50), (300, 600, 75), (400, 800, 100),
                          (600, 1200, 150), (800, 1600, 200), (1000, 2000, 250), (1500, 3000, 400), (2000, 4000, 500),
                          (3000, 6000, 750), (4000, 8000, 1000), (6000, 12000, 1500)])
DEEP_LEVELS = [{"sb": l["sb"] * 2, "bb": l["bb"] * 2, "ante": l["ante"] * 2} for l in REGULAR_LEVELS]
DEFAULT_LEVELS = TURBO_LEVELS + _levels([(3000, 6000, 750), (4000, 8000, 1000)])

# Шаблоны для формы в админке (браузер берёт их отсюда — одно место правды)
TEMPLATES = {
    "turbo": {"title": "Turbo", "stack": 5000, "level_seconds": 300, "levels": TURBO_LEVELS, "late_reg_level": 2, "rebuy_level": 0},
    "regular": {"title": "Regular", "stack": 10000, "level_seconds": 480, "levels": REGULAR_LEVELS, "late_reg_level": 4, "rebuy_level": 4},
    "deep": {"title": "Deep", "stack": 20000, "level_seconds": 900, "levels": DEEP_LEVELS, "late_reg_level": 4, "rebuy_level": 4},
}
DEFAULT_POINTS = [10, 6, 4, 2, 1]       # очки за 1–5 места (раньше); теперь главное — призы в долларах
# Как делить призовой фонд (проценты по местам) — зависит от числа входов. Деньги считает только сайт
# (для учёта между друзьями), сам сайт денег не принимает и не платит.
PAYOUTS = [(3, [100]), (6, [65, 35]), (10, [50, 30, 20]), (17, [40, 25, 18, 10, 7]),
           (27, [33, 21, 15, 11, 8, 6, 6]), (10 ** 9, [30, 20, 14, 10, 8, 6, 5, 4, 3])]


def payout_percents(entries):
    for upto, pct in PAYOUTS:
        if entries <= upto:
            return pct
    return PAYOUTS[-1][1]


def prize_list(pool, entries):
    """Призы по местам в центах. Округляем вниз до цента, остаток — первому месту."""
    pct = payout_percents(max(1, entries))
    prizes = [pool * p // 100 for p in pct]
    if prizes:
        prizes[0] += pool - sum(prizes)
    return prizes
STATUSES = ("registration", "running", "paused", "finished", "cancelled")


def default_config(**over):
    cfg = {
        "game": "nlhe",
        "stack": 10_000,            # стартовый стек
        "level_seconds": 360,       # длина уровня
        "levels": [dict(x) for x in DEFAULT_LEVELS],
        "seats": 7,                 # мест за столом
        "max_players": 50,
        "turn_seconds": 15,
        "late_reg_level": 0,        # поздняя регистрация до этого уровня включительно (0 — нет)
        "rebuy_level": 0,           # ребаи вылетевшим до этого уровня включительно (0 — нет)
        "points": list(DEFAULT_POINTS),
        "buy_in": 0,                # цена входа в центах ($25 = 2500); ребай стоит столько же
        "test": False,              # пробный: можно ботов, без очков и кубков
    }
    cfg.update(over)
    return cfg


def validate_config(raw):
    """Проверить настройки турнира из админки (браузеру не доверяем). Возвращает (настройки, ошибка)."""
    if not isinstance(raw, dict):
        return None, "Bad settings."
    cfg = default_config()
    def num(key, lo, hi):
        v = raw.get(key, cfg[key])
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v != int(v) or not lo <= v <= hi:
            raise ValueError(f"{key} must be a whole number from {lo:,} to {hi:,}.")
        return int(v)
    try:
        if raw.get("game", "nlhe") not in ("nlhe", "plo4"):
            raise ValueError("Game must be Hold'em or Omaha.")
        cfg["game"] = raw.get("game", "nlhe")
        cfg["stack"] = num("stack", 100, 10_000_000)
        cfg["level_seconds"] = num("level_seconds", 30, 3600)
        cfg["seats"] = num("seats", 2, 7)
        cfg["max_players"] = num("max_players", 2, 100)
        cfg["turn_seconds"] = num("turn_seconds", 5, 60)
        levels = raw.get("levels", cfg["levels"])
        if not isinstance(levels, list) or not 1 <= len(levels) <= 40:
            raise ValueError("From 1 to 40 levels.")
        clean, prev = [], 0
        for i, lv in enumerate(levels, 1):
            if not isinstance(lv, dict):
                raise ValueError(f"Level {i}: bad row.")
            sb, bb, ante = (lv.get(k, 0) for k in ("sb", "bb", "ante"))
            if any(isinstance(x, bool) or not isinstance(x, int) or x > 10 ** 9 for x in (sb, bb, ante)):
                raise ValueError(f"Level {i}: blinds and ante must be whole numbers up to 1,000,000,000.")
            if not (0 < sb < bb) or ante < 0 or bb < prev:
                raise ValueError(f"Level {i}: need 0 < SB < BB, ante ≥ 0, and blinds that don't go down.")
            clean.append({"sb": sb, "bb": bb, "ante": ante})
            prev = bb
        cfg["levels"] = clean
        cfg["late_reg_level"] = num("late_reg_level", 0, len(clean))
        cfg["rebuy_level"] = num("rebuy_level", 0, len(clean))
        pts = raw.get("points", cfg["points"])
        if not isinstance(pts, list) or len(pts) > 10 or any(isinstance(x, bool) or not isinstance(x, int) or not 0 <= x <= 1000 for x in pts):
            raise ValueError("Points: up to 10 whole numbers from 0 to 1,000.")
        cfg["points"] = pts
        cfg["test"] = bool(raw.get("test", False))
        cfg["buy_in"] = num("buy_in", 0, 1_000_000)            # до $10 000, в центах
    except ValueError as exc:
        return None, str(exc)
    return cfg, None


class Entry:
    """Участник турнира: человек (pid) или бот."""
    def __init__(self, name, pid=None, avatar="", bot=False):
        self.name = name
        self.pid = pid
        self.avatar = avatar
        self.bot = bot
        self.status = "registered"  # registered / playing / out
        self.player = None          # объект engine.Player, пока играет
        self.table = None           # код стола, где сидит
        self.bust_seq = None        # номер «волны» вылета (несколько вылетевших в одной раздаче — одна волна)
        self.bust_stack = 0         # фишки на начало раздачи, в которой вылетел (для порядка в одной волне)
        self.rebuys = 0
        self.bust_level = None      # на каком уровне вылетел (для пульта: «6th · out at level 5»)
        self.kicked = False         # «убрать игрока» из пульта: вылетает с местом между раздачами

    @property
    def key(self):
        return ("bot", self.name) if self.bot else ("pid", self.pid)


class Director:
    def __init__(self, tid, name, config, rnd=None, save=None, bot_delay=(0.6, 1.5)):
        self.tid = tid
        self.name = name
        self.cfg = default_config(**config)
        self.status = "registration"
        self.entries = []
        self.tables = {}            # код стола -> Table (в порядке создания)
        self.closing = set()        # столы, которые закрываются (слияние): их игроков рассадят после раздачи
        self.level = 0              # номер уровня (0 — первый)
        self.level_mark = None      # когда начался отсчёт текущего уровня (без пауз)
        self.level_elapsed = 0.0    # сколько уже прошло в уровне до последней паузы
        self.started = None
        self.ended = None
        self.bust_seq = 0
        self.removed_chips = 0      # фишки убранных из пульта игроков (ушли из игры)
        self.next_table_no = 1
        self.next_bot_no = 1
        self.rnd = rnd or random.Random(secrets.randbits(64))
        self.save = save
        self.bot_delay = bot_delay
        self.bot_due = {}           # код стола -> (ключ хода, когда боту ходить)
        self.moves = []             # [(Player, код нового стола)] — сервер скажет браузерам «перейди на другой стол»
        self.events = []            # короткие события для журнала и новостей
        self.dirty = True
        self.urgent = True          # важное событие — сохранить сразу, не дожидаясь 5 секунд
        self.last_save = None
        self.auto_resume_at = None  # после перезапуска сервера: продолжить само в это время
        self.error = None           # что-то не сошлось при восстановлении — турнир стоит на паузе
        self.starts_at = None       # когда стартовать самому (None — только кнопкой)
        self.now = 0.0              # время последнего вызова (для журнала событий)

    # ---------- уровни ----------
    def blinds(self, level=None):
        levels = self.cfg["levels"]
        return levels[min(self.level if level is None else level, len(levels) - 1)]

    def level_left(self, now):
        """Секунд до следующего уровня (None — уровни не идут)."""
        if self.status not in ("running", "paused") or self.level_mark is None:
            return None
        elapsed = self.level_elapsed + (0 if self.status == "paused" else now - self.level_mark)
        return max(0.0, self.cfg["level_seconds"] - elapsed)

    def apply_blinds(self):
        b = self.blinds()
        for t in self.tables.values():
            t.sb, t.bb = b["sb"], b["bb"]
            t.ante = b.get("ante", 0)           # раздача, которая уже идёт, доигрывается со старыми блайндами

    # ---------- участники ----------
    def find(self, pid=None, name=None):
        for e in self.entries:
            if (pid is not None and e.pid == pid) or (name is not None and e.bot and e.name == name):
                return e
        return None

    def can_register(self):
        if self.status == "registration":
            return True
        late = self.cfg["late_reg_level"]
        return self.status in ("running", "paused") and late and self.level + 1 <= late

    def register(self, pid, name, avatar=""):
        if not self.can_register():
            return "Registration is closed."
        if self.find(pid=pid):
            return "You are already registered."
        if len(self.entries) >= self.cfg["max_players"]:
            return "The tournament is full."
        e = Entry(name, pid=pid, avatar=avatar)
        self.entries.append(e)
        if self.status in ("running", "paused"):     # поздняя регистрация — сразу за стол
            self.seat_entry(e)
        self.dirty = True
        return None

    def unregister(self, pid):
        e = self.find(pid=pid)
        if e is None:
            return "You are not registered."
        if self.status != "registration":
            return "The tournament has started — you can't unregister now."
        self.entries.remove(e)
        self.dirty = True
        return None

    def add_bots(self, n):
        if not self.cfg["test"]:
            return "Bots are only allowed in test tournaments."
        if self.status != "registration":
            return "Bots can only be added before the start."
        for _ in range(n):
            if len(self.entries) >= self.cfg["max_players"]:
                break
            self.entries.append(Entry(f"Bot#{self.next_bot_no}", bot=True))
            self.next_bot_no += 1
        self.dirty = True
        return None

    def remove_bots(self):
        if self.status != "registration":
            return "Bots can only be removed before the start."
        self.entries = [e for e in self.entries if not e.bot]
        self.dirty = True
        return None

    def alive(self):
        return [e for e in self.entries if e.status == "playing"]

    def chips_in_play(self):
        return sum(e.player.stack + e.player.total for e in self.alive())

    def chips_total(self):
        """Сколько фишек должно быть в игре: входы + ребаи − убранные из пульта."""
        n = sum(1 for e in self.entries if e.status != "registered")
        return (n + sum(e.rebuys for e in self.entries)) * self.cfg["stack"] - self.removed_chips

    # ---------- старт ----------
    def new_table(self):
        code = f"m{self.tid}-{self.next_table_no}"
        self.next_table_no += 1
        b = self.blinds()
        t = Table(code, b["sb"], b["bb"], min_buyin=0, max_buyin=10 ** 12, turn_seconds=self.cfg["turn_seconds"],
                  game=self.cfg["game"], seats=self.cfg["seats"], mtt=True)
        t.ante = b.get("ante", 0)
        t.name = f"{self.name} · table {code.rsplit('-', 1)[1]}"
        t.chat = deque(maxlen=60)          # чат стола (как у кэша)
        t.equity_task = None              # подсчёт шансов олл-ина (ведёт сервер)
        t.on_hand_end = None                # раздачи турнира не идут в кэш-статистику
        t.auto = self.status == "running"
        self.tables[code] = t
        return t

    def make_player(self, e):
        from engine import Player
        p = Player(secrets.token_urlsafe(16), e.name, 0, self.cfg["stack"], e.pid, e.avatar)
        p.bot = e.bot
        p.connections = p.table_conns = 1 if e.bot else 0   # бот всегда «за столом»; людей посчитает сервер по вкладкам
        return p

    def start(self, now):
        self.now = now
        if self.status != "registration":
            return "The tournament has already started."
        if len(self.entries) < 2:
            return "At least 2 players are needed."
        self.status = "running"
        self.started = now
        self.level = 0
        self.level_mark = now
        self.level_elapsed = 0.0
        order = list(self.entries)
        self.rnd.shuffle(order)
        n_tables = math.ceil(len(order) / self.cfg["seats"])
        tables = [self.new_table() for _ in range(n_tables)]
        for i, e in enumerate(order):        # по кругу: 7 игроков на 4 места → 4 + 3
            t = tables[i % n_tables]
            seat = t.seats.index(None)
            e.player = self.make_player(e)
            t.put_in(e.player, seat)
            e.status, e.table = "playing", t.code
            self.moves.append((e.player, t.code))   # сервер подхватит открытые вкладки участника
        for t in tables:
            t.dealer = self.rnd.choice([p.seat for p in t.players()])   # кнопка дилера — случайно
            t.dealer = (t.dealer - 1) % len(t.seats)                    # start_hand передвинет её на этого игрока
            t.auto = True
        self.event("start", f"{self.name} started: {len(order)} players, {n_tables} table{'s' if n_tables > 1 else ''}")
        self.dirty = True
        return None

    def seat_entry(self, e):
        """Посадить (позднего или после ребая) за самый пустой стол со свободным местом."""
        free = [t for t in self.tables.values() if t.code not in self.closing and None in t.seats]
        if not free:
            free = [self.new_table()]
        t = min(free, key=lambda x: len(x.players()))
        e.player = self.make_player(e)
        t.put_in(e.player, self.rnd.choice([i for i, s in enumerate(t.seats) if s is None]))
        e.status, e.table = "playing", t.code
        e.bust_seq = None
        self.moves.append((e.player, t.code))

    # ---------- пауза, отмена ----------
    def pause(self, now):
        self.now = now
        if self.status != "running":
            return "The tournament is not running."
        self.level_elapsed += now - self.level_mark
        self.level_mark = now
        self.status = "paused"
        self.auto_resume_at = None          # пауза кнопкой — до кнопки Resume
        for t in self.tables.values():
            t.auto = False                  # раздача, которая идёт, доигрывается; новая не начнётся
        self.event("pause", "Tournament paused")
        self.dirty = True
        return None

    def resume(self, now):
        self.now = now
        if self.status != "paused":
            return "The tournament is not paused."
        if self.error:
            return "The tournament can't continue: " + self.error
        self.auto_resume_at = None
        self.level_mark = now
        self.status = "running"
        for t in self.tables.values():
            t.auto = True
        self.event("resume", "Tournament resumed")
        self.dirty = True
        return None

    def cancel(self, now):
        self.now = now
        if self.status in ("finished", "cancelled"):
            return "The tournament is already over."
        self.status = "cancelled"
        self.ended = now
        for t in self.tables.values():
            t.auto = False
        self.event("cancel", "Tournament cancelled")
        self.dirty = True
        return None

    def kick(self, pid=None, name=None):
        """«Убрать игрока»: вылет с местом сейчас (его фишки уходят из игры). Если он в раздаче — сбрасывает карты."""
        e = self.find(pid=pid, name=name)
        if e is None or e.status != "playing":
            return "This player is not in the game."
        e.kicked = True
        t = self.tables[e.table]
        p = e.player
        if t.running and p.in_hand and not p.folded and not p.all_in:
            t.fold_out_of_turn(p)
        self.dirty = True
        return None

    def rebuy(self, pid=None, name=None):
        e = self.find(pid=pid, name=name)
        if e is None or e.status != "out" or e.kicked:
            return "Only players who are out can rebuy."
        if self.status not in ("running", "paused") or not self.cfg["rebuy_level"] or self.level + 1 > self.cfg["rebuy_level"]:
            return "Rebuys are closed."
        e.rebuys += 1
        self.seat_entry(e)
        self.event("rebuy", f"{e.name} rebuys")
        self.dirty = True
        return None

    # ---------- главный такт (сервер зовёт ~4 раза в секунду, тест — сколько нужно) ----------
    def tick(self, now):
        """Возвращает True, если что-то поменялось."""
        changed = False
        self.now = now
        if self.status == "registration" and self.starts_at and now >= self.starts_at and len(self.entries) >= 2:
            changed = self.start(now) is None       # время старта пришло (меньше двух — ждём дальше)
        if self.status not in ("running", "paused"):
            if changed:
                self.dirty = True
                self.maybe_save(now)
            return changed
        if self.status == "paused" and self.auto_resume_at is not None and now >= self.auto_resume_at:
            self.resume(now)                # после перезапуска: продолжаем сами через 5 минут
            changed = True
        if self.status == "running" and self.level_left(now) == 0 and self.level < len(self.cfg["levels"]) - 1:
            self.level += 1
            self.level_mark = now
            self.level_elapsed = 0.0
            self.apply_blinds()
            b = self.blinds()
            self.event("level", f"Level {self.level + 1}: blinds {b['sb']}/{b['bb']}" + (f", ante {b['ante']}" if b.get("ante") else ""))
            changed = True
        if self.status == "running":
            changed |= self.bots(now)          # сначала ходы ботов: раздача может закончиться прямо сейчас
        for t in list(self.tables.values()):
            if not t.running:
                changed |= self.clean_table(t)
        changed |= self.rebalance()
        if len(self.alive()) <= 1:
            changed |= self.finish(now)
        if changed:
            self.dirty = True
        self.maybe_save(now)
        return changed

    def clean_table(self, t):
        """Между раздачами: убрать вылетевших (0 фишек) и «убранных» из пульта, выдать места."""
        out = [p for p in t.players() if p.stack == 0 or self.entry_of(p).kicked]
        if not out:
            return False
        last = t.history[-1] if t.history else None
        start = {pl["seat"]: pl["stack"] for pl in last["players"]} if last else {}
        self.bust_seq += 1
        for p in out:
            e = self.entry_of(p)
            if e.kicked:
                self.removed_chips += p.stack
            t.take_out(p)
            e.status, e.player, e.table = "out", None, None
            e.bust_seq = self.bust_seq
            e.bust_level = self.level + 1
            e.bust_stack = 0 if e.kicked else start.get(p.seat, 0)
        # в одной волне: больше фишек на начало раздачи — выше место; поровну — делят место
        wave = [e for e in self.entries if e.bust_seq == self.bust_seq]
        if len({e.bust_stack for e in wave}) > 1:
            groups = sorted({e.bust_stack for e in wave})           # меньше фишек — раньше «вылетел»
            for i, stack in enumerate(groups):
                for e in wave:
                    if e.bust_stack == stack:
                        e.bust_seq = self.bust_seq + i
            self.bust_seq += len(groups) - 1
        for e in wave:
            self.event("bust", f"{e.name} is out — {ordinal(self.place(e))} place")
        return True

    def entry_of(self, p):
        for e in self.entries:
            if e.player is p:
                return e
        raise KeyError(p.name)

    def place(self, e):
        """Место участника. Живые — 1 (если один) или None; вылетевшие — по порядку вылета (поровну — делят)."""
        alive = len(self.alive())
        if e.status == "playing":
            return 1 if alive == 1 and self.status == "finished" else None
        if e.bust_seq is None:
            return None
        later = sum(1 for x in self.entries if x.status == "out" and x.bust_seq is not None and x.bust_seq > e.bust_seq)
        return alive + later + 1

    # ---------- пересадки ----------
    def free_seats(self, t):
        return [i for i, s in enumerate(t.seats) if s is None]

    def move(self, p, src, dst):
        src.take_out(p)
        seat = self.rnd.choice(self.free_seats(dst))
        dst.put_in(p, seat)
        self.entry_of(p).table = dst.code
        self.moves.append((p, dst.code))

    def next_big_blind(self, t):
        """Кто на этом столе следующим сядет на большой блайнд — его и пересаживаем (не пропустит блайнды)."""
        live = lambda p: p.stack > 0
        d = t.next_seat(t.dealer, live)
        if d is None:
            return None
        sb = t.next_seat(d, live)
        bb = t.next_seat(sb, live) if len([p for p in t.players() if live(p)]) > 2 else sb
        return t.seats[bb] if bb is not None else None

    def rebalance(self):
        changed = False
        alive = len(self.alive())
        seats = self.cfg["seats"]
        # слияние: столов больше, чем нужно — самый пустой стол закрывается
        while len(self.tables) - len(self.closing) > 1 and alive <= seats * (len(self.tables) - len(self.closing) - 1):
            open_tables = [t for t in self.tables.values() if t.code not in self.closing]
            victim = min(open_tables, key=lambda t: (len(t.players()), t.running))
            self.closing.add(victim.code)
            changed = True
        for code in list(self.closing):
            t = self.tables[code]
            if t.running:
                continue
            others = [x for x in self.tables.values() if x.code not in self.closing]
            for p in list(t.players()):
                dst = min((x for x in others if self.free_seats(x)), key=lambda x: len(x.players()))
                self.move(p, t, dst)
            t.auto = False
            del self.tables[code]
            self.closing.discard(code)
            self.event("merge", f"Table {code.rsplit('-', 1)[1]} closed, players moved")
            changed = True
        # баланс: со стола без раздачи, где игроков на 2+ больше, чем на самом маленьком, — одного туда
        for _ in range(len(self.tables) * seats):
            open_tables = [t for t in self.tables.values() if t.code not in self.closing]
            if len(open_tables) < 2:
                break
            small = min(open_tables, key=lambda t: len(t.players()))
            big = max((t for t in open_tables if not t.running and t is not small),
                      key=lambda t: len(t.players()), default=None)
            if big is None or len(big.players()) - len(small.players()) < 2 or not self.free_seats(small):
                break
            p = self.next_big_blind(big) or self.rnd.choice(big.players())
            self.move(p, big, small)
            changed = True
        return changed

    # ---------- конец ----------
    def finish(self, now):
        self.status = "finished"
        self.ended = now
        for t in self.tables.values():
            t.auto = False
        winner = self.alive()[0] if self.alive() else None
        if winner:
            self.event("win", f"{winner.name} wins {self.name}!")
        return True

    # ---------- деньги: бай-ин, призовой фонд, призы ----------
    def entries_count(self):
        """Сколько входов: записавшиеся (до старта) или сыгравшие + ребаи."""
        played = [e for e in self.entries if e.status != "registered"] if self.status != "registration" else self.entries
        return len(played) + sum(e.rebuys for e in self.entries)

    def prize_pool(self):
        return self.cfg.get("buy_in", 0) * self.entries_count()

    def prizes(self):
        """Призы по местам (центы): 1-е, 2-е, … Сколько мест платят — по числу входов."""
        n = len([e for e in self.entries if e.status != "registered"]) if self.status != "registration" else len(self.entries)
        return prize_list(self.prize_pool(), n)

    def prize_for(self, place, tie=1):
        """Приз за место; если место делят tie человек — делят и призы мест place … place+tie-1."""
        p = self.prizes()
        return sum(p[i - 1] for i in range(place, place + tie) if i <= len(p)) // tie if place else 0

    def next_prize(self):
        """Что получит следующий вылетевший (как в клиентах покер-румов: «Next Prize $52.08 (6th)»)."""
        p = self.prizes()
        left = len(self.alive())
        if not p or left < 2:
            return None
        place = min(left - 1, len(p))
        return {"place": place, "amount": p[place - 1]}

    def results(self):
        """Итог: место, приз в долларах (центы), кубок. Пробный турнир — без кубка (и не идёт в рейтинг)."""
        out = []
        pts = self.cfg["points"]
        played = [e for e in self.entries if e.status != "registered"]
        places = [self.place(e) for e in played]
        for e, place in zip(played, places):
            tie = places.count(place) if place else 1
            points = 0 if self.cfg["test"] or place is None or place > len(pts) else pts[place - 1]
            out.append({"pid": e.pid, "name": e.name, "bot": e.bot, "place": place, "points": points,
                        "prize": self.prize_for(place, tie), "paid": self.cfg.get("buy_in", 0) * (1 + e.rebuys),
                        "trophy": int(place == 1 and not self.cfg["test"]), "rebuys": e.rebuys})
        return sorted(out, key=lambda r: (r["place"] or 999, r["name"]))

    # ---------- боты ----------
    def bots(self, now):
        changed = False
        for t in self.tables.values():
            if not t.running or t.actor is None:
                self.bot_due.pop(t.code, None)
                continue
            p = t.seats[t.actor]
            if not p.bot:
                continue
            key = (t.hand_no, t.street, t.actor, t.current_bet)
            due = self.bot_due.get(t.code)
            if due is None or due[0] != key:
                lo, hi = self.bot_delay
                due = (key, now + (lo + (hi - lo) * self.rnd.random() if hi else 0))
                self.bot_due[t.code] = due
            if now >= due[1]:
                action, amount = bot_action(t, p, self.rnd)
                err = t.act(p, action, amount)
                if err:                      # на всякий случай: законный ход всегда есть
                    t.act(p, "check" if t.options(p) and t.options(p)["check"] else "fold")
                self.bot_due.pop(t.code, None)
                changed = True
        return changed

    def next_level(self, now):
        """Кнопка в пульте: следующий уровень прямо сейчас (раздача, которая идёт, доигрывается со старыми блайндами)."""
        if self.status not in ("running", "paused"):
            return "The tournament is not running."
        if self.level >= len(self.cfg["levels"]) - 1:
            return "This is already the last level."
        self.now = now
        self.level += 1
        self.level_mark = now
        self.level_elapsed = 0.0
        self.apply_blinds()
        b = self.blinds()
        self.event("level", f"Level {self.level + 1}: blinds {b['sb']}/{b['bb']}" + (f", ante {b['ante']}" if b.get("ante") else ""))
        self.dirty = True
        return None

    def event(self, kind, text):
        self.events.append({"kind": kind, "text": text, "t": self.now})
        del self.events[:-100]
        self.urgent = True

    # ---------- сохранение и восстановление ----------
    # Снимок можно делать в ЛЮБОЙ момент между вызовами движка: фишки игрока = stack + total
    # («как будто текущая раздача отменена»). Нельзя только из on_hand_end (там выигрыш уже в stack,
    # а total ещё не обнулён) — поэтому у столов турнира on_hand_end = None, а снимок делает только директор.
    def snapshot(self, now):
        tables = []
        for t in self.tables.values():
            # раздача, которая идёт, после восстановления отменяется: кнопка дилера останется у того же игрока
            dealer = (t.dealer - 1) % len(t.seats) if t.running else t.dealer
            tables.append({"code": t.code, "dealer": dealer, "hand_no": t.hand_no, "closing": t.code in self.closing})
        entries = []
        for e in self.entries:
            p = e.player
            entries.append({"name": e.name, "pid": e.pid, "avatar": e.avatar, "bot": e.bot, "status": e.status,
                            "table": e.table, "seat": p.seat if p else None, "chips": p.stack + p.total if p else 0,
                            "away": bool(p and p.away), "bust_seq": e.bust_seq, "bust_stack": e.bust_stack,
                            "rebuys": e.rebuys, "kicked": e.kicked, "bust_level": e.bust_level})
        level_elapsed = self.level_elapsed + (now - self.level_mark if self.status == "running" and self.level_mark is not None else 0)
        return {"v": 1, "tid": self.tid, "name": self.name, "config": self.cfg, "status": self.status, "starts_at": self.starts_at,
                "level": self.level, "level_elapsed": level_elapsed, "started": self.started, "ended": self.ended,
                "bust_seq": self.bust_seq, "removed_chips": self.removed_chips, "next_table_no": self.next_table_no,
                "next_bot_no": self.next_bot_no, "entries": entries, "tables": tables, "error": self.error,
                "events": self.events[-50:]}

    def maybe_save(self, now, force=False):
        """Сохранить, если что-то поменялось: важное — сразу, остальное — не чаще раза в 5 секунд."""
        if not self.save or not self.dirty:
            return False
        if not (force or self.urgent or self.last_save is None or now - self.last_save >= 5):
            return False
        self.save(self.snapshot(now))
        self.dirty = self.urgent = False
        self.last_save = now
        return True

    @classmethod
    def restore(cls, state, now, rnd=None, save=None, bot_delay=(0.6, 1.5), resume_after=300):
        """Восстановить после перезапуска. Идущий турнир встаёт на паузу и сам продолжится через resume_after секунд."""
        from engine import Player
        d = cls(state["tid"], state["name"], state["config"], rnd=rnd, save=save, bot_delay=bot_delay)
        d.status = state["status"]
        d.level = state["level"]
        d.level_elapsed = state["level_elapsed"]
        d.level_mark = now
        d.started, d.ended = state["started"], state["ended"]
        d.bust_seq = state["bust_seq"]
        d.removed_chips = state["removed_chips"]
        d.next_table_no = state["next_table_no"]
        d.next_bot_no = state["next_bot_no"]
        d.error = state.get("error")
        d.starts_at = state.get("starts_at")
        d.events = list(state.get("events") or [])
        d.now = now
        b = d.blinds()
        for ts in state["tables"]:
            t = Table(ts["code"], b["sb"], b["bb"], min_buyin=0, max_buyin=10 ** 12, turn_seconds=d.cfg["turn_seconds"],
                      game=d.cfg["game"], seats=d.cfg["seats"], mtt=True)
            t.ante = b.get("ante", 0)
            t.name = f"{d.name} · table {ts['code'].rsplit('-', 1)[1]}"
            t.chat = deque(maxlen=60)          # чат стола (как у кэша)
            t.equity_task = None              # подсчёт шансов олл-ина (ведёт сервер)
            t.on_hand_end = None
            t.dealer = ts["dealer"]
            t.hand_no = ts["hand_no"]
            t.auto = False
            d.tables[t.code] = t
            if ts.get("closing"):
                d.closing.add(t.code)
        for es in state["entries"]:
            e = Entry(es["name"], pid=es["pid"], avatar=es["avatar"], bot=es["bot"])
            e.status, e.table = es["status"], es["table"]
            e.bust_seq, e.bust_stack, e.rebuys, e.kicked = es["bust_seq"], es["bust_stack"], es["rebuys"], es["kicked"]
            e.bust_level = es.get("bust_level")
            if e.status == "playing":
                p = Player(secrets.token_urlsafe(16), e.name, 0, es["chips"], e.pid, e.avatar)
                p.bot = e.bot
                p.connections = p.table_conns = 1 if e.bot else 0
                p.away = es.get("away", False)
                d.tables[e.table].put_in(p, es["seat"])
                e.player = p
            d.entries.append(e)
        if d.status in ("running", "paused"):
            if d.chips_in_play() != d.chips_total() and not d.error:
                d.error = f"chips don't add up after restart ({d.chips_in_play()} instead of {d.chips_total()})"
            d.status = "paused"
            d.auto_resume_at = None if d.error else now + resume_after
            d.event("restore", "Tournament restored after a restart — the unfinished hand was cancelled")
        d.dirty = True
        return d


def ordinal(n):
    if n is None:
        return "?"
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def bot_action(t, p, rnd):
    """Простой бот: только законные ходы. До флопа — по картам, после — по силе руки. Без «умного» ИИ."""
    o = t.options(p)
    to_call = o["call"]
    bb = max(t.bb, 1)
    if t.street == "preflop":
        ranks = sorted((RANKS.index(c[0]) for c in p.cards), reverse=True)
        pair = len(set(c[0] for c in p.cards)) < len(p.cards)
        high = ranks[0] >= RANKS.index("T") and ranks[1] >= RANKS.index("T")
        if pair or high or rnd.random() < 0.08:
            if o["raise"]:
                if p.stack + p.bet <= 10 * bb:
                    return "allin", 0
                return "raise", max(o["min_to"], min(o["max_to"], int(2.5 * bb) + p.bet))
            return ("check", 0) if o["check"] else ("call", 0)
        if o["check"]:
            return "check", 0
        if to_call <= 2 * bb and rnd.random() < 0.4:
            return "call", 0
        return "fold", 0
    made = t.strength(p.cards, t.board)[0] >= 1          # пара или лучше
    if made or rnd.random() < 0.1:
        if o["raise"] and (made or rnd.random() < 0.5):
            pot_half = max(o["min_to"], min(o["max_to"], t.current_bet + max(bb, t.pot() // 2)))
            return "raise", pot_half
        return ("check", 0) if o["check"] else ("call", 0)
    return ("check", 0) if o["check"] else ("fold", 0)


# ---------- что показывать на экране ----------
def avg_stack(d):
    alive = d.alive()
    return round(d.chips_in_play() / len(alive)) if alive else 0


def public_view(d, now, viewer_pid=None, admin=False):
    """Турнир для лобби и пульта. Игрокам — без внутренних подробностей; хозяину (admin) — всё."""
    b = d.blinds()
    nxt = d.cfg["levels"][d.level + 1] if d.level + 1 < len(d.cfg["levels"]) else None
    me = d.find(pid=viewer_pid) if viewer_pid is not None else None
    rows = []
    for e in d.entries:
        p = e.player
        rows.append({"name": e.name, "pid": e.pid if admin else None, "bot": e.bot, "avatar": e.avatar,
                     "status": e.status, "place": d.place(e), "chips": (p.stack + p.total) if p else 0,
                     "table": e.table, "rebuys": e.rebuys, "away": bool(p and p.away),
                     "online": bool(p and (p.bot or p.connections > 0)), "me": e is me, "bust_level": e.bust_level})
    playing = sorted((r for r in rows if r["status"] == "playing"), key=lambda r: -r["chips"])
    out = sorted((r for r in rows if r["status"] == "out"), key=lambda r: r["place"] or 999)
    reg = [r for r in rows if r["status"] == "registered"]
    tables = [{"code": t.code, "name": t.name, "players": len(t.players()), "running": t.running,
               "closing": t.code in d.closing} for t in d.tables.values()]
    view = {
        "id": d.tid, "name": d.name, "status": d.status, "test": d.cfg["test"], "starts_at": d.starts_at,
        "game": d.cfg["game"], "stack": d.cfg["stack"], "seats": d.cfg["seats"], "max_players": d.cfg["max_players"],
        "level": d.level + 1, "levels": d.cfg["levels"], "level_seconds": d.cfg["level_seconds"],
        "sb": b["sb"], "bb": b["bb"], "ante": b.get("ante", 0), "next": nxt, "level_left": d.level_left(now),
        "late_reg_level": d.cfg["late_reg_level"], "rebuy_level": d.cfg["rebuy_level"], "points": d.cfg["points"],
        "can_register": bool(d.can_register()),
        "can_rebuy": bool(d.status in ("running", "paused") and d.cfg["rebuy_level"] and d.level + 1 <= d.cfg["rebuy_level"]),
        "entrants": len(d.entries), "left": len(d.alive()), "avg_stack": avg_stack(d),
        "players": playing + out + reg, "tables": tables, "auto_resume_in": max(0, d.auto_resume_at - now) if d.auto_resume_at else None,
        "error": d.error, "started": d.started, "rebuys": sum(e.rebuys for e in d.entries),
        "buy_in": d.cfg.get("buy_in", 0), "prize_pool": d.prize_pool(), "prizes": d.prizes(), "next_prize": d.next_prize(),
        "log": d.events[-40:][::-1] if admin else None,
        "me": None if me is None else {"status": me.status, "place": d.place(me), "table": me.table, "rebuys": me.rebuys,
                                       "can_rebuy": bool(me.status == "out" and not me.kicked and d.status in ("running", "paused")
                                                         and d.cfg["rebuy_level"] and d.level + 1 <= d.cfg["rebuy_level"])},
    }
    if d.status == "finished":
        view["results"] = d.results()
    return view


def table_banner(d, t, viewer_pid, now):
    """Полоса над столом турнира: уровень, блайнды/анте, время до следующего уровня, сколько осталось, средний стек."""
    b = d.blinds()
    me = d.find(pid=viewer_pid) if viewer_pid is not None else None
    return {"id": d.tid, "name": d.name, "status": d.status, "level": d.level + 1, "sb": b["sb"], "bb": b["bb"],
            "ante": b.get("ante", 0), "level_left": d.level_left(now), "left": len(d.alive()), "entrants": len(d.entries),
            "avg_stack": avg_stack(d), "paused": d.status == "paused",
            "my_place": d.place(me) if me and me.status == "out" else None,
            "my_status": me.status if me else None, "my_table": me.table if me else None,
            "can_rebuy": bool(me and me.status == "out" and not me.kicked and d.status in ("running", "paused")
                              and d.cfg["rebuy_level"] and d.level + 1 <= d.cfg["rebuy_level"]),
            "test": d.cfg["test"], "game": d.cfg["game"], "buy_in": d.cfg.get("buy_in", 0), "prize_pool": d.prize_pool(),
            "next_prize": d.next_prize(), "level_seconds": d.cfg["level_seconds"],
            "winner": d.alive()[0].name if d.status == "finished" and d.alive() else None}
