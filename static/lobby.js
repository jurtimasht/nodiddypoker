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
const VIEWS = ["home", "cash", "mtt", "owner"];
function currentView() {
  const v = location.hash.replace("#", "");
  if (v === "owner" && !(data && data.admin)) return "home";
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
  if (view === "home") { renderLive(); renderLeaders(me); }
  if (view === "cash") renderCash();
  if (view === "owner") renderAdmin();
}

// Мой кружок в шапке, окно профиля и карточка «You»
function renderMe(me) {
  $("mechipava").replaceChildren(avatar(me.name, me.avatar, 30));
  $("mechipname").textContent = me.name;
  $("mechip").setAttribute("aria-label", `${me.name} — profile menu`);
  $("menudelphoto").hidden = !me.avatar;
  $("menuowner").hidden = !data.admin;

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
  $("statrank").textContent = r ? `#${i + 1}` : "—";
  $("statprofit").textContent = r ? signed(r.profit) : "0";
  $("statprofitbox").className = "stat " + (r && r.profit > 0 ? "up" : r && r.profit < 0 ? "down" : "");
  $("stathands").textContent = r ? fmt(r.hands) : "0";
}
const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v));

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
  const online = (data.online || []).length;
  const atTables = data.tables.reduce((s, x) => s + x.seated.length, 0);
  $("playsub").textContent = `${online} online · ${atTables} at tables`;
}

// Home: только столы, где кто-то сидит
function renderLive() {
  const live = data.tables.filter((t) => t.seated.length).sort((a, b) => b.seated.length - a.seated.length);
  const empty = data.tables.length - live.length;
  $("livetables").replaceChildren(...live.map((t) => tableRow(t, { short: true })));
  const note = $("liveempty");
  note.replaceChildren();
  if (!live.length) note.append("Nobody is playing right now — press Quick seat and your friends will see you at the table. ");
  else if (empty) note.append(`${empty} more table${empty === 1 ? " is" : "s are"} empty. `);
  const a = el("a", "", "See all cash tables");
  a.href = "#cash";
  note.append(a);
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
      const join = el("a", "sitwith", data.mine === t.id ? "Back" : "Join");
      join.href = tableLink(t);
      const blocked = data.mine && data.mine !== t.id;
      join.classList.toggle("off", Boolean(blocked));
      join.onclick = (event) => { if (blocked) { event.preventDefault(); toast("You are seated at another table — leave it first."); } };
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

// Лидеры: на Home первые 5, «Full table» — все
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
  peek.replaceChildren("🥇 ", el("b", "", top.name), ` ${signed(top.profit)}` + (myRank > 0 ? ` · you are #${myRank + 1}` : ""));
  const limit = leadersAll ? data.leaders.length : 5;
  body.replaceChildren(...data.leaders.slice(0, limit).map((r, i) => {
    const tr = el("tr");
    if (r.id === me.id) tr.className = "me";
    const who = el("td", "player");
    who.append(avatar(r.name, r.avatar, 30), el("span", "", r.name));
    const pct = r.hands ? Math.round(100 * r.wins / r.hands) : 0;
    const profit = el("td", "profit " + (r.profit > 0 ? "up" : r.profit < 0 ? "down" : ""));
    profit.append(el("b", "", signed(r.profit)),
                  el("small", "", ` ${(r.profit > 0 ? "+" : r.profit < 0 ? "−" : "")}${Number((Math.abs(r.profit) / data.bb).toFixed(1)).toLocaleString("en-US")} BB`));
    tr.append(el("td", "rank", i < 3 ? ["🥇", "🥈", "🥉"][i] : String(i + 1)), who,
              el("td", "", fmt(r.hands)), el("td", "", `${fmt(r.wins)} · ${pct}%`), el("td", "", fmt(r.best_pot)), profit);
    return tr;
  }));
  $("fulltable").hidden = data.leaders.length <= 5;
  $("fulltable").textContent = leadersAll ? "Show top 5" : `Full table (${data.leaders.length}) →`;
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
  if (!confirm("Log out on this device?")) return;
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

// ---------- инструменты хозяина ----------
let inviteTyping = false;
$("invitecode").oninput = () => { inviteTyping = true; };
function renderAdmin() {
  const a = data.admin;
  $("admin").hidden = !a;
  if (!a) return;
  if (!inviteTyping) $("invitecode").value = a.invite;
  $("playercount").textContent = `· ${a.players.length}`;
  if (!a.players.length) { $("players").replaceChildren(el("li", "muted small", "No accounts yet.")); return; }
  $("players").replaceChildren(...a.players.map((p) => {
    const li = el("li", "pl");
    const info = el("div", "pinfo");
    info.append(el("div", "pname", p.name + (data.me && p.id === data.me.id ? " (you)" : "")),
                el("div", "pwhere", `joined ${new Date(p.created * 1000).toLocaleDateString("en-GB")}` + (p.seen ? ` · seen ${ago(p.seen)}` : "")));
    const reset = el("button", "mini", "Reset password");
    reset.onclick = async () => {
      if (!confirm(`Reset the password of ${p.name}? They get a new temporary password and are logged out everywhere.`)) return;
      try {
        const res = await api("POST", "api/admin", { action: "reset_password", id: p.id });
        data.admin = res.admin;
        prompt(`New password for ${res.name} — send it to them. They can change it in their profile.`, res.password);
        renderAdmin();
      } catch (e) { toast(e.message); }
    };
    const del = el("button", "mini danger", "Delete");
    del.onclick = async () => {
      if (!confirm(`Delete the account ${p.name}? Their stats and photo are deleted too. This can't be undone.`)) return;
      try { data.admin = (await api("POST", "api/admin", { action: "delete", id: p.id })).admin; toast(`${p.name} deleted.`); refresh(); }
      catch (e) { toast(e.message); }
    };
    li.append(avatar(p.name, p.avatar, 28), info, reset, del);
    return li;
  }));
}
$("inviteform").onsubmit = async (event) => {
  event.preventDefault();
  try {
    data.admin = (await api("POST", "api/admin", { action: "invite", code: $("invitecode").value })).admin;
    inviteTyping = false;
    renderAdmin();
    toast("Invite code saved.");
  } catch (e) { toast(e.message); }
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

// ---------- обновление сайта с GitHub (только хозяин) ----------
function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
}
function renderUpdate() {
  const box = $("updatebar");
  const u = data.update;
  box.hidden = !u;
  if (!u) return;
  const cur = u.current ? `version ${u.current.short}` : "";
  const a = u.available, ap = u.applying, last = u.last;
  const parts = [];
  let cls = "ok";
  if (u.missing) {
    parts.push(el("div", "uline", "⏳ Waiting for the first check of GitHub…"));
  } else if (u.dirty || u.diverged) {
    cls = "bad";
    parts.push(el("div", "uline", "⚠ The server has changes that are not on GitHub — automatic updates are paused. Ask Claude to sort it out."));
  } else if (ap) {
    cls = "busy";
    parts.push(el("div", "uline", ap.state === "waiting"
      ? `⏳ Updating to ${ap.sha.slice(0, 7)} as soon as the tables are empty (${ap.seated} seated now)…`
      : `⚙ Installing ${ap.sha.slice(0, 7)}…`));
  } else if (a) {
    cls = a.tests === "failed" ? "bad" : "new";
    const head = el("div", "uhead");
    head.append(el("b", "", a.tests === "running" ? "🧪 New version on GitHub — running the tests…"
      : a.tests === "failed" ? "✖ New version on GitHub failed the tests — it can't be installed"
      : `⬆ New version on GitHub · ${a.commits.length} change${a.commits.length === 1 ? "" : "s"}`));
    if (a.tests === "passed") {
      const btn = el("button", "gold", u.requested ? "Starting…" : "Update site");
      btn.disabled = u.requested;
      btn.onclick = async () => {
        if (!confirm("Install the new version? The site restarts when nobody is sitting at a table (tables are cleared).")) return;
        try { data.update = (await api("POST", "api/update", { sha: a.sha })).update; renderUpdate(); toast("Update started."); }
        catch (e) { toast(e.message); }
      };
      head.append(btn);
    }
    parts.push(head);
    const list = el("ul", "commits");
    for (const c of a.commits.slice(0, 8)) {
      const li = el("li");
      li.append(el("span", "sha", c.short), el("span", "msg", c.subject), el("span", "who", `${c.author} · ${ago(Number(c.at))}`));
      list.append(li);
    }
    parts.push(list);
    if (a.stat) parts.push(el("div", "ustat muted", a.stat));
    if (a.tests === "failed" && a.test_output) {
      const pre = el("pre", "uout", a.test_output.split("\n").slice(-12).join("\n"));
      parts.push(pre);
    }
  } else {
    parts.push(el("div", "uline", `✓ Site is up to date · ${cur}`));
  }
  if (last && !ap && Date.now() / 1000 - last.at < 6 * 3600) {
    parts.push(el("div", "ulast " + (last.result === "ok" ? "good" : "bad"), `${last.result === "ok" ? "✓" : "⚠"} ${last.text} (${ago(last.at)})`));
  }
  if (u.error) parts.push(el("div", "ulast bad", `⚠ ${u.error}`));
  box.className = "updatebar " + cls;
  box.replaceChildren(...parts);
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
  if (!confirm("Remove your profile photo?")) return;
  try { await api("DELETE", "api/avatar"); refresh(); } catch (e) { message(e.message); }
};

// ---------- сброс статистики (только хозяин) ----------
$("reset").onclick = async () => {
  if (!confirm("Reset all-time statistics for EVERY player? Profiles and photos stay.")) return;
  try { data = await api("POST", "api/stats/reset", {}); render(); toast("Statistics reset."); } catch (e) { toast(e.message); }
};

// ---------- «я ещё на сайте» ----------
// Пока лобби открыто, сервер знает, что ты не закрыл сайт, и держит твоё место за столом.
// Закроешь сайт совсем (ни стола, ни лобби) — через 15 секунд встанешь из-за стола.
let seated = false;
let presenceOn = false;
function startPresence() { if (!presenceOn) { presenceOn = true; presence(); } }   // только после входа
function presence() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}${location.pathname.replace(/\/+$/, "")}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", lobby: true, token: load("poker-token"), profile: load(KEY_PROFILE) }));
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "auth") { ws.onclose = null; presenceOn = false; refresh(); return; }   // вход устарел
    if (msg.type === "presence") {
      seated = msg.seated;
      if (data && (data.mine || null) !== (msg.table || null)) refresh();   // сел или встал — обновить кнопки столов
    }
  };
  ws.onclose = () => setTimeout(presence, 3000);
}

refresh();
setInterval(refresh, 5000);          // лидеры и стол обновляются сами
