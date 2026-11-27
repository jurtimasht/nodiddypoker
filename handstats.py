"""NoDiddyPoker — флажки статистики игрока по одной раздаче (VPIP, PFR, 3-bet, C-bet…).

Чистая функция derive(hand) -> {место: флажки}: на входе запись раздачи (Table.hist после finish_hand,
можно и после JSON — ключи мест станут строками), на выходе для каждого игрока, получившего карты,
«возможность» (…_opp) и «действие» (0/1). Цифры в окне = сумма действий / сумма возможностей.
Определения — как в PokerTracker / Hold'em Manager (план архитектора 2026-11-27):

  VPIP / PFR  — возможность: был хоть один свой ход до флопа (walk у BB и олл-ин на блайнде — нет);
                действие: добровольно положил деньги (call / bet / raise) / хоть раз повысил
  3-bet       — до него было ровно одно повышение (open), и не он его сделал; действие: повысил
  Fold to 3b  — сделал open, а потом перед ним 3-bet (не 4-bet); действие: сбросил
  Steal       — до него все сбросили (ни лимпа, ни повышения), он на CO / BTN / SB; действие: повысил
                (при 4 игроках места CO нет — его роль у UTG)
  C-bet       — последним повышал до флопа, на флопе до него никто не ставил; действие: поставил
  Fold to CB  — на флопе перед ним ставка префлоп-агрессора без рейза между ними; действие: сбросил
  Check/raise — на флопе сделал check, потом кто-то поставил, ход дошёл до него; действие: повысил
  WTSD        — видел флоп; действие: дошёл до вскрытия (и олл-ин с открытыми картами)
  W$SD        — дошёл до вскрытия; действие: выиграл хоть часть спорного банка (на любой доске)

Бомб-пот: торговли до флопа нет — префлоп-цифры и C-bet без возможностей. Ход по таймеру и «ушёл» —
как обычный fold / check (так делают трекеры). Карты игроков (hole) не нужны: в базе их нет, только открытые всем (shown)."""

DV = 1                                       # версия правил: поменяли правило — увеличить и пересчитать базу

FLAGS = ("pf_opp", "vpip", "pfr", "tb_opp", "tb", "f3b_opp", "f3b", "st_opp", "st",
         "saw_flop", "cb_opp", "cb", "fcb_opp", "fcb", "cr_opp", "cr", "wtsd", "wsd", "sd_shown")
FORCED = ("ante", "sb", "bb", "bomb")        # не свой выбор — не «ход» для статистики


def _seatmap(d):
    """{место: …} из записи раздачи: после JSON ключи — строки."""
    return {int(k): v for k, v in (d or {}).items()}


def derive(hand):
    players = hand.get("players") or []
    seats = [pl["seat"] for pl in players]
    pos = {pl["seat"]: pl.get("pos", "") for pl in players}
    steal_pos = {"CO", "BTN", "SB"} | ({"UTG"} if len(players) == 4 else set())
    f = {s: dict.fromkeys(FLAGS, 0) for s in seats}
    acts = [e for e in hand.get("events") or [] if e.get("k") == "act" and e.get("a")]

    # ---------- до флопа ----------
    raises, limpers, opener, last_raiser = 0, 0, None, None
    folded_pre = set()
    answered_3b = set()
    for e in acts:
        if e.get("street") != "preflop" or e["a"] in FORCED:
            continue
        s, a = e["seat"], e["a"]
        if s not in f:
            continue
        x = f[s]
        x["pf_opp"] = 1
        if raises == 0 and limpers == 0 and pos.get(s) in steal_pos:
            x["st_opp"] = 1
            x["st"] = int(a in ("raise", "bet"))
        if raises == 1 and s != opener:
            x["tb_opp"] = 1
            x["tb"] = max(x["tb"], int(a in ("raise", "bet")))
        if s == opener and raises == 2 and s not in answered_3b:
            answered_3b.add(s)
            x["f3b_opp"] = 1
            x["f3b"] = int(a == "fold")
        if a in ("call", "bet", "raise"):
            x["vpip"] = 1
        if a in ("bet", "raise"):
            x["pfr"] = 1
            raises += 1
            if raises == 1:
                opener = s
            last_raiser = s
        elif a == "call" and raises == 0:
            limpers += 1
        elif a == "fold":
            folded_pre.add(s)

    # ---------- флоп ----------
    board = hand.get("board") or []
    saw = set()
    if len(board) >= 3:
        saw = {s for s in seats if s not in folded_pre}
        for s in saw:
            f[s]["saw_flop"] = 1
    flop = [e for e in acts if e.get("street") == "flop" and e["a"] not in FORCED]
    agg = last_raiser if not hand.get("bomb") else None
    bet_made = False
    cbet_open = False                        # префлоп-агрессор поставил на флопе, рейза после ещё не было
    acted = set()
    responded = set()                        # уже ответили на c-bet
    checked = set()                          # сделали check на флопе, пока ставки не было
    bet_after_check = False
    for e in flop:
        s, a = e["seat"], e["a"]
        if s not in f:
            continue
        first = s not in acted
        acted.add(s)
        if s == agg and first:
            f[s]["cb_opp"] = int(not bet_made)
            f[s]["cb"] = int(not bet_made and a == "bet")
            if f[s]["cb"]:
                cbet_open = True
        elif cbet_open and s not in responded:          # первый ответ на c-bet (и у тех, кто до неё сделал check)
            responded.add(s)
            f[s]["fcb_opp"] = 1
            f[s]["fcb"] = int(a == "fold")
        if s in checked and bet_after_check and not f[s]["cr_opp"]:
            f[s]["cr_opp"] = 1
            f[s]["cr"] = int(a == "raise")
        if a == "check" and not bet_made:
            checked.add(s)
        if a in ("bet", "raise"):
            if bet_made and a == "raise":
                cbet_open = False            # рейз после c-bet — дальше уже не «ответ на c-bet»
            bet_made = True
            if checked - {s}:
                bet_after_check = True

    # ---------- вскрытие ----------
    showdown = {int(s) for s in hand.get("showdown") or []}
    contested = {int(s) for s in hand.get("contested") or []}
    shown = _seatmap(hand.get("shown"))
    for s in seats:
        if f[s]["saw_flop"] and s in showdown:
            f[s]["wtsd"] = 1
        if s in showdown and s in contested:
            f[s]["wsd"] = 1
        cards = shown.get(s) or []
        f[s]["sd_shown"] = int(any(c != "back" for c in cards))
    if hand.get("bomb"):                     # бомб-пот: торговли до флопа нет
        for s in seats:
            for k in ("pf_opp", "vpip", "pfr", "tb_opp", "tb", "f3b_opp", "f3b", "st_opp", "st", "cb_opp", "cb", "fcb_opp", "fcb"):
                f[s][k] = 0
    return f
