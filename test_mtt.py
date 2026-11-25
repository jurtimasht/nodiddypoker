"""Проверки турнира (MTT): турниры ботов от начала до конца.
Запуск: .venv/bin/python test_mtt.py   (его же запускает test_engine.py)

Время «перематываем»: директору передаём своё now, а у столов обнуляем паузы (как в fuzz).
После КАЖДОГО такта проверяем: фишки сходятся, никто не сидит за двумя столами, на столе не больше мест,
пересадки только со стола без раздачи, столы ровные (разница ≤ 1, когда пересадка возможна)."""
import random

import engine
from tournament import Director, default_config


def run(director, rnd, limit=200_000, check_balance=True, on_tick=None):
    """Доиграть турнир. Возвращает число тактов."""
    now = 0.0
    steps = 0
    seen_running = {}
    while director.status in ("running", "paused"):
        steps += 1
        assert steps < limit, "турнир не заканчивается"
        now += 1.0
        was_idle = {c: (not t.running and t.next_hand_at is not None) for c, t in director.tables.items()}
        director.moves.clear()
        director.tick(now)
        # пересадка со стола, где идёт раздача, невозможна: Table.take_out() падает с assert (проверено ниже отдельно)
        check(director, check_balance)
        for code, t in list(director.tables.items()):
            if t.running:
                if t.street_end_at is not None:
                    t.street_end_at = 0
                if t.runout and t.next_street_at is not None:
                    t.next_street_at = 0
            elif was_idle.get(code) and t.next_hand_at is not None:
                t.next_hand_at = 0                  # пауза между раздачами прошла (директор уже убрал вылетевших)
            t.tick()
        check(director, False)                     # баланс проверяем только сразу после директора
        if on_tick:
            on_tick(director, now)
    return steps


def check(d, check_balance=True):
    assert d.chips_in_play() == d.chips_total(), ("фишки не сходятся", d.chips_in_play(), d.chips_total())
    where = {}
    for code, t in d.tables.items():
        assert len(t.players()) <= len(t.seats)
        for p in t.players():
            assert id(p) not in where, f"{p.name} сидит за двумя столами"
            where[id(p)] = code
            assert p.stack >= 0
    for e in d.alive():
        assert where.get(id(e.player)) == e.table, f"{e.name}: не там, где думает директор"
    if check_balance and d.status == "running":
        open_t = [t for c, t in d.tables.items() if c not in d.closing]
        idle = [t for t in open_t if not t.running]
        if len(open_t) > 1 and idle:
            counts = [len(t.players()) for t in open_t]
            # стол без раздачи никогда не больше самого маленького на 2+ (иначе его бы уже разгрузили)
            assert all(len(t.players()) - min(counts) <= 1 for t in idle), counts
        if len(d.alive()) <= d.cfg["seats"] and not d.closing:
            assert len(d.tables) == 1, "живых на один стол, а столов больше"


def bots_tournament(n, seats, seed, levels_fast=True, game="nlhe", stack=1000):
    rnd = random.Random(seed)
    cfg = default_config(stack=stack, seats=seats, level_seconds=40 if levels_fast else 400, test=True, game=game,
                         turn_seconds=15)
    d = Director(seed, "Test", cfg, rnd=rnd, bot_delay=(0, 0))
    assert d.add_bots(n) is None
    assert d.start(0.0) is None
    total = n * stack
    assert d.chips_in_play() == total
    n_tables = len(d.tables)
    assert n_tables == -(-n // seats)
    sizes = sorted(len(t.players()) for t in d.tables.values())
    assert sizes[-1] - sizes[0] <= 1, sizes                   # рассадка ровная
    steps = run(d, rnd)
    assert d.status == "finished"
    alive = d.alive()
    assert len(alive) == 1 and alive[0].player.stack == total, "у победителя все фишки"
    res = d.results()
    places = sorted(r["place"] for r in res)
    assert places[0] == 1 and places.count(1) == 1
    # места 1..n без дыр; при одновременном вылете с равными фишками место делят (следующее пропускается)
    assert len(places) == n, places
    for i, pl in enumerate(places):
        assert pl == i + 1 or (i and pl == places[i - 1]), places
    assert all(r["points"] == 0 and r["trophy"] == 0 for r in res), "пробный турнир — без очков"
    return d, steps


def check_basic_seating():
    d, _ = bots_tournament(7, 4, seed=1)
    print("турнир 7 ботов, 4 места: победитель", d.alive()[0].name)


def check_many():
    rnd = random.Random(2)
    for i in range(20):
        n = rnd.randint(2, 20)
        seats = rnd.randint(2, 7)
        bots_tournament(n, seats, seed=100 + i, game=rnd.choice(["nlhe", "nlhe", "plo4"]))
    print("20 турниров ботов (2–20 игроков, 2–7 мест): фишки сходятся, места выданы")


def check_points_and_ties():
    cfg = default_config(stack=1000, seats=3, level_seconds=40, test=False)
    d = Director(7, "Real", cfg, rnd=random.Random(7), bot_delay=(0, 0))
    d.cfg["test"] = True; d.add_bots(5); d.cfg["test"] = False     # боты как «люди» для проверки очков
    for i, e in enumerate(d.entries):
        e.bot, e.pid, e.name = False, 1000 + i, f"P{i}"
    for e in d.entries:
        e.bot = True                                              # ходит за них всё равно бот-логика
    d.start(0.0)
    for e in d.entries:
        e.player.bot = True
    run(d, random.Random(7))
    res = d.results()
    by_place = {r["place"]: r for r in res}
    assert by_place[1]["points"] == 10 and by_place[1]["trophy"] == 1
    for r in res:
        expect = [10, 6, 4, 2, 1][r["place"] - 1] if r["place"] <= 5 else 0
        assert r["points"] == expect, r
    print("очки 10/6/4/2/1 и кубок первому")


def check_same_hand_bust():
    """Двое вылетели в одной раздаче: выше тот, у кого было больше фишек на начало; поровну — делят место."""
    d = Director(9, "Ties", default_config(stack=1000, seats=7, test=True), rnd=random.Random(9), bot_delay=(0, 0))
    d.add_bots(4)
    d.start(0.0)
    t = next(iter(d.tables.values()))
    a, b, c, w = (e.player for e in d.entries)
    # подстроим «прошлую раздачу»: a начинал с 300, b с 300, c с 100, w выиграл всё
    t.history.append({"players": [{"seat": a.seat, "stack": 300}, {"seat": b.seat, "stack": 300},
                                  {"seat": c.seat, "stack": 100}, {"seat": w.seat, "stack": 3300}]})
    w.stack += a.stack + b.stack + c.stack
    a.stack = b.stack = c.stack = 0
    d.tick(1.0)
    places = {e.name: d.place(e) for e in d.entries}
    ea, eb, ec, ew = d.entries
    assert d.status == "finished" and places[ew.name] == 1
    assert places[ea.name] == places[eb.name] == 2 and places[ec.name] == 4, places
    print("вылет в одной раздаче: места по фишкам на начало, поровну — делят")


def check_pause_and_cancel():
    rnd = random.Random(5)
    d = Director(5, "Pause", default_config(stack=1000, seats=7, level_seconds=60, test=True), rnd=rnd, bot_delay=(0, 0))
    d.add_bots(3)
    d.start(0.0)
    d.tick(30.0)
    assert d.level == 0 and abs(d.level_left(30.0) - 30) < 1e-9
    d.pause(30.0)
    assert all(not t.auto for t in d.tables.values())
    d.tick(500.0)
    assert d.level == 0 and abs(d.level_left(500.0) - 30) < 1e-9, "на паузе уровень стоит"
    for t in d.tables.values():
        if not t.running:
            t.next_hand_at = 0
            assert not t.tick() or not t.running, "на паузе новая раздача не начинается"
            assert not t.running
    d.resume(500.0)
    d.tick(531.0)
    assert d.level == 1, "после паузы уровень идёт дальше"
    # новый уровень: у столов без раздачи — сразу, у идущей раздачи — со следующей
    assert all((t.next_blinds[1] if t.running else t.bb) == d.cfg["levels"][1]["bb"] for t in d.tables.values())
    assert d.next_level(540.0) is None and d.level == 2 and d.level_left(540.0) == 60, "кнопка «следующий уровень»"
    assert d.events[-1]["kind"] == "level" and d.events[-1]["t"] == 540.0
    d.cancel(600.0)
    assert d.status == "cancelled" and all(not t.auto for t in d.tables.values())
    assert all(r["place"] is None for r in d.results()), "отменённый турнир — без мест"
    print("пауза останавливает уровни и раздачи; отмена без мест")


def check_registration_rules():
    d = Director(3, "Reg", default_config(stack=1000, seats=7, late_reg_level=2, rebuy_level=2), rnd=random.Random(3))
    assert d.register(1, "Ann") is None
    assert d.register(1, "Ann") is not None, "дважды нельзя"
    assert d.add_bots(2) is not None, "боты только в пробном"
    assert d.start(0.0) is not None, "один игрок — не старт"
    assert d.unregister(1) is None and d.register(1, "Ann") is None
    d.register(2, "Bob")
    assert d.start(0.0) is None
    assert d.unregister(1) is not None, "после старта отписаться нельзя"
    assert d.register(3, "Cid") is None, "поздняя регистрация на 1-м уровне"
    assert d.find(pid=3).status == "playing" and d.chips_in_play() == 3000
    d.level = 2                                               # 3-й уровень: поздняя рег. закрыта
    assert d.register(4, "Dan") is not None
    # ребай: вылетевший до уровня N
    d.level = 1
    e = d.find(pid=1)
    t = d.tables[e.table]
    other = next(p for p in t.players() if p is not e.player)
    other.stack += e.player.stack
    e.player.stack = 0
    d.tick(1.0)
    assert e.status == "out"
    assert d.rebuy(pid=1) is None and e.status == "playing" and e.rebuys == 1
    assert d.chips_in_play() == d.chips_total() == 4000
    d.level = 2
    e.player.stack, other.stack = 0, other.stack + e.player.stack
    d.tick(2.0)
    assert d.rebuy(pid=1) is not None, "после уровня N ребаев нет"
    # убрать игрока: вылет с местом, его фишки уходят из игры
    cid = d.find(pid=3)
    assert d.kick(pid=3) is None
    for t in d.tables.values():
        t.running = False
    d.tick(3.0)
    assert cid.status == "out" and d.chips_in_play() == d.chips_total()
    print("регистрация, поздняя регистрация, ребаи до уровня N, «убрать игрока»")


def check_mtt_table_rules():
    """Стол турнира: карты получают все живые (даже офлайн); офлайн ходит за 1 с; не выкидывают; докупку не ждут."""
    t = engine.Table("m", small_blind=5, big_blind=10, min_buyin=0, turn_seconds=15, mtt=True)
    a, b, c = (engine.Player(f"t{i}", f"P{i}", 0, 100) for i in range(3))
    for i, p in enumerate((a, b, c)):
        t.put_in(p, i)
    a.connections = 1                       # b и c закрыли сайт
    b.offline_since = c.offline_since = 1.0
    assert t.start_hand() and all(p.in_hand for p in (a, b, c)), "офлайн тоже получают карты"
    actor = t.seats[t.actor]
    if actor is not a:
        assert t.turn_total <= 1, "офлайн — ход за 1 секунду"
    t.tick()
    assert len(t.players()) == 3, "в турнире за уход с сайта не выкидывают"
    # проиграл всё — стол не ждёт докупку
    while t.running:
        if t.street_end_at is not None:
            t.street_end_at = 0
            t.tick()
        elif t.runout:
            t.next_street_at = 0
            t.tick()
        else:
            p = t.seats[t.actor]
            t.act(p, "allin" if p is a else ("call" if not t.options(p)["check"] else "check"))
    assert all(p.rebuy_until is None for p in t.players()), "в турнире докупку не ждём"
    print("стол турнира: офлайн получают карты и ходят за 1 с, без выкидывания и ожидания докупки")


def check_no_move_during_hand():
    t = engine.Table("x", mtt=True)
    p = engine.Player("tok", "A", 0, 100)
    t.put_in(p, 0)
    t.running = True
    try:
        t.take_out(p)
    except AssertionError:
        pass
    else:
        raise AssertionError("take_out во время раздачи должен падать")
    print("пересадка во время раздачи запрещена")


def seeded_deck(seed):
    """Колода, которая тасуется повторяемо: один и тот же seed — те же турниры (тест не «плавает»)."""
    rnd = random.Random(seed)
    def deck():
        d = [r + s for r in engine.RANKS for s in engine.SUITS]
        rnd.shuffle(d)
        return d
    return deck


def check_ante_in_tournament():
    """Уровни с анте: турнир ботов доигрывается, фишки сходятся на каждом такте, анте реально платится."""
    paid = []
    def spy(d, now):
        for t in d.tables.values():
            if t.running and t.ante:
                paid.extend(p.ante for p in t.players() if p.in_hand)
    rnd = random.Random(11)
    cfg = default_config(stack=1000, seats=5, level_seconds=20, test=True)
    d = Director(11, "Ante", cfg, rnd=rnd, bot_delay=(0, 0))
    d.add_bots(9)
    d.start(0.0)
    run(d, rnd, on_tick=spy)
    assert d.status == "finished" and paid and max(paid) > 0, "анте не платилось"
    print("турнир с анте с 4-го уровня: фишки сходятся")


def check_restore():
    """Перезапуск в случайный момент (в том числе посреди раздачи): после восстановления фишки те же,
    у каждого = stack + total на момент снимка, турнир на паузе и сам продолжается через 5 минут."""
    import json
    mid_hand = 0
    for seed in range(8):
        rnd = random.Random(300 + seed)
        saved = []
        cfg = default_config(stack=1000, seats=4, level_seconds=30, test=True)
        d = Director(seed, "Restart", cfg, rnd=rnd, save=saved.append, bot_delay=(0, 0))
        d.add_bots(rnd.randint(3, 11))
        d.start(0.0)
        cut = rnd.randint(5, 80)
        state = {}
        def grab(dd, now):
            if not state and now >= cut:
                state["snap"] = json.loads(json.dumps(dd.snapshot(now)))     # как в базе: через JSON
                state["chips"] = {e.name: e.player.stack + e.player.total for e in dd.alive()}
                state["running"] = any(t.running for t in dd.tables.values())
        run(d, rnd, on_tick=grab)
        assert saved, "директор сохранял по ходу турнира"
        if not state:
            continue
        mid_hand += state["running"]
        r = Director.restore(state["snap"], 1000.0, rnd=random.Random(seed), bot_delay=(0, 0))
        assert r.status == "paused" and r.error is None and r.auto_resume_at == 1300.0
        assert {e.name: e.player.stack for e in r.alive()} == state["chips"], "фишки после восстановления"
        assert r.chips_in_play() == r.chips_total()
        r.tick(1299.0)
        assert r.status == "paused"
        r.tick(1300.0)
        assert r.status == "running", "само продолжилось через 5 минут"
        run(r, random.Random(seed))
        assert r.status == "finished" and len(r.alive()) == 1
        places = sorted(x["place"] for x in r.results())
        assert places[0] == 1
    assert mid_hand >= 2, "перезапуск посреди раздачи должен проверяться"
    # испорченный снимок: сумма фишек не сходится — пауза без автопродолжения, Resume не помогает
    d = Director(99, "Broken", default_config(stack=1000, seats=4, test=True), rnd=random.Random(1), bot_delay=(0, 0))
    d.add_bots(5)
    d.start(0.0)
    snap = d.snapshot(1.0)
    snap["entries"][0]["chips"] += 5
    r = Director.restore(snap, 2.0)
    assert r.status == "paused" and r.error and r.auto_resume_at is None
    assert r.resume(3.0) is not None and r.status == "paused"
    print("перезапуск в любой момент: фишки те же, пауза и автопродолжение через 5 мин; испорченный снимок — стоп")


def check_prizes():
    """Деньги: фонд = бай-ин × (входы + ребаи); призы в сумме = фонду (и при дележе места); «следующий приз»."""
    from tournament import prize_list
    for n in (1, 2, 3, 5, 7, 11, 22, 40):
        for pool in (0, 2500 * n, 1234 * n + 7):
            assert sum(prize_list(pool, n)) == pool, (n, pool)
    rnd = random.Random(21)
    d = Director(21, "Cash", default_config(stack=500, seats=4, level_seconds=30, test=True, buy_in=2500, rebuy_level=2),
                 rnd=rnd, bot_delay=(0, 0))
    d.add_bots(9)
    d.start(0.0)
    assert d.prize_pool() == 9 * 2500 and len(d.prizes()) == 3
    np_ = d.next_prize()
    assert np_ == {"place": 3, "amount": d.prizes()[2]}, np_         # 9 живых: следующий вылетевший — ещё без денег,
    # но «следующий приз» — минимальный призовой (как в покер-румах)
    run(d, rnd)
    res = d.results()
    assert sum(r["prize"] for r in res) == d.prize_pool(), "все деньги розданы"
    assert next(r for r in res if r["place"] == 1)["prize"] == max(r["prize"] for r in res)
    assert all(r["paid"] == 2500 * (1 + r["rebuys"]) for r in res)
    # место делят двое: делят и призы двух мест
    d2 = Director(22, "Tie", default_config(stack=1000, seats=7, test=True, buy_in=1000), rnd=random.Random(3), bot_delay=(0, 0))
    d2.add_bots(7)
    d2.start(0.0)
    t = next(iter(d2.tables.values()))
    ps = [e.player for e in d2.entries]
    t.history.append({"players": [{"seat": p.seat, "stack": 1000 if i < 5 else 400} for i, p in enumerate(ps)]})
    ps[0].stack += sum(p.stack for p in ps[1:])
    for p in ps[1:]:
        p.stack = 0
    d2.tick(1.0)
    res = d2.results()
    assert sum(r["prize"] for r in res) == 7000, res
    second = [r for r in res if r["place"] == 2]
    assert len(second) == 4 and all(r["prize"] == (2100 + 1400) // 4 for r in second), second
    print("призы: фонд = входы × бай-ин, сумма призов = фонду, делёж места — делёж призов")


def check_templates():
    """Шаблоны Turbo / Regular / Deep: анте с 1-го уровня (~10–13% BB), структура проходит проверку, турнир доигрывается."""
    from tournament import TEMPLATES, DEFAULT_LEVELS, validate_config
    assert DEFAULT_LEVELS[0]["ante"] > 0
    for key, t in TEMPLATES.items():
        lv = t["levels"]
        assert lv[0]["ante"] > 0, f"{key}: анте с первого уровня"
        assert all(0.1 <= l["ante"] / l["bb"] <= 0.15 for l in lv), key
        cfg, err = validate_config({"stack": t["stack"], "level_seconds": t["level_seconds"], "levels": lv,
                                    "late_reg_level": t["late_reg_level"], "rebuy_level": t["rebuy_level"], "test": True})
        assert err is None, (key, err)
        rnd = random.Random(len(key))
        cfg["level_seconds"] = 60
        d = Director(len(key), key, cfg, rnd=rnd, bot_delay=(0, 0))
        d.add_bots(7)
        d.start(0.0)
        assert next(iter(d.tables.values())).ante == lv[0]["ante"]
        run(d, rnd)
        assert d.status == "finished"
    print("шаблоны: анте с первого уровня, турниры доигрываются")


def check_repeatable():
    engine.new_deck = seeded_deck(42)
    a = [(r["name"], r["place"]) for r in bots_tournament(9, 4, seed=77)[0].results()]
    engine.new_deck = seeded_deck(42)
    b = [(r["name"], r["place"]) for r in bots_tournament(9, 4, seed=77)[0].results()]
    assert a == b, "один seed — разные итоги"
    print("турнир повторяется при том же seed")


def check_level_waits_for_hand():
    """Уровень сменился посреди раздачи: она доигрывается по старым блайндам и анте, новые — со следующей."""
    seen = {"pending": 0, "applied": 0}
    def spy(d, now):
        b = d.blinds()
        level = (b["sb"], b["bb"], b.get("ante", 0))
        for t in d.tables.values():
            if t.running:
                assert (t.hist["sb"], t.hist["bb"], t.hist["ante"]) == (t.sb, t.bb, t.ante), "блайнды сменились посреди раздачи"
                if t.next_blinds:
                    assert t.next_blinds == level and (t.sb, t.bb, t.ante) != level
                    seen["pending"] += 1
                    t.waited = t.hand_no
                else:
                    assert (t.sb, t.bb, t.ante) == level, "раздача началась не по текущему уровню"
                    if getattr(t, "waited", None) is not None and t.hand_no > t.waited:
                        seen["applied"] += 1
                        t.waited = None
    rnd = random.Random(12)
    cfg = default_config(stack=1000, seats=5, level_seconds=7, test=True)   # уровни короче раздачи
    d = Director(12, "Levels", cfg, rnd=rnd, bot_delay=(0, 0))
    d.add_bots(9)
    d.start(0.0)
    run(d, rnd, on_tick=spy)
    assert d.status == "finished" and seen["pending"] and seen["applied"], seen
    print("уровень посреди раздачи — со следующей раздачи:", seen)


def main():
    old, old_deck = engine.STREET_PAUSE, engine.new_deck
    engine.STREET_PAUSE = 0
    engine.new_deck = seeded_deck(2026)
    try:
        check_mtt_table_rules()
        check_no_move_during_hand()
        check_registration_rules()
        check_pause_and_cancel()
        check_same_hand_bust()
        check_points_and_ties()
        check_basic_seating()
        check_many()
        check_ante_in_tournament()
        check_level_waits_for_hand()
        check_restore()
        check_prizes()
        check_templates()
        check_repeatable()
    finally:
        engine.STREET_PAUSE, engine.new_deck = old, old_deck
    print("турниры ok")


if __name__ == "__main__":
    main()
