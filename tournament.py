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

from engine import Table, RANKS

# Уровни по умолчанию (SB / BB / Ante). Анте — классическое (платит каждый), с 4-го уровня.
DEFAULT_LEVELS = [
    {"sb": 25, "bb": 50, "ante": 0}, {"sb": 50, "bb": 100, "ante": 0}, {"sb": 75, "bb": 150, "ante": 0},
    {"sb": 100, "bb": 200, "ante": 25}, {"sb": 150, "bb": 300, "ante": 40}, {"sb": 200, "bb": 400, "ante": 50},
    {"sb": 300, "bb": 600, "ante": 75}, {"sb": 400, "bb": 800, "ante": 100}, {"sb": 500, "bb": 1000, "ante": 125},
    {"sb": 700, "bb": 1400, "ante": 175}, {"sb": 1000, "bb": 2000, "ante": 250}, {"sb": 1500, "bb": 3000, "ante": 400},
    {"sb": 2000, "bb": 4000, "ante": 500}, {"sb": 3000, "bb": 6000, "ante": 750}, {"sb": 4000, "bb": 8000, "ante": 1000},
]
DEFAULT_POINTS = [10, 6, 4, 2, 1]       # очки за 1–5 места (решение Саши); у первого ещё и кубок
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
        "test": False,              # пробный: можно ботов, без очков и кубков
    }
    cfg.update(over)
    return cfg


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
        t.chat = []
        t.on_hand_end = None                # раздачи турнира не идут в кэш-статистику
        t.auto = self.status == "running"
        self.tables[code] = t
        return t

    def make_player(self, e):
        from engine import Player
        p = Player(secrets.token_urlsafe(16), e.name, 0, self.cfg["stack"], e.pid, e.avatar)
        p.bot = e.bot
        p.connections = 1 if e.bot else 0   # бот всегда «на сайте»; людей посчитает сервер по вкладкам
        return p

    def start(self, now):
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
        if self.status not in ("running", "paused"):
            return False
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

    def results(self):
        """Итог: место, очки, кубок. В пробном турнире очков и кубков нет."""
        out = []
        pts = self.cfg["points"]
        for e in self.entries:
            if e.status == "registered":
                continue
            place = self.place(e)
            points = 0 if self.cfg["test"] or place is None or place > len(pts) else pts[place - 1]
            out.append({"pid": e.pid, "name": e.name, "bot": e.bot, "place": place, "points": points,
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

    def event(self, kind, text):
        self.events.append({"kind": kind, "text": text})
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
                            "rebuys": e.rebuys, "kicked": e.kicked})
        level_elapsed = self.level_elapsed + (now - self.level_mark if self.status == "running" and self.level_mark is not None else 0)
        return {"v": 1, "tid": self.tid, "name": self.name, "config": self.cfg, "status": self.status,
                "level": self.level, "level_elapsed": level_elapsed, "started": self.started, "ended": self.ended,
                "bust_seq": self.bust_seq, "removed_chips": self.removed_chips, "next_table_no": self.next_table_no,
                "next_bot_no": self.next_bot_no, "entries": entries, "tables": tables, "error": self.error}

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
        b = d.blinds()
        for ts in state["tables"]:
            t = Table(ts["code"], b["sb"], b["bb"], min_buyin=0, max_buyin=10 ** 12, turn_seconds=d.cfg["turn_seconds"],
                      game=d.cfg["game"], seats=d.cfg["seats"], mtt=True)
            t.ante = b.get("ante", 0)
            t.name = f"{d.name} · table {ts['code'].rsplit('-', 1)[1]}"
            t.chat = []
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
            if e.status == "playing":
                p = Player(secrets.token_urlsafe(16), e.name, 0, es["chips"], e.pid, e.avatar)
                p.bot = e.bot
                p.connections = 1 if e.bot else 0
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
