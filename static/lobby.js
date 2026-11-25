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
  const pick = (list) => list.filter((t) => !isHU(t) && freeSeats(t) > 0)
    .sort((a, b) => b.seated.length - a.seated.length)[0];
  return (kind && pick(data.tables.filter((t) => kindOf(t) === kind))) || pick(data.tables);
}

const tableLink = (t) => `table?t=${encodeURIComponent(t.id)}`;

// Строка стола: название, правила, кто сидит, Join / Back
function tableRow(t, opts = {}) {
  const mine = data.mine;
  const row = el("div", "trow" + (mine === t.id ? " mine" : "") + (isHU(t) ? " hu-row" : "") + (t.seated.length ? "" : " is-empty"));
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
  const go = el("a", "go", mine === t.id ? "Back" : full ? "Full" : t.seated.length ? "Join" : "Sit first");
  go.href = tableLink(t);
  const blocked = (mine && mine !== t.id) || (full && mine !== t.id);
  go.classList.toggle("off", Boolean(blocked));
  if (blocked) go.setAttribute("aria-disabled", "true");
  go.onclick = (event) => {
    if (mine && mine !== t.id) { event.preventDefault(); toast("You are seated at another table — leave it first."); }
    else if (full && mine !== t.id) { event.preventDefault(); toast("This table is full."); }
  };
  row.append(info, who, go);
  return row;
}
const short = (n) => n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : fmt(n);

// ---------- вкладки: Home / Cash game / MTT (адрес #home / #cash / #mtt, работает кнопка «назад») ----------
const VIEWS = ["home", "cash", "mtt"];
function currentView() {
  const v = location.hash.replace("#", "");
  return VIEWS.includes(v) ? v : "home";
}
window.addEventListener("hashchange", () => { closeMenu(); if (data && data.me) render(); window.scrollTo(0, 0); });

function render() {
  const me = data.me;

  // Не вошёл — только вход / регистрация
  $("auth").hidden = Boolean(me);
  $("hero").hidden = Boolean(me);
  $("nav").hidden = $("memenu").hidden = !me;
  $("where").hidden = Boolean(me);
  if (!me) {
    if (load(KEY_PROFILE)) save(KEY_PROFILE, "");         // ключ входа устарел или аккаунт удалён
    for (const v of VIEWS) $("view-" + v).hidden = true;
    $("updatebar").hidden = $("seatbar").hidden = true;
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
  if (view === "cash") renderCash();
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
  const t = data.tables.find((x) => x.id === data.mine);
  $("minewhere").textContent = t ? `playing · ${t.name}` : "in the lobby";
  const i = data.leaders.findIndex((r) => r.id === me.id);
  const r = data.leaders[i];
  $("statrank").textContent = r && r.diddy > 0 ? `#${i + 1}` : "—";      // ещё никого не переехал — места нет
  $("statdiddy").textContent = factor(r ? r.diddy : 0);
  $("stathands").textContent = r ? fmt(r.hands) : "0";
}
const factor = (v) => v.toFixed(1);                // Diddy factor: всегда один знак после точки

// Полоса «Вы сидите за столом» — на всех вкладках
function renderSeatbar() {
  const t = data.tables.find((x) => x.id === data.mine);
  $("seatbar").hidden = !t;
  document.body.classList.toggle("is-seated", Boolean(t));
  if (!t) return;
  $("seatname").textContent = t.name;
  $("seatback").href = tableLink(t);
}

// Quick seat: куда посадит
function renderQuick() {
  const kind = currentView() === "cash" ? selectedKind() : null;
  const t = quickTable(kind);
  document.querySelectorAll(".quickseat").forEach((a) => {
    a.hidden = Boolean(data.mine) || !t;
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
  const online = data.online || [];
  const label = { playing: (w) => `playing · ${w}`, away: (w) => `sitting out · ${w}`, watching: (w) => `watching · ${w}`, lobby: () => "in the lobby" };
  const byName = Object.fromEntries(data.tables.map((t) => [t.name, t]));
  const person = (p) => {
    const isMe = p.id === me.id;
    const li = el("li", "person st-" + p.state + (isMe ? " me" : ""));   // st-… — чтобы не совпасть с другими стилями
    const info = el("div", "pinfo");
    info.append(el("div", "pname", p.name + (isMe ? " (you)" : "")), el("div", "pwhere", label[p.state](p.where)));
    li.append(avatar(p.name, p.avatar, 28), info);
    const t = byName[p.where];
    if (t && !isMe && p.state !== "lobby") {
      const full = freeSeats(t) <= 0 && data.mine !== t.id;
      const join = el("a", "sitwith", data.mine === t.id ? "Back" : full ? "Full" : "Join");
      join.href = tableLink(t);
      const blocked = (data.mine && data.mine !== t.id) || full;
      join.classList.toggle("off", Boolean(blocked));
      join.onclick = (event) => {
        if (data.mine && data.mine !== t.id) { event.preventDefault(); toast("You are seated at another table — leave it first."); }
        else if (full) { event.preventDefault(); toast("This table is full."); }
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
function renderLeaders(me) {
  $("since").textContent = "since " + new Date(data.since * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const body = $("leaders");
  const peek = $("leaderspeek");
  const myRank = data.leaders.findIndex((r) => r.id === me.id);
  if (!data.leaders.length) {
    const tr = el("tr");
    const td = el("td", "muted", "No hands played yet.");
    td.colSpan = 6;
    tr.append(td);
    body.replaceChildren(tr);
    peek.textContent = "No hands played yet";
    $("fulltable").hidden = true;
    return;
  }
  const top = data.leaders[0];
  if (top.diddy > 0) {
    peek.replaceChildren("🥇 ", el("b", "", top.name), ` ${factor(top.diddy)} `,
                         ...(myRank > 0 && data.leaders[myRank].diddy > 0 ? [`· you are #${myRank + 1}`] : []));   // отдельным куском — чтобы переводилось
  } else peek.textContent = "No bad beats yet";
  const limit = leadersAll ? data.leaders.length : 5;
  body.replaceChildren(...data.leaders.slice(0, limit).map((r, i) => {
    const tr = el("tr");
    if (r.id === me.id) tr.className = "me";
    const who = el("td", "player");
    who.append(avatar(r.name, r.avatar, 30), el("span", "", r.name));
    const diddy = el("td", "diddy" + (r.diddy > 0 ? "" : " zero"));
    diddy.append(el("b", "", factor(r.diddy)));
    tr.append(el("td", "rank", r.diddy > 0 ? ["🥇", "🥈", "🥉"][i] || String(i + 1) : "—"), who,       // медали — только с очками
              diddy, el("td", "", fmt(r.badbeats)), el("td", "", fmt(r.hands)), el("td", "", r.sickest ? `${r.sickest}%` : "—"));
    return tr;
  }));
  $("fulltable").hidden = false;
  $("fulltable").textContent = leadersAll ? "Show less" : `Full table${data.leaders.length > 5 ? ` (${data.leaders.length})` : ""} →`;
  document.querySelector(".a-leaders").classList.toggle("all", leadersAll);     // «Full table» — все строки и все столбцы
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
  t.append(el("span", "tag", n.pinned ? "📌 " + NEWS_TAG[n.kind] : NEWS_TAG[n.kind] || "News"), said);
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
      del.onclick = () => { if (confirm(T("Delete this message for everyone?"))) sendLobby({ type: "lobby_chat_delete", id: m.id }); };
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
  if (!confirm(T("Log out on this device?"))) return;
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
  if (!confirm(T("Remove your profile photo?"))) return;
  try { await api("DELETE", "api/avatar"); refresh(); } catch (e) { message(e.message); }
};

// ---------- «я ещё на сайте» ----------
// Пока лобби открыто, сервер знает, что ты не закрыл сайт, и держит твоё место за столом.
// Закроешь сайт совсем (ни стола, ни лобби) — через 15 секунд встанешь из-за стола.
let seated = false;
let presenceOn = false;
let lobbyWs = null;
function startPresence() { if (!presenceOn) { presenceOn = true; presence(); } }   // только после входа
function presence() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}${location.pathname.replace(/\/+$/, "")}/ws`);
  lobbyWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", lobby: true, token: load("poker-token"), profile: load(KEY_PROFILE) }));
    ws.send(JSON.stringify({ type: "lobby_chat_history" }));
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "auth") { ws.onclose = null; presenceOn = false; refresh(); return; }   // вход устарел
    if (msg.type === "lobby_chat_history") { chat.items = msg.items; chat.owner = msg.owner; renderChat(true); return; }
    if (msg.type === "lobby_chat") { chat.items.push(msg.msg); chat.items = chat.items.slice(-200); renderChat(true); return; }
    if (msg.type === "lobby_chat_deleted") { chat.items = chat.items.filter((m) => m.id !== msg.id); renderChat(false); return; }
    if (msg.type === "error") { toast(msg.text); return; }
    if (msg.type === "presence") {
      seated = msg.seated;
      if (data && (data.mine || null) !== (msg.table || null)) refresh();   // сел или встал — обновить кнопки столов
    }
  };
  ws.onclose = () => { if (lobbyWs === ws) lobbyWs = null; setTimeout(presence, 3000); };
}

refresh();
setInterval(refresh, 5000);          // лидеры и стол обновляются сами
