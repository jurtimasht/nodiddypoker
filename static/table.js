// NoDiddyPoker — часть, которая работает в браузере.
// Держит «живую» связь с сервером, рисует стол и отправляет ходы.
// Все правила и карты — на сервере. Браузер только показывает то, что прислал сервер.

const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\/table\/?$/, "").replace(/\/+$/, "");   // "/poker"
const TABLE_ID = new URLSearchParams(location.search).get("t") || "";            // какой стол открыт (?t=violet)
const KEY_TOKEN = "poker-token";    // ключ своего места за столом (чтобы вернуться после обновления страницы)
const KEY_PROFILE = "poker-profile"; // ключ профиля из лобби (ник и фото)
let profileMe = null;               // мой профиль {id, name, avatar}
const KEY_HIST = "poker-hist";      // открыта ли история раздач
const KEY_CHAT = "poker-chat";      // открыт ли чат
const KEY_UNITS = "poker-units";    // показывать суммы в фишках ("") или в больших блайндах ("bb")

function load(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
function save(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) {} }

let ws = null;
let state = null;
let watching = false;           // нажал «Просто смотреть»
let retry = 1000;
let failedInRow = 0;            // сколько раз подряд не удалось подключиться
let deadline = null;            // когда закончится время хода (по часам браузера)
let lastActionKey = "";
let wasMyTurn = false;
let units = load(KEY_UNITS) === "bb" ? "bb" : "chips";
let raiseTo = 0;                            // выбранная сумма рейза (всегда в фишках)
let seenCards = { hand: -1, seats: {} };    // какие карты были у соперников на экране (для анимации фолда)
let mucks = {};                             // место -> {cards, start}: карты, которые сейчас «улетают» после фолда
const MUCK_MS = 550;
let pre = null;                 // заранее выбранный ход: {kind: "xf" | "any" | "call", amount, key}
let bustClosed = false;         // закрыл окно «Фишки закончились» — не показывать, пока снова не проиграешь всё
let bustWasOpen = false;
let bustSince = null;           // когда фишки закончились (окно докупки появится не сразу)
const BUST_DELAY = 4000;
let rebuyEnds = {};             // место -> когда кончится отсчёт докупки (performance.now)
let rebuyStarts = {};           // место -> когда начнётся отсчёт докупки        // 4 секунды — успеть посмотреть вскрытие, кто и чем выиграл

// ---------- связь с сервером ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}${base}/ws?t=${encodeURIComponent(TABLE_ID)}`);
  ws.onopen = () => {
    retry = 1000;
    failedInRow = 0;
    $("offline").hidden = true;
    send({ type: "hello", token: load(KEY_TOKEN), profile: load(KEY_PROFILE) });
    if (!$("logpanel").hidden) send({ type: "history_list" });
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      state = msg;
      // Отсчёт докупки: запоминаем, когда он кончится, по часам браузера
      rebuyEnds = {};
      rebuyStarts = {};
      msg.seats.forEach((p, i) => {
        if (p && p.rebuying != null) rebuyEnds[i] = performance.now() + p.rebuying * 1000;
        if (p && p.rebuy_in != null) rebuyStarts[i] = performance.now() + p.rebuy_in * 1000;
      });
      render();
    }
    else if (msg.type === "token") { save(KEY_TOKEN, msg.token); }
    else if (msg.type === "chat_history") {
      chatItems = msg.items;
      renderChat();
      profileMe = msg.me;
      if (!profileMe) { location.href = "./"; return; }      // без профиля — сначала в лобби
      showMe();
      render();
    }
    else if (msg.type === "chat") { gotChat(msg.msg); }
    else if (msg.type === "throw") { showThrow(msg); }
    else if (msg.type === "history_list") { histItems = msg.items; renderHistList(); }
    else if (msg.type === "history_hand") { openReplay(msg.hand); }
    else if (msg.type === "error") { toast(msg.text); }
    else if (msg.type === "auth") { ws.onclose = null; location.href = "./"; return; }   // не вошёл / вход устарел — в лобби
    else if (msg.type === "elsewhere") { location.replace(`table?t=${encodeURIComponent(msg.table)}`); }   // ты сидишь за другим столом
  };
  ws.onclose = (event) => {
    $("offline").hidden = false;
    // Не подключается несколько раз подряд — скорее всего, закончился вход. Обновим страницу: она попросит пароль.
    if (++failedInRow >= 3 && !event.wasClean) { location.reload(); return; }
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function act(action, amount) { send({ type: "act", action, amount }); }

// ---------- мелкие помощники ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;     // textContent: имя игрока никогда не станет кодом
  return node;
}
const fmt = (n) => Number(n).toLocaleString("en-US");
// Сумма в выбранных единицах: фишки (2 380) или большие блайнды (23,8 BB)
function amt(n) {
  if (units !== "bb" || !state) return fmt(n);
  return Number((n / state.bb).toFixed(2)).toLocaleString("en-US") + " BB";
}
// Тексты с сервера: суммы помечены §…§ — показываем их в выбранных единицах
const txt = (text) => String(text).replace(/§(\d+)§/g, (_, n) => amt(Number(n)));

function toggleUnits() {
  units = units === "bb" ? "chips" : "bb";
  save(KEY_UNITS, units === "bb" ? "bb" : "");
  toast(units === "bb" ? "Amounts in big blinds (BB)" : "Amounts in chips");
  render();
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

// Карта: цвет фона = масть (♠ серая, ♥ красная, ♦ синяя, ♣ зелёная), крупное достоинство слева сверху
const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
function cardEl(card, size) {
  const node = el("div", "card" + (size ? " " + size : ""));
  if (card === "back") { node.classList.add("back"); return node; }
  if (!card) { node.classList.add("slot"); return node; }
  node.classList.add("s-" + card[1]);
  node.append(el("span", "r", card[0] === "T" ? "10" : card[0]),
              el("span", "s", SUIT[card[1]]),
              el("span", "big", card[0] === "T" ? "10" : card[0]));   // большое значение внизу справа
  return node;
}

// Цвет аватарки — из ника, чтобы у каждого был свой и не менялся
function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Звук «твой ход» (короткий сигнал, без файлов)
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
}

// ---------- места вокруг стола ----------
// Точки (в % от размера стола) по часовой стрелке, начиная снизу по центру.
// Ты всегда сидишь снизу — остальные раскладываются вокруг.
// Heads-up (2 места): ты снизу, соперник сверху по центру.
const SPOTS = [[50, 88], [16, 79], [6, 44], [27, 8], [73, 8], [94, 44], [84, 79]];
const SPOTS_HU = [[50, 88], [50, 8]];
const seatCount = () => (state && state.seats ? state.seats.length : 7);
function spot(seat) {
  const n = seatCount();
  const mine = state.you ? state.you.seat : 0;
  return (n === 2 ? SPOTS_HU : SPOTS)[(seat - mine + n) % n];
}
function toward(pos, k) {              // точка между местом и центром стола
  return [pos[0] + (50 - pos[0]) * k, pos[1] + (46 - pos[1]) * k];
}
function place(node, pos) { node.style.left = pos[0] + "%"; node.style.top = pos[1] + "%"; }

function tagClass(text) {
  if (text.startsWith("Fold")) return "fold";
  if (text.startsWith("All-in")) return "allin";
  if (text.startsWith("Raise") || text.startsWith("Bet")) return "raise";
  return "";
}

// 50 -> "50s", 60 -> "1:00", 75 -> "1:15"
function clockText(secs) {
  secs = Math.max(0, Math.round(secs));
  return secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
}

// ---------- bad beat ----------
let badbeatTimer;
function showBadbeat(bb) {
  $("bbtext").replaceChildren(el("b", "", "BAD BEAT"), el("span", "", `${bb.name} lost with ${bb.equity}%`));
  const box = $("badbeat"), inner = $("bbinner"), room = $("room");
  // Сначала стол трясётся, потом из ниоткуда появляется картинка в золотом сиянии
  room.classList.remove("quake");
  void room.offsetWidth;
  room.classList.add("quake");
  clearTimeout(badbeatTimer);
  badbeatTimer = setTimeout(() => {
    room.classList.remove("quake");
    box.hidden = false;
    box.classList.remove("play");
    void box.offsetWidth;                  // перезапустить анимацию
    box.classList.add("play");
    badbeatTimer = setTimeout(() => { box.hidden = true; box.classList.remove("play"); }, BADBEAT_MS);
  }, QUAKE_MS);
}

// ---------- анимации ----------
// Стол перерисовывается при каждом событии. Чтобы анимация не начиналась заново при каждой
// перерисовке, запоминаем, КОГДА она началась (по ключу), и продолжаем с того же места.
const TW = 1120, TH = 590;          // размер стола на «сцене» (см. table.css) — для расчёта полётов в пикселях
const POT_POS = [50, 34];           // где на столе банк (в %)
let anims = new Map();              // ключ -> когда началась анимация
let animHand = -1;
let firstPaint = true;              // при первом открытии страницы ничего не анимируем
let ghosts = [];                    // «летящие» фишки: ставки в банк, банк к победителю
let prev = null;                    // как стол выглядел в прошлый раз
let prevDealerSpot = null;
let lastRefundId = null;
let lastBadbeat = null;             // последний показанный bad beat
const BADBEAT_MS = 5000;            // картинка: появляется ~1,5 с, сияет ~2,7 с, исчезает ~0,8 с
const QUAKE_MS = 750;               // перед ней стол трясётся            // картинка появляется ~1,2 с, держится, исчезает — всего ~2,4 с            // последний показанный возврат неуравненной ставки
let chatItems = [];                 // сообщения чата
let unread = 0;                     // сколько новых сообщений, пока чат закрыт
let bubbles = {};                   // место -> {text, until}: облачко с сообщением над игроком

function play(node, key, cls, ms, delay = 0) {
  const now = performance.now();
  if (!anims.has(key)) anims.set(key, firstPaint ? -1e9 : now);
  const elapsed = now - anims.get(key);
  if (elapsed >= ms + delay) return;                 // уже доиграла
  node.classList.add(cls);
  node.style.animationDuration = `${ms}ms`;
  node.style.animationDelay = `${Math.round(delay - elapsed)}ms`;
}
const later = (ms) => setTimeout(render, Math.max(0, ms) + 20);
const px = (from, to) => [`${(to[0] - from[0]) / 100 * TW}px`, `${(to[1] - from[1]) / 100 * TH}px`];

// ---------- рисуем всё ----------
function render() {
  if (!state) return;
  const s = state;
  const me = s.you;
  const mySeat = me ? s.seats[me.seat] : null;

  const blinds = $("blinds");
  document.body.classList.toggle("mtt", Boolean(s.mtt));
  if (s.mtt) renderMttBar(s);
  else blinds.replaceChildren(el("b", "tname", s.table_name || ""), " · ", el("b", "game", gameLabel(s)),
    ...(s.bomb ? [" · bomb pot ", el("b", "", `${fmt(s.bomb)} (${s.bomb / s.bb} BB)`)] : [" · blinds ", el("b", "", `${fmt(s.sb)}/${fmt(s.bb)}`)]),
    ...(s.double_board ? [" · ", el("b", "", "double board")] : []),
    ...(s.buyins ? [" · buy-in ", el("b", "", s.buyins.map(fmt).join(" / "))] : [" · buy-in from ", el("b", "", fmt(s.min_buyin))]));

  const now = performance.now();
  if (animHand !== s.hand_no) { anims = new Map(); animHand = s.hand_no; }
  if (seenCards.hand !== s.hand_no) { seenCards = { hand: s.hand_no, seats: {} }; mucks = {}; }

  // Что изменилось с прошлого раза: улица закончилась — ставки съезжаются в банк;
  // раздача закончилась — банк уезжает к победителю
  if (!firstPaint && prev && prev.hand === s.hand_no && prev.running) {
    if (prev.street !== s.street || !s.running) {
      for (const [seat, bet] of Object.entries(prev.bets)) {
        ghosts.push({ text: amt(bet), from: toward(spot(Number(seat)), 0.4), to: POT_POS, start: now, ms: 380 });
      }
    }
    if (!s.running && s.result) {
      const winners = s.seats.map((p, i) => (p && p.winner ? i : -1)).filter((i) => i >= 0);
      for (const w of winners) {
        ghosts.push({ text: winners.length === 1 ? amt(prev.pot) : "", from: POT_POS, to: spot(w), start: now + 380, ms: 600, win: true });
      }
    }
  }

  // Неуравненная часть ставки возвращается игроку: фишки едут со стола обратно к нему
  if (s.refund && s.refund.id !== lastRefundId) {
    if (!firstPaint) {
      const rp = spot(s.refund.seat);
      ghosts.push({ text: amt(s.refund.amount), from: toward(rp, 0.4), to: rp, start: now, ms: 550, back: true });
    }
    lastRefundId = s.refund.id;
  }
  const freshRefund = s.refund && anims.get(`refund:${s.refund.id}`) === undefined && !firstPaint ? s.refund.seat : null;
  if (s.refund) anims.set(`refund:${s.refund.id}`, true);

  // Bad beat: кто-то проиграл олл-ин, имея больше 69% — картинка у всех
  if (s.badbeat && s.badbeat.id !== lastBadbeat) {
    lastBadbeat = s.badbeat.id;
    if (!firstPaint) showBadbeat(s.badbeat);
  }

  // Банк и общие карты
  const pot = $("pot");
  pot.replaceChildren();
  if (s.pot) {
    const value = el("span", "", amt(s.pot));
    play(value, `pot:${s.pot}`, "bump", 320);                     // банк вырос — число «подпрыгивает»
    pot.append("Pot", value);
  }

  // Общие карты. При двух досках — два ряда карт поменьше (верхняя доска — 1-я, нижняя — 2-я)
  const two = Boolean(s.board2);
  const drawBoard = (node, cards, key) => {
    node.replaceChildren();
    node.classList.toggle("double", two);
    for (let i = 0; i < 5; i++) {
      const card = cardEl(cards[i] || "", two ? "md" : "");
      if (cards[i]) play(card, `${key}:${i}`, "deal", 450, (i < 3 ? i * 70 : 0) + (key === "board2" ? 120 : 0));   // новая карта переворачивается и ложится
      node.append(card);
    }
  };
  drawBoard($("board"), s.board, "board");
  $("board2").hidden = !two;
  if (two) drawBoard($("board2"), s.board2, "board2");
  const result = $("result");
  result.replaceChildren(...(s.result || []).map((line) => el("div", "", txt(line))));
  result.classList.remove("fadeUp");
  if (s.result) play(result, "result", "fadeUp", 400, 250);

  // Олл-ин или вскрытие: всё затемняется, кроме игроков, которые борются за банк (и общих карт)
  const involved = new Set();
  if (s.runout) s.seats.forEach((p, i) => { if (p && p.in_hand && !p.folded) involved.add(i); });
  else if (!s.running) s.seats.forEach((p, i) => { if (p && p.hand) involved.add(i); });
  $("stage").classList.toggle("spotlight", involved.size > 0);

  // Места
  const seats = $("seats");
  seats.replaceChildren();
  s.seats.forEach((p, i) => {
    const pos = spot(i);
    if (!p) {
      const empty = el("div", "empty", "empty");
      place(empty, pos);
      seats.append(empty);
      return;
    }
    const isMe = Boolean(me && me.seat === i);
    const box = el("div", "seat");
    box.classList.toggle("me", isMe);
    box.classList.toggle("actor", s.running && s.actor === i);
    box.classList.toggle("folded", p.folded);
    box.classList.toggle("out", !p.in_hand);
    box.classList.toggle("winner", p.winner);
    box.classList.toggle("gone", !p.online);              // закрыл сайт (не путать с красной полосой .offline)
    box.classList.toggle("involved", involved.has(i));
    box.dataset.throwSeat = i;
    if (me && !isMe) {                                    // клик по сопернику — чем в него кинуть
      box.classList.add("throwable");
      box.title = "Click to throw something";
    }

    // Карты: свои — большие и открытые; чужие — поверх аватарки (рубашкой или открытые на вскрытии).
    // Раздача: карты прилетают из центра стола по кругу, начиная слева от дилера.
    const hole = el("div", "hole");
    const [fx, fy] = px(pos, [50, 46]);
    hole.style.setProperty("--fx", fx);
    hole.style.setProperty("--fy", fy);
    hole.style.setProperty("--dx", `calc(${fx} * .45)`);
    hole.style.setProperty("--dy", `calc(${fy} * .45)`);
    const order = (i - s.dealer - 1 + s.seats.length) % s.seats.length;
    const showCards = (cards, size) => cards.forEach((c, ci) => {
      const card = cardEl(c, size);
      hole.classList.add("n" + cards.length);          // 2, 4 или 5 карт — от этого зависит, насколько они перекрываются
      play(card, `deal:${i}:${ci}`, "dealIn", 380, (ci * 7 + order) * (cards.length > 2 ? 22 : 45));   // 4–5 карт раздаются быстрее
      if (!isMe && c !== "back") play(card, `reveal:${i}:${ci}`, "flipIn", 420, ci * 90);  // вскрытие: карта переворачивается
      hole.append(card);
    });
    if (isMe) {
      showCards(p.cards, "lg");
      // Клик по своей карте — показать её всем (обе — кликнуть по обеим). Во время раздачи — откроется в конце.
      if (me.can_show) {
        hole.classList.add("showable");
        const pending = me.show_pending || [], shown = me.shown || [];
        hole.querySelectorAll(".card").forEach((card, ci) => {
          if (shown.includes(ci)) { card.classList.add("shown"); card.title = "Everyone sees this card"; return; }
          card.classList.add("clickable");
          card.classList.toggle("pending", pending.includes(ci));
          if (pending.includes(ci)) card.append(el("span", "eye", "👁"));     // глазок в углу: эту карту покажу
          card.title = pending.includes(ci) ? "Will be shown when the hand ends — click to cancel"
                     : s.running ? "Click to show this card when the hand ends" : "Click to show this card to everyone";
          card.onclick = () => send({ type: "show", card: ci });
        });
      }
      box.append(hole);
    } else {
      // Соперник только что сбросил карты — они «улетают» в центр стола
      const had = seenCards.seats[i] || [];
      if (p.folded && !p.cards.length && had.length && !mucks[i]) mucks[i] = { cards: had, start: now };
      if (p.cards.length) {
        showCards(p.cards, "md");
        seenCards.seats[i] = p.cards;
      } else if (mucks[i] && now - mucks[i].start < MUCK_MS) {
        for (const c of mucks[i].cards) {
          const card = cardEl(c, "md");
          card.classList.add("muck");
          card.style.animationDelay = `-${Math.round(now - mucks[i].start)}ms`;   // продолжить, а не начать заново
          hole.append(card);
        }
        later(MUCK_MS - (now - mucks[i].start));                                // потом убрать совсем
      }
      const pic = el("div", "pic");
      const avatar = el("div", "avatar" + (p.avatar ? " photo" : ""), p.avatar ? "" : [...p.name][0].toUpperCase());
      avatar.style.setProperty("--hue", hue(p.name));
      if (p.avatar) avatar.style.backgroundImage = `url("${p.avatar}")`;   // фото профиля из лобби
      pic.append(avatar, hole);
      pic.classList.toggle("nocards", !hole.children.length);     // без карт фото опускается ближе к имени
      box.append(pic);
    }

    const plate = el("div", "plate");
    const stack = el("div", "stack", amt(p.stack));
    // Фишек стало больше (выигрыш, возврат) — число подпрыгивает, когда фишки «доедут»
    const before = prev && prev.stacks ? prev.stacks[i] : undefined;
    if (before !== undefined && p.stack > before) {
      anims.set(`stackup:${i}:${p.stack}:delay`, p.winner && !s.running ? 950 : freshRefund === i ? 450 : 0);
    }
    if (anims.has(`stackup:${i}:${p.stack}:delay`)) play(stack, `stackup:${i}:${p.stack}`, "bump", 420, anims.get(`stackup:${i}:${p.stack}:delay`));
    plate.append(el("div", "name", p.name), stack);
    if (isMe) {
      // Правый клик по своему имени: фишки <-> большие блайнды
      plate.title = "Right-click: show amounts in chips or BB";
      plate.oncontextmenu = (e) => { e.preventDefault(); toggleUnits(); };
    }
    // Значок в углу плашки: «отошёл», «не в сети» (плюс/минус за вечер — в окне 📊 Итоги)
    // Пометки над плашкой: «sitting out», «in lobby», красным — «left the website»
    // Ушёл с сайта — показываем только это (без «sitting out» и прочего)
    const marks = [];
    if (!p.online) marks.push(el("span", "left", "left"));
    else {
      if (p.away) marks.push(el("span", "away", "sitting out"));
      if (p.lobby) marks.push(el("span", "lobby", "in lobby"));
    }
    // Докупается: золотая надпись с отсчётом прямо над именем
    if (rebuyEnds[i] != null) {
      const rb = el("div", "rebuying", "rebuying…");
      rb.dataset.seat = i;
      plate.append(rb);
    }
    if (marks.length) {
      // Пометки — маленькие «таблетки» на нижнем крае плашки, имя не закрывают
      const note = el("div", "note");
      note.append(...marks);
      plate.append(note);
      box.classList.add("noted");
    }

    // Тайм-чип: маленький значок, пока чип на этой улице ещё не потрачен
    if (s.running && !s.runout && p.in_hand && !p.folded && !p.all_in) {
      // Запас времени: до флопа свой, после флопа общий на флоп, тёрн и ривер (сколько осталось)
      const pre = s.street === "preflop";
      const left = pre ? p.bank_pre : p.bank_post;
      const tchip = el("div", "tchip" + (left > 0 ? "" : " used"), clockText(left));
      tchip.title = left > 0 ? `Time bank: ${left}s left${pre ? " (preflop)" : " for the flop, turn and river"}` : "Time bank used up";
      plate.append(tchip);
    }
    // Тайм-чип сработал: большой жетон «+10s» вылетает над игроком, полоска времени синеет
    if (s.timebank && s.actor === i) {
      box.classList.add("banked");
      const secs = s.timebank.secs;
      const key = `tb:${s.timebank.id}`;
      if (!firstPaint && (!anims.has(key) || now - anims.get(key) < 1400)) {   // жетон показываем только пока он летит
        const burst = el("div", "tb-burst", `⏱ +${clockText(secs)}`);
        play(burst, key, "chipPop", 1400);
        box.append(burst);
        later(1400 - (now - anims.get(key)));
      }
    }

    // Облачко с сообщением из чата
    const bubble = bubbles[i];
    if (bubble && bubble.until > now) {
      box.append(el("div", "bubble" + (pos[1] < 30 ? " below" : ""), bubble.text));
      later(bubble.until - now);
    }

    // Олл-ин: шанс игрока выиграть банк — рядом с плашкой (у лидера зелёный)
    // Две доски — две таблички (B1 и B2), каждая со своими шансами. Лидер — зелёный, проигрывающий — красный, 0% — 💀
    if (s.equity && s.equity[i] != null) {
      const wrap = el("div", "eqwrap" + (pos[0] > 50 ? " left" : "") + (s.equity2 ? " two" : ""));
      const boards = s.equity2 ? [[s.equity, "B1"], [s.equity2, "B2"]] : [[s.equity, ""]];
      for (const [eq, label] of boards) {
        const v = eq[i];
        const dead = v === 0;
        const lead = !dead && v === Math.max(...Object.values(eq));
        const badge = el("div", "equity " + (lead ? "lead" : dead ? "dead" : "lose"));
        const shown = dead ? "💀" : v === 100 ? "100%" : v < 1 ? "<1%" : v > 99 ? ">99%" : `${Math.round(v)}%`;
        if (label) badge.append(el("small", "", label));
        badge.append(el("b", "", shown));
        if (!label) badge.append(el("small", "", dead ? "dead" : "equity"));
        badge.title = dead ? "Can no longer win" + (label ? ` on board ${label[1]}` : "")
          : `Chance to win ${label ? "half the pot on board " + label[1] : "the pot"}: ${Number(v.toFixed(1)).toLocaleString("en-US")}%`;
        wrap.append(badge);
      }
      play(wrap, `eq:${s.board.length}:${i}`, "eqIn", 320);
      plate.append(wrap);
    }

    const timer = el("div", "timer");
    timer.append(el("i"));

    // Отметка хода — под плашкой, «поверх» (не сдвигает имя). Новая отметка слегка «выпрыгивает».
    const text = p.hand || (p.all_in && !p.last.startsWith("All") ? "All-in" : p.last);
    const tag = el("div", "tag " + (p.hand ? "hand" : tagClass(text)), txt(text));
    if (text) play(tag, `tag:${s.street}:${i}:${text}`, "pop", 220);

    box.append(plate, timer, tag);
    place(box, pos);
    seats.append(box);

    // Ставка: фишки выезжают от игрока на стол
    if (p.bet > 0) {
      const bpos = toward(pos, 0.4);
      const bet = el("div", "bet", amt(p.bet));
      place(bet, bpos);
      const [bx, by] = px(bpos, pos);
      bet.style.setProperty("--fx", bx);
      bet.style.setProperty("--fy", by);
      // ставка выросла — фишки выезжают от игрока; уменьшилась (возврат) — без выезда
      const was = prev && prev.hand === s.hand_no && prev.street === s.street ? (prev.bets[i] || 0) : 0;
      if (p.bet < was) anims.set(`bet:${s.street}:${i}:${p.bet}`, -1e9);
      play(bet, `bet:${s.street}:${i}:${p.bet}`, "slideIn", 300);
      seats.append(bet);
    }
    // Кнопка дилера: в новой раздаче переезжает от прошлого дилера
    if (s.dealer === i && (s.running || s.hand_no > 0)) {
      const d = el("div", "dealer", "D");
      const dpos = toward(pos, 0.26);
      const dspot = [dpos[0] + (pos[0] <= 50 ? 7 : -7), dpos[1]];
      place(d, dspot);
      if (prevDealerSpot && !anims.has("dealer")) {
        const [ox, oy] = px(dspot, prevDealerSpot);
        anims.set("dealer:from", [ox, oy]);
      }
      const from = anims.get("dealer:from") || ["0px", "0px"];
      d.style.setProperty("--fx", from[0]);
      d.style.setProperty("--fy", from[1]);
      play(d, "dealer", "slideIn", 500);
      prevDealerSpot = dspot;
      seats.append(d);
    }
  });

  // Летящие фишки (поверх всего)
  ghosts = ghosts.filter((g) => now - g.start < g.ms);
  for (const g of ghosts) {
    const node = el("div", "bet ghost" + (g.win ? " win" : "") + (g.back ? " back" : ""), g.text);
    place(node, g.from);
    const [tx, ty] = px(g.from, g.to);
    node.style.setProperty("--tx", tx);
    node.style.setProperty("--ty", ty);
    node.style.animationDuration = `${g.ms}ms`;
    node.style.animationDelay = `${Math.round(g.start - now)}ms`;
    seats.append(node);
    later(g.start + g.ms - now);
  }

  prev = {
    hand: s.hand_no, street: s.street, running: s.running, pot: s.pot,
    bets: Object.fromEntries(s.seats.map((p, i) => [i, p ? p.bet : 0]).filter(([, b]) => b > 0)),
    stacks: Object.fromEntries(s.seats.map((p, i) => [i, p ? p.stack : undefined]).filter(([, v]) => v !== undefined)),
  };
  firstPaint = false;
  checkThrowbox();

  // Таймер
  deadline = s.time_left != null ? performance.now() + s.time_left * 1000 : null;
  updateTimer();

  // Твой ход и заранее выбран ход серой кнопкой — делаем его сразу, без кнопок и сигнала
  if (me && me.options && pre) {
    const action = preAction(me.options);
    pre = null;
    if (action) { act(action); me.options = null; }
  }

  renderStatus(me);
  renderActions(me, mySeat);
  renderPre(me, mySeat);
  renderBust(me, mySeat);
  renderMine(me, mySeat);
  // Закончилась раздача — обновить список в истории (если открыт)
  const finished = s.running ? s.hand_no - 1 : s.hand_no;
  if (finished !== histKnown) { histKnown = finished; if (!$("logpanel").hidden) send({ type: "history_list" }); }
  if (!$("ledger").hidden) renderLedger();
  if (replay) renderReplay();

  // Окно «Сесть за стол»
  const full = s.seats.every(Boolean);
  $("join").hidden = Boolean(me) || watching || !profileMe || Boolean(s.mtt);   // за стол турнира садятся из лобби
  $("sit").disabled = full;
  $("joininfo").textContent = full ? `All ${s.seats.length} seats are taken. You can watch the game.` : `You will sit as "${profileMe ? profileMe.name : ""}".`;
  const buyin = $("buyin");
  buyin.min = s.min_buyin;
  buyin.max = s.max_buyin;
  if (!buyin.value) buyin.value = load("poker-buyin") || s.min_buyin;
  $("buyinhint").textContent = s.buyins ? `Blinds ${fmt(s.sb)}/${fmt(s.bb)}.` : `Minimum ${fmt(s.min_buyin)}. Blinds ${fmt(s.sb)}/${fmt(s.bb)}.`;
  if (!$("join").hidden) buyinChoices("buyinfield", "buyinlabel", "buyinpick", "buyin");
}

function renderStatus(me) {
  const s = state, status = $("status");
  const myTurn = Boolean(me && me.options);
  const hand = me && me.hand ? me.hand : "";
  status.classList.toggle("turn", myTurn);
  // Комбинация — отдельной маленькой строкой под надписью (просто «Flush», без «you have»)
  const show = (main) => status.replaceChildren(...(main ? [el("span", "main", main)] : []), ...(hand ? [el("span", "combo", hand)] : []));
  if (myTurn || s.runout || s.running) {                  // без «Your turn» / «All-in» — только комбинация
    show("");
  } else if (s.next_in == null) {
    status.textContent = "Waiting for players…";            // за столом меньше двух готовых игроков
  } else {
    status.textContent = "";                          // короткая пауза между раздачами — без надписей
  }

  // Сигнал и заголовок вкладки, когда наступает твой ход
  if (myTurn && !wasMyTurn) { beep(); document.title = "🔔 Your turn — NoDiddyPoker"; }
  if (!myTurn) document.title = `${state.table_name || "Table"} ${fmt(state.sb)}/${fmt(state.bb)} — NoDiddyPoker`;
  wasMyTurn = myTurn;
}

// Быстрые размеры ставки: до флопа — во сколько раз больше текущей ставки, после флопа — доля банка
function presets(o) {
  const s = state;
  const potParts = () => [["⅓", 1 / 3], ["½", 1 / 2], ["¾", 3 / 4], ["Pot", 1]].map(([label, part]) =>
    [label, s.current_bet + (s.pot + o.call) * part]);
  // Пот-лимит (Омаха): больше банка поставить нельзя — кнопки «доля банка», «Pot» = максимум
  if (o.pot_limit) return potParts().map(([label, v]) => [label, Math.max(o.min_to, Math.min(o.max_to, Math.round(v)))]);
  const list = s.street === "preflop"
    ? [["2.5x", s.current_bet * 2.5], ["3x", s.current_bet * 3], ["4x", s.current_bet * 4]]
    : potParts();
  list.push(["Max", o.max_to]);
  return list.map(([label, v]) => [label, Math.max(o.min_to, Math.min(o.max_to, Math.round(v)))]);
}

// ---------- предвыбор хода (пока ходит соперник) ----------
const streetKey = () => `${state.hand_no}:${state.street}`;

// Что сделать, когда наступит твой ход. null — ничего (ставку подняли, решай сам).
function preAction(o) {
  if (pre.key !== streetKey()) return null;
  if (pre.kind === "xf") return o.check ? "check" : "fold";            // чек, а если ставят — фолд
  if (pre.kind === "any") return o.check ? "check" : "call";           // колл любой ставки
  if (pre.kind === "call") {                                           // колл ровно этой суммы
    if (pre.amount === 0) return o.check ? "check" : null;
    return !o.check && o.call === pre.amount ? "call" : null;
  }
  return null;
}

function renderPre(me, mySeat) {
  const s = state, box = $("pre");
  const show = Boolean(me && !me.options && s.running && !s.runout && mySeat.in_hand && !mySeat.folded && !mySeat.all_in);
  if (pre && pre.key !== streetKey()) pre = null;                      // новая улица — выбор сбрасывается
  const toCall = mySeat ? Math.max(0, Math.min(s.current_bet - mySeat.bet, mySeat.stack)) : 0;
  if (pre && pre.kind === "call" && pre.amount !== toCall) pre = null; // ставку подняли — «колл X» отменяется
  box.hidden = !show;
  if (!show) return;
  for (const b of box.querySelectorAll("button")) {
    const kind = b.dataset.kind;
    if (kind === "call") b.textContent = toCall > 0 ? `Call ${amt(toCall)}` : "Check";
    b.classList.toggle("on", Boolean(pre && pre.kind === kind));
    b.onclick = () => {
      pre = pre && pre.kind === kind ? null : { kind, amount: toCall, key: streetKey() };
      renderPre(me, mySeat);
    };
  }
}

// ---------- фишки закончились: окно докупки по центру ----------
function renderBust(me, mySeat) {
  if (state.mtt) { $("bust").hidden = true; renderMttOut(state.mtt); return; }   // в турнире — своё окно «ты вылетел»
  const busted = Boolean(me && mySeat.stack === 0 && !(state.running && mySeat.in_hand));
  if (!busted) {
    bustClosed = false;                                                // снова с фишками — в следующий раз окно покажется
    bustSince = null;
  } else if (bustSince === null) {
    bustSince = performance.now();                                     // только что проиграл всё: ждём 4 секунды
    setTimeout(render, BUST_DELAY + 50);
  }
  const my = me ? me.seat : -1;
  const starting = rebuyStarts[my] != null && performance.now() < rebuyStarts[my];     // ещё идёт вскрытие / bad beat
  if (starting) setTimeout(render, rebuyStarts[my] - performance.now() + 50);
  const counting = rebuyEnds[my] != null && performance.now() < rebuyEnds[my];
  const waited = bustSince !== null && performance.now() - bustSince >= BUST_DELAY;
  const open = busted && !bustClosed && !starting && (counting || (waited && rebuyStarts[my] == null && rebuyEnds[my] == null));
  $("bustcount").hidden = !counting;
  $("bust").hidden = !open;
  if (open && !bustWasOpen) {
    $("bustamount").value = load("poker-buyin") || state.min_buyin;
    $("bustamount").min = state.min_buyin;
    $("bustamount").max = state.max_buyin;
    $("busthint").textContent = state.buyins ? "" : `Minimum ${fmt(state.min_buyin)} chips.`;
    if (!state.buyins) setTimeout(() => $("bustamount").focus(), 0);
  }
  if (open) buyinChoices("bustfield", "bustlabel", "bustpick", "bustamount");
  bustWasOpen = open;
}

function closeBust() { bustClosed = true; send({ type: "rebuy_skip" }); render(); }   // стол больше не ждёт
$("bustclose").onclick = closeBust;
$("bustwatch").onclick = closeBust;
$("bustform").onsubmit = (event) => {
  event.preventDefault();
  const amount = Number($("bustamount").value);
  if (!state.buyins && !(amount >= state.min_buyin)) { toast(`Minimum ${fmt(state.min_buyin)}`); return; }
  save("poker-buyin", amount);
  send({ type: "rebuy", amount });
};

function renderActions(me, mySeat) {
  const box = $("actions");
  const o = me && me.options;
  box.hidden = !o;
  if (!o) { lastActionKey = ""; return; }

  const s = state;
  // Не сбрасывать ползунок, пока ты думаешь (если стол обновился по другой причине)
  const key = `${s.hand_no}:${s.street}:${s.current_bet}`;
  const fresh = key !== lastActionKey;
  lastActionKey = key;

  const call = $("call");
  if (o.check) {
    call.querySelector(".l").textContent = "Check";
    call.querySelector(".v").textContent = "";
    call.onclick = () => act("check");
  } else {
    call.querySelector(".l").textContent = o.call >= mySeat.stack ? "All-in" : "Call";
    call.querySelector(".v").textContent = amt(o.call);
    call.onclick = () => act("call");
  }
  $("fold").onclick = () => {
    if (o.check && !confirm(T("You can check for free. Fold anyway?"))) return;
    act("fold");
  };

  const raise = $("raise");
  raise.hidden = !o.raise;
  $("raisebox").hidden = !o.raise;
  $("actions").querySelector(".buttons").style.gridTemplateColumns = o.raise ? "" : "1fr 1fr";
  if (!o.raise) return;

  // Сумма рейза всегда хранится в фишках (raiseTo). Поле ввода показывает её в выбранных единицах.
  const slider = $("slider"), amount = $("amount");
  const inBB = units === "bb";
  const clamp = (v) => Math.max(o.min_to, Math.min(o.max_to, Math.round(v)));
  slider.min = o.min_to;
  slider.max = o.max_to;
  slider.step = 1;
  amount.step = inBB ? "0.01" : "1";
  amount.min = inBB ? o.min_to / s.bb : o.min_to;
  amount.max = inBB ? o.max_to / s.bb : o.max_to;
  if (fresh) raiseTo = o.min_to;
  raiseTo = clamp(raiseTo);
  const showAmount = () => { amount.value = inBB ? Number((raiseTo / s.bb).toFixed(2)) : raiseTo; };
  const label = () => {
    const allIn = raiseTo >= (o.all_in_to || o.max_to);      // в пот-лимите максимум может быть меньше всего стека
    raise.querySelector(".l").textContent = allIn ? "All-in" : (o.is_bet ? "Bet" : "Raise to");
    raise.querySelector(".v").textContent = amt(raiseTo);
  };
  const setTo = (v) => { raiseTo = clamp(v); slider.value = raiseTo; showAmount(); label(); };
  slider.value = raiseTo;
  if (document.activeElement !== amount) showAmount();      // не мешать, пока вписываешь сумму
  slider.oninput = () => setTo(Number(slider.value));
  amount.oninput = () => {
    const x = parseFloat(String(amount.value).replace(",", "."));
    if (isNaN(x)) return;
    raiseTo = clamp(inBB ? x * s.bb : x);
    slider.value = raiseTo;
    label();
  };
  amount.onblur = showAmount;
  amount.onkeydown = (e) => { if (e.key === "Enter") raise.click(); };

  const bar = $("presets");
  bar.replaceChildren(...presets(o).map(([text, v]) => {
    const b = el("button", "", text);
    b.type = "button";
    b.title = amt(v);
    b.onclick = () => setTo(v);
    return b;
  }));
  raise.onclick = () => act(raiseTo >= (o.all_in_to || o.max_to) ? "allin" : "raise", raiseTo);
  label();
}

function renderMine(me, mySeat) {
  const box = $("mine");
  // Если ты как раз вписываешь сумму докупки — не стирать её при обновлении стола
  const old = box.querySelector(".rebuy input");
  const typed = old ? { value: old.value, focused: document.activeElement === old } : null;
  box.replaceChildren();
  if (!me) {
    if (watching && !state.seats.every(Boolean) && !state.mtt) {
      const sit = el("button", "gold", "Take a seat");
      sit.onclick = () => { watching = false; render(); };
      box.append(sit);
    }
    return;
  }
  const inHand = state.running && mySeat.in_hand;
  if (state.mtt) {                                     // турнир: встать и докупиться за столом нельзя — только «отойти»
    const away = el("button", "", me.away ? "▶ I'm back" : "☕ Sit out");
    away.title = me.away ? "Get dealt in again" : "Your cards are folded for you until you come back";
    away.onclick = () => send({ type: "away", value: !me.away });
    box.append(away);
    return;
  }
  if (mySeat.stack === 0 && !inHand && state.buyins) {
    // Фишки закончились: три кнопки докупки (суммы стола)
    const wrap = el("div", "rebuy picks");
    wrap.append(el("span", "rlabel", "💰 Rebuy"));
    for (const v of state.buyins) {
      const b = el("button", "gold", fmt(v));
      b.onclick = () => { save("poker-buyin", v); send({ type: "rebuy", amount: v }); };
      wrap.append(b);
    }
    box.append(wrap);
  } else if (mySeat.stack === 0 && !inHand) {
    // Фишки закончились: докупка на сумму по выбору (не меньше минимального входа)
    const wrap = el("div", "rebuy");
    const input = el("input");
    input.type = "number";
    input.min = state.min_buyin;
    input.max = state.max_buyin;
    input.step = 1000;
    input.value = typed ? typed.value : (load("poker-buyin") || state.min_buyin);
    input.setAttribute("aria-label", "Rebuy amount");
    const b = el("button", "gold", "💰 Rebuy");
    b.onclick = () => { save("poker-buyin", input.value); send({ type: "rebuy", amount: Number(input.value) }); };
    input.onkeydown = (e) => { if (e.key === "Enter") b.click(); };
    wrap.append(input, b);
    box.append(wrap);
    if (typed && typed.focused) input.focus();
  }
  const away = el("button", "", me.away ? "▶ I'm back" : "☕ Sit out");
  away.title = me.away ? "Get dealt in again" : "Skip hands without leaving the table";
  away.onclick = () => send({ type: "away", value: !me.away });
  box.append(away);
  const leave = el("button", "", "🚪 Leave table");
  leave.onclick = () => {
    if (confirm(T("Leave the table? Your chips will be cashed out to the results."))) { send({ type: "leave" }); watching = true; }
  };
  box.append(leave);
}

// ---------- турнир: полоса в шапке и окно «ты вылетел» ----------
let mttLevelEnd = null;          // когда кончится уровень (по часам браузера)
function renderMttBar(s) {
  const m = s.mtt;
  const box = $("blinds");
  const tn = el("b", "tname", s.table_name || "");
  tn.dataset.notr = "";
  const parts = [tn, " · ", el("b", "", `Level ${m.level}`), " · ", el("b", "", `${fmt(m.sb)}/${fmt(m.bb)}` + (m.ante ? ` (${fmt(m.ante)})` : ""))];
  mttLevelEnd = m.level_left != null && m.status === "running" ? performance.now() + m.level_left * 1000 : null;
  if (m.status === "paused") parts.push(" · ", el("b", "paused", "Paused"));
  else if (m.level_left != null) parts.push(" · ", el("b", "mttclock", clockText(m.level_left)));
  parts.push(" · ", `${m.left} left`, " · ", `avg ${fmt(m.avg_stack)}`);
  box.replaceChildren(...parts);
}
setInterval(() => {
  const c = document.querySelector("#blinds .mttclock");
  if (c && mttLevelEnd) c.textContent = clockText(Math.max(0, (mttLevelEnd - performance.now()) / 1000));
}, 1000);

let mttOutClosed = null;         // какое окно закрыли (чтобы не показывать снова)
function renderMttOut(m) {
  const key = m.status === "finished" ? "won" : m.my_status === "out" ? `out-${m.my_place}` : null;
  const box = $("mttout");
  box.hidden = !key || mttOutClosed === key;
  if (box.hidden) return;
  const title = $("mttouttitle"), text = $("mttouttext");
  if (key === "won") {
    title.textContent = "🏆 Tournament over";
    text.replaceChildren();
    const w = el("b", "", m.winner || "");
    w.dataset.notr = "";
    text.append(w, " wins!");
  } else {
    title.textContent = `You finished ${ordinal(m.my_place)}`;
    text.textContent = m.can_rebuy ? "Rebuys are still open — you get the starting stack again." : "Thanks for playing! You can watch the rest.";
  }
  $("mttrebuy").hidden = key === "won" || !m.can_rebuy;
}
function ordinal(n) {
  if (!n) return "?";
  return n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}
$("mttwatch").onclick = () => {
  const m = state && state.mtt;
  mttOutClosed = m ? (m.status === "finished" ? "won" : `out-${m.my_place}`) : null;
  $("mttout").hidden = true;
};
$("mttrebuy").onclick = async () => {
  const m = state && state.mtt;
  if (!m) return;
  try {
    const res = await fetch(`api/mtt/${m.id}/rebuy`, { method: "POST", headers: { "Content-Type": "application/json", "X-Profile": load(KEY_PROFILE) }, body: "{}" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Error");
    $("mttout").hidden = true;
    toast("Rebuy done — you're back in.");
    location.reload();                    // сервер посадил за стол — откроем его
  } catch (e) { toast(e.message); }
};

// ---------- история раздач и повтор ----------
let histItems = [];
let histKnown = -1;
let replay = null;              // {hand, step, timer}: открытый повтор раздачи
const STREET_NAMES = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", end: "Result" };
const clock = (t) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function renderHistList() {
  const list = $("histlist");
  if (!histItems.length) { list.replaceChildren(el("li", "muted", "No hands played yet.")); return; }
  list.replaceChildren(...histItems.map((h) => {
    const li = el("li", "hist");
    const top = el("div", "row1");
    top.append(el("b", "", `#${h.no}`), el("span", "muted", ` ${clock(h.time)} · pot ${amt(h.pot)}`));
    if (h.my != null) {
      top.append(el("span", "my " + (h.my > 0 ? "up" : h.my < 0 ? "down" : ""), h.my > 0 ? `+${amt(h.my)}` : h.my < 0 ? `−${amt(-h.my)}` : "±0"));
    }
    const mini = el("div", "mini");
    for (const c of h.board) mini.append(cardEl(c, "xs"));
    li.append(top, el("div", "res", txt(h.result[0] || "")), mini);
    if (h.board2 && h.board2.length) {                       // вторая доска
      const mini2 = el("div", "mini");
      for (const c of h.board2) mini2.append(cardEl(c, "xs"));
      li.append(mini2);
    }
    li.onclick = () => send({ type: "history_hand", no: h.no });
    return li;
  }));
}

function showHist(open) {
  $("logpanel").hidden = !open;
  $("logbtn").classList.toggle("on", open);
  save(KEY_HIST, open ? "1" : "");
  if (open) { renderHistList(); send({ type: "history_list" }); }
}
$("logbtn").onclick = () => showHist($("logpanel").hidden);
showHist(load(KEY_HIST) === "1");

// Состояние раздачи после шага k (k = -1 — до первого действия)
function replayState(hand, k) {
  const st = { board: [], board2: [], pot: 0, stacks: {}, folded: new Set(), last: {}, revealed: false, ended: false };
  for (const pl of hand.players) st.stacks[pl.seat] = pl.stack;
  for (let i = 0; i <= k; i++) {
    const e = hand.events[i];
    if (e.pot != null) st.pot = e.pot;
    if (e.k === "board") { st.board = e.board; st.board2 = e.board2 || []; st.last = {}; }
    if (e.k === "act" || e.k === "refund") st.stacks[e.seat] = e.stack;
    if (e.k === "act") { st.last[e.seat] = e.text; if (e.fold) st.folded.add(e.seat); }
    if (e.k === "reveal") st.revealed = true;
    if (e.k === "result") st.ended = true;
  }
  if (st.ended) for (const pl of hand.players) st.stacks[pl.seat] = pl.end;
  return st;
}

function openReplay(hand) {
  stopReplay();
  replay = { hand, step: hand.events.length - 1, timer: null };      // открываем сразу на итоге
  $("replay").hidden = false;
  renderReplay();
}

function stopReplay() {
  if (replay && replay.timer) { clearInterval(replay.timer); replay.timer = null; }
  $("rpplay").textContent = "▶ Play";
}

function goReplay(step) {
  if (!replay) return;
  replay.step = Math.max(-1, Math.min(replay.hand.events.length - 1, step));
  renderReplay();
}

function renderReplay() {
  const { hand, step } = replay;
  const st = replayState(hand, step);
  $("rptitle").textContent = `Hand #${hand.no}`;
  $("rpsub").textContent = `${new Date(hand.time * 1000).toLocaleString("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} · blinds ${amt(hand.sb)}/${amt(hand.bb)} · pot ${amt(hand.pot)}`;
  $("rppot").textContent = st.ended ? "" : `Pot ${amt(st.pot)}`;
  const board = $("rpboard");
  board.replaceChildren();
  for (let i = 0; i < 5; i++) board.append(cardEl(st.board[i] || "", "md"));
  const twoBoards = Boolean(hand.board2 && hand.board2.length);
  $("rpboard2").hidden = !twoBoards;
  if (twoBoards) {
    $("rpboard2").replaceChildren();
    for (let i = 0; i < 5; i++) $("rpboard2").append(cardEl(st.board2[i] || "", "md"));
  }

  $("rpplayers").replaceChildren(...hand.players.map((pl) => {
    const row = el("div", "rp-player");
    row.classList.toggle("folded", st.folded.has(pl.seat));
    row.classList.toggle("winner", st.ended && pl.winner);
    row.classList.toggle("me", pl.me);
    const open = pl.me || (pl.shown && (st.revealed || st.ended));
    const cards = el("div", "rp-cards");
    for (const c of pl.cards) cards.append(cardEl(open ? c : "back", "sm"));
    const info = el("div", "rp-info");
    info.append(el("div", "rp-name", pl.name + (pl.me ? " (you)" : "")), el("div", "rp-stack", amt(st.stacks[pl.seat])));
    const what = st.ended ? (pl.hand || (st.folded.has(pl.seat) ? "Fold" : "")) : (st.last[pl.seat] || "");
    row.append(el("span", "rp-pos", pl.pos), cards, info, el("div", "rp-last", txt(what)));
    if (st.ended && pl.end !== pl.stack) {
      const d = pl.end - pl.stack;
      row.append(el("div", "rp-net " + (d > 0 ? "up" : "down"), d > 0 ? `+${amt(d)}` : `−${amt(-d)}`));
    }
    return row;
  }));

  // Ход раздачи по улицам; текущий шаг подсвечен, будущие — бледные. Клик по строке — перейти к ней.
  const names = Object.fromEntries(hand.players.map((pl) => [pl.seat, pl.name]));
  const items = [el("li", "rp-street", "Preflop")];
  hand.events.forEach((e, i) => {
    let li;
    if (e.k === "board") {
      li = el("li", "rp-street", STREET_NAMES[e.street] + " ");
      const mini = el("span", "mini");
      for (const c of e.board) mini.append(cardEl(c, "xs"));
      li.append(mini);
      if (e.board2) {                                        // вторая доска — рядом, через черту
        const mini2 = el("span", "mini");
        for (const c of e.board2) mini2.append(cardEl(c, "xs"));
        li.append(" | ", mini2);
      }
    } else if (e.k === "result") {
      li = el("li", "rp-result", "🏆 " + txt(e.text));
    } else if (e.k === "reveal") {
      li = el("li", "rp-note", e.text);
    } else {
      li = el("li", "", "");
      li.append(el("b", "", names[e.seat] || "?"), ": " + txt(e.text));
    }
    li.classList.toggle("now", i === step);
    li.classList.toggle("future", i > step);
    li.onclick = () => { stopReplay(); goReplay(i); };
    items.push(li);
  });
  const list = $("rpevents");
  list.replaceChildren(...items);
  const now = list.querySelector(".now");
  if (now) now.scrollIntoView({ block: "nearest" });
  $("rpprev").disabled = $("rpfirst").disabled = step < 0;
  $("rpnext").disabled = $("rplast").disabled = step >= hand.events.length - 1;
}

$("rpfirst").onclick = () => { stopReplay(); goReplay(-1); };
$("rpprev").onclick = () => { stopReplay(); goReplay(replay.step - 1); };
$("rpnext").onclick = () => { stopReplay(); goReplay(replay.step + 1); };
$("rplast").onclick = () => { stopReplay(); goReplay(Infinity); };
$("rpplay").onclick = () => {
  if (replay.timer) { stopReplay(); return; }
  if (replay.step >= replay.hand.events.length - 1) goReplay(-1);   // с начала
  $("rpplay").textContent = "⏸ Pause";
  replay.timer = setInterval(() => {
    if (replay.step >= replay.hand.events.length - 1) { stopReplay(); return; }
    goReplay(replay.step + 1);
  }, 1000);
};
function closeReplay() { stopReplay(); replay = null; $("replay").hidden = true; }
$("replayclose").onclick = closeReplay;
$("replay").onclick = (e) => { if (e.target === $("replay")) closeReplay(); };

function updateTimer() {
  const bar = document.querySelector(".seat.actor .timer i");
  if (!bar || deadline == null || !state) return;
  const left = Math.max(0, deadline - performance.now()) / 1000;
  bar.style.width = (100 * left / state.turn_seconds) + "%";
  bar.style.background = state.timebank ? "#3d82ea" : left < 3 ? "var(--red)" : "var(--gold)";
}
setInterval(updateTimer, 100);

// Отсчёт докупки: над именем «rebuying… 7s» и в окне докупки
function updateRebuy() {
  const now = performance.now();
  for (const node of document.querySelectorAll(".plate .rebuying")) {
    const end = rebuyEnds[node.dataset.seat];
    node.textContent = end != null ? `rebuying… ${Math.max(0, Math.ceil((end - now) / 1000))}s` : "rebuying…";
  }
  const me = state && state.you;
  const end = me ? rebuyEnds[me.seat] : null;
  if (end != null && !$("bustcount").hidden) {
    const left = Math.max(0, Math.ceil((end - now) / 1000));
    $("bustcount").replaceChildren(el("b", "", String(left)), el("span", "", left > 0 ? "seconds to rebuy — the next hand waits for you" : "dealing without you…"));
  }
}
setInterval(updateRebuy, 200);

// ---------- кнопки вверху ----------
$("invite").onclick = async () => {
  const link = location.origin + base + "/";
  try { await navigator.clipboard.writeText(link); toast("Link copied. Send your friends the poker login and password separately."); }
  catch (e) { prompt(T("Copy the link and send it to your friends:"), link); }
};


// ---------- мой профиль (ник и фото выбираются в лобби) ----------
function showMe() {
  const box = $("meinfo");
  box.replaceChildren();
  if (!profileMe) return;
  const a = el("span", "mini-ava", profileMe.avatar ? "" : [...profileMe.name][0].toUpperCase());
  if (profileMe.avatar) a.style.backgroundImage = `url("${profileMe.avatar}")`;
  else a.style.background = `hsl(${hue(profileMe.name)} 45% 38%)`;
  box.append(a, profileMe.name);
}
if (!load(KEY_PROFILE)) location.href = "./";

// Название игры для шапки: «NL Hold'em», «PLO4 · Pot limit», «PLO5 · Pot limit»
function gameLabel(s) {
  if (s.game === "plo4") return "PLO4 · pot limit";
  if (s.game === "plo5") return "PLO5 · pot limit";
  return "NL Hold'em";
}

// ---------- выбор суммы входа: только варианты стола (например 10 000 / 15 000 / 20 000) ----------
// Если у стола есть список сумм — вместо поля ввода показываем кнопки; выбранная сумма лежит в скрытом поле.
function buyinChoices(field, label, pick, input) {
  const list = state && state.buyins && state.buyins.length ? state.buyins : null;
  $(field).hidden = Boolean(list);
  $(label).hidden = !list;
  $(pick).hidden = !list;
  if (!list) return;
  const saved = Number(load("poker-buyin"));
  if (!list.includes(Number($(input).value))) $(input).value = list.includes(saved) ? saved : list[0];
  const box = $(pick);
  const key = list.join(",") + ":" + $(input).value;
  if (box.dataset.key === key) return;                // не перерисовывать без нужды (чтобы клик не терялся)
  box.dataset.key = key;
  box.replaceChildren(...list.map((v) => {
    const b = el("button", "choice" + (Number($(input).value) === v ? " on" : ""), fmt(v));
    b.type = "button";
    b.onclick = () => { $(input).value = v; save("poker-buyin", v); buyinChoices(field, label, pick, input); };
    return b;
  }));
}

// ---------- окно «Сесть» ----------
$("joinform").onsubmit = (event) => {
  event.preventDefault();
  const buyin = Number($("buyin").value);
  if (!state.buyins && !(buyin >= state.min_buyin)) { toast(`Minimum buy-in ${fmt(state.min_buyin)}`); return; }
  save("poker-buyin", buyin);
  send({ type: "sit", buyin });
};
$("watch").onclick = () => { watching = true; render(); };

// ---------- чат ----------
function gotChat(msg) {
  chatItems.push(msg);
  if (chatItems.length > 60) chatItems.shift();
  if ($("chatpanel").hidden) unread++;
  if (msg.seat != null) bubbles[msg.seat] = { text: msg.text, until: performance.now() + 5000 };
  renderChat();
  render();
}

function renderChat() {
  const list = $("chatlist");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.replaceChildren(...chatItems.map((m) => {
    const li = el("li");
    const who = el("b", "", m.name + (m.watcher ? " 👁" : ""));
    who.style.color = `hsl(${hue(m.name)} 70% 68%)`;
    const said = el("span", "", m.text);
    said.dataset.notr = "";                               // сообщения людей не переводим
    who.dataset.notr = "";
    li.append(who, " ", said);
    li.title = new Date(m.t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return li;
  }));
  if (atBottom || !$("chatpanel").hidden) list.scrollTop = list.scrollHeight;
  $("chatcount").hidden = unread === 0;
  $("chatcount").textContent = unread > 9 ? "9+" : String(unread);
}

function showChat(open) {
  $("chatpanel").hidden = !open;
  $("chatbtn").classList.toggle("on", open);
  save(KEY_CHAT, open ? "1" : "");
  if (open) { unread = 0; renderChat(); $("chatlist").scrollTop = $("chatlist").scrollHeight; }
}
$("chatbtn").onclick = () => { showChat($("chatpanel").hidden); if (!$("chatpanel").hidden) $("chatinput").focus(); };
$("chatform").onsubmit = (event) => {
  event.preventDefault();
  const text = $("chatinput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatinput").value = "";
};
showChat(load(KEY_CHAT) === "1");

// ---------- броски: предмет летит в соперника (сами предметы и анимации — в throwables.js) ----------
let throwAt = null;             // в кого сейчас выбираем: {seat, name}

$("throwitems").replaceChildren(...THROWABLES.map((item) => {
  const b = el("button", `throwitem ${item.id}`);
  b.innerHTML = THROW_ART[item.id];                  // рисунок из нашего файла
  b.type = "button";
  b.title = item.title;
  b.setAttribute("aria-label", item.title);
  b.onclick = () => {
    if (throwAt) send({ type: "throw", item: item.id, seat: throwAt.seat });
    closeThrowbox();
  };
  return b;
}));

// Окошко стоит над игроком (или под ним, если сверху нет места) и не вылезает за экран.
// Оно вне «сцены»: на телефоне стол уменьшен, а кнопки должны остаться под палец.
function openThrowbox(seat, node) {
  throwAt = { seat, name: state.seats[seat].name };
  $("throwname").textContent = throwAt.name;
  const box = $("throwbox"), gap = 10;
  box.hidden = false;
  const r = node.getBoundingClientRect(), room = $("room").getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  const below = r.top - h - gap < room.top;
  const mid = r.left + r.width / 2;
  const left = Math.max(8, Math.min(innerWidth - w - 8, mid - w / 2));
  box.classList.toggle("below", below);
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, below ? r.bottom + gap : r.top - h - gap))}px`;
  box.style.setProperty("--ax", `${Math.max(18, Math.min(w - 18, mid - left))}px`);   // уголок смотрит на игрока
}
function closeThrowbox() { throwAt = null; $("throwbox").hidden = true; }
// Соперник ушёл (или ушёл ты) — кидать уже не в кого
function checkThrowbox() {
  if (!throwAt) return;
  const p = state.seats[throwAt.seat];
  if (!state.you || !p || p.name !== throwAt.name) closeThrowbox();
}
// Места перерисовываются целиком, поэтому слушаем клик на их общем контейнере
$("seats").addEventListener("click", (e) => {
  const node = e.target.closest(".seat.throwable");
  if (!node) return;
  const seat = Number(node.dataset.throwSeat);
  if (throwAt && throwAt.seat === seat) closeThrowbox();      // второй клик по тому же игроку — закрыть
  else openThrowbox(seat, node);
});
document.addEventListener("pointerdown", (e) => {
  if (throwAt && !e.target.closest("#throwbox, .seat.throwable")) closeThrowbox();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeThrowbox(); });
window.addEventListener("resize", closeThrowbox);

// Куда попадает (в пикселях стола): в фото соперника над его картами; в тебя — прямо в середину твоих карт
function throwPoint(seat) {
  const [x, y] = spot(seat);
  const isMe = Boolean(state.you && state.you.seat === seat);
  return [x / 100 * TW, y / 100 * TH + (isMe ? -28 : y < 30 ? -42 : -56)];   // верхние места — чуть ниже, чтобы не уйти под шапку
}
function showThrow(msg) {
  if (!state || document.hidden) return;
  const from = throwPoint(msg.from), to = throwPoint(msg.to);
  playThrow($("throws"), msg.item, from, to, () => {
    // Попало — место вздрагивает в сторону полёта. Место могло перерисоваться, поэтому ищем его сейчас
    const node = document.querySelector(`.seat[data-throw-seat="${msg.to}"]`);
    if (!node) return;
    const kick = Math.sign(to[0] - from[0] || 1) * (msg.item === "poop" ? 12 : 5);
    node.animate([
      { translate: "0 0", rotate: "0deg" }, { translate: `${kick}px 4px`, rotate: `${kick / 3}deg` },
      { translate: `${-kick * .6}px 0`, rotate: `${-kick / 4}deg` }, { translate: `${kick * .3}px 0`, rotate: "0deg" }, { translate: "0 0" },
    ], { duration: 420, easing: "ease-out" });
  });
}

// ---------- итоги вечера ----------
// Кто кому отдаёт: минусовые игроки отдают плюсовым, как можно меньшим числом передач
function settle(rows) {
  const win = rows.filter((r) => r.profit > 0).map((r) => ({ name: r.name, v: r.profit }));
  const lose = rows.filter((r) => r.profit < 0).map((r) => ({ name: r.name, v: -r.profit })).sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < lose.length && j < win.length) {
    const x = Math.min(lose[i].v, win[j].v);
    out.push([lose[i].name, win[j].name, x]);
    lose[i].v -= x; win[j].v -= x;
    if (!lose[i].v) i++;
    if (!win[j].v) j++;
  }
  return out;
}

function renderLedger() {
  $("ledgerreset").hidden = !(state && state.owner);          // обнулять итоги может только хозяин
  const rows = (state && state.ledger) || [];
  const body = $("ledgerrows");
  body.replaceChildren(...rows.map((r) => {
    const tr = el("tr");
    const profit = el("td", r.profit > 0 ? "up" : r.profit < 0 ? "down" : "",
      r.profit > 0 ? `+${amt(r.profit)}` : r.profit < 0 ? `−${amt(-r.profit)}` : "±0");
    tr.append(el("td", "", r.name), el("td", "", amt(r.bought)),
      el("td", "", r.now != null ? amt(r.now) : `left · ${amt(r.out)}`), profit);
    return tr;
  }));
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "muted", "Nobody has sat down yet.");
    td.colSpan = 4;
    tr.append(td);
    body.append(tr);
  }
  const plan = settle(rows);
  $("settle").replaceChildren(...(plan.length ? plan.map(([from, to, v]) => {
    const li = el("li");
    li.append(el("b", "", from), " → ", el("b", "", to), ": ", el("span", "", amt(v)));
    return li;
  }) : [el("li", "muted", "Everyone is even — nobody owes anything.")]));
}

function showLedger(open) {
  $("ledger").hidden = !open;
  if (open) renderLedger();
}
$("ledgerbtn").onclick = () => showLedger(true);
$("ledgerclose").onclick = $("ledgerok").onclick = () => showLedger(false);
$("ledger").onclick = (e) => { if (e.target === $("ledger")) showLedger(false); };
$("ledgerreset").onclick = () => {
  if (confirm(T("Start a new count? Everyone's current chips become their buy-in, and players who left disappear from the list."))) {
    send({ type: "ledger_reset" });
  }
};

// ---------- размер под окно ----------
// Вся «сцена» нарисована в размере 1280×760 и целиком масштабируется под окно —
// так стол, карты, кнопки и надписи всегда сохраняют пропорции.
function fit() {
  const room = $("room");
  const k = Math.min(room.clientWidth / 1280, room.clientHeight / 760);
  $("stage").style.setProperty("--k", k > 0 ? k : 1);
}
window.addEventListener("resize", fit);
fit();

connect();
