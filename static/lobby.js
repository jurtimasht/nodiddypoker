// NoDiddyPoker — лобби: вход / регистрация, ник, фото профиля, столы, таблица лидеров, инструменты хозяина.
// После входа сервер даёт ключ входа: он хранится в этом браузере (localStorage) и отправляется в заголовке X-Profile.

const $ = (id) => document.getElementById(id);
const KEY_PROFILE = "poker-profile";
function load(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
function save(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) {} }

let data = null;
const fmt = (n) => Number(n).toLocaleString("en-US");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Кружок с фото (или первой буквой ника)
function avatar(name, url, size) {
  const a = el("span", "ava");
  a.style.width = a.style.height = size + "px";
  if (url) a.style.backgroundImage = `url("${url}")`;
  else {
    a.textContent = [...name][0].toUpperCase();
    a.style.background = `hsl(${hue(name)} 45% 38%)`;
    a.style.fontSize = Math.round(size * 0.42) + "px";
  }
  return a;
}

async function api(method, url, body, type) {
  const headers = { "X-Profile": load(KEY_PROFILE) };
  if (body !== undefined) headers["Content-Type"] = type || "application/json";
  const res = await fetch(url, { method, headers, body: type ? body : body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Error " + res.status);
  return json;
}

// Сообщение об ошибке профиля: в окне профиля, а если оно закрыто — всплывающей строкой
function message(text) {
  $("msg").textContent = text || "";
  if (text && $("profiledlg").hidden) toast(text);
}

async function refresh() {
  try {
    data = await api("GET", "api/lobby");
    render();
  } catch (e) { message(e.message); }
}

// ---------- что за стол ----------
// Вид игры: hold'em / omaha / bomb pot (кнопки на вкладке Cash game)
const KINDS = [
  { id: "holdem", title: "Hold'em", desc: "No-limit, 2 cards. The classic." },
  { id: "omaha", title: "Omaha", desc: "Pot-limit, 4 cards, use exactly 2." },
  { id: "bomb", title: "Bomb Pot", desc: "Everyone puts 5 BB, straight to the flop, two boards." },
];
function kindOf(t) { return t.bomb ? "bomb" : (t.game === "plo4" || t.game === "plo5") ? "omaha" : "holdem"; }
const isHU = (t) => t.seats === 2;
const freeSeats = (t) => t.seats - t.seated.length;

// Название стола: «Hold'em #1» → «Hold'em» + серое «#1»; heads-up → красная метка
function tableName(t) {
  const box = el("div", "tname");
  let name = t.name, num = "";
  const m = /^(.*?)\s*(#\d+)$/.exec(name);
  if (m) { name = m[1]; num = m[2]; }
  if (isHU(t)) name = name.replace(/\s*heads[- ]?up\s*/i, " ").trim();
  box.append(name);
  if (num) box.append(el("span", "num", num));
  if (isHU(t)) box.append(el("span", "hu", "Heads-up"));
  return box;
}

// Что происходит за столом, словами
function tableState(t) {
  const n = t.seated.length;
  if (n === 0) return el("span", "state empty", isHU(t) ? "Empty — 1 vs 1" : "Empty — needs 2 players to start");
  if (n === 1) return el("span", "state wait", isHU(t) ? `${t.seated[0].name} is waiting for an opponent` : `${t.seated[0].name} is waiting — needs 1 more`);
  if (n >= t.seats) return el("span", "state live-hand", "Full · playing");
  return el("span", "state live-hand", "Playing now");
}

// Самый людный обычный стол со свободным местом (не heads-up): сначала выбранной игры, иначе любой
function quickTable(kind) {
  const pick = (list) => list.filter((t) => !isHU(t) && freeSeats(t) > 0 && !seatedAt(t.id))
    .sort((a, b) => b.seated.length - a.seated.length)[0];
  return (kind && pick(data.tables.filter((t) => kindOf(t) === kind))) || pick(data.tables);
}

const tableLink = (t) => `table?t=${encodeURIComponent(t.id)}`;

// Строка стола: название, правила, кто сидит, Join / Back
function tableRow(t, opts = {}) {
  const here = seatedAt(t.id);
  const row = el("div", "trow" + (here ? " mine" : "") + (isHU(t) ? " hu-row" : "") + (t.seated.length ? "" : " is-empty"));
  const info = el("div", "tinfo");
  const names = t.seated.map((p) => p.name).join(", ");
  const meta = el("div", "tmeta");
  meta.append(tableState(t), el("span", "mcount", `${t.seated.length}/${t.seats}` + (names ? ` · ${names}` : "")));
  if (opts.buy) meta.append(el("span", "buy", "· " + (t.buyins ? `buy-in ${t.buyins.map(short).join(" / ")}` : `buy-in from ${short(t.min_buyin)}`)));
  info.append(tableName(t), el("div", "tstakes", gameText(t, opts.short)), meta);
  const who = el("div", "twho");
  const faces = el("div", "faces");
  t.seated.slice(0, 7).forEach((p) => { const a = avatar(p.name, p.avatar, 28); a.title = p.name; faces.append(a); });
  who.append(faces, el("div", "tcount", (names ? names + " · " : "") + `${t.seated.length}/${t.seats}`));
  const full = freeSeats(t) <= 0;
  const go = el("a", "go", here ? "Open" : full ? "Full" : t.seated.length ? "Join" : "Sit first");
  go.href = tableLink(t);
  const blocked = !here && (full || tablesFull());
  go.classList.toggle("off", Boolean(blocked));
  if (blocked) go.setAttribute("aria-disabled", "true");
  go.onclick = (event) => {
    if (here) return;
    if (full) { event.preventDefault(); toast("This table is full."); }
    else if (tablesFull()) { event.preventDefault(); toast(TOO_MANY); }
  };
  row.append(info, who, go);
  return row;
}
const short = (n) => n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : fmt(n);

// ---------- вкладки: Home / Cash game / MTT (адрес #home / #cash / #mtt, работает кнопка «назад») ----------
const VIEWS = ["home", "cash", "mtt"];
function currentView() {
  const v = location.hash.replace("#", "").split("/")[0];        // #mtt/12 — карточка турнира на вкладке MTT
  return VIEWS.includes(v) ? v : "home";
}
let lastView = null;
window.addEventListener("hashchange", () => {
  closeMenu();
  if (data && data.me) render();
  if (currentView() !== lastView) window.scrollTo(0, 0);         // открыть/закрыть карточку — без прыжка наверх
  lastView = currentView();
});

function render() {
  const me = data.me;

  // Не вошёл — только вход / регистрация
  $("auth").hidden = Boolean(me);
  $("hero").hidden = Boolean(me);
  $("nav").hidden = $("memenu").hidden = !me;
  $("where").hidden = true;                                // слово «Lobby» в шапке до входа только путало
  if (!me) {
    if (load(KEY_PROFILE)) save(KEY_PROFILE, "");         // ключ входа устарел или аккаунт удалён
    for (const v of VIEWS) $("view-" + v).hidden = true;
    $("updatebar").hidden = $("seatbar").hidden = true;
    if (window.syncMttCard) syncMttCard();
    renderAuth();
    return;
  }
  startPresence();

  const view = currentView();
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
  document.querySelectorAll("#nav a").forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const atTables = data.tables.reduce((s, t) => s + t.seated.length, 0);
  $("navcount").hidden = !atTables;
  $("navcount").textContent = atTables;

  renderMe(me);
  renderSeatbar();
  renderUpdate();
  renderQuick();
  renderOnline(me);
  if (view === "home") { renderLeaders(me); renderNews(); }
  if (view === "mtt") loadMtt();
  if (view === "cash") renderCash();
  if (window.syncMttCard) syncMttCard();
}

// Мой кружок в шапке, окно профиля и карточка «You»
function renderMe(me) {
  $("mechipava").replaceChildren(avatar(me.name, me.avatar, 30));
  $("mechipname").textContent = me.name;
  $("mechip").setAttribute("aria-label", `${me.name} — profile menu`);
  $("menudelphoto").hidden = !me.avatar;
  $("menuowner").hidden = !data.owner;

  for (const [box, letter] of [["photo", "letter"], ["minephoto", "mineletter"]]) {
    const photo = $(box);
    photo.style.backgroundColor = `hsl(${hue(me.name)} 45% 38%)`;
    photo.style.backgroundImage = me.avatar ? `url("${me.avatar}")` : "none";
    photo.style.backgroundSize = "cover";
    photo.style.backgroundPosition = "center";
    $(letter).textContent = me.avatar ? "" : [...me.name][0].toUpperCase();
  }
  $("myname").textContent = $("minename").textContent = me.name;
  $("delphoto").hidden = !me.avatar;
  const seats = myList().filter((x) => x.code);
  $("minewhere").textContent = seats.length > 1 ? `playing · ${seats.length} tables` : seats.length ? `playing · ${seats[0].name}` : "in the lobby";
  // «You»: место в рейтинге Diddy, Diddy factor, раздачи
  const i = data.leaders.findIndex((r) => r.id === me.id);
  const r = data.leaders[i];
  $("statrank").textContent = r && r.diddy > 0 ? `#${i + 1}` : "—";      // ещё никого не переехал — места нет
  $("statdiddy").textContent = factor(r ? r.diddy : 0);
  $("stathands").textContent = r ? fmt(r.hands) : "0";
}
const factor = (v) => v.toFixed(1);                // Diddy factor: всегда один знак после точки

// Полоса «Вы сидите за столом» — на всех вкладках
// ---------- My tables: все мои места (до 4, кэш + турнир) ----------
// Сводку присылает сервер по сокету лобби (my_tables) — свежая, с «твой ход» и секундами; до неё — из api/lobby.
let myLive = null, myLiveAt = 0;
const myList = () => myLive || (data && data.my) || [];
const maxTables = () => (data && data.max_tables) || 4;
const seatedAt = (code) => myList().some((x) => x.code === code);
const tablesFull = () => myList().length >= maxTables();
const TOO_MANY = "You can play at most 4 tables at once. Leave one first.";
// ---------- столы в своих окнах ----------
// На компьютере стол сразу открывается окном 960×720 (имя ndp-<код>, у турнира ndp-mtt), лобби остаётся лобби.
// Окна — единственный режим (настройки больше нет). Браузер не дал открыть окно без нажатия — плашка «стол готов — Open».
// Телефон и старая программа (0.1, окон не умеет) — всегда в этой вкладке.
const phoneView = () => matchMedia("(max-width: 600px), (max-height: 500px) and (pointer: coarse)").matches;   // телефон и боком тоже
// Версия программы для компьютера: новые версии пишут её в window.__ndpDesktopVersion, 0.2.x — только __ndpDesktop = 2,
// 0.1 — __ndpDesktop = true. В браузере — null. Сервер её запоминает (в списке «онлайн» её видят все — это только
// «играет в программе x.y»), а старой программе — плашка.
function appVersion() {
  const d = window.__ndpDesktop;
  if (!d) return null;
  if (typeof window.__ndpDesktopVersion === "string") return window.__ndpDesktopVersion.slice(0, 12);
  return d === true ? "0.1" : "0.2";
}
function renderAppBar() {
  let hidden = false;
  try { hidden = localStorage.getItem("poker-appbar") === "hidden"; } catch (e) { /* без хранилища — покажем */ }
  $("appbar").hidden = hidden || appVersion() !== "0.1";
}
$("appbarclose").onclick = () => { try { localStorage.setItem("poker-appbar", "hidden"); } catch (e) { /* ничего */ } $("appbar").hidden = true; };
renderAppBar();
const useWindows = () => !phoneView() && window.__ndpDesktop !== true;   // окна столов всегда (кроме телефона и программы 0.1)
const isMttCode = (code) => /^m\d+-\d+$/.test(code);
// Открыть стол. byClick — после нажатия игрока (браузер разрешает окно). Без нажатия окно может быть заблокировано —
// тогда возвращаем false и ничего не трогаем (лобби покажет плашку «стол готов — Open»).
function openTable(code, mtt, byClick = true) {
  const url = new URL(`table?t=${encodeURIComponent(code)}`, location.href).href;
  const name = mtt ? "ndp-mtt" : "ndp-" + code;
  if (!useWindows()) {
    if (byClick) location.href = url;
    return byClick;
  }
  if (window.__ndpDesktop) { window.open(url, name); return true; }   // программа 0.2+: окно создаёт сама
  const w = window.open("", name, "popup,width=960,height=720");
  if (!w) {
    if (byClick) location.href = url;                                // окна заблокированы совсем — открыть во вкладке
    return byClick;
  }
  let blank = true;
  try { blank = w.location.href === "about:blank"; } catch (e) { blank = true; }   // адрес не прочитать (чужой сайт) — всё равно открыть наш стол
  if (blank) w.location.href = url;
  w.focus();
  return true;
}
// Любая ссылка на стол в лобби (Join, Open, Quick seat, My tables, «Back to my table», Watch) — окном, прямо в клике
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !useWindows()) return;
  const a = event.target.closest && event.target.closest('a[href^="table?t="]');
  if (!a) return;
  const code = new URL(a.href).searchParams.get("t");
  if (!code) return;
  event.preventDefault();
  openTable(code, isMttCode(code), true);
});
// Без нажатия (старт турнира, пересадка, поздняя запись, ребай): пробуем открыть окно сами. Браузер может не дать —
// тогда плашка «Your tournament table is ready — Open». Плашка гаснет, когда окно этого стола подключилось к серверу.
let readyTable = null;
function tableReady(code) {
  if (!code) return;
  if (!useWindows()) {
    // Телефон (и старая программа): окон нет, сами уйти со страницы не можем — та же плашка «стол готов — Open»
    // (по нажатию стол открывается в этой вкладке) и короткая вибрация, если телефон умеет
    readyTable = code;
    renderReady();
    try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) { /* не умеет — ничего */ }
    return;
  }
  const inWindow = myList().some((x) => x.code === code && x.window);
  if (inWindow) return;                                              // окно турнира уже открыто и само перейдёт
  openTable(code, isMttCode(code), false);
  readyTable = code;                                                 // погаснет, как только окно подключится
  renderReady();
}
function renderReady() {
  const bar = $("readybar");
  const x = readyTable && myList().find((t) => t.code === readyTable);
  if (x && x.window) readyTable = null;
  bar.hidden = !readyTable;
  if (!readyTable) return;
  const code = readyTable;
  $("readyopen").onclick = () => { openTable(code, isMttCode(code), true); };
  $("readyclose").onclick = () => { readyTable = null; renderReady(); };
}
function renderSeatbar() {
  const list = [...myList()].sort((a, b) => (b.my_turn - a.my_turn) || ((a.left || 99) - (b.left || 99)));
  const box = $("seatbar");
  box.hidden = !list.length;
  document.body.classList.toggle("is-seated", tablesFull());          // 4 из 4 — Quick seat прячется
  if (!list.length) return;
  $("mtcount").textContent = `${list.length}/${maxTables()}`;
  $("mtnote").textContent = tablesFull() ? "Table limit reached — leave one to join another" : "";
  const seated = list.filter((x) => x.code);
  const allAway = seated.length && seated.every((x) => x.away);
  $("sitoutall").hidden = !seated.length;
  $("sitoutall").textContent = allAway ? "I'm back on all" : "Sit out all";
  $("sitoutall").onclick = () => sendLobby({ type: "away_all", value: !allAway });
  const passed = (performance.now() - myLiveAt) / 1000;
  $("mtlist").replaceChildren(...list.map((x) => {
    const row = el("div", "mtrow" + (x.my_turn ? " turn" : "") + (x.away ? " away" : ""));
    const st = el("span", "mt-st");
    if (x.registered) st.textContent = "Signed up";
    else if (x.my_turn) {
      const chip = el("span", "mt-turn");
      chip.append(el("span", "", "Your turn"), " ", el("b", "mt-left", `${Math.max(0, Math.ceil((x.left || 0) - passed))}s`));
      chip.dataset.left = x.left || 0;
      st.append(chip);
    } else st.textContent = x.away ? "Sitting out" : "Waiting";
    const name = el("span", "mt-name");
    if (x.mtt) name.append(el("span", "mt-mtt", "MTT"));
    // «$25 NLH #1 · table 1»: название турнира пишет человек (не переводим), «· table 1» — переводим («· стол 1»)
    const tm = /^(.*) (· table \d+)$/.exec(x.name);
    const nm = el("b", "", tm ? tm[1] : x.name);
    nm.dataset.notr = "";
    if (tm) name.append(nm, el("b", "", tm[2])); else name.append(nm);
    name.append(el("span", "mt-meta", x.registered ? "starts soon" : `${x.game === "nlhe" ? "NLH" : x.game.toUpperCase()} · ${fmt(x.sb)}/${fmt(x.bb)}`));
    const stack = el("span", "mt-stack", x.registered ? "" : fmt(x.stack));
    const acts = el("span", "mt-acts");
    if (x.code) {
      const open = el("a", "go mt-open", "Open");
      open.href = `table?t=${encodeURIComponent(x.code)}`;
      const pop = el("button", "mt-pop" + (x.window ? " inwin" : ""), x.window ? "◉ In window" : "⧉ Pop out");
      pop.type = "button";
      pop.onclick = () => openTable(x.code, x.mtt);
      pop.hidden = window.__ndpDesktop === true || !useWindows();     // телефон и программа 0.1 — окон нет
      acts.append(open, pop);
    } else {
      const more = el("a", "mt-pop", "Details");
      more.href = "#mtt";
      acts.append(more);
    }
    row.append(st, name, stack, acts);
    return row;
  }));
}
setInterval(() => {                                      // секунды «Your turn» в My tables
  const passed = (performance.now() - myLiveAt) / 1000;
  document.querySelectorAll("#mtlist .mt-turn").forEach((c) => {
    c.querySelector(".mt-left").textContent = `${Math.max(0, Math.ceil(Number(c.dataset.left) - passed))}s`;
  });
}, 1000);

// Quick seat: куда посадит
function renderQuick() {
  const kind = currentView() === "cash" ? selectedKind() : null;
  const t = quickTable(kind);
  document.querySelectorAll(".quickseat").forEach((a) => {
    a.hidden = tablesFull() || !t;
    if (t) a.href = tableLink(t);
  });
  document.querySelectorAll(".quicktext").forEach((p) => {
    p.replaceChildren();
    if (!t) { p.textContent = "All tables are full."; return; }
    const n = t.seated.length;
    if (n) p.append("Seats you at the busiest table with a free seat — now ", el("b", "", t.name), ` (${n} playing, ${freeSeats(t)} free).`);
    else p.append("Nobody is playing yet — start a game at ", el("b", "", t.name), ".");
  });
}

// ---------- Cash game ----------
function selectedKind() {
  const saved = load("poker-kind");
  if (KINDS.some((k) => k.id === saved) && data.tables.some((t) => kindOf(t) === saved)) return saved;
  // по умолчанию — где больше всего игроков
  let best = KINDS[0].id, most = -1;
  for (const k of KINDS) {
    const n = data.tables.filter((t) => kindOf(t) === k.id).reduce((s, t) => s + t.seated.length, 0);
    if (n > most && data.tables.some((t) => kindOf(t) === k.id)) { best = k.id; most = n; }
  }
  return best;
}
const shownEmpty = new Set();            // какие свёрнутые пустые столы человек раскрыл («Show»)

function renderCash() {
  const kind = selectedKind();
  $("kinds").replaceChildren(...KINDS.filter((k) => data.tables.some((t) => kindOf(t) === k.id)).map((k) => {
    const tables = data.tables.filter((t) => kindOf(t) === k.id);
    const people = tables.flatMap((t) => t.seated);
    const b = el("button", "kind" + (k.id === kind ? " on" : ""));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", k.id === kind ? "true" : "false");
    const count = el("span", "kcount");
    count.append(el("span", "state " + (people.length ? "live-hand" : "empty"), people.length ? `${people.length} playing` : "nobody yet"));
    if (people.length) {
      const faces = el("span", "faces");
      people.slice(0, 5).forEach((p) => faces.append(avatar(p.name, p.avatar, 24)));
      count.append(faces);
    }
    b.append(el("span", "kname", k.title), el("span", "kdesc", k.desc), count);
    b.onclick = () => { save("poker-kind", k.id); render(); };
    return b;
  }));
  const info = KINDS.find((k) => k.id === kind);
  const tables = data.tables.filter((t) => kindOf(t) === kind);
  $("listtitle").textContent = `${info.title} tables`;
  const first = tables[0];
  $("kindsub").textContent = first ? `${info.desc} · blinds ${fmt(first.sb)}/${fmt(first.bb)}` : info.desc;

  // Порядок: столы с людьми (больше людей — выше), heads-up всегда виден,
  // из пустых обычных — один на виду, остальные свёрнуты, пока занятые не заполнились
  const regular = tables.filter((t) => !isHU(t));
  const busy = regular.filter((t) => t.seated.length).sort((a, b) => b.seated.length - a.seated.length);
  const empty = regular.filter((t) => !t.seated.length);
  const needEmpty = !busy.length || busy.every((t) => freeSeats(t) <= 0);
  const visible = [...busy];
  const folded = [];
  empty.forEach((t, i) => (needEmpty && i === 0) || shownEmpty.has(t.id) ? visible.push(t) : folded.push(t));
  const hu = tables.filter(isHU).sort((a, b) => b.seated.length - a.seated.length);
  const rows = [...visible.filter((t) => t.seated.length), ...hu.filter((t) => t.seated.length),
                ...visible.filter((t) => !t.seated.length), ...hu.filter((t) => !t.seated.length)];
  const out = rows.map((t) => tableRow(t, { buy: true }));
  for (const t of folded) {
    const note = el("div", "emptynote");
    const busyNames = busy.map((x) => x.name).join(", ");
    note.append(`${t.name} (${t.seats} seats) is empty` + (busyNames ? ` — for when ${busyNames} fills up. ` : ". "));
    const show = el("button", "linkbtn", "Show");
    show.type = "button";
    show.onclick = () => { shownEmpty.add(t.id); render(); };
    note.append(show);
    out.push(note);
  }
  $("tables").replaceChildren(...out);
}

// Кто онлайн: за столами (с Join — сесть к нему) / в лобби
function renderOnline(me) {
  const online = [...(data.online || [])];
  // себя считаем всегда: список с сервера мог прийти раньше, чем отметилось лобби (было «0 · just you»)
  if (!online.some((p) => p.id === me.id)) {
    const seated = myList().filter((x) => x.code);
    const state = !seated.length ? "lobby" : seated.every((x) => x.away) ? "away" : "playing";
    const where = seated.length === 1 ? seated[0].name : seated.length ? `${seated.length} tables` : "";
    online.unshift({ id: me.id, name: me.name, avatar: me.avatar, state, where });
  }
  const label = { playing: (w) => `playing · ${w}`, away: (w) => `sitting out · ${w}`, watching: (w) => `watching · ${w}`, lobby: () => "in the lobby" };
  const byName = Object.fromEntries(data.tables.map((t) => [t.name, t]));
  const person = (p) => {
    const isMe = p.id === me.id;
    const li = el("li", "person st-" + p.state + (isMe ? " me" : ""));   // st-… — чтобы не совпасть с другими стилями
    const info = el("div", "pinfo");
    info.append(el("div", "pname", p.name + (isMe ? " (you)" : "")), el("div", "pwhere", label[p.state](p.where)));
    if (p.app) { const a = el("span", "papp", `🖥 app ${p.app}`); a.title = "Plays in the desktop app"; info.lastChild.append(" · ", a); }
    li.append(avatar(p.name, p.avatar, 28), info);
    const t = byName[p.where];
    if (t && !isMe && p.state !== "lobby") {
      const here = seatedAt(t.id);
      const full = freeSeats(t) <= 0 && !here;
      const join = el("a", "sitwith", here ? "Open" : full ? "Full" : "Join");
      join.href = tableLink(t);
      const blocked = !here && (full || tablesFull());
      join.classList.toggle("off", Boolean(blocked));
      join.onclick = (event) => {
        if (here) return;
        if (full) { event.preventDefault(); toast("This table is full."); }
        else if (tablesFull()) { event.preventDefault(); toast(TOO_MANY); }
      };
      join.title = `Go to ${t.name}`;
      li.append(join);
    } else li.append(el("span", "pdot"));
    return li;
  };
  const fill = (box, sections) => {
    if (!online.length) { box.replaceChildren(el("p", "muted small", "Nobody is online right now.")); return; }
    const parts = [];
    for (const [title, list] of sections) {
      if (!list.length) continue;
      if (title) parts.push(el("div", "sub", title));
      const ul = el("ul", "people");
      ul.append(...list.map(person));
      parts.push(ul);
    }
    box.replaceChildren(...parts);
  };
  const atTables = online.filter((p) => p.state !== "lobby");
  const inLobby = online.filter((p) => p.state === "lobby");
  fill($("people"), [["At tables", atTables], ["In the lobby", inLobby]]);
  fill($("wherelist"), [["", online]]);
  const others = online.filter((p) => p.id !== me.id).map((p) => p.name);
  for (const [count, peek] of [["onlinecount", "onlinepeek"], ["wherecount", "wherepeek"]]) {
    $(count).textContent = online.length;
    $(peek).replaceChildren(el("b", "", String(online.length)), others.length ? ` · ${others.join(", ")}` : " · just you");
  }
}

// Diddy leaderboard (кто сколько фаворитов переехал): на Home первые 5, «Full table» — все
let leadersAll = false;
// Рейтинг Diddy (кто переезжает фаворитов): на Home первые 5, «Full table» — все
function renderLeaders(me) {
  $("since").textContent = "since " + new Date(data.since * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const head = el("tr");
  for (const h of ["#", "Player", "Factor", "Bad beats", "Hands", "Sickest"]) head.append(el("th", "", h));
  $("lbhead").replaceChildren(head);
  const rows = data.leaders;
  const body = $("leaders");
  const peek = $("leaderspeek");
  const myRank = rows.findIndex((r) => r.id === me.id);
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "muted", "No hands played yet.");
    td.colSpan = 6;
    tr.append(td);
    body.replaceChildren(tr);
    peek.textContent = "No hands played yet";
    $("fulltable").hidden = true;
    return;
  }
  const top = rows[0];
  if (top.diddy > 0) {
    peek.replaceChildren("🥇 ", el("b", "", top.name), ` ${factor(top.diddy)} `,
                         ...(myRank > 0 && rows[myRank].diddy > 0 ? [`· you are #${myRank + 1}`] : []));
  } else peek.textContent = "No bad beats yet";
  const limit = leadersAll ? rows.length : 5;
  body.replaceChildren(...rows.slice(0, limit).map((r, i) => {
    const tr = el("tr");
    if (r.id === me.id) tr.className = "me";
    const who = el("td", "player");
    who.append(avatar(r.name, r.avatar, 30), el("span", "", r.name));
    const f = el("td", "diddy" + (r.diddy > 0 ? "" : " zero"));
    f.append(el("b", "", factor(r.diddy)));
    tr.append(el("td", "rank", r.diddy > 0 ? ["🥇", "🥈", "🥉"][i] || String(i + 1) : "—"), who,       // медали — только с очками
              f, el("td", "", fmt(r.badbeats)), el("td", "", fmt(r.hands)), el("td", "", r.sickest ? `${r.sickest}%` : "—"));
    return tr;
  }));
  $("fulltable").hidden = false;
  $("fulltable").textContent = leadersAll ? "Show less" : `Full table${rows.length > 5 ? ` (${rows.length})` : ""} →`;
  const card = document.querySelector(".a-leaders");
  card.classList.toggle("all", leadersAll);     // «Full table» — все строки и все столбцы
  card.classList.add("lb-diddy");
}
$("fulltable").onclick = () => { leadersAll = !leadersAll; render(); };

// Телефон: блоки-«гармошки» свёрнуты (в строке — главное). Компьютер: всегда открыты.
const phone = matchMedia("(max-width: 820px)");
function setupFolds() {
  document.querySelectorAll("details.fold").forEach((d) => { d.open = !phone.matches; });
}
document.querySelectorAll("details.fold > summary").forEach((s) => {
  s.addEventListener("click", (event) => { if (!phone.matches) event.preventDefault(); });
});
phone.addEventListener("change", setupFolds);
setupFolds();

// ---------- новости ----------
const NEWS_ICON = { owner: "📣", leader: "👑", player: "👋", tournament: "🏆" };
const NEWS_TAG = { owner: "From the owner", leader: "Leaderboard", player: "Players", tournament: "Tournaments" };
function newsWhen(t) {
  const d = new Date(t * 1000);
  const day = dayName(d);
  return (day === "Today" || day === "Yesterday" ? day + ", " : day + ", ") + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function newsItem(n) {
  const li = el("li", "n-item" + (n.pinned ? " pin" : ""));
  const body = el("div", "nbody");
  const t = el("div", "t");
  const said = el("span", "", n.text);
  if (n.kind === "owner") said.dataset.notr = "";          // новости владельца — как написаны; автоновости переводим
  t.append(el("span", "tag", NEWS_TAG[n.kind] || "News"), said);        // 📌 уже слева, в теге не повторяем
  body.append(t, el("div", "d", newsWhen(n.t)));
  li.append(el("span", "ic", n.pinned ? "📌" : NEWS_ICON[n.kind] || "✨"), body);
  return li;
}
function renderNews() {
  const news = data.news || [];
  $("news").replaceChildren(...(news.length ? news.slice(0, 4).map(newsItem) : [el("li", "muted small", "No news yet.")]));
  const top = news[0];
  $("newspeek").replaceChildren();
  if (top) {
    const said = el("span", "", (top.pinned ? "📌 " : "") + top.text);
    if (top.kind === "owner") said.dataset.notr = "";
    $("newspeek").append(said);
  } else $("newspeek").textContent = "No news yet";
}
// ---------- общий чат лобби ----------
const chat = { items: [], owner: false };
const dayName = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : day.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
};
function renderChat(scroll) {
  const list = $("msgs");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const parts = [];
  let lastDay = "";
  for (const m of chat.items) {
    const when = new Date(m.t * 1000);
    const day = dayName(when);
    if (day !== lastDay) { parts.push(el("li", "day", day)); lastDay = day; }
    const li = el("li", "m" + (data && data.me && m.pid === data.me.id ? " mine" : ""));
    const body = el("div", "body");
    const who = el("div", "who");
    who.append(el("span", "", m.name));
    who.firstChild.dataset.notr = "";
    who.append(el("time", "", when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })));
    const said = el("div", "txt", m.text);                // только textContent — никакого HTML от людей
    said.dataset.notr = "";                               // сообщения людей не переводим
    body.append(who, said);
    li.append(avatar(m.name, m.avatar, 30), body);
    if (chat.owner) {
      const del = el("button", "mdel", "×");
      del.type = "button";
      del.title = "Delete this message";
      del.setAttribute("aria-label", `Delete message from ${m.name}`);
      del.onclick = async () => {
        if (await Dialog.ask({ text: "Delete this message for everyone?", ok: "Delete", danger: true })) sendLobby({ type: "lobby_chat_delete", id: m.id });
      };
      li.append(del);
    }
    parts.push(li);
  }
  if (!chat.items.length) parts.push(el("li", "empty muted small", "No messages yet. Say hi — everyone in the lobby sees it."));
  list.replaceChildren(...parts);
  if (scroll || nearBottom) list.scrollTop = list.scrollHeight;
  const last = chat.items[chat.items.length - 1];
  const peek = $("chatpeek");
  peek.replaceChildren();
  if (last) {
    const said = el("span", "", "");
    said.dataset.notr = "";
    said.append(el("b", "", last.name + ": "), last.text);
    peek.append(said);
  }
  else peek.textContent = "Say hi to everyone";
}
function sendLobby(msg) {
  if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) { lobbyWs.send(JSON.stringify(msg)); return true; }
  toast("No connection — trying again…");
  return false;
}
$("compose").onsubmit = (event) => {
  event.preventDefault();
  const text = $("say").value.trim();
  if (!text) return;
  if (sendLobby({ type: "lobby_chat", text })) $("say").value = "";
};
$("lchat").addEventListener("toggle", () => { if ($("lchat").open) $("msgs").scrollTop = $("msgs").scrollHeight; });
renderChat(true);

// ---------- меню под ником ----------
function closeMenu() { $("menu").hidden = true; $("mechip").setAttribute("aria-expanded", "false"); }
$("mechip").onclick = (event) => {
  event.stopPropagation();
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("mechip").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) $("menu").querySelector("button, a").focus();
};
document.addEventListener("click", (event) => { if (!event.target.closest("#memenu")) closeMenu(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("menu").hidden) { closeMenu(); $("mechip").focus(); }
  else if (!$("profiledlg").hidden) closeProfile();
});
$("menu").addEventListener("click", (event) => {
  const b = event.target.closest("[data-act]");
  if (!b) { closeMenu(); return; }
  closeMenu();
  const act = b.dataset.act;
  if (act === "photo") $("file").click();
  else if (act === "delphoto") $("delphoto").click();
  else if (act === "rename") { openProfile(); $("rename").click(); }
  else if (act === "password") { openProfile(); $("chpass").click(); }
  else if (act === "logout") logout();
});

// Окно «Your profile»
function openProfile() { $("profiledlg").hidden = false; message(""); }
function closeProfile() {
  $("profiledlg").hidden = true;
  $("renameform").hidden = $("pwform").hidden = true;
  $("pwold").value = $("pwnew").value = "";
}
$("editprofile").onclick = openProfile;
$("profileclose").onclick = closeProfile;
$("profiledlg").onclick = (event) => { if (event.target === $("profiledlg")) closeProfile(); };

// ---------- вход и регистрация ----------
let authMode = "login";
function renderAuth() {
  document.querySelectorAll(".authtabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.auth === authMode));
  const reg = authMode === "register";
  $("invitefield").hidden = !reg || !data.need_invite;
  $("authinvite").required = reg && data.need_invite;
  $("authpass").autocomplete = reg ? "new-password" : "current-password";
  $("authgo").textContent = reg ? "Create account" : "Log in";
  $("authhint").textContent = reg
    ? "Pick a nickname (others see it at the table) and a password (6+ characters). Then you can log in from any device."
    : "Log in with your nickname and password — from any device.";
}
document.querySelectorAll(".authtabs .tab").forEach((b) => {
  b.onclick = () => { authMode = b.dataset.auth; $("authmsg").textContent = ""; renderAuth(); };
});
$("authform").onsubmit = async (event) => {
  event.preventDefault();
  const reg = authMode === "register";
  const body = { name: $("authname").value, password: $("authpass").value };
  if (reg) body.invite = $("authinvite").value;
  $("authgo").disabled = true;
  try {
    const res = await api("POST", reg ? "api/register" : "api/login", body);
    save(KEY_PROFILE, res.token);
    save("poker-token", "");                   // место за столом — от прошлого входа, не нужно
    $("authpass").value = $("authinvite").value = "";
    $("authmsg").textContent = "";
    toast(reg ? "Account created! Add a photo in the menu under your name." : `Welcome back, ${res.me.name}!`);
    await refresh();
  } catch (e) { $("authmsg").textContent = e.message; }
  finally { $("authgo").disabled = false; }
};
async function logout() {
  if (!await Dialog.ask({ text: "Log out on this device?", ok: "Log out" })) return;
  try { await api("POST", "api/logout", {}); } catch (e) {}
  save(KEY_PROFILE, "");
  save("poker-token", "");
  location.hash = "";
  location.reload();
}

// ---------- смена пароля ----------
$("chpass").onclick = () => {
  $("pwuser").value = data.me.name;
  $("pwform").hidden = false;
  $("pwold").focus();
};
$("pwcancel").onclick = () => { $("pwform").hidden = true; $("pwold").value = $("pwnew").value = ""; };
$("pwform").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("POST", "api/password", { old: $("pwold").value, new: $("pwnew").value });
    $("pwform").hidden = true;
    $("pwold").value = $("pwnew").value = "";
    message("");
    toast("Password changed. Other devices need to log in again.");
  } catch (e) { message(e.message); }
};

// Что за игра за столом: «NL Hold'em · 50/100», «PLO4 · Pot limit · 50/100», «PLO5 · Bomb pot 5 BB»
function gameText(t, brief) {
  const name = t.game === "plo4" ? (brief ? "PLO4" : "PLO4 · pot limit") : t.game === "plo5" ? (brief ? "PLO5" : "PLO5 · pot limit") : (brief ? "NL" : "NL Hold'em");
  let text = `${name} · ${fmt(t.sb)}/${fmt(t.bb)}`;
  if (t.bomb) text += ` · bomb pot ${t.bomb / t.bb} BB`;
  if (t.double_board) text += " · double board";
  if (!brief) text += ` · ${isHU(t) ? "1 vs 1" : t.seats + " seats"}`;
  return text;
}

// Хозяину — короткая подсказка в лобби; сама кнопка Update site теперь в Admin
function renderUpdate() {
  const box = $("updatebar");
  const u = data.update;
  const a = u && u.available, ap = u && u.applying;
  let text = "", cls = "new";
  if (u && (u.dirty || u.diverged)) { text = "⚠ Updates are paused — see Admin › Site"; cls = "bad"; }
  else if (ap) { text = ap.state === "waiting" ? "⏳ The site will update when the tables are empty" : "⚙ Installing the new version…"; cls = "busy"; }
  else if (a && a.tests === "passed") text = "⬆ A new version is ready — open Admin › Site to install it";
  box.hidden = !text;
  if (!text) return;
  const link = el("a", "", text);
  link.href = "admin#site";
  box.className = "updatebar compact " + cls;
  box.replaceChildren(link);
}

// ---------- профиль ----------
$("rename").onclick = () => {
  $("renameinput").value = data.me.name;
  $("renameform").hidden = false;
  $("renameinput").focus();
};
$("renamecancel").onclick = () => { $("renameform").hidden = true; };
$("renameform").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("POST", "api/profile", { name: $("renameinput").value });
    $("renameform").hidden = true;
    message("");
    refresh();
  } catch (e) { message(e.message); }
};

// ---------- фото ----------
$("photo").onclick = () => $("file").click();
$("file").onchange = async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { message("The photo must be under 4 MB."); return; }
  message("Uploading photo…");
  try {
    await api("POST", "api/avatar", file, file.type || "application/octet-stream");
    message("");
    toast("Photo updated — it shows at the table and on the leaderboard.");
    refresh();
  } catch (e) { message(e.message); }
};
$("delphoto").onclick = async () => {
  if (!await Dialog.ask({ text: "Remove your profile photo?", ok: "Remove", danger: true })) return;
  try { await api("DELETE", "api/avatar"); refresh(); } catch (e) { message(e.message); }
};

// ---------- «я ещё на сайте» ----------
// Пока лобби открыто, сервер знает, что ты не закрыл сайт, и держит твоё место за столом.
// Закроешь сайт совсем (ни стола, ни лобби) — через 15 секунд встанешь из-за стола.
let seated = false;
let presenceOn = false;
let lobbyWs = null;
// Лобби закрывают (или обновляют) — сказать серверу «ухожу»: иначе он примет это за обрыв связи и будет ждать дольше
window.addEventListener("pagehide", () => { if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) lobbyWs.send(JSON.stringify({ type: "bye" })); });
function startPresence() { if (!presenceOn) { presenceOn = true; presence(); } }   // только после входа
function presence() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}${location.pathname.replace(/\/+$/, "")}/ws`);
  lobbyWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", lobby: true, token: load("poker-token"), profile: load(KEY_PROFILE), app: appVersion() }));
    ws.send(JSON.stringify({ type: "lobby_chat_history" }));
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "auth") { ws.onclose = null; presenceOn = false; refresh(); return; }   // вход устарел
    if (msg.type === "lobby_chat_history") { chat.items = msg.items; chat.owner = msg.owner; renderChat(true); return; }
    if (msg.type === "lobby_chat") { chat.items.push(msg.msg); chat.items = chat.items.slice(-200); renderChat(true); return; }
    if (msg.type === "lobby_chat_deleted") { chat.items = chat.items.filter((m) => m.id !== msg.id); renderChat(false); return; }
    if (msg.type === "error") { toast(msg.text); return; }
    if (msg.type === "mtt_seat") { tableReady(msg.table); return; }      // рассадка / пересадка / ребай в турнире
    if (msg.type === "my_tables") {
      const codes = (l) => l.map((x) => x.code || "reg").sort().join();
      const changed = !data || codes(msg.tables) !== codes(myList());
      myLive = msg.tables;
      myLiveAt = performance.now();
      if (readyTable) renderReady();
      if (data && data.me) renderSeatbar();
      if (changed) refresh();                            // сел или встал — обновить кнопки Join
      return;
    }
    if (msg.type === "presence") {
      seated = msg.seated;
      if (data && (data.mine || null) !== (msg.table || null)) refresh();   // сел или встал — обновить кнопки столов
    }
  };
  ws.onclose = () => { if (lobbyWs === ws) lobbyWs = null; setTimeout(presence, 3000); };
}

refresh();
setInterval(refresh, 5000);          // лидеры и стол обновляются сами

// ---------- вкладка MTT: турниры ----------
let mtt = null;
let mttLoading = false;
async function loadMtt() {
  if (mttLoading) return;
  mttLoading = true;
  try { mtt = await api("GET", "api/mtt"); renderMtt(); }
  catch (e) { /* лобби обновится через 5 секунд */ }
  finally { mttLoading = false; }
}
const nfmt = (n) => Number(n).toLocaleString("en-US");
const usd = (cents) => (cents < 0 ? "−" : "") + "$" + (Math.abs(cents) % 100 ? (Math.abs(cents) / 100).toFixed(2) : String(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function inDays(ts) {
  const d = Math.round((new Date(ts * 1000).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
}
function dateTile(ts) {
  const box = el("div", "dtile");
  if (!ts) { box.append(el("b", "", "🏁"), el("span", "small", "by the owner")); return box; }
  const d = new Date(ts * 1000);
  box.append(el("span", "dw", d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase()),
             el("b", "", String(d.getDate())), el("span", "dt", d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })));
  return box;
}
// Длина уровня честно: 30 с — «30-sec levels», 60 с и кратные минуте — «N-min levels»
const lobbyLevelLen = (sec) => (sec % 60 ? `${sec}-sec levels` : `${sec / 60}-min levels`);
function chipsTags(a) {
  const tags = el("div", "mtags");
  const ante = a.levels.findIndex((l) => l.ante > 0);
  const items = [a.game === "plo4" ? "Omaha" : "Hold'em", `${nfmt(a.stack)} chips`, lobbyLevelLen(a.level_seconds)];
  if (a.buy_in) items.unshift(`${usd(a.buy_in)} buy-in`);
  if (a.buy_in) items.splice(1, 0, `prize pool ${usd(a.prize_pool)}`);
  if (ante >= 0) items.push(ante === 0 ? "ante from the start" : `ante from lvl ${ante + 1}`);
  items.push(a.late_reg_level ? `late reg to lvl ${a.late_reg_level}` : "no late reg");
  items.push(a.rebuy_level ? `rebuys to lvl ${a.rebuy_level}` : "no rebuys");
  items.push(`${a.seats} per table`);
  if (a.test) items.push("test — no points");
  for (const t of items) tags.append(el("span", "mtag", t));
  return tags;
}
function structure(a) {
  const d = el("details", "struct");
  d.append(el("summary", "", "Blind structure"));
  const t = el("table", "mini-blinds");
  const head = el("tr");
  for (const h of ["Lvl", "SB", "BB", "Ante"]) head.append(el("th", "", h));
  t.append(head);
  a.levels.forEach((l, i) => {
    const tr = el("tr" , i + 1 === a.level && a.status !== "registration" ? "now" : "");
    tr.append(el("td", "", String(i + 1)), el("td", "", nfmt(l.sb)), el("td", "", nfmt(l.bb)), el("td", "", l.ante ? nfmt(l.ante) : "—"));
    t.append(tr);
  });
  d.append(t);
  return d;
}
async function mttAct(action) {
  try { await api("POST", `api/mtt/${mtt.active.id}/${action}`, {}); await loadMtt(); refresh(); }
  catch (e) { toast(e.message); }
}
function ordinalEn(n) {
  if (!n) return "?";
  return n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}
// Ссылка на карточку турнира (#mtt/<номер>): название турнира
function cardLink(id, text) {
  const a = el("a", "", text);
  a.href = `#mtt/${id}`;
  return a;
}
let mttClockEnd = null;
function renderMtt() {
  if (!mtt) return;
  const a = mtt.active;
  const me = a && a.me;
  // 1. идёт турнир, где я играю (или уже вылетел)
  const live = $("mttlive");
  live.hidden = !(a && ["running", "paused"].includes(a.status) && me);
  if (!live.hidden) {
    const playing = a.players.filter((p) => p.status === "playing");
    const mine = a.players.find((p) => p.me);
    const rank = playing.findIndex((p) => p.me) + 1;
    const head = el("div", "lhead");
    const nm = el("h2", "lname");
    nm.append(cardLink(a.id, a.name));
    nm.dataset.notr = "";
    head.append(el("span", "st st-" + a.status, a.status === "paused" ? "Paused" : "Running"), nm,
                el("span", "muted small", `${a.left} of ${a.entrants} left`));
    const grid = el("div", "lgrid");
    const lv = el("div", "lcell");
    const bl = el("div", "lbl", `${nfmt(a.sb)} / ${nfmt(a.bb)}`);
    if (a.ante) bl.append(el("span", "ante", ` ante ${nfmt(a.ante)}`));
    mttClockEnd = a.level_left != null && a.status === "running" ? Date.now() + a.level_left * 1000 : null;
    const nextTxt = el("span", "muted small", a.next ? `next: ${nfmt(a.next.sb)} / ${nfmt(a.next.bb)}` + (a.next.ante ? ` · ante ${nfmt(a.next.ante)}` : "") + " in " : "last level");
    const clock = el("b", "mclock", a.level_left != null ? mmssL(a.level_left) : "");
    if (a.next) nextTxt.append(clock);
    lv.append(el("span", "eyebrow", `Level ${a.level} of ${a.levels.length}`), bl, nextTxt);
    const you = el("div", "lcell");
    const go = el("div", "lcell lgo");
    if (me.status === "playing" && mine) {
      if (a.buy_in) lv.append(el("span", "muted small", `prize pool ${usd(a.prize_pool)}` + (a.next_prize ? ` · next prize ${usd(a.next_prize.amount)} (${ordinalEn(a.next_prize.place)})` : "")));
      you.append(el("span", "eyebrow", `You · table ${String(me.table || "").split("-").pop()}`),
                 el("div", "lbl", nfmt(mine.chips)), el("span", "muted small", `${a.bb ? Math.round(mine.chips / a.bb) : 0} BB · place ${rank} of ${playing.length} · avg ${nfmt(a.avg_stack)}`));
      const b = el("a", "go", "Back to my table");
      b.href = `table?t=${encodeURIComponent(me.table)}`;
      go.append(b, el("span", "muted small", "hands keep going without you"));
    } else {
      you.append(el("span", "eyebrow", "You"), el("div", "lbl", `${ordinalEn(me.place)} place`), el("span", "muted small", "you're out"));
      if (me.can_rebuy) {
        const b = el("button", "go", "💰 Rebuy");
        b.type = "button";
        b.onclick = () => mttAct("rebuy");
        go.append(b, el("span", "muted small", "you get the starting stack again"));
      } else go.append(el("span", "muted", "Thanks for playing!"));
    }
    grid.append(lv, you, go);
    live.replaceChildren(head, grid);
  }
  // 2. ближайший турнир (регистрация) или идущий, где меня нет
  const coming = $("mttcoming");
  if (a && (a.status === "registration" || (["running", "paused"].includes(a.status) && !me))) {
    const card = el("div", "ucard" + (me ? " mine" : ""));
    const body = el("div", "ubody");
    const nm = el("h3", "uname");
    nm.append(cardLink(a.id, a.name));
    nm.dataset.notr = "";
    body.append(nm, el("span", "when", a.status === "registration" ? (a.starts_at ? inDays(a.starts_at) : "starts when the owner presses Start") : `running · level ${a.level} · ${a.left} left`),
                chipsTags(a), structure(a));
    const side = el("div", "uside");
    if (me && me.status === "registered") {
      side.append(el("span", "youin", "✓ You're in"));
    } else if (a.can_register) {
      const b = el("button", "go", a.status === "registration" ? "Register" : "Late register");
      b.type = "button";
      b.onclick = () => mttAct("register");
      side.append(b);
    } else side.append(el("span", "muted small", "Registration is closed"));
    const names = a.players.map((p) => p.name + (p.me ? " (you)" : ""));
    const who = el("p", "small muted", "");
    who.append(el("b", "", `${a.entrants} of ${a.max_players}`), names.length ? ": " : "");
    const nl = el("span", "", names.join(", "));
    nl.dataset.notr = "";
    who.append(nl);
    const faces = el("div", "faces");
    a.players.slice(0, 10).forEach((p) => faces.append(avatar(p.name, p.avatar, 26)));
    side.append(who, faces);
    if (me && me.status === "registered") {
      const u = el("button", "linkbtn", "Unregister");
      u.type = "button";
      u.onclick = () => mttAct("unregister");
      side.append(u);
    }
    card.append(dateTile(a.status === "registration" ? a.starts_at : null), body, side);
    coming.replaceChildren(card);
  } else {
    coming.replaceChildren(el("p", "muted", "No tournaments planned. Ask Sanya to set one up!"));
  }
  // 3. итоги
  const res = [...mtt.past];
  if (a && a.status === "finished" && a.results) {
    const mine = a.results.find((r) => data.me && r.pid === data.me.id);
    res.unshift({ id: a.id, name: a.name, ended: a.ended || null, players: a.results.length, winner: (a.results.find((r) => r.place === 1) || {}).name,
                  places: a.results, test: a.test, pool: a.prize_pool,
                  me: mine ? { place: mine.place, points: mine.points, trophy: mine.trophy, prize: mine.prize } : null });
  }
  $("mttresultsbox").hidden = !res.length;
  $("mttresults").replaceChildren(...res.map((r) => {
    const row = el("div", "rcard" + (r.me && r.me.place === 1 ? " gold" : ""));
    const d = r.ended ? new Date(r.ended * 1000) : new Date();
    const left = el("div", "rdate");
    left.append(el("span", "", d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase()), el("b", "", d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }).toUpperCase()));
    const mid = el("div", "rmid");
    const nm = el("h3", "uname");
    nm.append(cardLink(r.id, r.name));
    nm.dataset.notr = "";
    const winner = el("span", "", r.winner || "");
    winner.dataset.notr = "";
    const line = el("p", "small muted", "🏆 ");
    line.append(winner, ` · ${r.players} players` + (r.pool ? ` · prize pool ${usd(r.pool)}` : "") + (r.test ? " · test" : ""));
    mid.append(nm, line);
    const right = el("div", "rme");
    if (r.me) right.append(el("b", "", ordinalEn(r.me.place) + (r.me.trophy ? " 🏆" : "")),
                           el("span", "muted small", r.me.prize ? `you · won ${usd(r.me.prize)}` : "you · no prize"));
    row.append(left, mid, right);
    return row;
  }));
}
const mmssL = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
setInterval(() => {
  const c = document.querySelector("#mttlive .mclock");
  if (c && mttClockEnd) c.textContent = mmssL(Math.max(0, (mttClockEnd - Date.now()) / 1000));
}, 1000);
