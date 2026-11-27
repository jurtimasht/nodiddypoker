// NoDiddyPoker — часть, которая работает в браузере.
// Держит «живую» связь с сервером, рисует стол и отправляет ходы.
// Все правила и карты — на сервере. Браузер только показывает то, что прислал сервер.

const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\/table\/?$/, "").replace(/\/+$/, "");   // "/poker"
const TABLE_ID = new URLSearchParams(location.search).get("t") || "";            // какой стол открыт (?t=violet)
// Стол в своём окне (окно из лобби ndp-…, или окно программы 0.2+). Тогда кнопки «Lobby» нет,
// а закрыл окно — через 12 с встал из-за стола (сервер ждёт: вдруг это обновление страницы)
const DESKTOP_WINDOW = Boolean(window.__ndpDesktop && window.__ndpDesktop !== true);
const IN_WINDOW = window.name.startsWith("ndp-") || DESKTOP_WINDOW;
document.body.classList.toggle("inwin", IN_WINDOW);
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
    send({ type: "hello", token: load(KEY_TOKEN), profile: load(KEY_PROFILE), window: IN_WINDOW });
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
    else if (msg.type === "fair") { fairNote(msg); }
    else if (msg.type === "history_list") { histItems = msg.items; renderHistList(); }
    else if (msg.type === "history_hand") { openReplay(msg.hand); if (fairOpenLast) { fairOpenLast = false; verifyReplay(); } }
    else if (msg.type === "error") { toast(msg.text); }
    else if (msg.type === "my_tables") { myTables = msg.tables || []; myTablesAt = performance.now(); renderTurnChip(); }
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
// Та же сумма кусочком страницы: число и рядом мелкое «BB» — всегда в одну строку (стек, ставка, банк, «+сумма»)
function amtNode(n, prefix = "") {
  const box = el("span", "amt");
  if (units !== "bb" || !state) { box.textContent = prefix + fmt(n); return box; }
  box.append(prefix + Number((n / state.bb).toFixed(2)).toLocaleString("en-US"), el("small", "u", "BB"));
  return box;
}
// Длинное число в стеке — шрифт поменьше, чтобы влезло в плашку одной строкой (BB считаем как 2,5 знака)
function stackSize(n) {
  const len = (units === "bb" && state ? Number((n / state.bb).toFixed(2)).toLocaleString("en-US").length + 2.5 : fmt(n).length);
  return len > 10.5 ? " xlong" : len > 8 ? " long" : "";
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

// ---------- стопка фишек: чем больше сумма (в BB), тем выше стопка ----------
// 1 фишка за мелочь, дальше ступеньками (логарифмически) до двух столбиков по 7. Цвета — из палитры сайта.
const CHIP_COLORS = ["c1", "c2", "c3", "c4"];          // фиолетовая, малиновая, красная, золотая
function chipCount(amount) {
  const bb = Math.max(0, amount / Math.max(1, state ? state.bb : 1));
  return Math.max(1, Math.min(14, Math.round(1 + Math.log2(1 + bb) * 1.6)));
}
function chipStack(amount) {
  const box = el("span", "chips");
  box.setAttribute("aria-hidden", "true");
  const n = chipCount(amount);
  const cols = n > 7 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
  cols.forEach((h, c) => {
    const col = el("span", "chipcol");
    for (let k = 0; k < h; k++) col.append(el("i", "chip " + CHIP_COLORS[(k + c * 2) % CHIP_COLORS.length]));
    box.append(col);
  });
  return box;
}

// ---------- места вокруг стола ----------
// Точки (в % от размера стола) по часовой стрелке, начиная снизу по центру.
// Ты всегда сидишь снизу — остальные раскладываются вокруг.
// Heads-up (2 места): ты снизу, соперник сверху по центру.
const SPOTS = [[50, 88], [16, 79], [6, 44], [27, 8], [73, 8], [94, 44], [84, 79]];
// Окно стола на компьютере (картинка 4:3, html.z43): места крупнее — верхние ниже, нижние боковые дальше от кнопок хода
const SPOTS_PIC = [[50, 88], [13, 74], [6, 43], [27, 12], [73, 12], [94, 43], [87, 74]];
const SPOTS_HU = [[50, 88], [50, 8]];
// Телефон вертикально: стол вытянут вверх — сверху двое, по бокам по двое, я внизу по центру
const SPOTS_P = [[50, 88], [14, 71], [14, 31], [30, 12], [70, 12], [86, 31], [86, 71]];
const SPOTS_HU_P = [[50, 88], [50, 13]];
const seatCount = () => (state && state.seats ? state.seats.length : 7);
function spot(seat) {
  const n = seatCount();
  const mine = state.you ? state.you.seat : 0;
  const list = n === 2 ? (portrait ? SPOTS_HU_P : SPOTS_HU) : (portrait ? SPOTS_P : pic ? SPOTS_PIC : SPOTS);
  return list[(seat - mine + n) % n];
}
function toward(pos, k) {              // точка между местом и центром стола
  return [pos[0] + (50 - pos[0]) * k, pos[1] + (46 - pos[1]) * k];
}
// Где поставить фишки ставки (или кнопку D) рядом с местом: идём от места к центру стола (можно чуть в сторону —
// turn, в радианах) и останавливаемся в первой точке, где предмет ни на что не налезает (карты, плашка, значки,
// уже поставленные ставки). Считаем в пикселях стола без масштаба, по настоящим размерам на экране.
function tableRect(node, base, scale) {
  const r = node.getBoundingClientRect();
  return { l: (r.left - base.left) / scale, t: (r.top - base.top) / scale, r: (r.right - base.left) / scale, b: (r.bottom - base.top) / scale };
}
function seatRects(box, base, scale) {
  const parts = [...box.children, ...(box.querySelector(".plate")?.children || [])]
    .filter((e) => !e.matches(".bubble, .tb-burst, .wonamt, .tag:empty, .tchip"));
  return parts.map((e) => tableRect(e, base, scale)).filter((r) => r.r - r.l > 0 && r.b - r.t > 0);
}
function clearSpot(pos, node, obstacles, gap, turn = 0) {
  const sx = pos[0] / 100 * TW, sy = pos[1] / 100 * TH;
  let dx = TW * 0.5 - sx, dy = TH * 0.46 - sy;
  [dx, dy] = [dx * Math.cos(turn) - dy * Math.sin(turn), dx * Math.sin(turn) + dy * Math.cos(turn)];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const w = node.offsetWidth / 2 + gap, h = node.offsetHeight / 2 + gap;
  let t = 0;
  const hits = (x, y) => obstacles.some((o) => x + w > o.l && x - w < o.r && y + h > o.t && y - h < o.b);
  while (t < len * 0.6 && hits(sx + dx * t, sy + dy * t)) t += 2;
  const spot = [(sx + dx * t) / TW * 100, (sy + dy * t) / TH * 100];
  spot.dist = t;
  spot.ok = !hits(sx + dx * t, sy + dy * t);
  return spot;
}
const betSpots = {};
const tchipShown = {}, tchipFading = {};  // тайм-чипы: у кого показан сейчас и какие плавно гаснут                    // место -> где сейчас лежит его ставка (оттуда фишки едут в банк)

function place(node, pos) { node.style.left = pos[0] + "%"; node.style.top = pos[1] + "%"; }

// Значок последнего хода. FOLD и ALL-IN висят до конца раздачи, остальные — до следующего хода или новой улицы
// (на новой улице сервер очищает p.last). Блайнды, анте и бомб-пот значком не отмечаем: их видно по фишкам.
function actionBadge(p) {
  if (!p.in_hand) return "";
  if (p.folded) return "FOLD";
  if (p.all_in) return "ALL-IN";
  const last = p.last || "";
  for (const word of ["Check", "Call", "Raise", "Bet", "All-in"]) if (last.startsWith(word)) return word.toUpperCase();
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
let TW = 1120, TH = 655;            // размер стола на «сцене» (см. table.css) — для расчёта полётов в пикселях
let POT_POS = [50, 34];             // где на столе банк (в %)
// Телефон вертикально: свой вид стола (body.portrait). Сцена не уменьшается — стол во весь экран в настоящих пикселях
const PORTRAIT = matchMedia("(orientation: portrait) and (max-width: 600px)");
const LOW = matchMedia("(max-height: 500px)");          // телефон боком: прежняя сцена 1280×760
const COARSE = matchMedia("(pointer: coarse)");
let portrait = PORTRAIT.matches;
let pic = false;                    // компьютер: вся страница — картинка 1280×960, масштаб Z (см. fit)
let Z = 1;
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
  $("pinfo").hidden = !s.mtt;
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
        ghosts.push({ text: amt(bet), from: betSpots[seat] || toward(spot(Number(seat)), 0.4), to: POT_POS, start: now, ms: 380 });
      }
    }
    if (!s.running && s.result) {
      s.seats.forEach((p, w) => {
        if (p && p.won > 0) ghosts.push({ text: amt(p.won), from: POT_POS, to: spot(w), start: now + 380, ms: 600, win: p.net > 0 });
      });
    }
  }

  // Неуравненная часть ставки возвращается игроку: фишки едут со стола обратно к нему
  if (s.refund && s.refund.id !== lastRefundId) {
    if (!firstPaint) {
      const rp = spot(s.refund.seat);
      ghosts.push({ text: amt(s.refund.amount), from: betSpots[s.refund.seat] || toward(rp, 0.4), to: rp, start: now, ms: 550, back: true });
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

  // Банк и общие карты. Одна плашка: слева всегда слово «POT», дальше стопки с суммами на одной средней линии.
  // Пока банк один — одна стопка со всей суммой (вместе со ставками этой улицы); есть побочные — по стопке на банк.
  $("pot").replaceChildren();
  const pots = s.pots || [];
  const potBoxes = pots.length > 1 ? pots.map((amount, k) => [amount, k]) : s.pot && s.running ? [[s.pot, 0]] : [];
  $("pots").replaceChildren(...(potBoxes.length ? [el("small", "potlabel", "Pot")] : []), ...potBoxes.map(([amount, k]) => {
    const box = el("div", "potstack" + (k ? " side" : ""));
    const value = el("b");
    value.append(amtNode(amount));
    if (pots.length <= 1) play(value, `pot:${amount}`, "bump", 320);   // банк вырос — число «подпрыгивает»
    box.append(chipStack(amount), value);
    box.title = pots.length <= 1 ? "Pot" : k ? `Side pot ${k}` : "Main pot";
    return box;
  }));

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
  // Кто выиграл — не текстом в центре, а золотой аурой у победителя и «+сумма» над ним (см. места ниже)
  $("result").replaceChildren();

  // Олл-ин или вскрытие: всё затемняется, кроме игроков, которые борются за банк (и общих карт)
  const involved = new Set();
  if (s.runout) s.seats.forEach((p, i) => { if (p && p.in_hand && !p.folded) involved.add(i); });
  else if (!s.running) s.seats.forEach((p, i) => { if (p && p.hand) involved.add(i); });
  $("stage").classList.toggle("spotlight", involved.size > 0);

  // Места
  const seats = $("seats");
  seats.replaceChildren();
  const placedBets = [];                // уже поставленные ставки: следующие на них не ложатся
  const placeLater = [];                // телефон вертикально: ставки и кнопка D — после всех мест
  if (portrait) {                       // телефон вертикально: стол узкий — ставки и кнопка D не ложатся на банк, борд и строки турнира
    const tb = $("table").getBoundingClientRect();
    for (const id of ["pots", "board", "board2", "pinfo"]) {
      const n = $(id);
      if (!n.hidden && n.offsetParent) placedBets.push(tableRect(n, tb, 1));
    }
  }
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
    // золотая аура — только если за раздачу в плюсе (забрал больше, чем вложил). Забрал побочный банк, но в минусе —
    // фишки к нему просто едут, без золота
    const profit = p.won > 0 && p.net > 0 && !s.running;
    box.classList.toggle("winner", profit);
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
      // После раздачи: на вскрытии твои карты и так открыты всем — ярко, без глазков. Без вскрытия — показанные
      // кнопкой яркие с глазком, а остальные затемнены: так видно, что видят соперники.
      const after = !s.running && me.can_show;
      const shown = me.shown || [], pending = me.show_pending || [];
      if (me.showdown || (s.runout && p.in_hand && !p.folded)) play(hole, `sdlift:${s.hand_no}:${i}`, "sdLift", 320);
      hole.querySelectorAll(".card").forEach((card, ci) => {
        if (after && !me.showdown) card.classList.toggle("dim", !shown.includes(ci));
        if (shown.includes(ci)) {
          card.classList.add("shown");
          card.append(el("span", "eye", "👁"));                              // ты показал её всем — глазок
          card.title = "Everyone sees this card";
          return;
        }
        if (!me.can_show || me.showdown) return;
        hole.classList.add("showable");
        card.classList.add("clickable");
        card.classList.toggle("pending", pending.includes(ci));
        if (pending.includes(ci)) card.append(el("span", "eye", "👁"));     // глазок в углу: эту карту покажу
        card.title = pending.includes(ci) ? "Will be shown when the hand ends — click to cancel"
                   : s.running ? "Click to show this card when the hand ends" : "Click to show this card to everyone";
        card.onclick = () => send({ type: "show", card: ci });
      });
      box.append(hole);
      if (me.hand && p.in_hand && !p.folded) box.append(el("div", "mycombo", txt(me.hand)));   // вертикальный телефон: над картами
    } else {
      // Соперник только что сбросил карты — они «улетают» в центр стола
      const had = seenCards.seats[i] || [];
      if (p.folded && !p.cards.length && had.length && !mucks[i]) mucks[i] = { cards: had, start: now };
      if (p.cards.length) {
        showCards(p.cards, "md");
        hole.classList.toggle("backs", p.cards.every((c) => c === "back"));
        if (p.cards.some((c) => c !== "back")) play(hole, `sdlift:${s.hand_no}:${i}`, "sdLift", 320);   // открылись — выезжают вперёд
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
    const stack = el("div", "stack" + stackSize(p.stack));
    stack.append(amtNode(p.stack));
    // Фишек стало больше (выигрыш, возврат) — число подпрыгивает, когда фишки «доедут»
    const before = prev && prev.stacks ? prev.stacks[i] : undefined;
    if (before !== undefined && p.stack > before) {
      anims.set(`stackup:${i}:${p.stack}:delay`, p.won > 0 && !s.running ? 950 : freshRefund === i ? 450 : 0);
    }
    if (anims.has(`stackup:${i}:${p.stack}:delay`)) play(stack, `stackup:${i}:${p.stack}`, "bump", 420, anims.get(`stackup:${i}:${p.stack}:delay`));
    plate.append(el("div", "name", p.name), stack);
    // Правый клик по любой плашке игрока: все суммы за столом (и средний стек в панели турнира) — фишки <-> BB
    plate.oncontextmenu = (e) => { e.preventDefault(); toggleUnits(); };
    if (isMe) plate.title = "Right-click any stack: show amounts in chips or BB";
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

    // Тайм-чип (запас времени) — только когда основное время хода кончилось и пошёл тайм-банк: выезжает, растёт
    // и пульсирует, пока тратится. Ход ушёл — плавно гаснет. Свой остаток — в подсказке при наведении на свою плашку.
    const tchipKey = `${s.hand_no}:${s.street}:${i}`;
    const bankLeft = s.street === "preflop" ? p.bank_pre : p.bank_post;
    if (isMe && bankLeft != null) {
      plate.title = bankLeft > 0 ? `Time bank: ${bankLeft}s left${s.street === "preflop" ? " (preflop)" : " for the flop, turn and river"}` : "Time bank used up";
    }
    if (s.running && !s.runout && s.timebank && s.actor === i) {
      const cls = "tchip ticking";
      const tchip = el("div", cls, clockText(bankLeft));
      tchip.title = "Time bank is running";
      play(tchip, `tchip:${s.timebank.id}`, "tchipIn", 380);
      plate.append(tchip);
      tchipShown[i] = { cls, text: clockText(bankLeft), key: tchipKey };
    } else if (tchipShown[i]) {
      tchipFading[i] = { ...tchipShown[i], start: now };
      tchipShown[i] = null;
    }
    const fade = tchipFading[i];
    if (fade && now - fade.start < 300 && !plate.querySelector(".tchip")) {
      const ghost = el("div", fade.cls.replace(" ticking", "") + " tchipOut", fade.text);
      ghost.style.animationDelay = `-${Math.round(now - fade.start)}ms`;
      plate.append(ghost);
      later(300 - (now - fade.start));
    } else if (fade) {
      delete tchipFading[i];
    }
    // Тайм-чип сработал: большой жетон «+10s» вылетает над игроком, полоска времени синеет
    if (s.timebank && s.actor === i) {
      box.classList.add("banked");
      const secs = s.timebank.secs;
      const key = `tb:${s.timebank.id}`;
      if (!firstPaint && (!anims.has(key) || now - anims.get(key) < 1400)) {   // жетон показываем только пока он летит
        const low = pos[1] < 30;                          // у верхних мест сверху аватар и шапка — жетон летит вниз
        const burst = el("div", "tb-burst" + (low ? " below" : ""), `⏱ +${clockText(secs)}`);
        play(burst, key, low ? "chipPopDown" : "chipPop", 1400);
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

    // Под плашкой — только комбинация (на вскрытии). Последний ход — цветной значок над плашкой, в углу карт.
    const tag = el("div", "tag" + (p.hand ? " hand" : ""), txt(p.hand || ""));
    if (p.hand) play(tag, `tag:${s.street}:${i}:${p.hand}`, "pop", 220);
    const rebuying = rebuyEnds[i] != null;              // докупается: надпись «rebuying… 10s» над именем важнее значков
    const act = rebuying ? "" : actionBadge(p);
    if (act) {
      const badge = el("div", "actbadge " + act.toLowerCase().replace("-", ""), act);
      badge.dataset.notr = "";                            // покерные слова не переводятся
      play(badge, `act:${s.hand_no}:${s.street}:${i}:${act}:${p.last}`, "badgeIn", 220);
      plate.append(badge);
    }
    // SB / BB: кто на блайндах в этой раздаче (присылает сервер) — в правом углу карт, в стиле кнопки дилера
    const blind = !rebuying && s.blinds ? (s.blinds.sb === i ? "SB" : s.blinds.bb === i ? "BB" : "") : "";
    if (blind) {
      const bb = el("div", "blindbadge", blind);
      bb.dataset.notr = "";
      bb.title = blind === "SB" ? "Small blind" : "Big blind";
      plate.append(bb);
    }

    box.append(plate, timer, tag);
    if (profit) {                                        // «+сумма» над плашкой (все банки вместе; при сплите — у каждого своя)
      // у верхних мест над плашкой — край стола и шапка, поэтому там «+сумма» под плашкой
      // «+сумма» — прибыль за раздачу (net), а не всё, что забрал: пошёл олл-ин на 200 и выиграл ещё 200 — «+200».
      // Фишки к нему при этом едут полной суммой (призрак с p.won выше).
      const plus = el("div", "wonamt" + (pos[1] < 30 ? " below" : ""));
      plus.append(amtNode(p.net, "+"));
      play(plus, `won:${s.hand_no}:${i}`, "wonUp", 400, 700);
      box.append(plus);
    }
    place(box, pos);
    seats.append(box);

    // Ставка: фишки выезжают от игрока на стол и ложатся сразу за его картами и плашкой (видно, чья ставка)
    const base = $("table").getBoundingClientRect();
    const scale = base.width / TW || 1;
    const placeChips = (body) => {
      let betRect = null;
      if (p.bet > 0) {
        const bet = el("div", "bet");
        bet.append(chipStack(p.bet), amtNode(p.bet));
        seats.append(bet);
        // телефон вертикально: стол узкий — пробуем и в стороны от прямой к центру, берём ближайшее свободное место
        const turns = portrait ? [0, 0.45, -0.45, 0.9, -0.9, 1.3, -1.3] : [0];
        const tries = turns.map((a) => clearSpot(pos, bet, [...body, ...placedBets], 6, a));
        const free = tries.filter((t) => t.ok);
        const bpos = (free.length ? free : tries).reduce((a, b) => (b.dist < a.dist ? b : a));
        betSpots[i] = bpos;
        place(bet, bpos);
        const [bx, by] = px(bpos, pos);
        bet.style.setProperty("--fx", bx);
        bet.style.setProperty("--fy", by);
        // ставка выросла — фишки выезжают от игрока; уменьшилась (возврат) — без выезда
        const was = prev && prev.hand === s.hand_no && prev.street === s.street ? (prev.bets[i] || 0) : 0;
        if (p.bet < was) anims.set(`bet:${s.street}:${i}:${p.bet}`, -1e9);
        play(bet, `bet:${s.street}:${i}:${p.bet}`, "slideIn", 300);
        const bw = bet.offsetWidth / 2, bh = bet.offsetHeight / 2;
        const cx = bpos[0] / 100 * TW, cy = bpos[1] / 100 * TH;
        betRect = { l: cx - bw, r: cx + bw, t: cy - bh, b: cy + bh };
        placedBets.push(betRect);
      } else {
        delete betSpots[i];
      }
      // Кнопка дилера: рядом с местом, чуть в сторону от ставки. В новой раздаче переезжает от прошлого дилера
      if (s.dealer === i && (s.running || s.hand_no > 0)) {
        const d = el("div", "dealer", "D");
        seats.append(d);
        // пробуем чуть влево и чуть вправо от линии к центру — берём ближайшее свободное место
        const side = pos[0] <= 50 ? -1 : 1;
        const dtries = [0.35, -0.35, 0.6, -0.6, 0.9, -0.9].map((a) => clearSpot(pos, d, [...body, ...placedBets], 5, a * side));
        const dfree = portrait ? dtries.filter((t) => t.ok) : [];
        const dspot = (dfree.length ? dfree : dtries).reduce((a, b) => (b.dist < a.dist ? b : a));
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
      }
    };
    // телефон вертикально: ставки раскладываем, когда нарисованы все места, — обходят и соседей
    if (portrait) placeLater.push(placeChips); else placeChips(seatRects(box, base, scale));
  });
  if (placeLater.length) {
    const base = $("table").getBoundingClientRect();
    const all = [...seats.querySelectorAll(".seat")].flatMap((b) => seatRects(b, base, 1));
    for (const f of placeLater) f(all);
  }

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
  $("fairbtn").hidden = Boolean(s.mtt);                 // у турниров пока обычная перемешка
  if (!$("fairbox").hidden) renderFair();
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
  if (portrait) {
    renderPStatus(me, myTurn);
  } else if (myTurn || s.runout || s.running) {           // без «Your turn» / «All-in» — только комбинация
    show("");
  } else if (s.next_in == null) {
    status.textContent = "Waiting for players…";            // за столом меньше двух готовых игроков
  } else {
    status.textContent = "";                          // короткая пауза между раздачами — без надписей
  }

  // Твой ход: заголовок «⏰ Your turn» мигает, рамка по краю окна; звук — один раз и только если окно не в фокусе
  // (на окно, на которое ты и так смотришь, хватает рамки и кнопок). В программе — ещё мигание в панели задач.
  if (myTurn && !wasMyTurn) {
    if (!document.hasFocus()) beep();
    if (window.__ndpAttention) window.__ndpAttention();
  }
  document.body.classList.toggle("myturn", myTurn);
  turnTitle = myTurn;
  if (!myTurn) document.title = plainTitle();
  wasMyTurn = myTurn;
}

// Телефон вертикально: строка-подсказка в нижней панели. Кто думает (и его запас времени), чем кончилась раздача,
// когда следующая. Пока ходит соперник — напоминание, что ход можно выбрать заранее
let pNextAt = null;                 // когда следующая раздача (для отсчёта в строке-подсказке)
setInterval(() => {
  const n = document.querySelector("#status .pnextin");
  if (n && pNextAt) n.textContent = `next hand in ${Math.max(1, Math.ceil((pNextAt - performance.now()) / 1000))} s`;
}, 500);
function renderPStatus(me, myTurn) {
  const s = state, status = $("status");
  const mySeat = me ? s.seats[me.seat] : null;
  const lines = [];
  if (myTurn) {
    // свой ход — только кнопки
  } else if (s.running && s.actor != null && s.seats[s.actor]) {
    const a = s.seats[s.actor];
    const who = el("span", "pmain");
    const nm = el("b", "", a.name);
    nm.dataset.notr = "";
    who.append(nm, " ", el("span", "", "is thinking"));
    const left = s.street === "preflop" ? a.bank_pre : a.bank_post;
    if (s.timebank && left != null) who.append(" · ", el("span", "", `time bank ${left}s`));
    lines.push(who);
    if (me && mySeat && mySeat.in_hand && !mySeat.folded && !mySeat.all_in && !s.runout) {
      lines.push(el("span", "psub", "Pick your move now — it plays on your turn"));
    }
  } else if (s.running && s.runout) {
    lines.push(el("span", "pmain", "All-in — cards revealed"));
  } else if (!s.running && s.result && s.result.length) {
    lines.push(el("span", "pmain win", txt(s.result[0])));
    if (s.next_in != null) {
      pNextAt = performance.now() + s.next_in * 1000;
      lines.push(el("span", "psub pnextin", `next hand in ${Math.max(1, Math.ceil(s.next_in))} s`));
    }
  } else if (s.next_in == null) {
    lines.push(el("span", "psub", "Waiting for players…"));
  }
  status.replaceChildren(...lines);
}

const plainTitle = () => `${state ? state.table_name || "Table" : "Table"} ${state ? fmt(state.sb) + "/" + fmt(state.bb) : ""} — NoDiddyPoker`;
let turnTitle = false;
let titleOn = false;
setInterval(() => {                                   // «⏰ Your turn» мигает в заголовке: 1 с есть, 1 с нет
  if (!turnTitle || !state) { titleOn = false; return; }
  titleOn = !titleOn;
  document.title = titleOn ? `⏰ Your turn — ${state.table_name || "Table"}` : plainTitle();
}, 1000);

// ---------- несколько столов: окна столов и «твой ход на другом столе» ----------
let myTables = [];                  // сводка сервера: мои места (стол, мой ли ход, сколько секунд осталось)
let myTablesAt = 0;                 // когда пришла (секунды считаем от неё)
const tableUrl = (code) => new URL(`table?t=${encodeURIComponent(code)}`, location.href).href;
// Открыть стол в своём окне (или показать уже открытое). Имя окна: ndp-<код>, у турнира всегда ndp-mtt (при пересадке
// окно меняет адрес само). Телефон и старая программа (0.1) — в этом же окне. Программа 0.2+ создаёт окна сама.
function openTable(code, mtt) {
  const url = tableUrl(code);
  const name = mtt ? "ndp-mtt" : "ndp-" + code;
  if (portrait || window.__ndpDesktop === true) { location.href = url; return false; }
  if (window.__ndpDesktop) { window.open(url, name); return true; }
  const w = window.open("", name, "popup,width=960,height=720");
  if (!w) { location.href = url; return false; }      // окна заблокированы — открыть в этой вкладке
  let blank = true;
  try { blank = w.location.href === "about:blank"; } catch (e) { blank = true; }   // адрес не прочитать (чужой сайт) — всё равно открыть наш стол
  if (blank) w.location.href = url;
  w.focus();
  return true;
}
// Красная плашка в шапке (на телефоне — полоса под шапкой): «⏰ стол 9s» — мой ход за ДРУГИМ столом. Тап — к нему.
function renderTurnChip() {
  const here = TABLE_ID;
  const passed = (performance.now() - myTablesAt) / 1000;
  const others = myTables.filter((x) => x.my_turn && x.code && x.code !== here && !(state && state.mtt && x.mtt))
    .map((x) => ({ ...x, secs: Math.max(0, Math.ceil((x.left || 0) - passed)) })).sort((a, b) => a.secs - b.secs);
  const had = document.body.classList.contains("has-pturn");
  document.body.classList.toggle("has-pturn", others.length > 0);
  if (portrait && had !== others.length > 0) fit();          // телефон: полоса сдвигает стол вниз — пересчитать места
  for (const id of ["turnchip", "pturn"]) {
    const chip = $(id);
    chip.hidden = !others.length;
    if (!others.length) continue;
    const t = others[0];
    const name = el("b", "", t.name);
    name.dataset.notr = "";
    chip.replaceChildren(el("span", "tc-i", "⏰"), " ", ...(id === "pturn" ? [el("span", "", "Your turn at"), " "] : []), name, " ",
                         el("span", "tc-s", `${t.secs}s`), ...(others.length > 1 ? [" ", el("span", "tc-more", `+${others.length - 1}`)] : []));
    chip.onclick = () => openTable(t.code, t.mtt);
    chip.title = `Your turn at ${t.name} — open it`;
  }
}
setInterval(() => { if (myTables.some((x) => x.my_turn)) renderTurnChip(); }, 1000);
// Окно стола: «ты вылетел» — вместо «Lobby» кнопка «Close» (лобби и так открыто в другой вкладке).
// В программе окно закрывают крестиком (window.close там ненадёжен) — кнопку просто прячем
if (IN_WINDOW) {
  const back = document.querySelector("#mttout .lobbylink");
  if (DESKTOP_WINDOW) back.hidden = true;
  else {
    back.textContent = "Close";
    back.onclick = (e) => { e.preventDefault(); window.close(); };
  }
}
// Закрывает окно кэш-стола посреди своей раздачи — браузер переспросит («Покинуть сайт?»):
// закрытое окно = встал из-за стола, карты сбросятся. Текст вопроса браузер пишет свой.
window.addEventListener("beforeunload", (e) => {
  if (!IN_WINDOW || DESKTOP_WINDOW || !state || state.mtt || !state.you || !state.running) return;
  const seat = state.seats[state.you.seat];
  if (!seat || !seat.in_hand || seat.folded) return;
  e.preventDefault();
  e.returnValue = "";
});

// Окно стола в браузере держим в 4:3 (картинка 1280×960 без полей). Пока игрок тянет край — не мешаем
// (картинка просто вписывается по центру), а через ~200 мс тишины после отпускания окно «защёлкивается» в 4:3
// по той стороне, которую тянули. Своё изменение размера новую поправку не запускает; не больше одной поправки
// на одно действие игрока. Развёрнутое на весь экран, полноэкранное или «прилипшее» окно не трогаем — там поля.
// Работает только в окне, открытом из лобби (вкладке браузер размер менять не даёт); в программе 4:3 держит она сама.
if (IN_WINDOW && !DESKTOP_WINDOW) {
  let quiet = null, ours = false, oursTimer = null;
  let lastW = innerWidth, lastH = innerHeight;
  const snap = () => {
    const w = innerWidth, h = innerHeight;
    const dw = Math.abs(w - lastW) / 4, dh = Math.abs(h - lastH) / 3;     // какую сторону тянули (в долях 4:3)
    lastW = w; lastH = h;
    if (Math.abs(w * 3 - h * 4) <= 2 * 4) return;                          // уже 4:3 (допуск ±2 px)
    if (document.fullscreenElement || !window.screen) return;
    const aw = screen.availWidth, ah = screen.availHeight;
    if (outerWidth >= aw - 2 && outerHeight >= ah - 2) return;             // развёрнуто на весь экран — поля
    const cw = outerWidth - w, ch = outerHeight - h;                       // рамка и строка адреса браузера
    let tw, th;
    if (dw >= dh) { tw = w; th = Math.round(w * 3 / 4); } else { th = h; tw = Math.round(h * 4 / 3); }
    const maxW = aw - cw, maxH = ah - ch;                                  // не больше экрана
    if (tw > maxW) { tw = maxW; th = Math.round(tw * 3 / 4); }
    if (th > maxH) { th = maxH; tw = Math.round(th * 4 / 3); }
    if (tw < 200 || th < 150) return;
    ours = true;
    clearTimeout(oursTimer);
    oursTimer = setTimeout(() => { ours = false; lastW = innerWidth; lastH = innerHeight; }, 600);
    try { window.resizeTo(tw + cw, th + ch); } catch (e) { ours = false; }
  };
  window.addEventListener("resize", () => {
    if (ours) return;                     // это мы сами поменяли размер
    clearTimeout(quiet);
    quiet = setTimeout(snap, 200);
  });
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

let foldAsking = null;               // открыто окно «Fold anyway?» — для какого хода (раздача:улица:ставка)
function renderActions(me, mySeat) {
  const box = $("actions");
  const o = me && me.options;
  box.hidden = !o;
  if (!o) {
    lastActionKey = "";
    if (foldAsking) { foldAsking = null; Dialog.dismiss(); }    // ход ушёл, а окно «Fold anyway?» ещё открыто — закрыть
    return;
  }

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
  $("fold").onclick = async () => {
    if (o.check) {
      // своё окно — асинхронное: пока оно открыто, ход мог уйти (таймер, конец раздачи). Тогда тихо ничего не делаем
      const key = `${s.hand_no}:${s.street}:${s.current_bet}`;
      foldAsking = key;
      const ok = await Dialog.ask({ text: "You can check for free. Fold anyway?", ok: "Fold", danger: true });
      if (foldAsking === key) foldAsking = null;
      const now = state && state.you && state.you.options;
      if (!ok || !now || `${state.hand_no}:${state.street}:${state.current_bet}` !== key) return;
    }
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
    const pen = $("presets").querySelector(".pamt");
    if (pen) pen.textContent = "✎ " + amt(raiseTo);
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
  // Телефон вертикально, короткий экран: ползунок спрятан за кнопкой с суммой (тап — открыть над панелью)
  const pen = el("button", "pamt", "");
  pen.type = "button";
  pen.setAttribute("aria-label", "Bet amount");
  pen.onclick = () => $("raisebox").classList.toggle("open");
  bar.append(pen);
  if (fresh) $("raisebox").classList.remove("open");
  $("minus").onclick = () => setTo(raiseTo - s.bb);
  $("plus").onclick = () => setTo(raiseTo + s.bb);
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
    const away = el("button", "away" + (me.away ? " back" : ""), me.away ? "▶ I'm back" : "☕ Sit out");
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
  const away = el("button", "away" + (me.away ? " back" : ""), me.away ? "▶ I'm back" : "☕ Sit out");
  away.title = me.away ? "Get dealt in again" : "Skip hands without leaving the table";
  away.onclick = () => send({ type: "away", value: !me.away });
  box.append(away);
  const leave = el("button", "leave", "🚪 Leave table");
  leave.onclick = async () => {
    if (await Dialog.ask({ text: "Leave the table? Your chips will be cashed out to the results.", ok: "Leave", danger: true })) {
      send({ type: "leave" });
      watching = true;
    }
  };
  box.append(leave);
}

// ---------- турнир: полоса в шапке и окно «ты вылетел» ----------
let mttLevelEnd = null;          // когда кончится уровень (по часам браузера)
const usd = (cents) => "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
let mttLateEnd = null;           // когда закончится поздняя регистрация
let mttRebuyEnd = null;          // когда закончатся ребаи
let mttLast = null;              // последний state с турниром (для подробной панели)
function renderMttBar(s) {
  const m = s.mtt;
  mttLast = s;
  // шапка: только название стола и блайнды; всё остальное — в панели слева вверху
  const tn = el("b", "tname", s.table_name || "");
  tn.dataset.notr = "";
  // Блайнды — те, по которым идёт раздача. Уровень сменился посреди раздачи — новые блайнды подписью «next hand»
  const blindsText = (sb, bb, ante) => `${fmt(sb)}/${fmt(bb)}` + (ante ? ` (${fmt(ante)})` : "");
  const pending = s.bb !== m.bb || s.sb !== m.sb || (s.ante || 0) !== (m.ante || 0);
  const next = pending ? el("span", "nextblinds", `next hand ${blindsText(m.sb, m.bb, m.ante)}`) : "";
  $("blinds").replaceChildren(tn, " · ", el("b", "", blindsText(s.sb, s.bb, s.ante)), ...(pending ? [" · ", next] : []));
  $("mttpanel").hidden = false;
  // В плашке только 4 ячейки; название турнира и блайнды — в шапке и в подробной панели
  $("mp-level").textContent = `Level ${m.level}`;
  const running = m.status === "running";
  const until = (secs) => (secs != null && running ? performance.now() + secs * 1000 : null);
  mttLevelEnd = until(m.level_left);
  mttLateEnd = until(m.late_reg_left);
  mttRebuyEnd = until(m.rebuy_left);
  $("mp-clock").textContent = m.status === "paused" ? "Paused" : m.level_left != null ? mmss(m.level_left) : "—";
  const np = m.next_prize;
  $("mp-prize").textContent = np && np.amount ? `${usd(np.amount)}(${ordinal(np.place)})` : "—";
  // Пока открыта поздняя регистрация — вместо среднего стека сколько ей осталось
  if (m.late_reg_left != null) {
    $("mp-avgk").textContent = "Late reg";
    $("mp-avg").textContent = m.status === "paused" ? "Paused" : mmss(m.late_reg_left);
    $("mp-avg").classList.add("late");
  } else {
    $("mp-avgk").textContent = "Avg. Stack";
    $("mp-avg").replaceChildren(amtNode(m.avg_stack));      // в фишках или в BB — как стеки за столом
    $("mp-avg").classList.remove("late");
  }
  // Моё место по фишкам среди оставшихся; зрителю и вылетевшему — сколько игроков осталось
  if (m.my_rank != null) {
    $("mp-leftk").textContent = "Position";
    $("mp-left").textContent = `${m.my_rank}/${m.left}`;
    $("mp-left").title = `You are ${ordinal(m.my_rank)} by chips of ${m.left} players left`;
  } else {
    $("mp-leftk").textContent = "Players Left";
    $("mp-left").textContent = String(m.left);
    $("mp-left").title = "";
  }
  renderPinfo(s, pending ? blindsText(m.sb, m.bb, m.ante) : "");
  if (mpOpen) renderMttMore();
}
// Телефон вертикально: две строки на сукне под бордом — «Level 5 · 300/600 (75) · 07:29 ⓘ» и «Next prize $21 · Position 6/27».
// Тап открывает шторку с подробностями (та же панель, что на компьютере по наведению)
function renderPinfo(s, nextBlinds) {
  const m = s.mtt;
  const l1 = el("span", "pl");
  l1.append(el("span", "", `Level ${m.level}`), " · ", el("b", "", `${fmt(s.sb)}/${fmt(s.bb)}`),
            ...(s.ante ? [" ", el("span", "", `(${fmt(s.ante)})`)] : []), " · ",
            el("b", "pi-clock", m.status === "paused" ? "Paused" : m.level_left != null ? mmss(m.level_left) : "—"),
            el("span", "pi-i", "i"));
  const l2 = el("span", "pl");
  const np = m.next_prize;
  if (np && np.amount) l2.append(el("span", "", "Next prize"), " ", el("b", "gold", usd(np.amount)), " · ");
  if (m.my_rank != null) l2.append(el("span", "", "Position"), " ", el("b", "", `${m.my_rank}/${m.left}`));
  else l2.append(el("span", "", "Players left"), " ", el("b", "", String(m.left)));
  const lines = [l1, l2];
  if (nextBlinds) lines.push(el("span", "pl pnext", `next hand ${nextBlinds}`));
  $("pinfo").replaceChildren(...lines);
  $("pinfo").setAttribute("aria-label", "Tournament: prizes, levels and more");
}
const mmss = (secs) => `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
const leftOf = (end) => mmss(Math.max(0, (end - performance.now()) / 1000));
setInterval(() => {
  if (mttLevelEnd) {
    $("mp-clock").textContent = leftOf(mttLevelEnd);
    const pc = document.querySelector("#pinfo .pi-clock");
    if (pc) pc.textContent = leftOf(mttLevelEnd);
  }
  if (mttLateEnd && $("mp-avg").classList.contains("late")) $("mp-avg").textContent = leftOf(mttLateEnd);
  document.querySelectorAll("#mp-more [data-end]").forEach((x) => {
    const end = { level: mttLevelEnd, late: mttLateEnd, rebuy: mttRebuyEnd }[x.dataset.end];
    if (end) x.textContent = leftOf(end);
  });
}, 1000);

// ---------- подробная панель турнира: наведение ~0,7 с (мышь) или тап (телефон) ----------
let mpOpen = false;
let mpTimer = null;
function setMttMore(open) {
  clearTimeout(mpTimer);
  mpOpen = open && Boolean(mttLast);
  $("mp-more").hidden = !mpOpen;
  $("mp-bar").setAttribute("aria-expanded", String(mpOpen));
  $("mttpanel").classList.toggle("open", mpOpen);
  if (mpOpen) renderMttMore();
  if (window.pSheets) pSheets();
}
function renderMttMore() {
  const s = mttLast, m = s.mtt;
  const box = $("mp-more");
  const keep = box.querySelector(".mp-prizes");
  const scroll = [box.scrollTop, keep ? keep.scrollTop : 0];        // перерисовка не сбивает прокрутку
  const paused = m.status === "paused";
  const timer = (kind, secs) => {
    const t = el("b", "mp-t", paused ? "Paused" : secs != null ? mmss(secs) : "—");
    if (!paused && secs != null) t.dataset.end = kind;
    return t;
  };
  const sec = (title, ...rest) => { const d = el("div", "mp-sec"); d.append(el("div", "mp-h", title), ...rest); return d; };
  const blindsTxt = (l) => `${fmt(l.sb)} / ${fmt(l.bb)}`;
  // название и ссылка на карточку турнира в лобби
  const head = el("div", "mp-mhead");
  const nm = el("b", "mp-name", m.name);
  nm.dataset.notr = "";
  const link = el("a", "mp-card", "Tournament card ›");
  link.href = `./#mtt/${m.id}`;
  link.target = "_blank";
  link.rel = "noopener";
  head.append(nm, link);
  // уровни: текущий, сколько до следующего, следующие 2–3
  const lv = el("table", "mp-levels");
  const hr = el("tr");
  for (const h of ["Lvl", "Blinds", "Ante"]) hr.append(el("th", h === "Lvl" ? "" : h === "Ante" ? "r" : "", h));
  lv.append(hr);
  const row = (l, cls) => {
    const tr = el("tr", cls);
    tr.append(el("td", "", String(l.level)), el("td", "", blindsTxt(l)), el("td", "r", l.ante ? fmt(l.ante) : "—"));
    lv.append(tr);
  };
  row({ level: m.level, sb: m.sb, bb: m.bb, ante: m.ante }, "now");
  (m.ahead || []).forEach((l) => row(l, ""));
  const nextLine = el("div", "mp-line");
  if (m.ahead && m.ahead.length) nextLine.append(el("span", "", "Next level in"), " ", timer("level", m.level_left));
  else nextLine.append(el("span", "", "This is the last level"));
  const levels = sec("Blinds", nextLine, lv);
  // игроки
  const players = el("div", "mp-line");
  players.append(el("span", "", "Players left"), " ", el("b", "", `${m.left} of ${m.entrants}`));
  const avg = el("div", "mp-line");
  avg.append(el("span", "", "Avg. stack"), " ", el("b", "", ""));
  avg.lastChild.append(amtNode(m.avg_stack));
  const people = sec("Players", players, avg);
  if (m.my_rank != null) {
    const pos = el("div", "mp-line");
    pos.append(el("span", "", "Your position by chips"), " ", el("b", "", `${m.my_rank} of ${m.left}`));
    people.append(pos);
  }
  // поздняя регистрация — если открыта (нет — секции «Open now» нет совсем)
  const open = [];
  if (m.late_reg_left != null) {
    const d = el("div", "mp-line");
    d.append(el("span", "", "Late registration closes in"), " ", timer("late", m.late_reg_left));
    open.push(d);
  }
  // призы по местам (со своей прокруткой, если мест много)
  const prizes = el("div", "mp-sec");
  if (m.buy_in && m.prizes && m.prizes.length) {
    const ph = el("div", "mp-h", "Prize pool ");
    ph.append(el("b", "gold", usd(m.prize_pool)));
    const ol = el("ol", "mp-prizes");
    m.prizes.forEach((amount, i) => {
      const li = el("li", m.next_prize && m.next_prize.place === i + 1 ? "next" : "");
      const place = el("span", "", ordinal(i + 1));
      if (m.next_prize && m.next_prize.place === i + 1) place.append(el("span", "nx", "next prize"));
      li.append(place, el("b", "", usd(amount)));
      ol.append(li);
    });
    prizes.append(ph, ol);
  } else prizes.append(el("div", "mp-h", "No buy-in: play for the 🏆"));
  box.replaceChildren(head, levels, people, ...(open.length ? [sec("Open now", ...open)] : []), prizes);
  box.scrollTop = scroll[0];
  const ol = box.querySelector(".mp-prizes");
  if (ol) ol.scrollTop = scroll[1];
}
(() => {
  const wrap = $("mttpanel"), bar = $("mp-bar");
  wrap.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse" || mpOpen) return;
    clearTimeout(mpTimer);
    mpTimer = setTimeout(() => setMttMore(true), 700);
  });
  wrap.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setMttMore(false); });
  bar.addEventListener("click", () => setMttMore(!mpOpen));          // тап (и клик мышью) — открыть / закрыть
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMttMore(!mpOpen); }
    if (e.key === "Escape") setMttMore(false);
  });
  document.addEventListener("pointerdown", (e) => {
    if (mpOpen && !wrap.contains(e.target) && !$("pinfo").contains(e.target)) setMttMore(false);
  });
  $("pinfo").addEventListener("click", () => setMttMore(!mpOpen));
})();

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
  if (!portrait) save(KEY_HIST, open ? "1" : "");
  if (open) { renderHistList(); send({ type: "history_list" }); }
  pSheets();
}
$("logbtn").onclick = () => showHist($("logpanel").hidden);
showHist(!portrait && load(KEY_HIST) === "1");

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
  $("rpfairbar").hidden = !hand.proof;
  $("rpfair").hidden = true;
  $("rpevents").hidden = false;
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
  catch (e) { Dialog.copy({ title: "Invite friends", text: "Copy the link and send it to your friends:", value: link }); }
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
  $("chatcount").hidden = $("pchatcount").hidden = unread === 0;
  $("chatcount").textContent = $("pchatcount").textContent = unread > 9 ? "9+" : String(unread);
}

function showChat(open) {
  $("chatpanel").hidden = !open;
  $("chatbtn").classList.toggle("on", open);
  if (!portrait) save(KEY_CHAT, open ? "1" : "");      // на телефоне шторка не открывается сама при следующем заходе
  if (open) { unread = 0; renderChat(); $("chatlist").scrollTop = $("chatlist").scrollHeight; }
  pSheets();
}
$("chatbtn").onclick = () => { showChat($("chatpanel").hidden); if (!$("chatpanel").hidden) $("chatinput").focus(); };
$("chatform").onsubmit = (event) => {
  event.preventDefault();
  const text = $("chatinput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatinput").value = "";
};
showChat(!portrait && load(KEY_CHAT) === "1");

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
  // На компьютере страница — картинка с масштабом Z, и position: fixed считается от неё:
  // переводим экранные координаты в пиксели картинки (на телефоне — как есть)
  const o = pic ? document.body.getBoundingClientRect() : { left: 0, top: 0 };
  const W = pic ? 1280 : innerWidth, H = pic ? 960 : innerHeight;
  const R = (b) => ({ top: (b.top - o.top) / Z, bottom: (b.bottom - o.top) / Z, left: (b.left - o.left) / Z, width: b.width / Z });
  const r = R(node.getBoundingClientRect()), room = R($("room").getBoundingClientRect());
  const w = box.offsetWidth, h = box.offsetHeight;
  const below = r.top - h - gap < room.top;
  const mid = r.left + r.width / 2;
  const left = Math.max(8, Math.min(W - w - 8, mid - w / 2));
  box.classList.toggle("below", below);
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, Math.min(H - h - 8, below ? r.bottom + gap : r.top - h - gap))}px`;
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

// ---------- честная перемешка (математика и проверка — в fair.js) ----------
const fairNote = (msg) => Fair.onNote(msg, { seat: state && state.you ? state.you.seat : null, send, warn: toast }).catch(() => {});
const FAIR_TEXT = {
  format: ["The proof is damaged", "The proof is damaged", "The proof is damaged"],
  lock: ["The decks were locked before anyone's seed was known", "The decks were changed after they were locked", "This browser did not see the decks being locked"],
  mine: ["Your seed is in the shuffle", "Your seed is missing or was changed", "You had no seed in this hand"],
  seeds: ["All seeds match the hashes promised before", "A seed does not match its promised hash", ""],
  people: ["Seeds from players", "", "Every seed came from the server: this hand proves nothing"],
  pick: ["The seeds give exactly this shuffle", "The seeds give a different shuffle", ""],
  decks: ["The 3 unused decks are real: 52 different cards", "An unused deck is not a real deck", ""],
  cards: ["Every card you saw was in its place", "A card you saw was not in its place", ""],
  retries: ["No reshuffles before this hand", "", "Reshuffles before this hand"],
};
// Доказательство + то, что показано на экране: проверяем именно карты из истории, а не список от сервера
function proofOf(hand) {
  const hole = Object.fromEntries(hand.players.map((pl) => [pl.seat, pl.cards]));
  return { ...hand.proof, seen: { ...hand.proof.seen, seats: seatCount(), hole_count: state.hole_count, double_board: state.double_board,
    board: hand.board, board2: hand.board2, hole } };
}
async function verifyReplay() {
  const hand = replay && replay.hand;
  if (!hand || !hand.proof) return;
  const list = $("rpfair");
  list.hidden = false;
  $("rpevents").hidden = true;
  list.replaceChildren(el("li", "", "Checking…"));
  let steps;
  if (!Fair.ok()) { list.replaceChildren(el("li", "", "This browser can't check here (it needs https). Download the proof instead.")); return; }
  try { steps = await Fair.verify(proofOf(hand), Fair.record(hand.proof.id)); }
  catch (e) { steps = [{ key: "format", ok: false, n: null }]; }
  if (!replay || replay.hand !== hand) return;                  // пока считали, открыли другую раздачу
  const bad = steps.some((x) => x.ok === false);
  const proves = steps.find((x) => x.key === "people" && x.ok);
  const head = el("li", "verdict " + (bad ? "bad" : proves ? "good" : "none"),
    bad ? "Something does not match!" : proves ? "Everything that can be checked matches" : "The math matches, but no player added a seed");
  const rows = steps.map((x) => {
    const li = el("li", x.ok === false ? "bad" : x.ok ? "good" : "none");
    li.append(el("span", "", FAIR_TEXT[x.key][x.ok ? 0 : x.ok === false ? 1 : 2]));
    const count = x.n && (x.key !== "people" || x.ok);
    if (count) li.append(" ", el("b", "", String(x.n)));
    return li;
  });
  for (const a of hand.proof.aborted || []) rows.push(el("li", "none sub", a.reason));
  list.replaceChildren(head, ...rows);
}
$("rpverify").onclick = verifyReplay;
$("rpproof").onclick = () => {
  if (!replay || !replay.hand.proof) return;
  const proof = proofOf(replay.hand), rec = Fair.record(proof.id);
  // Что видел этот браузер (без фразы): по нему verify_hand.py поймёт, что колоду не подменили
  if (rec) proof.witness = { root: rec.root, hashes: rec.hashes ? Object.fromEntries(Object.entries(rec.hashes).map(([s, h]) => [s, h.hash])) : null };
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 1)], { type: "application/json" }));
  a.download = `nodiddy-table${proof.table}-hand${proof.hand}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

let fairOpenLast = false;                                       // открыть раздачу сразу с проверкой
function renderFair() {
  const f = state && state.fair;
  $("fairno").hidden = Fair.ok();
  $("fairnone").hidden = Boolean(f);
  $("fairfpline").hidden = !f;
  $("fairfp").textContent = f ? f.fp : "";
  $("faircheck").hidden = !f || (state.running && state.hand_no === f.hand);       // идущую раздачу проверить ещё нельзя
  $("fairlist").replaceChildren(...(f ? f.seeds.map((x) => {
    const li = el("li", x.by);
    const name = el("b", "", x.name);
    name.dataset.notr = "";
    li.append(name, el("span", "", x.by === "player" ? "own seed" : "seed from the server"));
    return li;
  }) : []));
}
function showFair(open) {
  $("fairbox").hidden = !open;
  if (open) { $("phrase").value = Fair.phrase(); renderFair(); }
}
$("fairbtn").onclick = () => showFair(true);
$("fairclose").onclick = $("fairok").onclick = () => showFair(false);
$("fairbox").onclick = (e) => { if (e.target === $("fairbox")) showFair(false); };
$("phrase").oninput = () => Fair.phrase($("phrase").value);
$("faircheck").onclick = () => { fairOpenLast = true; send({ type: "history_hand", no: state.fair.hand }); showFair(false); };

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
$("ledgerreset").onclick = async () => {
  if (await Dialog.ask({ text: "Start a new count? Everyone's current chips become their buy-in, and players who left disappear from the list.", ok: "Start new count" })) {
    send({ type: "ledger_reset" });
  }
};

// ---------- телефон вертикально: шторки снизу (меню, турнир, чат, история) ----------
// Одно затемнение под всеми: тап по нему закрывает то, что открыто
function pSheets() {
  if (!portrait) { $("psheetback").hidden = true; return; }
  const any = !$("psheet").hidden || mpOpen || !$("chatpanel").hidden || !$("logpanel").hidden;
  $("psheetback").hidden = !any;
}
window.pSheets = pSheets;
function closeSheets() {
  $("psheet").hidden = true;
  if (mpOpen) setMttMore(false);
  if (!$("chatpanel").hidden) showChat(false);
  if (!$("logpanel").hidden) showHist(false);
  pSheets();
}
function menuItem(icon, title, sub, onclick, extra) {
  const b = el("button", "pitem");
  b.type = "button";
  b.append(el("span", "pic-i", icon), el("span", "pt", title));
  if (sub) b.append(el("span", "ps", sub));
  if (extra) b.append(extra);
  b.onclick = () => { closeSheets(); onclick(); };
  return b;
}
function openMenu() {
  const s = state, me = s && s.you;
  const items = [];
  const count = el("span", "count", unread > 9 ? "9+" : String(unread));
  count.hidden = unread === 0;
  items.push(menuItem("💬", "Chat", "", () => { showChat(true); }, count));
  items.push(menuItem("📜", "Hand history", "replay any hand", () => showHist(true)));
  if (!$("fairbtn").hidden) items.push(menuItem("🎲", "Fair shuffle", "your phrase, proof", () => $("fairbtn").click()));
  if (s && !s.mtt) {
    items.push(menuItem("📊", "Results", "who is up and down", () => $("ledgerbtn").click()));
    items.push(menuItem("🔗", "Invite", "copy the link", () => $("invite").click()));
  }
  const away = document.querySelector("#mine button.away");
  if (me && away) items.push(menuItem(me.away ? "▶" : "☕", me.away ? "I'm back" : "Sit out", me.away ? "deal me in" : "cards fold for you", () => away.click()));
  const leave = document.querySelector("#mine button.leave");
  if (leave) items.push(menuItem("🚪", "Leave table", "chips go to the results", () => leave.click()));
  // язык: EN / RU прямо в строке меню
  const lang = el("div", "plang");
  for (const code of ["en", "ru"]) {
    const b = el("button", window.i18n && i18n.lang === code ? "on" : "", code.toUpperCase());
    b.type = "button";
    b.dataset.notr = "";
    b.setAttribute("aria-pressed", String(Boolean(window.i18n && i18n.lang === code)));
    b.onclick = (e) => { e.stopPropagation(); if (window.i18n) i18n.setLang(code); openMenu(); };
    lang.append(b);
  }
  const langRow = el("div", "pitem plangrow");
  langRow.append(el("span", "pic-i", "🌐"), el("span", "pt", "Language"), lang);
  items.push(langRow);
  if (s && s.mtt) items.push(menuItem("ℹ️", "Tournament", "prizes, levels", () => setMttMore(true)));
  if (fullscreenOk()) {
    const on = Boolean(document.fullscreenElement);
    items.push(menuItem("⛶", on ? "Exit full screen" : "Full screen", on ? "" : "hide the browser bars", toggleFullscreen));
  }
  items.push(menuItem("←", "Lobby", "your seat stays", () => { location.href = "./"; }));
  $("pmenulist").replaceChildren(...items);
  $("psheet").hidden = false;
  pSheets();
}
// Полный экран (Android Chrome и др.). На iPhone Safari его нет — там «На экран Домой» (manifest, apple-mobile-web-app-capable)
function fullscreenOk() {
  const d = document.documentElement;
  return Boolean(document.fullscreenEnabled && d.requestFullscreen);
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => toast("Full screen is not available here"));
}
document.addEventListener("fullscreenchange", () => setTimeout(fit, 120));
$("pmenu").onclick = openMenu;
$("pchat").onclick = () => { showChat(true); };
$("psheetback").onclick = (e) => { if (e.target === $("psheetback")) closeSheets(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && portrait && !$("psheetback").hidden) closeSheets(); });

// ---------- размер под окно ----------
// Вся «сцена» нарисована в размере 1280×760 и целиком масштабируется под окно —
// так стол, карты, кнопки и надписи всегда сохраняют пропорции.
// Телефон вертикально — сцена не масштабируется: стол занимает всё место между шапкой и нижней панелью.
function fit() {
  const was = portrait;
  portrait = PORTRAIT.matches;
  document.body.classList.toggle("portrait", portrait);
  const room = $("room");
  // Компьютер (не телефон): вся страница — одна картинка 1280×960 (шапка 75 + стол 885), масштаб Z под окно
  pic = !portrait && !LOW.matches;
  document.documentElement.classList.toggle("z43", pic);
  Z = pic ? Math.min(innerWidth / 1280, innerHeight / 960) || 1 : 1;
  document.documentElement.style.setProperty("--z", Z);
  if (portrait) {
    room.style.setProperty("--k", 1);
    const t = $("table");
    TW = t.clientWidth || 390;
    TH = t.clientHeight || 600;
    POT_POS = [50, 37];
  } else if (pic) {
    // Сцена 1280×885 внутри картинки в масштабе 1 (всю картинку масштабирует Z), стол 1120×655
    TW = 1120; TH = 655; POT_POS = [50, 37];
    room.style.setProperty("--k", 1);
    smallHint(Z < 0.42 && !COARSE.matches);
  } else {
    // Телефон боком (высота до 500 px): прежняя сцена 1280×760 под экран
    TW = 1120; TH = 590; POT_POS = [50, 34];
    const k = Math.min(room.clientWidth / 1280, room.clientHeight / 760);
    room.style.setProperty("--k", k > 0 ? k : 1);
    smallHint(k > 0 && k < 0.42 && !COARSE.matches);       // на сенсорных экранах (телефон боком) подсказку не показываем
  }
  if (was !== portrait) { $("psheet").hidden = true; pSheets(); }
  if (portrait || was !== portrait) render();
}
// Окно стало слишком маленьким (ники мельче ~9 px): подсказка по центру, гаснет через 4 с после последнего изменения
let smallTimer = null;
function smallHint(show) {
  const box = $("smallhint");
  clearTimeout(smallTimer);
  box.hidden = !show;
  if (show) smallTimer = setTimeout(() => { box.hidden = true; }, 4000);
}
window.addEventListener("resize", fit);
PORTRAIT.addEventListener("change", fit);
LOW.addEventListener("change", fit);
fit();

connect();
