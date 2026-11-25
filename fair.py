"""Честная перемешка: колода зависит от секретов игроков, и после раздачи это можно проверить.

Как идёт одна раздача:
1. Сервер тасует 4 колоды и «запечатывает» каждую карту: hash(соль + карта). Отпечаток всех печатей (root) —
   всем игрокам ДО того, как кто-то прислал свой секрет. Поменять карты после этого нельзя.
2. Каждый браузер придумывает секрет (фраза игрока + случайные байты) и присылает только его отпечаток.
3. Отпечатки видны всем. Кто не ответил — за него секрет делает сервер (тоже отпечаток, тоже заранее).
4. Браузеры присылают сами секреты. Не прислал обещанный — эта перемешка выбрасывается, начинаем новую без него.
5. Из всех секретов вместе получается: какая из 4 колод играет и в каком порядке лежат её карты.
6. После раздачи: 3 лишние колоды открываются целиком (в них честные 52 карты), а в сыгранной — только те карты,
   которые игрок и так видел. Сброшенные карты остаются запечатанными.

Здесь только математика и порядок шагов: ни сети, ни правил покера. Формат описан в README (Provably fair shuffle).
Проверяют раздачу браузер (static/fair.js) и отдельная программа verify_hand.py — они написаны независимо."""
import hashlib
import hmac
import re
import secrets

RANKS = "23456789TJQKA"
SUITS = "shdc"
CARDS = [r + s for r in RANKS for s in SUITS]
DECKS = 4               # сколько колод готовим: одна играет, остальные после раздачи открываются
COMMIT_TIME = 1.5       # сколько секунд ждём отпечатки секретов
REVEAL_TIME = 1.5       # ... и сами секреты
HEX32 = re.compile(r"[0-9a-f]{64}")


def H(tag, *parts):
    """SHA-256 от частей. Перед каждой — её длина: склеить другие части в то же самое нельзя."""
    h = hashlib.sha256()
    for part in (tag, *parts):
        data = part if isinstance(part, bytes) else str(part).encode()
        h.update(len(data).to_bytes(4, "big") + data)
    return h.digest()


def card_salt(key, i):
    return hmac.new(key, i.to_bytes(4, "big"), hashlib.sha256).digest()


def card_commit(salt, card):
    return H("ndp/card", salt, card)


def deck_commits(key, cards):
    return [card_commit(card_salt(key, i), c) for i, c in enumerate(cards)]


def decks_root(sid, commits):
    return H("ndp/root", sid, *[H("ndp/deck", b"".join(c)) for c in commits])


def seed_hash(sid, root, seat, seed):
    return H("ndp/seed", sid, root, seat, seed)


def combine(sid, table, hand, root, seeds):
    """Секреты всех мест (по возрастанию места) -> одно число, которое решает всё."""
    parts = []
    for seat in sorted(seeds):
        parts += [seat, seeds[seat]]
    return H("ndp/combine", sid, table, hand, root, *parts)


def words(combined):
    """Бесконечный поток 32-битных чисел из combined."""
    j = 0
    while True:
        block = H("ndp/stream", combined, j.to_bytes(4, "big"))
        for k in range(0, 32, 4):
            yield int.from_bytes(block[k:k + 4], "big")
        j += 1


def below(stream, n):
    """Число 0..n-1, все одинаково вероятны: «хвост», который не делится поровну, отбрасываем."""
    limit = 2 ** 32 - 2 ** 32 % n
    while True:
        x = next(stream)
        if x < limit:
            return x % n


def permute(combined):
    """(какая колода играет, порядок её карт). order[место в раздаче] = номер карты в запечатанной колоде."""
    stream = words(combined)
    deck = below(stream, DECKS)
    order = list(range(52))
    for i in range(51, 0, -1):
        j = below(stream, i + 1)
        order[i], order[j] = order[j], order[i]
    return deck, order


def hole_positions(seat, hole_count):
    """Карты места лежат в колоде на постоянных местах — кто сидит рядом, на них не влияет."""
    return [seat * hole_count + k for k in range(hole_count)]


def board_positions(seats, hole_count, double):
    """Где в колоде доски: после карт ВСЕХ мест (и пустых). Перед каждой улицей одна карта сжигается."""
    pos, boards = seats * hole_count, ([], [])
    for count in (3, 1, 1):
        pos += 1                                # сожжённая
        for b in boards[:2 if double else 1]:
            b += range(pos, pos + count)
            pos += count
    return boards


class Shuffle:
    """Одна перемешка: commit -> reveal -> ready (или aborted)."""

    def __init__(self, table, hand, people, now, rand=secrets.token_bytes, excluded=()):
        """people: {место: {"token", "name", "online"}}. excluded — токены тех, за кого секрет сделает сервер."""
        self.table, self.hand, self.rand = table, hand, rand
        self.id = rand(16)
        self.people = people
        self.waiting = {seat for seat, p in people.items() if p["online"] and p["token"] not in excluded}
        self.keys = [rand(32) for _ in range(DECKS)]
        self.decks = [self.random_deck() for _ in range(DECKS)]
        commits = [deck_commits(k, d) for k, d in zip(self.keys, self.decks)]
        self.root = decks_root(self.id, commits)
        self.hashes, self.seeds, self.by = {}, {}, {}
        self.phase = "commit"
        self.deadline = now + COMMIT_TIME
        self.combined = self.deck = self.order = None

    def random_deck(self):
        """Колода на сервере тасуется тем же способом, что и вся перемешка, — от случайных байтов системы."""
        _, order = permute(self.rand(32))
        return [CARDS[i] for i in order]

    def belongs(self, seat, token):
        return seat in self.people and secrets.compare_digest(self.people[seat]["token"], token)

    def commit(self, seat, token, value):
        """Отпечаток секрета игрока. Первый ответ засчитывается, второй (другая вкладка) — нет."""
        if (self.phase != "commit" or seat not in self.waiting or seat in self.hashes
                or not self.belongs(seat, token) or not isinstance(value, str) or not HEX32.fullmatch(value)):
            return False
        self.hashes[seat] = bytes.fromhex(value)
        self.by[seat] = "player"
        return True

    def reveal(self, seat, token, value):
        """Сам секрет: принимаем, только если он подходит к отпечатку."""
        if (self.phase != "reveal" or self.by.get(seat) != "player" or seat in self.seeds
                or not self.belongs(seat, token) or not isinstance(value, str) or not HEX32.fullmatch(value)):
            return False
        seed = bytes.fromhex(value)
        if not hmac.compare_digest(seed_hash(self.id, self.root, seat, seed), self.hashes[seat]):
            return False
        self.seeds[seat] = seed
        return True

    def step(self, now):
        """Пора ли дальше: все ответили или время вышло. Возвращает новую фазу или None."""
        late = now >= self.deadline
        if self.phase == "commit" and (late or self.waiting <= set(self.hashes)):
            for seat in self.people:
                if seat not in self.hashes:         # не ответил — секрет делает сервер, и он уже не поменяется
                    self.seeds[seat] = self.rand(32)
                    self.hashes[seat] = seed_hash(self.id, self.root, seat, self.seeds[seat])
                    self.by[seat] = "server"
            self.phase, self.deadline = "reveal", now + REVEAL_TIME
            return "reveal"
        if self.phase == "reveal":
            if set(self.seeds) == set(self.people):
                self.combined = combine(self.id, self.table, self.hand, self.root, self.seeds)
                self.deck, self.order = permute(self.combined)
                self.phase = "ready"
                return "ready"
            if late:
                self.phase = "aborted"
                return "aborted"
        return None

    def silent(self):
        """Кто обещал секрет и не прислал."""
        return [s for s in sorted(self.people) if s not in self.seeds]

    def cards(self):
        """Колода в порядке раздачи (место 0 — первая карта)."""
        return [self.decks[self.deck][i] for i in self.order]

    # ---------- что видят браузеры ----------
    def note(self):
        """Сообщение о текущем шаге — одинаковое для всех за столом."""
        data = {"type": "fair", "phase": self.phase, "id": self.id.hex(), "root": self.root.hex(), "hand": self.hand}
        if self.phase in ("reveal", "ready"):
            data["hashes"] = {str(s): {"hash": h.hex(), "by": self.by[s]} for s, h in sorted(self.hashes.items())}
        if self.phase == "ready":
            data["seeds"] = {str(s): v.hex() for s, v in sorted(self.seeds.items())}
            data["fp"] = self.fingerprint()
        return data

    def fingerprint(self):
        """Короткий отпечаток перемешки: его можно сверить вслух."""
        return self.combined.hex()[:8]

    def proof(self, positions):
        """Доказательство после раздачи. positions — какие места колоды этому зрителю можно открыть."""
        decks = []
        for d in range(DECKS):
            if d == self.deck:
                decks.append({"commits": [c.hex() for c in deck_commits(self.keys[d], self.decks[d])]})
            else:
                decks.append({"key": self.keys[d].hex(), "cards": self.decks[d]})
        return {
            "v": 1, "id": self.id.hex(), "table": self.table, "hand": self.hand, "root": self.root.hex(),
            "seeds": [{"seat": s, "name": self.people[s]["name"], "by": self.by[s], "hash": self.hashes[s].hex(),
                       "seed": self.seeds[s].hex()} for s in sorted(self.people)],
            "fp": self.fingerprint(), "deck": self.deck, "decks": decks,
            "open": [{"pos": p, "card": self.decks[self.deck][self.order[p]],
                      "salt": card_salt(self.keys[self.deck], self.order[p]).hex()} for p in sorted(positions)],
        }
