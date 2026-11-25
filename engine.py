"""Правила покера: техасский холдем без лимита (No-Limit Texas Hold'em).

Здесь только игра: колода, ставки, банки, кто победил.
Ничего про интернет и браузеры — этим занимается server.py.

Карты записываются двумя буквами: достоинство + масть.
  Достоинства: 2 3 4 5 6 7 8 9 T(10) J(валет) Q(дама) K(король) A(туз)
  Масти: s ♠ пики, h ♥ червы, d ♦ бубны, c ♣ трефы
  Например: "As" = туз пик, "Th" = десятка червей.
"""
import itertools
import math
import secrets
import time
from collections import deque

import fair

RANKS = "23456789TJQKA"
# Названия мест от дилера по кругу, в зависимости от числа игроков
POSITIONS = {2: ["BTN", "BB"], 3: ["BTN", "SB", "BB"], 4: ["BTN", "SB", "BB", "UTG"],
             5: ["BTN", "SB", "BB", "UTG", "CO"], 6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
             7: ["BTN", "SB", "BB", "UTG", "MP", "HJ", "CO"]}
SUITS = "shdc"
MAX_SEATS = 7
RUNOUT_DELAY = 2.5      # секунд между флопом, тёрном и ривером, когда все в олл-ине
TIMEBANK_PRE = 10       # time chip before the flop: +10 seconds, one per hand
TIMEBANK_POST = 60      # time chip after the flop: +1 minute, one per hand
BADBEAT_EQUITY = 0.69  # проиграл олл-ин, имея 69% и больше на любой улице — на экране у всех появляется картинка
BADBEAT_RIVER_HOLD = 1 # тогда после ривера пауза 1 с,
BADBEAT_SHOW = 6       # тряска стола, картинка с золотым свечением ~5 с, потом следующая раздача
REBUY_WAIT = 10        # проиграл все фишки — следующая раздача ждёт до 10 с, пока он докупается
KICK_AFTER = 15         # закрыл сайт (нет ни стола, ни лобби) дольше 15 секунд — встаёт из-за стола
HAND_BREAK = 4          # секунд между раздачами (успеть посмотреть вскрытие)
FAIR_LEAD = 3           # за сколько секунд до раздачи начинать честную перемешку (1,5 с на отпечатки + 1,5 с на секреты)
STREET_PAUSE = 1       # секунда паузы после последнего хода улицы — чтобы все увидели колл или чек
RIVER_HOLD = 1.5       # олл-ин: после ривера показать итоговые шансы (100% и 💀), потом отдать банк

HAND_NAMES = ["High card", "Pair", "Two pair", "Three of a kind", "Straight",
              "Flush", "Full house", "Four of a kind", "Straight flush"]


# ---------- колода и комбинации ----------
def new_deck():
    """Новая перемешанная колода. SystemRandom = надёжный случайный генератор системы."""
    deck = [r + s for r in RANKS for s in SUITS]
    secrets.SystemRandom().shuffle(deck)
    return deck


def card_value(card):
    return RANKS.index(card[0]) + 2          # "2" -> 2 ... "A" -> 14


def eval5(cards):
    """Сила руки из 5 карт в виде кортежа: чем больше, тем сильнее.
    Первое число — вид комбинации (0 = старшая карта ... 8 = стрит-флеш),
    дальше — карты для сравнения одинаковых комбинаций."""
    values = sorted((card_value(c) for c in cards), reverse=True)
    flush = len({c[1] for c in cards}) == 1

    unique = sorted(set(values), reverse=True)
    straight_high = 0
    if len(unique) == 5:
        if unique[0] - unique[4] == 4:
            straight_high = unique[0]
        elif unique == [14, 5, 4, 3, 2]:      # «колесо»: A-2-3-4-5, туз считается единицей
            straight_high = 5

    # Группы одинаковых карт: сначала самые большие группы, потом самые старшие
    groups = sorted(((values.count(v), v) for v in unique), reverse=True)
    shape = [count for count, _ in groups]
    order = [value for _, value in groups]

    if straight_high and flush:
        return (8, straight_high)
    if shape == [4, 1]:
        return (7, *order)
    if shape == [3, 2]:
        return (6, *order)
    if flush:
        return (5, *values)
    if straight_high:
        return (4, straight_high)
    if shape == [3, 1, 1]:
        return (3, *order)
    if shape == [2, 2, 1]:
        return (2, *order)
    if shape == [2, 1, 1, 1]:
        return (1, *order)
    return (0, *values)


def best_hand(cards):
    """Лучшая рука из 5 карт среди 6–7 доступных (2 свои + общие)."""
    return max(eval5(combo) for combo in itertools.combinations(cards, 5))


def chips(n):
    """Сумма в тексте помечается §…§ — браузер сам покажет её в фишках или в больших блайндах."""
    return f"§{n}§"


# ---------- быстрый подсчёт для шансов (equity) ----------
# Тот же результат, что best_hand(), но сразу по 7 картам, без перебора 21 комбинации —
# в десятки раз быстрее. Нужен, чтобы за доли секунды проиграть тысячи вариантов досок.
def parse(card):
    return (RANKS.index(card[0]) + 2, SUITS.index(card[1]))


def straight_high(ranks):
    """Старшая карта стрита среди достоинств (множество) или 0."""
    if 14 in ranks:
        ranks = ranks | {1}                  # туз может быть единицей: A-2-3-4-5
    for high in range(14, 4, -1):
        if high in ranks and high - 1 in ranks and high - 2 in ranks and high - 3 in ranks and high - 4 in ranks:
            return high
    return 0


def eval7(cards):
    """Сила лучшей руки из 7 (или 5–6) карт вида (достоинство, масть). Совпадает с best_hand()."""
    count = [0] * 15
    by_suit = ([], [], [], [])
    for rank, suit in cards:
        count[rank] += 1
        by_suit[suit].append(rank)
    flush = None
    for suited in by_suit:
        if len(suited) >= 5:
            high = straight_high(set(suited))
            if high:
                return (8, high)
            flush = (5, *sorted(suited, reverse=True)[:5])
            break
    present = [r for r in range(14, 1, -1) if count[r]]
    fours = [r for r in present if count[r] == 4]
    threes = [r for r in present if count[r] == 3]
    twos = [r for r in present if count[r] == 2]
    if fours:
        q = fours[0]
        return (7, q, max(r for r in present if r != q))
    if threes and (len(threes) > 1 or twos):
        t = threes[0]
        return (6, t, max(threes[1:] + twos))
    if flush:
        return flush
    high = straight_high(set(present))
    if high:
        return (4, high)
    if threes:
        t = threes[0]
        return (3, t, *[r for r in present if r != t][:2])
    if len(twos) >= 2:
        a, b = twos[0], twos[1]
        return (2, a, b, max(r for r in present if r != a and r != b))
    if twos:
        p = twos[0]
        return (1, p, *[r for r in present if r != p][:3])
    return (0, *present[:5])


def equity(hands, board, samples=100_000, dead=()):
    """Шанс каждой руки выиграть банк (0..1), ничьи делятся поровну.
    На флопе и тёрне перебираем ВСЕ оставшиеся доски точно; до флопа — 100 000 случайных досок
    (точность около ±0,3%). Сброшенные карты не учитываем: игроки их не знают."""
    import random
    known = set(board) | set(dead) | {c for h in hands for c in h}   # dead — карты второй доски
    deck = [parse(r + s) for r in RANKS for s in SUITS if r + s not in known]
    my = [[parse(c) for c in h] for h in hands]
    table = [parse(c) for c in board]
    need = 5 - len(board)
    if need == 0:
        boards = [()]
    elif need <= 2:
        boards = itertools.combinations(deck, need)
    else:
        rnd = random.Random()
        boards = (rnd.sample(deck, need) for _ in range(samples))
    score = [0.0] * len(hands)
    total = 0
    for extra in boards:
        full = table + list(extra)
        values = [eval7(h + full) for h in my]
        best = max(values)
        winners = [i for i, v in enumerate(values) if v == best]
        for i in winners:
            score[i] += 1 / len(winners)
        total += 1
    return [x / total for x in score]


# ---------- Омаха ----------
# В Омахе комбинация собирается СТРОГО из 2 своих карт и 3 общих (не 1+4 и не 3+2).
# Своих карт 4 (PLO4) или 5 (PLO5).
def omaha_strength(hole, board):
    """Сила лучшей руки в Омахе. hole и board — карты вида (достоинство, масть)."""
    best = None
    triples = list(itertools.combinations(board, 3))
    for a, b in itertools.combinations(hole, 2):
        for x, y, z in triples:
            v = eval7((a, b, x, y, z))
            if best is None or v > best:
                best = v
    return best


def best_omaha(hole, board):
    """То же для карт-строк ("Ah"): для вскрытия и подсказки «у тебя …»."""
    return omaha_strength([parse(c) for c in hole], [parse(c) for c in board])


def equity_omaha(hands, board, budget=0.9, dead=()):
    """Шансы в Омахе. Флоп и тёрн — точный перебор всех досок; до флопа — случайные доски,
    сколько успеем примерно за budget секунд (точность ±2–3%, для подсказки этого хватает)."""
    import random
    known = set(board) | set(dead) | {c for h in hands for c in h}   # dead — карты второй доски
    deck = [parse(r + s) for r in RANKS for s in SUITS if r + s not in known]
    my = [[parse(c) for c in h] for h in hands]
    table = [parse(c) for c in board]
    need = 5 - len(board)
    if need == 0:
        boards = [()]
    elif need <= 2:
        boards = itertools.combinations(deck, need)
    else:
        per = len(hands) * (115e-6 if len(hands[0]) <= 4 else 230e-6)   # примерно столько стоит одна доска
        samples = max(300, min(20_000, int(budget / per)))
        rnd = random.Random()
        boards = (rnd.sample(deck, need) for _ in range(samples))
    score = [0.0] * len(hands)
    total = 0
    for extra in boards:
        full = table + list(extra)
        values = [omaha_strength(h, full) for h in my]
        best = max(values)
        winners = [i for i, v in enumerate(values) if v == best]
        for i in winners:
            score[i] += 1 / len(winners)
        total += 1
    return [x / total for x in score]


def hand_name(strength):
    if strength[0] == 8 and strength[1] == 14:
        return "Royal flush"
    return HAND_NAMES[strength[0]]


# ---------- игрок ----------
class Player:
    def __init__(self, token, name, seat, stack, pid=None, avatar=""):
        self.token = token          # секретный ключ игрока (хранится в его браузере)
        self.name = name
        self.pid = pid              # номер профиля (для статистики за всё время)
        self.avatar = avatar        # адрес фото профиля ("" — нет фото)
        self.seat = seat            # номер места 0..6
        self.stack = stack          # фишки перед игроком
        self.bought = stack         # сколько всего фишек взял: вход + докупки (чтобы считать плюс/минус)
        self.connections = 0        # сколько открыто вкладок сайта (стол + лобби); 0 = закрыл сайт
        self.table_conns = 0        # из них — вкладок со столом (0 при connections > 0 = ушёл в лобби)
        self.offline_since = None   # когда закрыл сайт (для автоматического «встать»)
        self.away = False           # «отошёл»: не получает карты
        self.leaving = False        # встаёт из-за стола после этой раздачи
        self.timeouts = 0           # сколько раз подряд не успел походить
        self.rebuy_from = None      # проиграл всё: с какого времени идёт отсчёт докупки
        self.rebuy_until = None     # до какого времени стол ждёт его докупку
        self.bot = False            # бот (только в пробных турнирах): ходит за него директор турнира
        self.reset_hand()

    def reset_hand(self):
        self.bank_pre = TIMEBANK_PRE    # запас времени на префлоп (секунды) — на раздачу
        self.bank_post = TIMEBANK_POST  # запас времени после флопа — общий на флоп, тёрн и ривер:
                                        # потратил 10 с на флопе — на тёрне осталось 50
        self.cards = []
        self.in_hand = False        # участвует в текущей раздаче
        self.folded = False
        self.all_in = False
        self.bet = 0                # поставил на этой улице
        self.total = 0              # поставил за всю раздачу (вместе с анте)
        self.ante = 0               # анте в этой раздаче (мёртвые деньги: в банке, но не в ставке улицы)
        self.acted = False          # уже ходил после последнего полного повышения
        self.last = ""              # последнее действие, для показа на столе
        self.show_cards = set()     # какие свои карты (0, 1) показать всем, когда раздача закончится


# ---------- стол ----------
class Table:
    def __init__(self, code, small_blind=50, big_blind=100, min_buyin=10_000, max_buyin=1_000_000, turn_seconds=30,
                 game="nlhe", bomb_bb=0, double_board=False, seats=MAX_SEATS, mtt=False):
        self.code = code
        # Стол турнира (MTT): им управляет директор турнира (tournament.py) — уровни блайндов, пересадки, вылеты.
        # Отличия от кэша: карты получают все, у кого есть фишки (даже офлайн — тогда авто-check/fold за 1 с),
        # никого не выкидывают за уход с сайта, докупку стол не ждёт, итоги вечера и статистика не ведутся.
        self.mtt = mtt
        self.ante = 0               # анте (турнир): каждый в раздаче кладёт его до блайндов. 0 — без анте (кэш)
        # Вид игры: "nlhe" — холдем без лимита (2 карты), "plo4" / "plo5" — Омаха пот-лимит (4 / 5 карт).
        self.game = game
        self.hole_count = {"nlhe": 2, "plo4": 4, "plo5": 5}[game]
        self.pot_limit = game != "nlhe"   # в Омахе повышать можно максимум на размер банка
        self.bomb_bb = bomb_bb      # бомб-пот: каждую раздачу все ставят bomb_bb больших блайндов, сразу флоп
        self.double_board = double_board   # две доски: каждый банк делится пополам — половина лучшей руке на каждой доске
        self.board2 = []
        self.min_buyin = min_buyin  # с какой суммой минимум можно сесть или докупиться
        self.max_buyin = max_buyin  # защита от опечатки «лишних нулей»
        self.buyins = None          # если задан список (например [10000, 15000, 20000]) — можно выбрать только эти суммы
        self.sb = small_blind
        self.bb = big_blind
        self.turn_seconds = turn_seconds
        self.created = time.time()
        self.last_activity = time.time()

        # Мест за столом: 7 (обычный) или 2 (heads-up, один на один). Больше 7 стол на экране не рисует.
        self.seats = [None] * max(2, min(int(seats), MAX_SEATS))
        self.auto = True            # раздачи идут сами, когда за столом 2+ игрока
        self.running = False        # сейчас идёт раздача
        self.hand_no = 0
        self.dealer = -1
        self.deck = []
        self.board = []
        self.street = ""            # preflop, flop, turn, river
        self.actor = None           # чьё место сейчас ходит
        self.deadline = None        # до какого времени он должен походить
        self.turn_total = turn_seconds
        self.timebank = None
        self.timebank_seq = 0
        self.bank_start = 0
        self.current_bet = 0        # самая большая ставка на этой улице
        self.min_raise = big_blind  # на сколько минимум можно повысить
        self.next_hand_at = None
        self.runout = False         # все в олл-ине: карты открыты, улицы выходят по одной с паузой
        self.next_street_at = None  # когда выложить следующую улицу
        self.street_end_at = None   # торговля на улице закончилась: когда выкладывать следующую
        self.equity = None          # олл-ин: шансы игроков {место: 0..1} для текущей доски (считает server.py)
        self.equity2 = None         # то же для второй доски (если досок две)
        self.equity_key = None      # (номер раздачи, сколько карт на доске) — для какой доски посчитано
        self.refund = None          # последний возврат неуравненной ставки {seat, amount, id} — для анимации
        self.refund_seq = 0
        self.allin_equity = None     # шансы в момент олл-ина (первые посчитанные) — для «bad beat»
        self.badbeat = None          # {seat, name, equity, id}: кто проиграл с >69%
        self.badbeat_seq = 0
        self.result = None          # итог прошлой раздачи (кто выиграл, чьи карты открыть)
        self.log = []
        self.ledger = {}            # итоги вечера по имени: сколько взял фишек и сколько унёс (даже если ушёл)
        self.history = deque(maxlen=100)  # история последних 100 раздач (для просмотра и повтора)
        self.hist = None            # запись текущей раздачи
        self.on_hand_end = None     # что вызвать, когда раздача записана (для статистики)
        self.last_act_event = None
        self.rebuy_sig = ()           # кто сейчас докупается (чтобы заметить начало и конец отсчёта)
        # Честная перемешка (fair.py). Включает server.py у кэш-столов; без неё — обычная new_deck()
        self.fair = False
        self.shuffle = None           # перемешка следующей раздачи
        self.shuffle_played = None    # перемешка идущей (или последней) раздачи
        self.fair_notes = []          # что разослать браузерам (забирает server.py)
        self.fair_aborted = []        # выброшенные перемешки перед следующей раздачей — попадут в доказательство
        self.fair_silent = set()      # токены тех, кто не прислал обещанный секрет: в этой раздаче — без них

    # ----- помощники -----
    def players(self):
        return [p for p in self.seats if p]

    def active(self):
        """Кто ещё борется за банк (не сбросил карты)."""
        return [p for p in self.players() if p.in_hand and not p.folded]

    def pot(self):
        return sum(p.total for p in self.players())

    def say(self, text):
        self.log.append(text)
        del self.log[:-60]

    def next_seat(self, start, condition):
        """Следующее место по часовой стрелке после start, где сидит подходящий игрок."""
        n = len(self.seats)
        for step in range(1, n + 1):
            p = self.seats[(start + step) % n]
            if p and condition(p):
                return p.seat
        return None

    def strength(self, cards, board):
        """Сила руки по правилам этого стола (холдем: любые 5 из 7; Омаха: 2 свои + 3 общие)."""
        if self.game == "nlhe":
            return best_hand(cards + board)
        return best_omaha(cards, board)

    def hand_label(self, cards):
        """Название руки: «Flush», а при двух досках — «Flush / Two pair» (первая / вторая доска)."""
        first = hand_name(self.strength(cards, self.board))
        if self.double_board and len(self.board2) >= 3:
            return f"{first} / {hand_name(self.strength(cards, self.board2))}"
        return first

    def max_raise_to(self, p):
        """До скольки игрок может повысить: в холдеме — всё, что есть; в пот-лимите — не больше банка.
        Пот-рейз = уравнять + ещё столько, сколько будет в банке после колла."""
        all_in_to = p.bet + p.stack
        if not self.pot_limit:
            return all_in_to
        to_call = max(0, self.current_bet - p.bet)
        return min(all_in_to, self.current_bet + self.pot() + to_call)

    def can_play(self, p):
        if self.mtt:
            return p.stack > 0             # в турнире карты получают все живые
        return p.stack > 0 and p.connections > 0 and not p.away and not p.leaving

    def needs_action(self, p):
        if not p.in_hand or p.folded or p.all_in:
            return False
        others_can_bet = any(o is not p and not o.all_in for o in self.active())
        if not others_can_bet and p.bet >= self.current_bet:
            return False            # все остальные в олл-ине и ставка уравнена — ходить незачем
        return not p.acted or p.bet < self.current_bet

    def put(self, p, amount):
        """Игрок кладёт фишки в банк (не больше, чем у него есть)."""
        amount = max(0, min(amount, p.stack))
        p.stack -= amount
        p.bet += amount
        p.total += amount
        if p.stack == 0:
            p.all_in = True
        return amount

    def put_ante(self, p, amount):
        """Анте: фишки идут в банк (total), но не в ставку улицы (bet) — их не нужно «уравнивать»,
        и они никогда не возвращаются как неуравненная ставка. Короткий стек кладёт сколько есть."""
        amount = max(0, min(amount, p.stack))
        p.stack -= amount
        p.total += amount
        p.ante = amount
        if p.stack == 0:
            p.all_in = True
        return amount

    # ----- итоги вечера (кто сколько в плюсе или минусе) -----
    def book(self, name):
        return self.ledger.setdefault(name.lower(), {"name": name, "bought": 0, "out": 0})

    def ledger_view(self):
        """Для окна «Итоги»: взял (вход + докупки), сейчас за столом, унёс (если ушёл), итог."""
        seated = {p.name.lower(): p for p in self.players()}
        rows = []
        for key, e in self.ledger.items():
            p = seated.get(key)
            now = p.stack + p.total if p else 0            # фишки в текущей раздаче считаем как свои
            rows.append({"name": e["name"], "bought": e["bought"], "out": e["out"],
                         "now": now if p else None, "profit": e["out"] + now - e["bought"]})
        return sorted(rows, key=lambda r: -r["profit"])

    def reset_ledger(self, who):
        """Новый подсчёт: всё, что сейчас у игроков, считается их входом; ушедшие убираются."""
        self.ledger = {}
        for p in self.players():
            self.book(p.name)["bought"] = p.stack + p.total
        self.say(f"{who} starts a new results count.")

    # ----- игроки садятся и уходят -----
    def check_buyin(self, amount):
        """Сумма входа или докупки, которую выбрал игрок. Возвращает (сумма, ошибка)."""
        try:
            amount = int(amount)
        except (TypeError, ValueError):
            return 0, "Enter the amount as a number."
        if self.buyins:
            if amount not in self.buyins:
                return 0, "Choose " + " / ".join(f"{b:,}" for b in self.buyins) + " chips."
            return amount, None
        if amount < self.min_buyin:
            return 0, f"Minimum {self.min_buyin:,} chips."
        if amount > self.max_buyin:
            return 0, f"Maximum {self.max_buyin:,} chips."
        return amount, None

    def add_player(self, token, name, buyin, pid=None, avatar=""):
        buyin, error = self.check_buyin(buyin)
        if error:
            return None, error
        if any(p.name.lower() == name.lower() for p in self.players()):
            return None, "That name is already at the table."
        free = [i for i, s in enumerate(self.seats) if s is None]
        if not free:
            return None, f"All {len(self.seats)} seats are taken."
        if pid is not None and any(p.pid == pid for p in self.players()):
            return None, "You are already at the table (in another tab?)."
        p = Player(token, name, free[0], buyin, pid, avatar)
        self.seats[p.seat] = p
        self.book(name)["bought"] += buyin
        self.say(f"{name} sits down with {chips(buyin)}.")
        return p, None

    # ----- турнир: перенос игрока между столами (тот же объект Player: фишки, ключ, вкладки сохраняются) -----
    def take_out(self, p):
        """Убрать игрока с этого стола без итогов вечера. Только между раздачами."""
        assert not self.running, "нельзя пересаживать во время раздачи"
        assert self.seats[p.seat] is p
        self.seats[p.seat] = None

    def put_in(self, p, seat):
        """Посадить игрока на свободное место. Если тут идёт раздача — он ждёт следующую."""
        assert self.seats[seat] is None
        p.seat = seat
        p.reset_hand()
        p.leaving = False
        self.seats[seat] = p

    def remove_player(self, p):
        self.seats[p.seat] = None
        self.book(p.name)["out"] += p.stack       # унёс с собой — для итогов вечера
        self.say(f"{p.name} leaves the table ({chips(p.stack)}).")

    def leave(self, p):
        if self.running and p.in_hand and not p.folded and not p.all_in:   # в олл-ине карты не сбрасываем — доиграет
            self.fold_out_of_turn(p)
        if self.running and p.in_hand:
            p.leaving = True        # уберём, когда раздача закончится
        else:
            self.remove_player(p)

    def rebuy(self, p, amount):
        if p.stack > 0:
            return "You can only rebuy when you are out of chips."
        if self.running and p.in_hand:
            return "Wait until the hand is over."
        amount, error = self.check_buyin(amount)
        if error:
            return error
        p.stack += amount
        p.bought += amount
        p.rebuy_from = p.rebuy_until = None
        self.book(p.name)["bought"] += amount
        self.say(f"{p.name} rebuys {chips(amount)}.")
        return None

    def skip_rebuy(self, p):
        """Закрыл окно докупки («просто смотреть») — стол его больше не ждёт."""
        p.rebuy_from = p.rebuy_until = None

    def rebuy_wait(self, p, now):
        """Сколько секунд осталось ждать его докупку (None — не ждём)."""
        if p.stack > 0 or p.rebuy_until is None or p.leaving or p.away or p.connections <= 0:
            return None
        if now < p.rebuy_from or now >= p.rebuy_until:
            return None
        return p.rebuy_until - now

    def show(self, p, card):
        """Клик по одной своей карте: показать её всем (обе — кликнуть по обеим).
        Во время раздачи — пометка «покажу в конце» (повторный клик снимает её), после раздачи — сразу."""
        if not p.cards:
            return "You have no cards to show."
        if card not in range(len(p.cards)):
            return "Which card?"
        if self.running:
            if not p.in_hand:
                return "You have no cards to show."
            p.show_cards ^= {card}
            return None
        if self.result is None:
            return "You have no cards to show."
        self.reveal(p, {card})
        if self.history and self.history[-1]["no"] == self.hand_no:   # и в истории раздач тоже
            h = self.history[-1]
            h["shown"][p.seat] = list(self.result["show"][p.seat])
            if p.seat in self.result["hands"]:
                h["hands"][p.seat] = self.result["hands"][p.seat]
        return None

    def reveal(self, p, which):
        """Открыть всем карты игрока с номерами which; остальные остаются рубашкой ("back")."""
        cur = list(self.result["show"].get(p.seat) or ["back"] * len(p.cards))
        new = [i for i in sorted(which) if cur[i] == "back"]
        if not new:
            return
        for i in new:
            cur[i] = p.cards[i]
        self.result["show"][p.seat] = cur
        if "back" not in cur and len(self.board) >= 3 and not p.folded and p.seat not in self.result["hands"]:
            self.result["hands"][p.seat] = self.hand_label(p.cards)   # у сбросившего — без комбинации
        self.say(f"{p.name} shows {' '.join(p.cards[i] for i in new)}.")

    # ----- раздача -----
    def start_hand(self):
        ready = [p for p in self.players() if self.can_play(p)]
        if len(ready) < 2:
            return False
        if self.fair and not self.shuffle_ready():
            return False            # честный стол никогда не раздаёт «просто так»
        self.hand_no += 1
        self.result = None
        self.board = []
        self.board2 = []
        self.deck = [] if self.fair else new_deck()
        for p in self.players():
            p.reset_hand()
            p.in_hand = p in ready

        self.dealer = self.next_seat(self.dealer, lambda p: p.in_hand)
        if len(ready) == 2:         # один на один: дилер ставит малый блайнд
            sb_seat = self.dealer
        else:
            sb_seat = self.next_seat(self.dealer, lambda p: p.in_hand)
        bb_seat = self.next_seat(sb_seat, lambda p: p.in_hand)

        self.say(f"— Hand #{self.hand_no} —")
        # Запись раздачи для истории: кто сидел, где, с каким стеком
        order = sorted(ready, key=lambda p: (p.seat - self.dealer) % len(self.seats))   # от дилера по кругу
        names = POSITIONS.get(len(order), POSITIONS[7])
        self.hist = {
            "no": self.hand_no, "time": time.time(), "sb": self.sb, "bb": self.bb, "ante": self.ante, "dealer": self.dealer,
            "players": [{"seat": p.seat, "name": p.name, "stack": p.stack, "pos": names[i], "token": p.token,
                         "pid": p.pid, "avatar": p.avatar}
                        for i, p in enumerate(order)],
            "hole": {}, "events": [], "board": [], "board2": [], "shown": {}, "hands": {}, "result": [], "winners": [], "pot": 0,
            "badbeats": [],             # кого переехали на ривере и кто это сделал (для Diddy factor)
            "fair": None,               # перемешка этой раздачи: из неё потом делаем доказательство
        }
        if self.bomb_bb:
            # Бомб-пот: блайндов нет, каждый ставит одинаково (5 BB), торговли до флопа нет
            ante = self.bomb_bb * self.bb
            for p in order:
                self.put(p, ante)
                p.last = "All-in" if p.all_in else f"Bomb {chips(p.bet)}"
                self.record_act(p)
        else:
            if self.ante:                   # анте — с каждого, до блайндов
                for p in order:
                    self.put_ante(p, self.ante)
                    p.last = "All-in" if p.all_in else f"Ante {chips(p.ante)}"
                    self.record_act(p)
            sb_p, bb_p = self.seats[sb_seat], self.seats[bb_seat]
            for p, blind in ((sb_p, self.sb), (bb_p, self.bb)):
                if p.all_in:                # ушёл в олл-ин уже на анте — блайнд поставить нечем
                    continue
                self.put(p, blind)
                p.last = f"Blind {chips(p.bet)}"
                self.record_act(p)

        if self.fair:
            self.deal_fair(ready)
        else:
            for _ in range(self.hole_count):
                for p in ready:
                    p.cards.append(self.deck.pop())
        self.hist["hole"] = {p.seat: list(p.cards) for p in ready}

        self.street = "preflop"
        self.current_bet = self.bb
        self.min_raise = self.bb
        self.running = True
        self.runout = False
        self.street_end_at = None
        self.equity = None
        self.equity2 = None
        self.equity_key = None
        self.refund = None
        self.allin_equity = None
        self.badbeat = None
        self.next_hand_at = None
        if self.bomb_bb:
            self.current_bet = max(p.bet for p in ready)
            for p in ready:
                p.acted = True
            self.end_street()               # сразу флоп (или олл-ин, если почти у всех фишки кончились)
            return True
        self.advance(bb_seat)
        return True

    # ----- честная перемешка (fair.py) -----
    def shuffle_ready(self):
        return self.shuffle is not None and self.shuffle.phase == "ready"

    def deal_fair(self, ready):
        """Раздать из готовой перемешки. У каждого места свои постоянные карты в колоде: сел кто-то или встал
        в последний момент — чужие карты и доска от этого не меняются."""
        cards = self.shuffle.cards()
        for p in ready:
            p.cards += [cards[i] for i in fair.hole_positions(p.seat, self.hole_count)]
        self.deck = cards[len(self.seats) * self.hole_count:][::-1]      # доски: end_street() берёт с конца
        self.hist["fair"] = {"shuffle": self.shuffle, "aborted": self.fair_aborted}
        self.shuffle_played, self.shuffle = self.shuffle, None
        self.fair_aborted, self.fair_silent = [], set()

    def new_shuffle(self, now):
        people = {p.seat: {"token": p.token, "name": p.name, "online": p.table_conns > 0}
                  for p in self.players() if not p.leaving}
        self.shuffle = fair.Shuffle(self.code, self.hand_no + 1, people, now, excluded=self.fair_silent)
        self.fair_notes.append(self.shuffle.note())

    def step_shuffle(self, now):
        """Двигает перемешку дальше, если пора."""
        if self.shuffle is None:
            self.new_shuffle(now)
        phase = self.shuffle.step(now)
        while phase:
            if phase == "aborted":
                silent = self.shuffle.silent()
                self.fair_silent |= {self.shuffle.people[s]["token"] for s in silent}
                names = ", ".join(self.shuffle.people[s]["name"] for s in silent)
                self.drop_shuffle(f"Reshuffle: no seed from {names}.")
                self.new_shuffle(now)
            else:
                self.fair_notes.append(self.shuffle.note())
            phase = self.shuffle.step(now)

    def drop_shuffle(self, reason):
        """Перемешку выбросили до раздачи. Молча этого делать нельзя: причина — всем и в доказательство."""
        s = self.shuffle
        seats = s.silent() if s.phase == "aborted" else []
        self.fair_aborted = (self.fair_aborted + [{"id": s.id.hex(), "root": s.root.hex(), "reason": reason}])[-20:]
        self.fair_notes.append({"type": "fair", "phase": "aborted", "id": s.id.hex(), "reason": reason, "seats": seats})
        self.say(reason)
        self.shuffle = None

    def seed_message(self, p, kind, sid, value):
        """Отпечаток или секрет от игрока. Неподходящее просто не засчитываем."""
        s = self.shuffle
        if s is None or self.seats[p.seat] is not p or not isinstance(sid, str) or sid != s.id.hex():
            return False
        done = (s.commit if kind == "seed_commit" else s.reveal)(p.seat, p.token, value)
        if done:
            self.step_shuffle(time.time())          # ответили все — сразу дальше, не ждём таймера
        return done

    def fair_proof(self, h, players):
        """Доказательство для зрителя. players — то, что он видит в истории: открываем только эти карты и доски."""
        if not h.get("fair"):
            return None
        hole = {pl["seat"]: pl["cards"] for pl in players}
        opened = set()
        for seat, cards in hole.items():
            at = fair.hole_positions(seat, self.hole_count)
            opened |= {at[k] for k, c in enumerate(cards) if c != "back"}
        for at, cards in zip(fair.board_positions(len(self.seats), self.hole_count, self.double_board),
                             (h["board"], h["board2"])):
            opened |= set(at[:len(cards)])
        return h["fair"]["shuffle"].proof(opened) | {
            "aborted": h["fair"]["aborted"],
            "seen": {"seats": len(self.seats), "hole_count": self.hole_count, "double_board": self.double_board,
                     "board": h["board"], "board2": h["board2"], "hole": {str(s): c for s, c in hole.items()}},
        }

    def set_actor(self, seat):
        self.actor = seat
        p = self.seats[seat]
        seconds = self.turn_seconds if p.connections > 0 else min(5, self.turn_seconds)
        if self.mtt and not p.bot and (p.connections <= 0 or p.away):
            seconds = min(1, self.turn_seconds)   # турнир: офлайн или «отошёл» — авто-check/fold через секунду
        self.deadline = time.time() + seconds
        self.turn_total = seconds   # на сколько секунд рассчитана полоска времени
        self.timebank = None        # сработал ли тайм-чип на этом ходу ("pre" / "post")

    def advance(self, from_seat):
        """После хода: кто ходит дальше? Или улица закончилась?"""
        if len(self.active()) == 1:
            return self.win_without_showdown(self.active()[0])
        nxt = self.next_seat(from_seat, self.needs_action)
        if nxt is not None:
            return self.set_actor(nxt)
        # Торговля на улице закончилась. Неуравненная часть ставки возвращается игроку сразу.
        # Короткая пауза, чтобы все увидели последний ход (колл, чек), и только потом следующая улица (её выложит tick()).
        self.actor = None
        self.deadline = None
        self.return_uncalled()
        if STREET_PAUSE <= 0:
            return self.end_street()
        self.street_end_at = time.time() + STREET_PAUSE

    def return_uncalled(self):
        """Неуравненная ставка — назад игроку. Пример: у P1 200 BB, у P2 100 BB, оба олл-ин —
        в банк идёт по 100 BB, а лишние 100 BB P1 сразу возвращаются в его стек."""
        in_hand = [p for p in self.players() if p.in_hand]
        if not in_hand:
            return
        top = max(in_hand, key=lambda p: p.bet)
        answered = max((p.bet for p in in_hand if p is not top), default=0)   # сколько уравнял лучший из остальных
        extra = top.bet - answered
        if extra <= 0:
            return
        top.bet -= extra
        top.total -= extra
        top.stack += extra
        top.all_in = top.stack == 0
        self.current_bet = top.bet
        self.refund_seq += 1
        self.refund = {"seat": top.seat, "amount": extra, "id": self.refund_seq}
        self.say(f"{top.name}: uncalled {chips(extra)} returned.")
        self.record({"k": "refund", "street": self.street, "seat": top.seat, "text": f"Returned {chips(extra)}",
                     "pot": self.pot(), "stack": top.stack})

    def end_street(self):
        self.actor = None
        self.deadline = None
        for p in self.players():
            p.bet = 0
            p.acted = False
            p.last = ""             # новая улица — на столе видны только её ходы
        self.current_bet = 0
        self.min_raise = self.bb

        if self.street == "river":
            return self.showdown()

        can_bet = [p for p in self.active() if not p.all_in]
        if len(can_bet) <= 1 and not self.runout:
            # Торговаться больше некому: открываем карты и выкладываем улицы по одной, с паузой
            self.runout = True
            self.next_street_at = time.time() + RUNOUT_DELAY
            self.say("Everyone is all-in — cards up.")
            self.record({"k": "reveal", "street": self.street, "seats": [p.seat for p in self.active()],
                         "text": "All-in — cards revealed", "pot": self.pot()})
            return

        self.deck.pop()             # «сжечь» карту, как в настоящем покере
        count = 3 if self.street == "preflop" else 1
        self.board += [self.deck.pop() for _ in range(count)]
        if self.double_board:       # вторая доска получает столько же карт
            self.board2 += [self.deck.pop() for _ in range(count)]
        self.street = {"preflop": "flop", "flop": "turn", "turn": "river"}[self.street]
        event = {"k": "board", "street": self.street, "board": list(self.board), "pot": self.pot()}
        if self.double_board:
            event["board2"] = list(self.board2)
        self.record(event)

        if self.runout:
            # Шансы на флопе, тёрне и ривере считаются мгновенно (перебор немногих карт) — сразу вместе с картой.
            # После ривера — короткая пауза с итогом (100% и 💀), потом вскрытие и банк победителю.
            # В Омахе на флопе перебор дольше (до ~0,4 с) — его посчитает сервер в отдельном потоке
            if self.game == "nlhe" or len(self.board) >= 4:
                self.compute_equity()
            delay = RIVER_HOLD if self.street == "river" else RUNOUT_DELAY
            if self.street == "river" and self.find_badbeats():
                delay = BADBEAT_RIVER_HOLD
            self.next_street_at = time.time() + delay
            return
        self.advance(self.dealer)

    def find_badbeats(self):
        """Ривер олл-ина вышел: у кого на какой-нибудь улице было 69% и больше, а теперь 0% — bad beat.
        Картинка — про первого такого игрока, в запись раздачи (для Diddy factor) идут все. Есть ли хоть один?"""
        beats = [{"seat": seat, "equity": round(start * 100)} for seat, start in (self.allin_equity or {}).items()
                 if round(start * 100) >= BADBEAT_EQUITY * 100 and self.combined_equity(seat, 1) == 0]
        if not beats:
            return False
        # Кто переехал: победители ривера. Их шансы сейчас — это их доли банка (при ничьей и двух досках делятся)
        shares = {seat: self.combined_equity(seat) for seat in self.equity or {}}
        by = {seat: share for seat, share in shares.items() if share > 0}
        if self.hist is not None:
            self.hist["badbeats"] = [{**b, "by": by} for b in beats]
        first = beats[0]
        self.badbeat_seq += 1
        self.badbeat = {"seat": first["seat"], "name": self.seats[first["seat"]].name if self.seats[first["seat"]] else "",
                        "equity": first["equity"], "id": self.badbeat_seq}
        self.say(f"Bad beat! {self.badbeat['name']} loses with {self.badbeat['equity']}%.")
        return True

    # ----- ходы -----
    def can_raise(self, p):
        """Можно ли повышать: ещё не ходил после последнего полного повышения, фишек больше, чем нужно
        для колла, и есть хоть один соперник, который может ответить (не все остальные в олл-ине)."""
        to_call = max(0, self.current_bet - p.bet)
        someone_can_answer = any(o is not p and not o.all_in for o in self.active())
        return not p.acted and p.stack > to_call and someone_can_answer

    def options(self, p):
        """Что может сделать игрок сейчас (для кнопок на экране)."""
        if not self.running or self.actor != p.seat or self.seats[p.seat] is not p:
            return None
        to_call = max(0, self.current_bet - p.bet)
        max_to = self.max_raise_to(p)
        can_raise = self.can_raise(p)
        return {
            "call": min(to_call, p.stack),
            "check": to_call == 0,
            "raise": can_raise,
            "min_to": min(self.current_bet + self.min_raise, max_to),
            "max_to": max_to,
            "all_in_to": p.bet + p.stack,      # в пот-лимите max_to может быть меньше «всё, что есть»
            "pot_limit": self.pot_limit,
            "is_bet": self.current_bet == 0,
        }

    def act(self, p, action, amount=0):
        """Ход игрока. Возвращает текст ошибки или None, если всё хорошо."""
        # на месте должен сидеть именно он (а не тот, кто сел туда после его вылета или пересадки)
        if not self.running or self.actor != p.seat or self.seats[p.seat] is not p:
            return "It is not your turn."
        to_call = self.current_bet - p.bet
        max_to = self.max_raise_to(p)       # в пот-лимите «олл-ин» = пот-рейз, если фишек больше банка

        if action == "fold":
            p.folded = True
            p.last = "Fold"
        elif action == "check":
            if to_call > 0:
                return "You cannot check: call the bet or fold."
            p.last = "Check"
        elif action == "call":
            if to_call <= 0:
                return "Nothing to call — you can check."
            self.put(p, to_call)
            p.last = "All-in" if p.all_in else f"Call {chips(p.bet)}"
        elif action in ("raise", "allin"):
            try:
                target = max_to if action == "allin" else int(amount)
            except (TypeError, ValueError):
                return "Invalid amount."
            if action == "allin" and not self.can_raise(p) and target > self.current_bet:
                return self.act(p, "call")          # повышать нельзя — «олл-ин» значит просто уравнять
            if target <= self.current_bet:
                if action != "allin":
                    return "A raise must be bigger than the current bet."
                self.put(p, p.stack)        # олл-ин на меньшую сумму = колл всем, что есть
                p.last = "All-in"
            else:
                if not self.can_raise(p):
                    return "You cannot raise now: only call or fold."
                if target > max_to:
                    if self.pot_limit and target <= p.bet + p.stack:
                        return f"Pot limit: maximum {max_to:,}."
                    return "You do not have that many chips."
                min_to = self.current_bet + self.min_raise
                if target < min_to and target != max_to:
                    return f"Minimum {min_to}."
                was_bet = self.current_bet == 0
                raise_size = target - self.current_bet
                self.put(p, target - p.bet)
                if raise_size >= self.min_raise:    # полноценное повышение: все ходят снова
                    self.min_raise = raise_size
                    for o in self.active():
                        if o is not p:
                            o.acted = False
                self.current_bet = target
                p.last = "All-in" if p.all_in else (f"Bet {chips(target)}" if was_bet else f"Raise to {chips(target)}")
        else:
            return "Unknown action."

        self.spend_bank(p)
        p.acted = True
        p.timeouts = 0
        self.say(f"{p.name}: {p.last}")
        self.record_act(p)
        self.advance(p.seat)
        return None

    def spend_bank(self, p):
        """Игрок походил, пока шёл запас времени: списываем ровно столько, сколько потратил."""
        if self.timebank is None or self.actor != p.seat:
            return
        used = time.time() - self.bank_start
        if self.timebank == "pre":
            p.bank_pre = max(0, p.bank_pre - used)
        else:
            p.bank_post = max(0, p.bank_post - used)
        self.timebank = None

    def fold_out_of_turn(self, p):
        """Игрок ушёл посреди раздачи — его карты сбрасываются."""
        if self.actor == p.seat:
            return self.act(p, "fold")
        p.folded = True
        p.last = "Fold"
        self.say(f"{p.name}: Fold")
        self.record_act(p, "Fold (left)")
        if len(self.active()) == 1:
            self.win_without_showdown(self.active()[0])
        elif self.actor is not None and not self.needs_action(self.seats[self.actor]):
            self.advance(self.actor)

    # ----- конец раздачи -----
    def win_without_showdown(self, winner):
        amount = self.pot()
        if self.hist:
            self.hist["pot"] = amount
        winner.stack += amount
        self.say(f"{winner.name} takes the pot {chips(amount)}.")
        self.result = {"text": [f"{winner.name} takes the pot {chips(amount)}"], "show": {}, "hands": {}, "winners": [winner.seat],
                       "won": {winner.seat: amount}}
        self.finish_hand()

    def pots_on_table(self):
        """Банки в середине стола (для экрана): основной и побочные из уже собранных фишек — без ставок этой улицы."""
        return [pot["amount"] for pot in self.build_pots(collected=True)]

    def build_pots(self, collected=False):
        """Делим фишки на основной и побочные банки (когда кто-то в олл-ине на меньшую сумму).
        collected=True — только то, что уже в середине (без ставок текущей улицы)."""
        left = {p: p.total - (p.bet if collected else 0) for p in self.players()}
        left = {p: v for p, v in left.items() if v > 0}
        pots = []
        while any(left.values()):
            alive = [p for p in left if left[p] > 0 and not p.folded]
            if not alive:                   # остались фишки только от сбросивших — в последний банк
                if pots:
                    pots[-1]["amount"] += sum(left.values())
                break
            level = min(left[p] for p in alive)
            amount = 0
            for p in left:
                part = min(left[p], level)
                amount += part
                left[p] -= part
            pots.append({"amount": amount, "players": alive})
        return pots

    def showdown(self):
        self.actor = None
        alive = self.active()
        strength = {p: self.strength(p.cards, self.board) for p in alive}
        boards = [(strength, "")]
        if self.double_board:       # две доски: у каждого банка две половины, каждая — своей доске
            boards = [(strength, "Board 1"), ({p: self.strength(p.cards, self.board2) for p in alive}, "Board 2")]
        texts, winners = [], set()
        won_by = {}                 # кто сколько забрал из банков (свой неоспоренный остаток — не выигрыш)
        if self.hist:
            self.hist["pot"] = self.pot()
        pots = self.build_pots()
        for i, pot in enumerate(pots):
            label = "Pot" if len(pots) == 1 else ("Main pot" if i == 0 else f"Side pot {i}")
            if len(pot["players"]) == 1:            # за этот банк больше никто не боролся — забирает обратно
                p = pot["players"][0]
                p.stack += pot["amount"]
                winners.add(p.seat)
                texts.append(f"{p.name} gets back {chips(pot['amount'])}")
                continue
            # первой доске — бóльшая половина (если сумма нечётная, лишняя фишка ей)
            parts = [pot["amount"]] if len(boards) == 1 else [(pot["amount"] + 1) // 2, pot["amount"] // 2]
            for (st, board_label), amount in zip(boards, parts):
                best = max(st[p] for p in pot["players"])
                won = [p for p in pot["players"] if st[p] == best]
                share, extra = divmod(amount, len(won))
                # лишняя фишка при делёжке — первому слева от дилера
                won.sort(key=lambda p: (p.seat - self.dealer - 1) % len(self.seats))
                for j, p in enumerate(won):
                    gain = share + (1 if j < extra else 0)
                    if gain <= 0:           # две доски и крошечный банк: на кого-то при делёжке не хватило фишки
                        continue
                    p.stack += gain
                    winners.add(p.seat)
                    won_by[p.seat] = won_by.get(p.seat, 0) + gain
                names = " and ".join(p.name for p in won)
                verb = "wins" if len(won) == 1 else "split"
                where = f"{board_label} · " if board_label else ""
                texts.append(f"{where}{label} {chips(amount)}: {names} {verb} — {hand_name(best)}")
        for t in texts:
            self.say(t)
        self.result = {
            "text": texts,
            "show": {p.seat: p.cards for p in alive},
            "hands": {p.seat: self.hand_label(p.cards) for p in alive},
            "winners": sorted(winners),
            "won": won_by,
        }
        self.finish_hand()

    def finish_hand(self):
        if self.result is not None:         # кто заранее нажал «показать карты»
            for p in self.players():
                if p.show_cards and p.cards and p.in_hand:
                    self.reveal(p, p.show_cards)
        if self.hist:
            h = self.hist
            h["board"] = list(self.board)
            h["board2"] = list(self.board2)
            if self.result:
                h["result"] = list(self.result["text"])
                h["shown"] = {seat: list(c) for seat, c in self.result["show"].items()}
                h["hands"] = dict(self.result["hands"])
                h["winners"] = list(self.result["winners"])
            for line in h["result"]:
                self.record({"k": "result", "street": "end", "text": line})
            ends = {p.seat: p.stack for p in self.players()}
            for pl in h["players"]:
                pl["end"] = ends.get(pl["seat"], 0)
            self.history.append(h)
            self.hist = None
            if self.on_hand_end:
                try:
                    self.on_hand_end(h)             # статистика за всё время (server.py -> profiles.py)
                except Exception as exc:
                    print(f"stats error: {exc!r}", flush=True)
        self.running = False
        self.runout = False
        self.street_end_at = None
        self.next_street_at = None
        self.actor = None
        self.deadline = None
        for p in self.players():
            p.bet = 0
            p.total = 0             # банк уже раздан победителям
            if p.leaving:
                self.remove_player(p)
        # пауза: посмотреть, кто выиграл (после bad beat — только пока показывается картинка)
        self.next_hand_at = time.time() + (BADBEAT_SHOW if self.badbeat else HAND_BREAK)
        for p in self.players() if not self.mtt else []:   # проиграл всё в этой раздаче — 10 с на докупку
            if p.in_hand and p.stack == 0:
                p.rebuy_from = self.next_hand_at
                p.rebuy_until = self.next_hand_at + REBUY_WAIT

    # ----- таймер (вызывается сервером два раза в секунду) -----
    def tick(self):
        """Возвращает True, если что-то изменилось и надо обновить экраны."""
        now = time.time()
        if self.running and self.street_end_at is not None and now >= self.street_end_at:
            self.street_end_at = None
            self.end_street()               # пауза после последнего хода прошла — следующая улица
            return True
        if self.running and self.runout and self.next_street_at is not None and now >= self.next_street_at:
            self.end_street()               # следующая улица олл-ина
            return True
        if self.running and self.deadline is not None and now >= self.deadline:
            p = self.seats[self.actor]
            # Время вышло — сначала тайм-чип (если ещё есть и игрок на сайте), потом уже авто-ход
            phase = "pre" if self.street == "preflop" else "post"
            extra = p.bank_pre if phase == "pre" else p.bank_post
            if extra >= 1 and p.connections > 0 and self.timebank is None and not (self.mtt and p.away):
                self.deadline = now + extra
                self.turn_total = extra
                self.timebank = phase
                self.bank_start = now
                self.timebank_seq += 1
                self.say(f"{p.name} uses the time bank ({int(extra)}s left).")
                return True
            if self.timebank is not None:       # запас кончился полностью
                if self.timebank == "pre":
                    p.bank_pre = 0
                else:
                    p.bank_post = 0
                self.timebank = None
            missed = p.timeouts + 1         # act() обнуляет счётчик, поэтому запоминаем заранее
            in_lobby = p.table_conns == 0
            self.act(p, "check" if p.bet >= self.current_bet else "fold")
            p.last += " (time)"
            if self.last_act_event is not None:
                self.last_act_event["text"] += " (time)"
            p.timeouts = missed
            if in_lobby and not p.away:     # ушёл в лобби и не вернулся к своему ходу — пропускает раздачи
                p.away = True
                self.say(f"{p.name} did not come back from the lobby and sits out.")
            elif p.timeouts >= 2 and not p.away:
                p.away = True
                self.say(f"{p.name} missed two turns and sits out.")
            return True
        # Закрыл сайт (ни стола, ни лобби) дольше KICK_AFTER секунд — встаёт из-за стола (в турнире — нет)
        for p in self.players() if not self.mtt else []:
            if p.connections <= 0 and p.offline_since and now - p.offline_since >= KICK_AFTER and not p.leaving:
                self.say(f"{p.name} left the website and leaves the table.")
                p.offline_since = None
                self.leave(p)
                return True
        # Начался или кончился отсчёт докупки — обновить экраны (надпись «rebuying» над именем)
        sig = tuple(p.seat for p in self.players() if self.rebuy_wait(p, now) is not None)
        if sig != self.rebuy_sig:
            self.rebuy_sig = sig
            return True
        if self.auto and not self.running:
            ready = sum(1 for p in self.players() if self.can_play(p))
            if ready < 2:                   # ждём, пока за столом будет хотя бы 2 игрока
                changed = self.next_hand_at is not None
                self.next_hand_at = None
                if self.shuffle is not None:
                    self.drop_shuffle("Shuffle dropped: not enough players.")
                return changed
            if self.next_hand_at is None:   # игроков хватает: раздача после короткой паузы
                self.next_hand_at = now + HAND_BREAK
                return True
            if self.fair and now >= self.next_hand_at - FAIR_LEAD:
                self.step_shuffle(now)      # перемешка идёт в паузе между раздачами, раздачу не задерживает
            if now >= self.next_hand_at:
                if any(self.rebuy_wait(p, now) for p in self.players()):
                    return False            # кто-то докупается — ждём (отсчёт браузеры ведут сами)
                return self.start_hand()
        return False

    # ----- история раздач -----
    def record(self, event):
        if self.hist is not None:
            self.hist["events"].append(event)

    def record_act(self, p, text=None):
        event = {"k": "act", "street": self.street or "preflop", "seat": p.seat, "text": text or p.last,
                 "pot": self.pot(), "stack": p.stack, "fold": (text or p.last).startswith("Fold")}
        self.record(event)
        self.last_act_event = event

    def history_list(self, viewer):
        """Короткий список раздач (новые сверху) — для панели «История»."""
        items = []
        for h in reversed(self.history):
            mine = next((pl for pl in h["players"] if viewer and pl["token"] == viewer.token), None)
            items.append({
                "no": h["no"], "time": h["time"], "pot": h["pot"], "players": len(h["players"]),
                "result": h["result"][:1], "board": h["board"], "board2": h.get("board2", []),
                "my": mine["end"] - mine["stack"] if mine else None,
            })
        return items

    def history_hand(self, no, viewer):
        """Одна раздача целиком. Чужие карты — только если их показали (вскрытие, олл-ин); свои — всегда."""
        h = next((h for h in self.history if h["no"] == no), None)
        if h is None:
            return None
        me = next((pl["seat"] for pl in h["players"] if viewer and pl["token"] == viewer.token), None)
        players = []
        for pl in h["players"]:
            seat = pl["seat"]
            if seat == me:
                cards = h["hole"].get(seat, [])
            elif seat in h["shown"]:
                cards = list(h["shown"][seat])     # показанные (может быть только одна карта)
            else:
                cards = ["back"] * len(h["hole"].get(seat, [])) or ["back", "back"]
            players.append({k: v for k, v in pl.items() if k not in ("token", "pid")} | {
                "cards": cards, "me": seat == me, "shown": seat in h["shown"], "hand": h["hands"].get(seat, ""),
                "winner": seat in h["winners"],
            })
        return {k: v for k, v in h.items() if k not in ("players", "hole", "shown", "hands", "badbeats", "fair")} | {
            "players": players, "proof": self.fair_proof(h, players)}

    # ----- шансы при олл-ине -----
    def calc_equity(self, hands, board, board2=None):
        """Шансы по правилам этого стола (холдем или Омаха). При двух досках — для каждой доски свои:
        (шансы на 1-й доске, шансы на 2-й доске или None). Карты другой доски считаются выбывшими."""
        def one(b, dead):
            return equity(hands, b, dead=dead) if self.game == "nlhe" else equity_omaha(hands, b, dead=dead)
        if board2 is None:
            return one(board, ()), None
        return one(board, board2), one(board2, board)

    def compute_equity(self):
        players = self.active()
        v1, v2 = self.calc_equity([p.cards for p in players], self.board, self.board2 if self.double_board else None)
        self.set_equity({p.seat: v for p, v in zip(players, v1)},
                        {p.seat: v for p, v in zip(players, v2)} if v2 else None)

    def combined_equity(self, seat, default=0):
        """Общий шанс: при двух досках — средний по доскам (половина банка на каждой)."""
        if self.equity is None or seat not in self.equity:
            return default
        if self.equity2:
            return (self.equity[seat] + self.equity2.get(seat, 0)) / 2
        return self.equity[seat]

    def set_equity(self, by_seat, by_seat2=None):
        self.equity = by_seat
        self.equity2 = by_seat2
        self.equity_key = (self.hand_no, len(self.board))
        # Самые большие шансы каждого игрока за весь олл-ин (до флопа, на флопе, на тёрне) — с ними сравним в конце
        if self.allin_equity is None:
            self.allin_equity = {}
        if len(self.board) < 5:
            for seat in by_seat:
                self.allin_equity[seat] = max(self.combined_equity(seat), self.allin_equity.get(seat, 0))

    def equity_need(self):
        """Для какой доски сейчас нужны шансы (или None, если не олл-ин)."""
        return (self.hand_no, len(self.board)) if self.running and self.runout else None

    # ----- что показать конкретному игроку -----
    def view(self, viewer):
        now = time.time()
        show = self.result["show"] if self.result else {}
        if self.runout:                     # олл-ин: карты всех, кто в игре, открыты
            show = {p.seat: p.cards for p in self.active()}
        seats = []
        for p in self.seats:
            if p is None:
                seats.append(None)
                continue
            if p.cards and p is viewer:
                cards = p.cards                     # свои карты
            elif p.cards and p.seat in show:
                cards = list(show[p.seat])          # открытые на вскрытии или показанные (может быть одна из двух)
            elif p.in_hand and not p.folded and p.cards:
                cards = ["back"] * len(p.cards)     # чужие — рубашкой вверх
            else:
                cards = []
            seats.append({
                "name": p.name, "avatar": p.avatar, "stack": p.stack, "bet": p.bet, "last": p.last,
                "bank_pre": math.ceil(p.bank_pre), "bank_post": math.ceil(p.bank_post),
                "in_hand": p.in_hand, "folded": p.folded, "all_in": p.all_in,
                "online": p.connections > 0, "lobby": p.connections > 0 and p.table_conns <= 0, "away": p.away, "bought": p.bought,
                "cards": cards, "hand": (self.result or {}).get("hands", {}).get(p.seat, ""),
                "winner": bool(self.result) and p.seat in self.result["winners"],
                "won": (self.result or {}).get("won", {}).get(p.seat, 0),       # сколько забрал из банков в этой раздаче
                "rebuying": self.rebuy_wait(p, now),     # секунд до конца докупки (None — не докупается)
                "rebuy_in": max(0, p.rebuy_from - now) if p.rebuy_until and p.stack == 0 and now < p.rebuy_from else None,
            })
        you = None
        if viewer:
            you = {"seat": viewer.seat, "away": viewer.away, "options": self.options(viewer), "hand": "",
                   "show_pending": sorted(viewer.show_cards) if self.running else [],
                   "shown": [i for i, c in enumerate((self.result or {}).get("show", {}).get(viewer.seat, [])) if c != "back"]
                            if not self.running else [],
                   "can_show": bool(viewer.cards) and (viewer.in_hand if self.running else bool(self.result))}
            if viewer.in_hand and not viewer.folded and len(self.board) >= 3:
                you["hand"] = self.hand_label(viewer.cards)
        return {
            "type": "state",
            "code": self.code, "running": self.running, "runout": self.runout,
            "next_in": max(0, self.next_hand_at - time.time()) if self.next_hand_at and not self.running else None,
            "hand_no": self.hand_no, "street": self.street, "board": self.board,
            "board2": self.board2 if self.double_board else None, "double_board": self.double_board,
            "pot": self.pot(), "current_bet": self.current_bet,
            "pots": self.pots_on_table() if self.running else [],             # основной и побочные банки в середине
            "sb": self.sb, "bb": self.bb, "ante": self.ante, "min_buyin": self.min_buyin, "max_buyin": self.max_buyin, "buyins": self.buyins,
            "game": self.game, "pot_limit": self.pot_limit, "bomb": self.bomb_bb * self.bb, "hole_count": self.hole_count,
            "dealer": self.dealer, "actor": self.actor,
            "time_left": max(0, self.deadline - time.time()) if self.deadline else None,
            "turn_seconds": getattr(self, "turn_total", self.turn_seconds) if self.deadline else self.turn_seconds,
            "timebank": {"phase": self.timebank, "id": self.timebank_seq, "secs": math.ceil(self.turn_total)}
                        if self.running and self.timebank else None,
            "chip_secs": {"pre": TIMEBANK_PRE, "post": TIMEBANK_POST},
            "seats": seats, "you": you,
            "result": self.result["text"] if self.result else None,
            "refund": self.refund,
            "fair": {"hand": self.shuffle_played.hand, "fp": self.shuffle_played.fingerprint(),
                     "seeds": [{"name": self.shuffle_played.people[s]["name"], "by": self.shuffle_played.by[s]}
                               for s in sorted(self.shuffle_played.people)]} if self.shuffle_played else None,
            "badbeat": self.badbeat if not self.running else None,   # картинку показываем после ривера + 1 с (на вскрытии)
            "ledger": self.ledger_view(),
            # шансы при олл-ине — только если посчитаны для той доски, что сейчас на столе
            "equity": {str(seat): round(v * 100, 3) for seat, v in self.equity.items()}
                      if self.runout and self.equity and self.equity_key == self.equity_need() else None,
            "equity2": {str(seat): round(v * 100, 3) for seat, v in self.equity2.items()}
                       if self.runout and self.equity2 and self.equity_key == self.equity_need() else None,
            "log": self.log[-30:],
        }
