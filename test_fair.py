"""Проверки честной перемешки: секреты игроков, порядок шагов, доказательства, что ничего лишнего не открывается.
Запуск: .venv/bin/python test_fair.py   (его же запускает test_engine.py)"""
import copy
import hashlib
import json
import os
import random
import shutil
import subprocess
import time

import engine
import fair
import verify_hand
from engine import Table

# Образцы: эти же числа считают fair.py, verify_hand.py и static/fair.js. Поменялись — значит, поменялся протокол.
VECTOR = {
    "combined": "07c703ba75b969e3b7286c0c7a85e55d86eca4b0e2435bc3267b1faa1e8b76c6",
    "deck": 0, "order": [46, 9, 10, 51, 43, 15, 6, 41],
}


def counter_bytes(tag):
    """Предсказуемые «случайные» байты: тесты повторяются."""
    n = 0

    def rand(size):
        nonlocal n
        n += 1
        return hashlib.sha256(f"{tag}:{n}".encode()).digest()[:size]
    return rand


def people(n, online=True):
    return {s: {"token": f"tok{s}", "name": f"P{s}", "online": online} for s in range(n)}


class Browser:
    """Браузер игрока: секрет и отпечаток, как в static/fair.js."""
    def __init__(self, seat, token, phrase="lucky"):
        self.seat, self.token, self.phrase = seat, token, phrase

    def commit(self, note):
        self.seed = fair.H("ndp/phrase", self.phrase, os.urandom(32))
        return fair.seed_hash(bytes.fromhex(note["id"]), bytes.fromhex(note["root"]), self.seat, self.seed).hex()


def complete(s, now=0.0):
    """Все присылают отпечатки, потом секреты."""
    bs = {seat: Browser(seat, p["token"]) for seat, p in s.people.items()}
    for seat, b in bs.items():
        assert s.commit(seat, b.token, b.commit(s.note()))
    assert s.step(now) == "reveal"
    for seat, b in bs.items():
        assert s.reveal(seat, b.token, b.seed.hex())
    assert s.step(now) == "ready"
    return bs


def check_permutation():
    for i in range(300):
        deck, order = fair.permute(os.urandom(32))
        assert sorted(order) == list(range(52)) and 0 <= deck < fair.DECKS
    # хи-квадрат: куда попадает каждая карта и какая колода выбирается
    n = 4000
    where = [[0] * 52 for _ in range(52)]
    decks = [0] * fair.DECKS
    for i in range(n):
        deck, order = fair.permute(hashlib.sha256(b"chi%d" % i).digest())
        decks[deck] += 1
        for pos, card in enumerate(order):
            where[pos][card] += 1
    chi = sum((x - n / 52) ** 2 / (n / 52) for row in where for x in row)
    assert 2300 < chi < 2900, chi                    # в среднем 51·51 = 2601, разброс ±72
    assert sum((x - n / 4) ** 2 / (n / 4) for x in decks) < 20, decks
    # «хвост» отбрасывается: слишком большие числа не дают перекоса
    top = 2 ** 32 - 2 ** 32 % 52
    assert fair.below(iter([top, 2 ** 32 - 1, 5]), 52) == 5
    # любой вход меняет результат
    base = (b"i" * 16, "1", 7, b"r" * 32, {0: b"a" * 32, 3: b"b" * 32})
    got = {fair.combine(*base)}
    for k, v in ((0, b"j" * 16), (1, "2"), (2, 8), (3, b"s" * 32), (4, {0: b"a" * 32, 3: b"c" * 32}),
                 (4, {0: b"a" * 32, 4: b"b" * 32}), (4, {0: b"a" * 32}), (4, {0: b"b" * 32, 3: b"a" * 32})):
        got.add(fair.combine(*[v if i == k else x for i, x in enumerate(base)]))
    assert len(got) == 9
    assert fair.combine(*base[:4], {3: b"b" * 32, 0: b"a" * 32}) == fair.combine(*base)      # порядок — по местам
    assert fair.H("a", "bc") != fair.H("ab", "c")
    print("перемешка: все порядки равновероятны, зависит от каждого секрета")


def check_phases():
    s = fair.Shuffle("1", 5, people(3), 0.0)
    complete(s)
    assert sorted(s.cards()) == sorted(fair.CARDS) and len(s.fingerprint()) == 8
    # никто не ответил: все секреты делает сервер, и раздача всё равно идёт
    s = fair.Shuffle("1", 5, people(3), 0.0)
    assert s.step(1.4) is None and s.step(1.5) == "reveal" and s.step(1.5) == "ready"
    assert set(s.by.values()) == {"server"}
    s = fair.Shuffle("1", 5, people(2, online=False), 0.0)      # никого нет за столом — не ждём
    assert s.step(0.0) == "reveal" and s.step(0.0) == "ready"
    # часть ответила: не ответивший получает секрет сервера, зафиксированный ДО раскрытия
    s = fair.Shuffle("1", 5, people(2), 0.0)
    b = Browser(0, "tok0")
    assert s.commit(0, "tok0", b.commit(s.note()))
    assert s.step(0.1) is None and s.step(2.0) == "reveal" and s.by == {0: "player", 1: "server"}
    fixed = s.hashes[1]
    note = s.note()
    assert note["hashes"]["1"] == {"hash": fixed.hex(), "by": "server"} and "seeds" not in note
    assert s.seeds[1].hex() not in json.dumps(note)             # сам секрет сервера пока не видно
    assert s.reveal(0, "tok0", b.seed.hex()) and s.step(2.1) == "ready"
    assert fair.seed_hash(s.id, s.root, 1, s.seeds[1]) == fixed
    # плохие сообщения не засчитываются
    s = fair.Shuffle("1", 5, people(2), 0.0)
    b = Browser(0, "tok0")
    good = b.commit(s.note())
    for bad in (None, 5, "", "zz" * 32, good[:-1], good + "0", good.upper() if good.upper() != good else "x", [good], {"a": 1}):
        assert not s.commit(0, "tok0", bad), bad
    assert not s.commit(0, "tok1", good) and not s.commit(5, "tok0", good)      # чужой токен, чужое место
    assert not s.reveal(0, "tok0", b.seed.hex())                                # рано
    assert s.commit(0, "tok0", good) and not s.commit(0, "tok0", "11" * 32)     # вторая вкладка — нет
    b1 = Browser(1, "tok1")
    assert s.commit(1, "tok1", b1.commit(s.note())) and s.step(0.2) == "reveal"
    assert not s.commit(1, "tok1", "22" * 32)                                   # поздно
    assert not s.reveal(0, "tok0", "33" * 32) and not s.reveal(0, "tok1", b.seed.hex())
    assert not s.reveal(1, "tok1", b.seed.hex())                                # чужой секрет
    assert s.reveal(0, "tok0", b.seed.hex()) and not s.reveal(0, "tok0", b.seed.hex())
    # второй секрет не пришёл — перемешка выброшена, виноват только он
    assert s.step(1.0) is None and s.step(1.8) == "aborted" and s.silent() == [1]
    again = fair.Shuffle("1", 5, people(2), 2.0, excluded={"tok1"})
    b = Browser(0, "tok0")
    assert again.root != s.root and not again.commit(1, "tok1", "44" * 32)
    assert again.commit(0, "tok0", b.commit(again.note())) and again.step(2.0) == "reveal"
    assert again.reveal(0, "tok0", b.seed.hex()) and again.step(2.0) == "ready" and again.by[1] == "server"
    print("шаги: ответили все, не ответил никто, обещал и не прислал, лишние сообщения — OK")


def check_layout():
    for game, h, double in (("nlhe", 2, False), ("plo4", 4, False), ("plo5", 5, False), ("plo5", 5, True)):
        for seats in (2, 7):
            used = [p for s in range(seats) for p in fair.hole_positions(s, h)]
            boards = fair.board_positions(seats, h, double)
            used += boards[0] + boards[1]
            assert len(boards[0]) == 5 and len(boards[1]) == (5 if double else 0)
            assert len(set(used)) == len(used) and max(used) < 52, (game, seats)
    print("места карт в колоде не пересекаются и помещаются")


def fair_table(n, game="nlhe", bomb_bb=0, double_board=False, stacks=None):
    t = Table("7", small_blind=5, big_blind=10, min_buyin=10, max_buyin=100_000, game=game, bomb_bb=bomb_bb,
              double_board=double_board)
    t.fair = True
    for i in range(n):
        p, err = t.add_player(f"tok{i}", f"P{i}", 1000)
        assert not err
        p.connections = p.table_conns = 1
        if stacks:
            p.stack = stacks[i]
    return t


def browsers(t, skip_commit=(), skip_reveal=()):
    """Ответить на все шаги перемешки за игроков. Возвращает записки, которые получили браузеры."""
    seen, mine = [], {}
    while t.fair_notes:
        note = t.fair_notes.pop(0)
        seen.append(note)
        for p in t.players():
            if note["phase"] == "commit" and p.seat not in skip_commit:
                mine[note["id"], p.seat] = b = Browser(p.seat, p.token)
                t.seed_message(p, "seed_commit", note["id"], b.commit(note))
            if note["phase"] == "reveal" and p.seat not in skip_reveal and (note["id"], p.seat) in mine:
                t.seed_message(p, "seed_reveal", note["id"], mine[note["id"], p.seat].seed.hex())
    return seen


def deal(t, **kw):
    """Пауза между раздачами прошла: перемешка и новая раздача."""
    t.next_hand_at = time.time() + engine.FAIR_LEAD - 0.1
    t.tick()
    assert t.shuffle is not None and not t.running
    notes = browsers(t, **kw)
    t.next_hand_at = 0
    t.tick()
    notes += browsers(t, **kw)
    return notes


def play_out(t, rnd, spy=None):
    steps = 0
    while t.running:
        steps += 1
        assert steps < 300
        if spy:
            spy()
        if t.street_end_at is not None:
            t.street_end_at = 0
            t.tick()
        elif t.runout:
            t.next_street_at = 0
            t.tick()
        else:
            p = t.seats[t.actor]
            o = t.options(p)
            a = rnd.choice(["fold", "check" if o["check"] else "call", "check" if o["check"] else "call"] + (["raise", "allin"] if o["raise"] else []))
            assert t.act(p, a, rnd.randint(o["min_to"], o["max_to"]) if a == "raise" else 0) is None


def proof_of(t, no, viewer):
    """Доказательство так, как его получит браузер: через JSON."""
    return json.loads(json.dumps(t.history_hand(no, viewer)))["proof"]


def passed(proof):
    res = verify_hand.verify(proof)
    return not any(ok is False for _, ok, _ in res), res


def check_table():
    """Целые раздачи: доказательство сходится у каждого, открыто ровно то, что он видел, фишки на месте."""
    rnd = random.Random(8)
    for game, kw in (("nlhe", {}), ("plo4", {}), ("plo5", {"bomb_bb": 5}), ("plo5", {"bomb_bb": 5, "double_board": True})):
        opened_some = folded_some = 0
        for g in range(40):
            n = rnd.randint(2, 7)
            t = fair_table(n, game=game, stacks=[rnd.choice([30, 100, 400, 1000]) for _ in range(n)], **kw)
            total = sum(p.stack for p in t.players())
            for _ in range(3):
                if sum(p.stack > 0 for p in t.players()) < 2:
                    break
                notes = deal(t)
                assert t.running or t.history, "раздача началась"
                s = t.shuffle_played
                keys = [k.hex() for k in s.keys]
                for note in notes:
                    assert not any(k in json.dumps(note) for k in keys)
                assert [x["phase"] for x in notes] == ["commit", "reveal", "ready"]

                def spy():           # пока раздача идёт, печати и ключи не уходят никому
                    for p in [None] + t.players():
                        text = json.dumps(t.view(p))
                        assert not any(k in text for k in keys) and "salt" not in text
                        assert t.history_hand(t.hand_no, p) is None
                play_out(t, rnd, spy if g < 4 else None)
                assert sum(p.stack for p in t.players()) == total, "фишки потерялись"
                h = t.history[-1]
                if rnd.random() < .4:       # показал карту после раздачи — её тоже можно проверить
                    p = rnd.choice([p for p in t.players() if p.cards])
                    t.show(p, rnd.randrange(len(p.cards)))
                for viewer in [None] + t.players():
                    hand = t.history_hand(h["no"], viewer)
                    proof = proof_of(t, h["no"], viewer)
                    good, res = passed(proof)
                    assert good, res
                    may = set()             # что этот зритель видит на экране
                    for pl in hand["players"]:
                        may |= {fair.hole_positions(pl["seat"], t.hole_count)[k] for k, c in enumerate(pl["cards"]) if c != "back"}
                        folded_some += "back" in pl["cards"]
                    for at, b in zip(fair.board_positions(len(t.seats), t.hole_count, t.double_board), (h["board"], h["board2"])):
                        may |= set(at[:len(b)])
                    assert {o["pos"] for o in proof["open"]} == may
                    opened_some += len(may)
                    text = json.dumps(proof)
                    assert s.keys[s.deck].hex() not in text, "ключ сыгранной колоды"
                    hidden = [c for pl in hand["players"] for c in h["hole"][pl["seat"]] if c not in {o["card"] for o in proof["open"]}]
                    for c in hidden:        # закрытая карта встречается только в лишних колодах
                        assert f'"card": "{c}"' not in text
                    assert "tok" not in text
        assert opened_some and folded_some
    print("раздачи на честных столах: доказательства сходятся, лишних карт не открыто, фишки на месте")


def check_no_shift():
    """Кто-то встал или сел после перемешки — чужие карты и доска не меняются."""
    boards, holes = set(), set()
    for who_left in (None, 3, 4):
        t = fair_table(5)
        s = fair.Shuffle("7", 1, people(5, online=False), 0.0, rand=counter_bytes("same"))
        assert s.step(0) == "reveal" and s.step(0) == "ready"
        t.shuffle = s
        if who_left is not None:
            t.seats[who_left].away = True
        assert t.start_hand()
        holes.add(tuple(t.seats[0].cards))
        for _ in range(3):
            t.runout = True
            t.end_street()
        boards.add(tuple(t.board))
    assert len(boards) == 1 and len(holes) == 1
    print("места карт постоянные: встал или сел — доска та же")


def check_table_steps():
    # без перемешки честный стол не раздаёт
    t = fair_table(2)
    assert not t.start_hand() and t.hand_no == 0
    # перемешка начинается не раньше, чем за FAIR_LEAD секунд
    t.next_hand_at = time.time() + engine.FAIR_LEAD + 1
    t.tick()
    assert t.shuffle is None
    # обещал секрет и не прислал: мешаем заново без него, это видно всем и в доказательстве
    t = fair_table(3)
    t.next_hand_at = time.time() + 2
    t.tick()
    browsers(t, skip_reveal={1})
    assert t.shuffle.phase == "reveal"
    t.shuffle.deadline = 0
    t.next_hand_at = 0
    t.tick()
    assert not t.running and t.shuffle.phase == "commit" and t.fair_silent == {"tok1"}
    notes = browsers(t)
    dropped = next(x for x in notes if x["phase"] == "aborted")
    assert dropped["seats"] == [1] and dropped["reason"] == "Reshuffle: no seed from P1." and dropped["reason"] in t.log
    assert t.shuffle.phase == "ready" and t.shuffle.by == {0: "player", 1: "server", 2: "player"}
    assert t.tick() and t.running and not t.fair_silent
    play_out(t, random.Random(1))
    proof = proof_of(t, 1, t.seats[0])
    assert passed(proof)[0] and [a["id"] for a in proof["aborted"]] == [dropped["id"]]
    deal(t)                                        # следующая раздача — снова с ним и без старых записей
    assert t.shuffle_played.by[1] == "player" and t.hist["fair"]["aborted"] == []
    # сел после начала перемешки: карты получит, секрет — со следующей раздачи
    t = fair_table(2)
    t.next_hand_at = time.time() + 2
    t.tick()
    late, _ = t.add_player("tokL", "Late", 1000)
    late.connections = late.table_conns = 1
    notes = browsers(t)
    t.next_hand_at = 0
    assert t.tick() and t.running and late.cards and late.seat not in t.shuffle_played.by
    play_out(t, random.Random(2))
    good, res = passed(proof_of(t, 1, late))
    assert good, res
    # встал посреди перемешки, остался один: перемешка не пропадает молча
    t = fair_table(2)
    t.next_hand_at = time.time() + 2
    t.tick()
    t.leave(t.seats[1])
    t.tick()
    assert t.shuffle is None and t.fair_aborted[0]["reason"] == "Shuffle dropped: not enough players."
    # на его место сел другой: чужим токеном секрет не прислать
    t = fair_table(2)
    t.next_hand_at = time.time() + 2
    t.tick()
    sid = t.shuffle.id.hex()
    t.leave(t.seats[1])
    other, _ = t.add_player("tokX", "New", 1000)
    assert other.seat == 1 and not t.seed_message(other, "seed_commit", sid, "11" * 32)
    for bad in (None, 5, "", "00" * 16, ["x"]):
        assert not t.seed_message(t.seats[0], "seed_commit", bad, "11" * 32)
    assert not t.seed_message(t.seats[0], "seed_reveal", sid, "11" * 32)
    # в лобби — не ждём
    t = fair_table(2)
    t.seats[1].table_conns = 0
    t.next_hand_at = time.time() + 2
    t.tick()
    browsers(t, skip_commit={1})
    assert t.shuffle.phase == "ready" and t.shuffle.by == {0: "player", 1: "server"}
    # докупка: готовая перемешка ждёт вместе со столом и остаётся той же
    t.seats[0].stack = 0
    t.seats[0].rebuy_from, t.seats[0].rebuy_until = 0, time.time() + 5
    s = t.shuffle
    t.add_player("tok3", "P3", 1000)
    t.next_hand_at = 0
    t.tick()
    assert not t.running and t.shuffle is s
    # обычный стол и турнир — как раньше
    t = fair_table(2)
    t.fair = False
    assert t.start_hand() and t.shuffle is None and t.view(None)["fair"] is None
    print("стол: задержек нет, не прислал — мешаем заново, поздно сел, встал, лобби, докупка — OK")


def sample_proof():
    rnd = random.Random(4)
    while True:
        t = fair_table(3)
        deal(t)
        play_out(t, rnd)
        h = t.history[-1]
        if len(h["board"]) == 5 and any(pl["seat"] not in h["shown"] for pl in h["players"]):
            return proof_of(t, 1, t.seats[0])


def check_tampering():
    """Любая подмена в доказательстве замечена (Python и JS)."""
    proof = sample_proof()
    proof["witness"] = {"root": proof["root"], "hashes": {str(s["seat"]): s["hash"] for s in proof["seeds"]}}
    good, res = passed(proof)
    assert good and not any(ok is None for _, ok, _ in res), res
    flip = lambda h: ("0" if h[0] != "0" else "1") + h[1:]      # noqa: E731
    played, spare = proof["deck"], (proof["deck"] + 1) % 4

    def edit(f):
        p = copy.deepcopy(proof)
        f(p)
        return p
    bad = {
        "root": lambda p: p.update(root=flip(p["root"])),
        "id": lambda p: p.update(id=flip(p["id"])),
        "table": lambda p: p.update(table="8"),
        "hand": lambda p: p.update(hand=2),
        "fp": lambda p: p.update(fp=flip(p["fp"])),
        "deck": lambda p: p.update(deck=spare),
        "seed": lambda p: p["seeds"][0].update(seed=flip(p["seeds"][0]["seed"])),
        "hash": lambda p: p["seeds"][0].update(hash=flip(p["seeds"][0]["hash"])),
        "seed dropped": lambda p: p["seeds"].pop(),
        "seed added": lambda p: p["seeds"].append({**p["seeds"][0], "seat": 6}),
        "seats swapped": lambda p: (p["seeds"][0].update(seat=1), p["seeds"][1].update(seat=0)),
        "board card": lambda p: p["seen"]["board"].reverse(),
        "hole card": lambda p: p["seen"]["hole"]["0"].reverse(),
        "opened card": lambda p: p["open"][0].update(card=p["open"][1]["card"]),
        "salt": lambda p: p["open"][0].update(salt=flip(p["open"][0]["salt"])),
        "card hidden": lambda p: p["open"].pop(),
        "card twice": lambda p: p["open"].append(p["open"][0]),
        "commit": lambda p: p["decks"][played]["commits"].reverse(),
        "commit cut": lambda p: p["decks"][played]["commits"].pop(),
        "unused card": lambda p: p["decks"][spare]["cards"].__setitem__(0, p["decks"][spare]["cards"][1]),
        "unused order": lambda p: p["decks"][spare]["cards"].reverse(),
        "unused key": lambda p: p["decks"][spare].update(key=flip(p["decks"][spare]["key"])),
        "decks swapped": lambda p: p["decks"].reverse(),
        "witness root": lambda p: p["witness"].update(root=flip(p["witness"]["root"])),
        "witness hash": lambda p: p["witness"]["hashes"].update({"0": flip(p["witness"]["hashes"]["0"])}),
        "version": lambda p: p.update(v=2),
        "seats count": lambda p: p["seen"].update(seats=6),
    }
    for name, f in bad.items():
        assert not passed(edit(f))[0], name
    # сервер подсунул колоду с лишними тузами: если она не сыграла — её откроют и увидят
    caught = 0
    for i in range(60):
        s = fair.Shuffle("7", 1, people(2), 0.0, rand=counter_bytes(f"rig{i}"))
        s.decks[0] = ["As"] * 4 + s.decks[0][4:]
        s.root = fair.decks_root(s.id, [fair.deck_commits(k, d) for k, d in zip(s.keys, s.decks)])
        complete(s)
        p = s.proof([]) | {"aborted": [], "seen": {"seats": 7, "hole_count": 2, "double_board": False, "board": [], "board2": [], "hole": {}}}
        caught += not passed(p)[0]
    assert 33 <= caught <= 57, caught               # около 3 из 4
    check_browser(proof, bad, edit)
    print(f"подмены: замечены все {len(bad)}; подсунутая колода поймана в {caught} случаях из 60")


NODE = r"""
const Fair = require(process.argv[1]);
const lines = require("fs").readFileSync(0, "utf8");
(async () => {
  const { vector, cases } = JSON.parse(lines);
  const out = { seed: Fair.hex(await Fair.makeSeed(vector.phrase, Fair.unhex(vector.nonce))) };
  out.hash = await Fair.seedHash(vector.id, vector.root, vector.seat, Fair.unhex(out.seed));
  out.combined = Fair.hex(await Fair.combine({ id: vector.id, root: vector.root, table: vector.table, hand: vector.hand,
    seeds: [{ seat: vector.seat, seed: out.seed }, { seat: vector.seat + 1, seed: out.hash }] }));
  out.perm = await Fair.permute(Fair.unhex(out.combined));
  out.cases = {};
  for (const [name, c] of Object.entries(cases)) {
    let bad;
    try { bad = (await Fair.verify(c.proof, c.rec)).some((x) => x.ok === false); } catch (e) { bad = true; }
    out.cases[name] = bad;
  }
  console.log(JSON.stringify(out));
})();
"""


def check_browser(proof, bad, edit):
    """static/fair.js считает то же самое, что fair.py, и замечает те же подмены (если на компьютере есть Node)."""
    node = shutil.which("node")
    if not node:
        print("  (Node не найден — static/fair.js здесь не проверен)")
        return
    vector = {"phrase": "Чёрный ♠ туз", "nonce": "07" * 32, "id": "ab" * 16, "root": "cd" * 32, "seat": 3, "table": "7", "hand": 41}

    def case(p):
        w = p.pop("witness")
        return {"proof": p, "rec": {"root": w["root"], "hashes": {
            s: {"hash": h, "by": next((x["by"] for x in p["seeds"] if str(x["seat"]) == s), "player")} for s, h in w["hashes"].items()}}}
    cases = {"good": case(copy.deepcopy(proof))} | {name: case(edit(f)) for name, f in bad.items()}
    run = subprocess.run([node, "-e", NODE, os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "fair.js")],
                         input=json.dumps({"vector": vector, "cases": cases}).encode(), capture_output=True, timeout=120)
    assert run.returncode == 0, run.stderr.decode(errors="replace")
    out = json.loads(run.stdout)
    sid, root = bytes.fromhex(vector["id"]), bytes.fromhex(vector["root"])
    seed = fair.H("ndp/phrase", vector["phrase"], bytes.fromhex(vector["nonce"]))
    h = fair.seed_hash(sid, root, 3, seed)
    combined = fair.combine(sid, "7", 41, root, {3: seed, 4: h})
    assert (out["seed"], out["hash"], out["combined"]) == (seed.hex(), h.hex(), combined.hex())
    assert out["perm"] == [fair.permute(combined)[0], fair.permute(combined)[1]]
    assert not out["cases"].pop("good")
    assert all(out["cases"].values()), [k for k, v in out["cases"].items() if not v]


def check_vector():
    """Протокол не поменялся нечаянно: старые скачанные доказательства должны сходиться и потом."""
    seed = fair.H("ndp/phrase", "lucky", bytes(32))
    h = fair.seed_hash(bytes(16), bytes(32), 2, seed)
    combined = fair.combine(bytes(16), "1", 1, bytes(32), {2: seed, 5: h})
    deck, order = fair.permute(combined)
    assert combined.hex() == VECTOR["combined"], combined.hex()
    assert (deck, order[:8]) == (VECTOR["deck"], VECTOR["order"]), (deck, order[:8])
    assert (verify_hand.shuffle_from(combined)) == (deck, order)
    print("образцы протокола: OK")


def main():
    pause, engine.STREET_PAUSE = engine.STREET_PAUSE, 0
    banks = engine.TIMEBANK_PRE, engine.TIMEBANK_POST
    engine.TIMEBANK_PRE = engine.TIMEBANK_POST = 0
    try:
        check_vector()
        check_permutation()
        check_phases()
        check_layout()
        check_table()
        check_no_shift()
        check_table_steps()
        check_tampering()
    finally:
        engine.STREET_PAUSE = pause
        engine.TIMEBANK_PRE, engine.TIMEBANK_POST = banks
    print("честная перемешка ok")


if __name__ == "__main__":
    main()
