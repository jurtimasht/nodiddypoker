"""Проверки правил покера. Запуск: /opt/poker/.venv/bin/python test_engine.py"""
import random

import engine

REAL_DECK = engine.new_deck
engine.TIMEBANK_PRE = engine.TIMEBANK_POST = 0   # тайм-чипы проверяем отдельно
engine.STREET_PAUSE = 0     # в большинстве проверок улицы выходят сразу; паузу проверяем отдельно
from engine import Table, best_hand, eval5, hand_name


def strength(text):
    return eval5(text.split())


def check_hands():
    order = [
        "As Kd 9c 7h 3s",   # старшая карта
        "2s 2d 9c 7h 3s",   # пара
        "2s 2d 9c 9h 3s",   # две пары
        "2s 2d 2c 9h 3s",   # сет
        "As 2d 3c 4h 5s",   # стрит-колесо
        "6s 2d 3c 4h 5s",   # стрит до 6
        "Ts Jd Qc Kh As",   # стрит до туза
        "2s 7s 9s Js Ks",   # флеш
        "2s 2d 2c 9h 9s",   # фулл-хаус
        "2s 2d 2c 2h 9s",   # каре
        "As 2s 3s 4s 5s",   # стрит-флеш (колесо)
        "Ts Js Qs Ks As",   # роял
    ]
    values = [strength(h) for h in order]
    assert values == sorted(values) and len(set(values)) == len(values), values
    assert strength("Ks Kd 5c 4h 3s") > strength("Qs Qd Ac Kh Js")            # пара K > пара Q
    assert strength("Ks Kd Ac 4h 3s") > strength("Ks Kh Qc Jh Ts")            # кикер
    assert strength("Ks Kd 5c 5h 3s") > strength("Qs Qd Jc Jh As")            # старшая пара решает
    assert strength("As Ad 2c 2h 3s") == strength("Ah Ac 2d 2s 3h")           # делёжка
    assert hand_name(best_hand("Ts Js Qs Ks As 2d 3c".split())) == "Royal flush"
    assert hand_name(best_hand("Ah Kh 2s 2d 2c 9h 9s".split())) == "Full house"
    assert hand_name(best_hand("Ah 2h 3s 4d 5c 9h Js".split())) == "Straight"
    print("комбинации: OK")


def table_with(n, stacks=None, game="nlhe", bomb_bb=0, double_board=False):
    t = Table("test", small_blind=5, big_blind=10, min_buyin=10, max_buyin=100_000, game=game, bomb_bb=bomb_bb,
              double_board=double_board)
    for i in range(n):
        p, err = t.add_player(f"tok{i}", f"P{i}", 1000)
        assert not err
        p.connections = 1
        p.table_conns = 1
        if stacks:
            p.stack = stacks[i]
    return t


def fixed_deck(cards):
    """Колода, из которой карты выходят в указанном порядке."""
    deck = cards.split()
    engine.new_deck = lambda: list(reversed(deck))


def finish_runout(t):
    """Олл-ин: улицы выходят по таймеру. В тестах не ждём — «перематываем» время."""
    steps = []
    while t.running and t.runout:
        t.next_street_at = 0
        assert t.tick()
        steps.append(len(t.board))
    return steps


def total_chips(t):
    return sum(p.stack for p in t.players()) + t.pot()


def check_heads_up():
    t = table_with(2)
    fixed_deck("As 2c Ad 3c  9h  Ks Qs Js  8h  Th  7h  4d")  # P0: AA, P1: 23; борд K Q J T 4 -> у P0 стрит до туза
    assert t.start_hand()
    p0, p1 = t.seats[0], t.seats[1]
    # Один на один: дилер (P0) ставит малый блайнд и ходит первым до флопа
    assert t.dealer == 0 and p0.bet == 5 and p1.bet == 10 and t.actor == 0
    assert t.act(p1, "call") == "It is not your turn."
    assert t.act(p0, "call") is None
    assert t.actor == 1 and t.options(p1)["check"]                # большой блайнд может чек
    assert t.act(p1, "check") is None
    assert t.street == "flop" and len(t.board) == 3 and t.actor == 1   # после флопа первым ходит не-дилер
    assert t.act(p1, "raise", 5) is not None                       # меньше большого блайнда нельзя
    assert t.act(p1, "raise", 20) is None and t.current_bet == 20
    assert t.act(p0, "raise", 30) is not None                      # мин. рейз до 40
    assert t.act(p0, "raise", 40) is None
    assert t.act(p1, "call") is None and t.street == "turn"
    assert t.act(p1, "check") is None and t.act(p0, "check") is None and t.street == "river"
    assert t.act(p1, "check") is None and t.act(p0, "check") is None
    assert not t.running and t.result
    assert p0.stack == 1050 and p1.stack == 950, (p0.stack, p1.stack, t.result)
    print("один на один:", t.result["text"])


def check_heads_up_table():
    """Стол heads-up (2 места): третий не сядет; дилер = малый блайнд; кнопка переходит по кругу."""
    t = Table("hu", small_blind=5, big_blind=10, min_buyin=10, max_buyin=100_000, seats=2)
    assert len(t.seats) == 2
    for i in range(2):
        p, err = t.add_player(f"tok{i}", f"P{i}", 1000)
        assert not err
        p.connections = p.table_conns = 1
    p, err = t.add_player("tok2", "P2", 1000)
    assert p is None and "2 seats" in err, err
    total = sum(p.stack for p in t.players())
    dealers = []
    for _ in range(6):
        assert t.start_hand()
        d = t.seats[t.dealer]
        other = t.seats[1 - t.dealer]
        assert d.bet == 5 and other.bet == 10 and t.actor == d.seat, "дилер ставит малый блайнд и ходит первым"
        dealers.append(t.dealer)
        assert t.act(d, "fold") is None and not t.running
        assert sum(p.stack for p in t.players()) == total
    assert dealers == [0, 1, 0, 1, 0, 1], dealers
    assert len(Table("x", seats=9).seats) == 7 and len(Table("y", seats=1).seats) == 2   # больше 7 / меньше 2 нельзя
    print("стол heads-up: 2 места, дилер = малый блайнд")


def play_out(t, choose):
    """Доиграть раздачу: choose(p, options) -> (действие, сумма). Паузы и олл-ин «перематываем»."""
    steps = 0
    while t.running:
        steps += 1
        assert steps < 200, "раздача не заканчивается"
        if t.street_end_at is not None:
            t.street_end_at = 0
            t.tick()
        elif t.runout:
            finish_runout(t)
        else:
            p = t.seats[t.actor]
            a, amount = choose(p, t.options(p))
            assert t.act(p, a, amount) is None, a


def passive(p, o):
    return ("check", 0) if o["check"] else ("call", 0)


def check_ante_basic():
    t = table_with(4)
    t.ante = 3
    assert t.start_hand()
    assert all(p.ante == 3 and p.total >= 3 for p in t.players())
    assert t.current_bet == 10 and t.pot() == 4 * 3 + 5 + 10
    bb = t.seats[(t.dealer + 2) % 4]
    play_out(t, lambda p, o: ("check", 0) if o["check"] else ("fold", 0))
    assert bb.stack == 1000 - 3 - 10 + (4 * 3 + 5 + 10), bb.stack
    assert total_chips(t) == 4000
    h = t.history[-1]
    assert h["ante"] == 3 and sum(pl["end"] - pl["stack"] for pl in h["players"]) == 0
    print("анте: все платят, банк забирает BB, история сходится")


def check_ante_short():
    # P0 — дилер, у него 2 фишки при анте 3: олл-ин на анте, претендует только на основной банк 2×4
    t = table_with(4, stacks=[2, 1000, 1000, 1000])
    t.ante = 3
    fixed_deck("As 2c 2d 2h  Ad 3c 3d 3h  9s  Kd Qc Jh  8s  7s  6c  4c")
    assert t.start_hand()
    p0 = t.seats[0]
    assert p0.all_in and p0.total == 2 and p0.bet == 0
    play_out(t, passive)
    assert p0.stack == 8, p0.stack                  # основной банк: по 2 с каждого
    assert [p.stack for p in t.players()[1:]] == [998, 998, 998], [p.stack for p in t.players()]
    assert total_chips(t) == 3002
    print("анте: короткий стек олл-ин на анте получает только основной банк")


def check_ante_allin_everyone():
    t = table_with(3, stacks=[3, 2, 3])
    t.ante = 3
    assert t.start_hand()
    assert all(p.all_in for p in t.players())
    play_out(t, passive)
    assert not t.running and total_chips(t) == 8
    print("анте: все в олл-ине уже на анте — карты открываются, раздача заканчивается")


def check_ante_refund():
    t = table_with(3)
    t.ante = 3
    assert t.start_hand()
    p0, p1, p2 = t.seats[:3]
    assert t.actor == 0
    assert t.act(p0, "allin") is None
    assert t.act(p1, "fold") is None and t.act(p2, "fold") is None
    t.tick() if t.running else None
    assert not t.running
    assert p0.stack == 1000 - 3 - 10 + (3 * 3 + 5 + 10 + 10), p0.stack   # вернулась только неуравненная ставка
    assert p1.stack == 1000 - 3 - 5 and p2.stack == 1000 - 3 - 10
    print("анте: возвращается только неуравненная ставка, анте остаётся в банке")


def check_ante_heads_up():
    t = table_with(2)
    t.ante = 2
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    assert t.dealer == 0 and p0.bet == 5 and p1.bet == 10 and t.actor == 0, "кнопка = SB и ходит первой"
    assert p0.total == 7 and p1.total == 12
    play_out(t, passive)
    assert total_chips(t) == 2000
    print("анте один на один: порядок ходов как без анте")


def check_side_pots():
    # P0 короткий (100) — олл-ин, P1 и P2 играют дальше: основной банк и побочный
    t = table_with(3, stacks=[100, 1000, 1000])
    # раздача по кругу начиная с места после... карты: по одной каждому игроку в порядке мест, два круга
    fixed_deck("As Kc 2d  Ad Kh 3d  9s  Qs Js Ts  8c  4h  7c  2c")
    assert t.start_hand()
    p0, p1, p2 = t.seats[:3]
    # дилер = P0, SB = P1, BB = P2, первым ходит P0
    assert t.dealer == 0 and t.actor == 0
    assert t.act(p0, "allin") is None and p0.all_in and t.current_bet == 100
    assert t.act(p1, "raise", 300) is None
    assert t.act(p2, "call") is None
    assert t.street == "flop"
    assert t.act(p1, "raise", 200) is None                         # ставка на флопе
    assert t.act(p2, "fold") is None
    assert t.running and t.runout and len(t.board) == 3            # олл-ин: ждём паузу, тёрн ещё не вышел
    v = t.view(p2)
    assert v["seats"][0]["cards"] == p0.cards and v["seats"][1]["cards"] == p1.cards   # карты открыты всем
    assert v["seats"][2]["cards"] == p2.cards                       # свои видно, хоть и сбросил
    assert finish_runout(t) == [4, 5, 5]                            # тёрн, ривер, пауза с итогом — и вскрытие
    assert not t.running
    # P1 и P2 вложили по 300, P0 — 100. Основной банк 300 (у P0 AA vs P1 KK — P0 выигрывает),
    # побочный 400 (300-100 от P1, 200 от P2) + невостребованная ставка 200 на флопе -> P1
    assert p0.stack == 300, (p0.stack, t.result)
    assert p1.stack == 1000 - 300 - 200 + 400 + 200, (p1.stack, t.result)
    assert p2.stack == 700
    assert total_chips(t) == 2100
    print("побочные банки:", t.result["text"])


def check_incomplete_raise():
    # Неполный олл-ин не даёт право повторно повышать тем, кто уже ходил
    t = table_with(3, stacks=[1000, 1000, 125])
    assert t.start_hand()
    p0, p1, p2 = t.seats[:3]   # дилер P0, SB P1, BB P2(125)
    assert t.act(p0, "raise", 100) is None
    assert t.act(p1, "call") is None
    assert t.act(p2, "allin") is None and t.current_bet == 125    # +25 — меньше минимального рейза 90
    opts = t.options(p0)
    assert opts and not opts["raise"] and opts["call"] == 25, opts
    assert t.act(p0, "raise", 300) is not None
    assert t.act(p0, "call") is None and t.act(p1, "call") is None
    assert t.street == "flop"
    print("неполный рейз: OK")


def check_everyone_allin_runs_out():
    t = table_with(2, stacks=[50, 50])
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    assert t.act(p0, "allin") is None and t.act(p1, "call") is None
    assert t.running and t.runout and t.board == []                 # префлоп-олл-ин: сначала только открытые карты
    assert not t.tick()                                             # пауза ещё не прошла — ничего не выходит
    steps = []
    while t.runout:
        t.next_street_at = 0
        t.tick()
        steps.append(len(t.board))
        if t.runout and len(t.board) == 5:                         # ривер вышел: итоговые шансы 100% / 0% (или ничья)
            assert sorted(t.equity.values()) in ([0.0, 1.0], [0.5, 0.5]), t.equity
    assert steps == [3, 4, 5, 5]                                    # флоп целиком, тёрн, ривер, пауза с итогом
    assert not t.running and len(t.board) == 5 and total_chips(t) == 100
    print("олл-ин до конца:", t.result["text"])


def check_timeout_and_away():
    t = table_with(2)
    t.auto = True
    assert t.start_hand()
    actor = t.seats[t.actor]
    t.deadline = 0
    assert t.tick() and actor.folded and actor.timeouts == 1 and not t.running
    t.next_hand_at = 0
    assert t.tick() and t.running
    other = t.seats[t.actor]
    assert other is not actor and t.act(other, "fold") is None    # дилер сменился, ходит второй
    t.next_hand_at = 0
    assert t.tick() and t.seats[t.actor] is actor                 # снова ход первого
    t.deadline = 0
    t.tick()
    assert actor.timeouts == 2 and actor.away, "после двух пропусков подряд игрок «отходит»"
    t.next_hand_at = 0
    assert not t.start_hand()                                     # одного игрока мало для раздачи
    print("таймер: OK")


def check_buyin():
    t = Table("test")                                   # 50/100, минимум 10 000
    assert t.add_player("a", "A", 9_999)[1] == "Minimum 10,000 chips."
    assert t.add_player("a", "A", "много")[1]
    assert t.add_player("a", "A", 2_000_000)[1]
    a, err = t.add_player("a", "A", 25_000)
    b, _ = t.add_player("b", "B", 10_000)
    assert not err and a.stack == 25_000 and a.bought == 25_000
    a.connections = b.connections = 1
    assert t.rebuy(a, 10_000) == "You can only rebuy when you are out of chips."
    assert t.tick() and t.next_hand_at and not t.running       # раздача начнётся через 5 секунд
    t.next_hand_at = 0
    assert t.tick() and t.running and t.bb == 100
    while t.running:                                    # B идёт олл-ин, A уравнивает
        if t.runout:
            finish_runout(t)
            break
        p = t.seats[t.actor]
        t.act(p, "allin" if p is b else "call")
    loser = b if b.stack == 0 else (a if a.stack == 0 else None)
    if loser:
        assert t.rebuy(loser, 5_000)
        assert t.rebuy(loser, 12_000) is None and loser.stack == 12_000
        assert loser.bought == (25_000 if loser is a else 10_000) + 12_000
    print("вход и докупка: OK")


def check_cover_allin():
    # Соперник в олл-ине на меньшую сумму, больше отвечать некому — повышать бессмысленно: только колл или фолд
    t = table_with(2, stacks=[500, 3000])
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    assert t.act(p0, "allin") is None
    o = t.options(p1)
    assert o and not o["raise"] and o["call"] == 490, o
    assert t.act(p1, "raise", 2000) == "You cannot raise now: only call or fold."
    assert t.act(p1, "allin") is None and p1.stack == 2500     # «олл-ин» = просто колл 490
    # Но если есть третий игрок с фишками — повышать можно
    t = table_with(3, stacks=[500, 3000, 3000])
    assert t.start_hand()
    p0, p1, p2 = t.seats[:3]
    assert t.act(p0, "allin") is None
    assert t.options(p1)["raise"]
    print("олл-ин соперника покрыт: OK")


def check_refund():
    # P0 200 BB, P1 100 BB, оба олл-ин: в банк по 100 BB, лишние 100 BB P0 возвращаются сразу, до флопа
    t = table_with(2, stacks=[2000, 1000])
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    assert t.act(p0, "allin") is None and t.act(p1, "call") is None
    assert t.refund == {"seat": 0, "amount": 1000, "id": t.refund_seq}, t.refund
    assert p0.stack == 1000 and not p0.all_in and t.pot() == 2000 and t.board == []
    assert t.runout
    finish_runout(t)
    assert p0.stack + p1.stack == 3000
    assert not any("gets back" in line for line in t.result["text"]), t.result      # возвращать в конце уже нечего
    # Ставка, которую никто не уравнял (все сбросили), — победитель забирает всё, отдельного возврата нет
    t = table_with(3, stacks=[1000, 1000, 1000])
    assert t.start_hand()
    a, b, c = t.seats[:3]
    assert t.act(a, "raise", 300) is None and t.act(b, "fold") is None and t.act(c, "fold") is None
    assert a.stack == 1015 and t.refund is None
    print("возврат лишних фишек: OK")


def check_ledger():
    t = Table("test", small_blind=5, big_blind=10, min_buyin=100, max_buyin=100_000)
    a, _ = t.add_player("a", "Аня", 1000)
    b, _ = t.add_player("b", "Боря", 500)
    a.connections = b.connections = 1
    b.stack = 0
    assert t.rebuy(b, 700) is None
    a.stack = 1300                               # будто выиграла у Бори 300
    b.stack = 400
    rows = {r["name"]: r for r in t.ledger_view()}
    assert rows["Аня"]["profit"] == 300 and rows["Боря"]["profit"] == -800, rows
    t.leave(b)                                   # Боря ушёл с 400 — его итог остаётся
    rows = {r["name"]: r for r in t.ledger_view()}
    assert rows["Боря"] == {"name": "Боря", "bought": 1200, "out": 400, "now": None, "profit": -800}, rows["Боря"]
    c, _ = t.add_player("c", "боря", 100)        # вернулся (то же имя) — считается дальше
    rows = {r["name"].lower(): r for r in t.ledger_view()}
    assert rows["боря"]["bought"] == 1300 and rows["боря"]["profit"] == -800
    t.reset_ledger("Аня")
    rows = {r["name"]: r for r in t.ledger_view()}
    assert all(r["profit"] == 0 for r in rows.values()) and len(rows) == 2
    print("итоги вечера: OK")


def check_history():
    t = table_with(3)
    assert t.start_hand()
    a, b, c = t.seats[:3]                    # дилер a, SB b, BB c; первым ходит a
    assert t.act(a, "fold") is None and t.act(b, "call") is None and t.act(c, "check") is None
    while t.running:                         # дальше все чекают до вскрытия
        p = t.seats[t.actor]
        assert t.act(p, "check") is None
    h = t.history_hand(1, a)                 # смотрит сбросивший a
    seats = {pl["name"]: pl for pl in h["players"]}
    assert [pl["pos"] for pl in h["players"]] == ["BTN", "SB", "BB"]
    assert seats["P0"]["cards"] == a.cards and seats["P0"]["me"]          # свои карты видно
    assert seats["P1"]["cards"] == b.cards and seats["P1"]["shown"]       # показанные на вскрытии — видно
    assert "token" not in seats["P1"]
    kinds = [e["k"] for e in h["events"]]
    assert kinds[:2] == ["act", "act"] and kinds.count("board") == 3 and kinds[-1] == "result"
    assert h["events"][0]["text"] == "Blind §5§" and h["pot"] == 20
    assert sum(pl["end"] - pl["stack"] for pl in h["players"]) == 0
    # Сбросившего никто, кроме него самого, не видит
    h2 = t.history_hand(1, b)
    assert {pl["name"]: pl for pl in h2["players"]}["P0"]["cards"] == ["back", "back"]
    lst = t.history_list(a)
    assert lst[0]["no"] == 1 and lst[0]["my"] == 0 and lst[0]["pot"] == 20
    print("история раздач: OK")


def check_kick_and_lobby():
    import time as _t
    t = table_with(3)
    a, b, c = t.seats[:3]
    for p in (a, b, c):
        p.table_conns = 1
    # c закрыл сайт: сразу не выгоняем (может просто обновить страницу), через 15 секунд — встаёт
    c.connections = c.table_conns = 0
    c.offline_since = _t.time()
    assert not t.tick() or t.seats[2] is not None
    t.auto = False
    c.offline_since = _t.time() - 16
    assert t.tick() and t.seats[2] is None
    assert {r["name"]: r for r in t.ledger_view()}["P2"]["out"] == 1000
    # b ушёл в лобби: остаётся за столом, получает карты и полное время; не походил — пропускает раздачи
    b.table_conns = 0
    assert t.view(a)["seats"][1]["lobby"]
    assert t.start_hand() and b.in_hand
    while t.actor != b.seat:
        t.act(t.seats[t.actor], "call")
    assert t.deadline - _t.time() > t.turn_seconds - 1         # полное время на ход, а не 5 секунд
    t.deadline = 0
    assert t.tick() and b.away and b.folded is False or b.away
    print("выход с сайта и лобби: OK")


def check_time_chips():
    import time as _t
    engine.TIMEBANK_PRE, engine.TIMEBANK_POST = 10, 60
    t = table_with(2)
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    # префлоп: время вышло — включился запас 10 с; не походил — запас сгорел, авто-фолд
    t.deadline = 0
    assert t.tick() and t.timebank == "pre" and t.turn_total == 10 and not p0.folded
    t.deadline = 0
    assert t.tick() and p0.folded and p0.bank_pre == 0 and not t.running
    t.next_hand_at = 0
    assert t.tick() and t.running and p0.bank_pre == 10 and p0.bank_post == 60     # новая раздача — запас снова полный
    while t.street == "preflop":
        if t.street_end_at is not None:
            t.street_end_at = 0; t.tick(); continue
        p = t.seats[t.actor]
        t.act(p, "check" if t.options(p)["check"] else "call")
    # флоп: запас 60 с, потратил 10 с и походил — на тёрне осталось 50
    actor = t.seats[t.actor]
    t.deadline = 0
    assert t.tick() and t.timebank == "post" and t.turn_total == 60
    t.bank_start = _t.time() - 10
    assert t.act(actor, "check") is None and 49 <= actor.bank_post <= 50.1, actor.bank_post
    other = t.seats[t.actor]
    assert t.act(other, "check") is None
    while t.street_end_at is not None or t.street == "flop":
        t.street_end_at = 0; t.tick()
    assert t.street == "turn"
    while t.seats[t.actor] is not actor:
        t.act(t.seats[t.actor], "check")
    t.deadline = 0
    assert t.tick() and t.timebank == "post" and 49 <= t.turn_total <= 50.1, t.turn_total    # на тёрне — оставшиеся ~50 с
    assert t.view(actor)["timebank"]["secs"] == 50
    engine.TIMEBANK_PRE = engine.TIMEBANK_POST = 0
    print("запас времени по улицам: OK")


def check_badbeat():
    import time as _t
    t = table_with(2, stacks=[3000, 1000])     # у P0 останутся фишки после проигрыша — будет следующая раздача
    # P0: AA, P1: 7-2; доска 7 2 K 9 3 — у 7-2 две пары
    fixed_deck("As 7c Ad 2h  5c  7d 2s Kc  8h  9h  4c  3d")
    assert t.start_hand()
    p0, p1 = t.seats[:2]
    assert t.act(p0, "allin") is None and t.act(p1, "call") is None and t.runout
    t.set_equity(dict(zip((0, 1), engine.equity([p0.cards, p1.cards], []))))   # как делает сервер до флопа
    assert t.allin_equity[0] > 0.8
    while len(t.board) < 5:
        t.next_street_at = 0
        t.tick()
    assert t.badbeat and t.badbeat["seat"] == 0 and t.badbeat["equity"] >= 80, t.badbeat
    assert t.next_street_at - _t.time() <= 1.01                  # после ривера — пауза 1 с
    t.next_street_at = 0
    assert t.tick() and not t.running
    assert 5.5 < t.next_hand_at - _t.time() <= 6.01              # тряска + картинка ~5 с — и сразу следующая раздача
    assert t.view(p0)["badbeat"]["name"] == "P0"
    t.next_hand_at = 0
    assert t.tick() and t.running and t.badbeat is None and t.allin_equity is None
    # До флопа меньше 69%, но на тёрне 69%+ — и проиграл на ривере: тоже bad beat
    t = table_with(2, stacks=[3000, 1000])
    t.start_hand()
    p0, p1 = t.seats[:2]
    t.act(p0, "allin"); t.act(p1, "call")
    t.set_equity({0: 0.55, 1: 0.45})                  # до флопа 55% — мало
    t.board = ["Kd", "Qd", "2c"]; t.set_equity({0: 0.60, 1: 0.40})
    t.board = ["Kd", "Qd", "2c", "3h"]; t.set_equity({0: 0.69, 1: 0.31})   # на тёрне ровно 69%
    assert t.allin_equity[0] == 0.69
    t.board = ["Kd", "Qd", "2c", "3h", "4s"]; t.set_equity({0: 0.0, 1: 1.0})
    assert t.allin_equity[0] == 0.69                  # ривер в «лучшие шансы» не идёт
    engine.new_deck = REAL_DECK
    print("bad beat: OK")


def check_rebuy_wait():
    import time as _t
    # P1 проигрывает всё; за столом ещё двое — следующая раздача ждёт его докупку до 10 с
    t = table_with(3, stacks=[3000, 1000, 3000])
    fixed_deck("7c As 4d 2h Ad 5d  5c  7d 2s Kc  8h  9h  4c  3d")   # у P1 тузы, но у P0 две пары
    assert t.start_hand()
    p0, p1, p2 = t.seats[:3]
    while t.running:
        a = t.seats[t.actor]
        o = t.options(a)
        move = "allin" if a is p0 else ("call" if o["call"] else "check") if a is p1 else "fold"
        assert t.act(a, move) is None, (a.name, move)
        while t.running and t.actor is None:
            t.next_street_at = 0; t.street_end_at = None if t.street_end_at is None else 0
            t.tick()
    assert p1.stack == 0 and p1.rebuy_until and abs(p1.rebuy_until - t.next_hand_at - 10) < .01
    assert t.view(p1)["seats"][1]["rebuying"] is None and t.view(p1)["seats"][1]["rebuy_in"] > 3
    now = _t.time()
    p1.rebuy_from -= 100; p1.rebuy_until = now + 10; t.next_hand_at = 0
    assert t.tick() and t.rebuy_sig == (1,)                  # отсчёт начался — экраны обновились
    assert not t.tick() and not t.running                    # ждём
    assert 9 < t.view(p2)["seats"][1]["rebuying"] <= 10
    assert t.rebuy(p1, 10000) is None and p1.rebuy_until is None
    t.tick()                                                 # отсчёт кончился
    assert t.tick() and t.running and t.seats[1].in_hand     # докупился — раздача сразу, и он в ней
    # Время вышло — раздача без него; «просто смотреть» — тоже сразу
    t2 = table_with(3, stacks=[3000, 0, 3000])
    q = t2.seats[1]; now = _t.time()
    q.rebuy_from, q.rebuy_until = now - 1, now + 10
    t2.next_hand_at = 0
    t2.tick(); assert not t2.tick() and not t2.running
    t2.skip_rebuy(q)
    t2.tick(); assert t2.tick() and t2.running and not q.in_hand
    q.rebuy_from, q.rebuy_until = now - 11, now - 1           # истёк — не ждём
    assert t2.rebuy_wait(q, _t.time()) is None
    print("10 секунд на докупку: OK")


def check_show_cards():
    t = table_with(3, stacks=[3000, 3000, 3000])
    assert t.start_hand()
    first = t.seats[t.actor]
    assert t.show(first, 1) is None and first.show_cards == {1}     # во время раздачи — пометка на одну карту
    assert t.view(first)["you"]["show_pending"] == [1]
    assert t.show(first, 0) is None and t.show(first, 0) is None    # вторую отметил и снял
    assert t.show(first, 5) and first.show_cards == {1}
    other = next(p for p in t.players() if p is not first)
    assert t.view(other)["seats"][first.seat]["cards"] == ["back", "back"]   # пока не видно
    t.act(first, "fold")
    while t.running:
        a = t.seats[t.actor]; t.act(a, "fold")
    winner = next(p for p in t.players() if p.stack > 3000)
    assert t.view(other)["seats"][first.seat]["cards"] == ["back", first.cards[1]]   # видна только вторая карта
    assert t.history[-1]["shown"][first.seat] == ["back", first.cards[1]]
    h = t.history_hand(t.history[-1]["no"], other)
    assert next(pl for pl in h["players"] if pl["seat"] == first.seat)["cards"] == ["back", first.cards[1]]
    assert t.view(first)["you"]["shown"] == [1]
    # после раздачи — сразу, по одной
    assert t.show(winner, 0) is None
    assert t.view(other)["seats"][winner.seat]["cards"] == [winner.cards[0], "back"]
    assert t.show(winner, 1) is None
    assert t.view(other)["seats"][winner.seat]["cards"] == winner.cards
    assert t.history[-1]["shown"][winner.seat] == winner.cards
    assert t.view(winner)["you"]["shown"] == [0, 1]
    assert t.view(other)["seats"][first.seat]["hand"] == ""          # одна карта / сбросил — без комбинации
    print("показ карт по клику (по одной): OK")


def check_omaha():
    import itertools
    from engine import best_omaha, eval5, equity_omaha
    # 4 червы на доске и одна черва на руке — в Омахе флеша НЕТ (нужно ровно 2 свои карты)
    assert hand_name(best_omaha("Qh 9s 9d 3c".split(), "Ah Kh 8h 4h 2c".split())) == "Pair"
    assert hand_name(best_omaha("Jh Th 4s 5s".split(), "Ah Kh Qh 2c 3d".split())) == "Royal flush"
    # три туза на доске + пара на руке = фулл-хаус; каре на доске не считается
    assert hand_name(best_omaha("Ks Kd 2s 3s".split(), "As Ad Ac Ah 7c".split())) == "Full house"
    assert hand_name(best_omaha("2s 3s 5d 9c".split(), "As Ad Ac Ah 7c".split())) == "Three of a kind"
    # сверка с полным перебором на случайных раздачах
    rnd = random.Random(7)
    deck = [r + s_ for r in "23456789TJQKA" for s_ in "shdc"]
    for _ in range(1500):
        cards = rnd.sample(deck, 10)
        hole, board = cards[:rnd.choice([4, 5])], cards[5:10]
        ref = max(eval5(list(h) + list(b)) for h in itertools.combinations(hole, 2) for b in itertools.combinations(board, 3))
        assert best_omaha(hole, board) == ref
    # шансы: на ривере точно 1/0, на тёрне сумма = 1
    e = equity_omaha(["As Ad Kc Qc".split(), "7h 8h 9s Ts".split()], "Ah Ac 2d 3s 4c".split())
    assert e == [1.0, 0.0]
    e = equity_omaha(["As Ad Kc Qc".split(), "7h 8h 9s Ts".split()], "6h 2c 3d Jh".split())
    assert abs(sum(e) - 1) < 1e-9

    # пот-лимит: до флопа максимум 3,5 BB (10 + 15 + 10 = 35 при блайндах 5/10)
    t = table_with(3, game="plo4")
    assert t.start_hand()
    assert all(len(p.cards) == 4 for p in t.players())
    p = t.seats[t.actor]
    o = t.options(p)
    assert o["max_to"] == 35 and o["all_in_to"] == 1000 and o["pot_limit"], o
    assert t.act(p, "raise", 40) == "Pot limit: maximum 35."
    assert t.act(p, "allin") is None and p.bet == 35        # «олл-ин» в пот-лимите = пот-рейз
    q = t.seats[t.actor]
    assert t.options(q)["max_to"] == 35 + (5 + 10 + 35) + (35 - q.bet), t.options(q)
    v = t.view(t.players()[1])
    assert v["game"] == "plo4" and v["pot_limit"] and v["hole_count"] == 4
    assert all(len(sv["cards"]) == 4 for sv in v["seats"] if sv and sv["in_hand"])

    # бомб-пот PLO5: блайндов нет, каждый ставит 5 BB, сразу флоп, первым ходит левее дилера
    t = table_with(3, game="plo5", bomb_bb=5)
    assert t.start_hand()
    assert t.street == "flop" and len(t.board) == 3 and t.pot() == 150
    assert all(len(p.cards) == 5 and p.total == 50 for p in t.players())
    assert t.actor == t.next_seat(t.dealer, lambda p: p.in_hand) and t.current_bet == 0
    # короткий стек меньше 5 BB идёт в олл-ин бомбой
    t = table_with(3, stacks=[30, 1000, 1000], game="plo5", bomb_bb=5)
    assert t.start_hand()
    assert t.seats[0].all_in and t.pot() == 130
    print("Омаха (PLO4/PLO5), пот-лимит, бомб-пот: OK")


def check_double_board():
    """Две доски: каждый банк — пополам, половина лучшей руке на каждой доске (в т. ч. побочные банки)."""
    def deal(order):
        fixed_deck(" ".join(order))
    # 2 игрока по 5 карт, бомб-пот по 50 (5 BB при BB=10): банк 100, плюс оба олл-ин
    # P0 выигрывает доску 1 (флеш червей), P1 — доску 2 (флеш пик). Колода: P0 5 карт, P1 5 карт по кругу.
    p0 = "Ah Kh 2c 3d 4c".split(); p1 = "As Ks 5c 6d 7c".split()
    hole = [c for pair in zip(p0, p1) for c in pair]
    boards = ["9c", "Qh", "Jh", "8h", "Qs", "Js", "8s",   # сжечь, флоп 1, флоп 2
              "2s", "Td", "Th",                           # сжечь, тёрн 1, тёрн 2
              "3s", "2h", "Ts"]                           # сжечь, ривер 1, ривер 2
    deal(hole + boards)
    t = table_with(2, stacks=[1001, 1000], game="plo5", bomb_bb=5, double_board=True)
    assert t.start_hand()
    assert len(t.board) == 3 and len(t.board2) == 3 and t.board == ["Qh", "Jh", "8h"] and t.board2 == ["Qs", "Js", "8s"]
    while t.running:
        if t.actor is not None:
            a = t.seats[t.actor]
            t.act(a, "allin" if t.options(a)["raise"] else "call")
        else:
            t.next_street_at = 0; t.street_end_at = None if t.street_end_at is None else 0
            t.tick()
    a, b = t.seats[0], t.seats[1]
    # Оба поставили по 1000 (у P0 1 фишка вернулась). Банк 2000: по 1000 на доску
    assert a.stack + b.stack == 2001 and a.stack == 1001 and b.stack == 1000, (a.stack, b.stack, t.result)
    assert len([x for x in t.result["text"] if "Board" in x]) == 2
    assert "/" in t.result["hands"][0]
    # Нечётный банк: 101 → 51 первой доске, 50 второй; фишки не теряются
    deal(hole + boards)
    t = table_with(2, stacks=[51, 50], game="plo5", bomb_bb=5, double_board=True)
    t.start_hand()
    while t.running:
        if t.actor is not None:
            p = t.seats[t.actor]; t.act(p, "allin" if t.options(p)["raise"] else "call")
        else:
            t.next_street_at = 0; t.street_end_at = None if t.street_end_at is None else 0
            t.tick()
    assert t.seats[0].stack + t.seats[1].stack == 101
    # Шансы на двух досках: на ривере 100/0 на каждой; на тёрне — сумма по каждой доске = 1
    v1, v2 = t.calc_equity([p0, p1], ["Qh", "Jh", "8h", "Td"], ["Qs", "Js", "8s", "Th"])
    assert abs(sum(v1) - 1) < 1e-9 and abs(sum(v2) - 1) < 1e-9 and v1[0] > .9 and v2[1] > .9
    print("две доски: делёж пополам, нечётная фишка, шансы по доскам: OK")


def check_street_pause():
    engine.STREET_PAUSE = 1
    try:
        t = table_with(2)
        assert t.start_hand()
        p0, p1 = t.seats[:2]
        assert t.act(p0, "call") is None and t.act(p1, "check") is None
        # Торговля закончилась: улица ещё префлоп, последний ход виден, ходить никому нельзя
        assert t.street == "preflop" and t.actor is None and p1.last == "Check" and t.street_end_at
        assert t.act(p0, "check") == "It is not your turn."
        assert not t.tick()                         # секунда ещё не прошла
        t.street_end_at = 0
        assert t.tick() and t.street == "flop" and len(t.board) == 3 and t.actor is not None and p1.last == ""
        # Олл-ин: сначала пауза, потом карты открываются и улицы идут по одной
        t2 = table_with(2)
        assert t2.start_hand()
        a, b = t2.seats[:2]
        assert t2.act(a, "allin") is None and t2.act(b, "call") is None
        assert not t2.runout and t2.street_end_at
        t2.street_end_at = 0
        assert t2.tick() and t2.runout and t2.board == []
        assert finish_runout(t2) == [3, 4, 5, 5] and not t2.running
    finally:
        engine.STREET_PAUSE = 0
    print("пауза перед улицей: OK")


def fuzz(games=3000, game="nlhe", bomb_bb=0, double_board=False, ante=0):
    """Тысячи случайных раздач со случайными ходами: фишки не теряются, ничего не ломается."""
    rnd = random.Random(1)
    for g in range(games):
        n = rnd.randint(2, 7)
        t = table_with(n, stacks=[rnd.choice([10, 37, 100, 250, 1000, 5000]) for _ in range(n)], game=game, bomb_bb=bomb_bb,
                       double_board=double_board)
        t.ante = ante and rnd.choice([1, ante, ante * 3])
        before = total_chips(t)
        for hand in range(rnd.randint(1, 6)):
            if not t.start_hand():
                break
            steps = 0
            while t.running:
                steps += 1
                assert steps < 200, "раздача не заканчивается"
                if t.street_end_at is not None:      # пауза перед улицей — «перематываем»
                    assert t.actor is None
                    t.street_end_at = 0
                    assert t.tick()
                    continue
                if t.runout:
                    assert t.actor is None
                    t.view(t.players()[0])
                    finish_runout(t)
                    continue
                p = t.seats[t.actor]
                o = t.options(p)
                choices = ["fold", "allin"] + (["check"] if o["check"] else ["call"])
                if o["raise"]:
                    choices += ["raise"] * 3
                a = rnd.choice(choices)
                amount = rnd.randint(o["min_to"], o["max_to"]) if a == "raise" else 0
                err = t.act(p, a, amount)
                assert err is None, (a, amount, o, err)
                if t.pot_limit and a == "raise":
                    assert amount <= o["max_to"] <= o["all_in_to"]
                if t.running and rnd.random() < 0.02:
                    other = rnd.choice(t.players())
                    t.fold_out_of_turn(other) if other.in_hand and not other.folded else None
                assert total_chips(t) == before, "фишки потерялись"
                assert all(p.stack >= 0 for p in t.players())
            t.view(t.players()[0])
            if t.history:
                h = t.history_hand(t.history[-1]["no"], t.players()[0])
                assert sum(pl["end"] - pl["stack"] for pl in h["players"]) == 0, "фишки в истории не сходятся"
                t.history_list(t.players()[0])
        assert total_chips(t) == before
    print(f"случайные игры ({game}{', bomb ' + str(bomb_bb) + 'BB' if bomb_bb else ''}{', 2 доски' if double_board else ''}{', анте' if ante else ''}): {games} столов OK")


if __name__ == "__main__":
    check_hands()
    check_heads_up()
    check_heads_up_table()
    check_ante_basic()
    check_ante_short()
    check_ante_allin_everyone()
    check_ante_refund()
    check_ante_heads_up()
    check_side_pots()
    check_incomplete_raise()
    check_everyone_allin_runs_out()
    check_timeout_and_away()
    check_buyin()
    check_cover_allin()
    check_refund()
    check_ledger()
    check_history()
    check_kick_and_lobby()
    check_time_chips()
    check_badbeat()
    check_street_pause()
    check_omaha()
    check_double_board()
    check_rebuy_wait()
    check_show_cards()
    engine.new_deck = REAL_DECK
    fuzz()
    fuzz(500, game="plo4")
    fuzz(500, game="plo5", bomb_bb=5)
    fuzz(500, game="plo5", bomb_bb=5, double_board=True)
    fuzz(1000, ante=4)                           # анте и маленькие стеки
    fuzz(300, game="plo4", ante=4)
    engine.STREET_PAUSE = 1
    fuzz(1000)                                   # то же самое, но с паузой перед каждой улицей
    import test_mtt                              # турниры: турниры ботов от начала до конца
    test_mtt.main()
    import test_accounts                         # аккаунты: вход, пароли, код приглашения
    test_accounts.main()
    print("ВСЁ ХОРОШО")
