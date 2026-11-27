// NoDiddyPoker — карточка турнира в лобби (окно поверх вкладки MTT, на телефоне — на весь экран).
// Открывается по адресу #mtt/<номер>: ссылку можно скинуть в чат, кнопка «назад» закрывает окно.
// Данные — GET api/mtt/<номер>: текущий турнир или законченный (из базы). Пользуется помощниками из lobby.js
// (el, avatar, api, usd, nfmt, ordinalEn, mttAct, data).

(() => {                    // всё внутри — свои имена, не мешают lobby.js
let card = null;            // последние данные карточки
let cardId = null;          // какой турнир открыт (null — окно закрыто)
let cardLoading = false;
let cardFromLobby = false;  // открыли кликом в лобби — закрываем кнопкой «назад» (не плодим записи в истории)
let cardGot = 0;            // когда пришли данные (Date.now()) — для таймеров
let cardFocus = null;       // куда вернуть фокус после закрытия

const cardHashId = () => { const m = /^#mtt\/(\d{1,9})$/.exec(location.hash); return m ? Number(m[1]) : null; };

// ---------- время ----------
const two = (n) => String(Math.floor(n)).padStart(2, "0");
function dur(sec) {                       // «1 d 02:14:33», «02:14:33», «14:33»
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = sec % 3600 / 60, s = sec % 60;
  const hms = (h || d ? two(h) + ":" : "") + two(m) + ":" + two(s);
  return d ? `${d} d ${hms}` : hms;
}
function lasted(sec) {                    // «1 h 41 m», «35 m»
  const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
  return h ? `${h} h ${m} m` : `${m} m`;
}
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayName = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const isToday = (ts) => new Date(ts * 1000).toDateString() === new Date().toDateString();
const whenText = (ts) => (isToday(ts) ? `today ${hm(ts)}` : `${dayName(ts)}, ${hm(ts)}`);
const levelLen = (sec) => (sec % 60 ? `${sec} sec each` : `${sec / 60} min each`);
const gameName = (g) => (g === "plo4" ? "Pot-Limit Omaha" : "No-Limit Hold'em");
const tableNo = (code) => "Table " + String(code || "").split("-").pop();

// ---------- открыть / закрыть ----------
function syncMttCard() {                  // зовёт lobby.js после каждой отрисовки (раз в 5 с) и при смене адреса
  const id = data && data.me ? cardHashId() : null;
  if (id === null) { if (cardId !== null) hideCard(); return; }
  if (id !== cardId) {
    cardId = id;
    card = null;
    cardFocus = cardFocus || document.activeElement;
    showShell();
    loadCard();
  } else if (card && card.status !== "finished") loadCard();
}
window.syncMttCard = syncMttCard;

async function loadCard() {
  if (cardLoading || cardId === null) return;
  cardLoading = true;
  const id = cardId;
  try {
    const got = await api("GET", `api/mtt/${id}`);
    if (id !== cardId) return;
    card = got;
    cardGot = Date.now();
    renderCard();
  } catch (e) {
    if (id === cardId) renderCardError(e.message);
  } finally { cardLoading = false; }
}

function showShell() {
  const ov = $("mttinfo");
  ov.hidden = false;
  document.body.classList.add("sheet-open");
  const h = el("h2", "ti-name ti-pad", "Tournament");
  h.id = "ti-name";
  $("ti-body").replaceChildren(h, el("p", "muted ti-wait", "Loading…"));
  window.scrollTo(0, 0);
}

function hideCard() {
  cardId = null;
  card = null;
  $("mttinfo").hidden = true;
  document.body.classList.remove("sheet-open");
  if (cardFocus && document.contains(cardFocus)) cardFocus.focus({ preventScroll: true });
  cardFocus = null;
}

function closeCard() {
  if (cardFromLobby) { cardFromLobby = false; history.back(); }
  else location.hash = "mtt";
}

// Клик по ссылке «#mtt/N» в лобби: запоминаем, что окно открыто из лобби (тогда «закрыть» = «назад»)
document.addEventListener("click", (event) => {
  const a = event.target.closest && event.target.closest('a[href^="#mtt/"]');
  if (a && !a.closest("#mttinfo")) { cardFromLobby = true; cardFocus = a; }
});
window.addEventListener("hashchange", () => { if (cardHashId() === null) cardFromLobby = false; });
document.addEventListener("keydown", (event) => {
  if (cardId === null) return;
  if (event.key === "Escape") { event.preventDefault(); closeCard(); }
  if (event.key === "Tab") {                       // фокус не уходит из окна
    const items = [...$("mttinfo").querySelectorAll("a[href], button:not([disabled])")].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$("ti-close").onclick = closeCard;
$("ti-back").onclick = (event) => { event.preventDefault(); closeCard(); };
$("mttinfo").onclick = (event) => { if (event.target === $("mttinfo")) closeCard(); };

function renderCardError(text) {
  const h = el("h2", "ti-name ti-pad", "Tournament");
  h.id = "ti-name";
  $("ti-body").replaceChildren(h, el("p", "muted ti-wait", text || "Something went wrong."));
}

// ---------- мелкие кусочки ----------
function nick(name, cls) {
  const s = el("span", cls || "", name);
  s.dataset.notr = "";
  return s;
}
function kpi(label, value, sub, cls) {
  const k = el("div", "kpi" + (cls ? " " + cls : ""));
  const b = el("b");
  if (Array.isArray(value)) b.append(...value); else b.append(value);
  k.append(el("span", "eyebrow", label), b);
  if (sub) k.append(el("span", "muted", sub));
  return k;
}
function section(id, title, note) {
  const s = el("section", "tsec ts-" + id);
  s.setAttribute("aria-labelledby", "ti-h-" + id);
  const head = el("div", "sh");
  const h = el("h3", "", title);
  h.id = "ti-h-" + id;
  head.append(h);
  if (note) head.append(el("span", "muted", note));
  s.append(head);
  return s;
}
function fact(dl, term, ...value) {
  const dd = el("dd");
  dd.append(...value);
  dl.append(el("dt", "", term), dd);
}
const rebuysTxt = (n) => `(${n} rebuy${n === 1 ? "" : "s"})`;
const netTxt = (c) => (c > 0 ? "+" : c < 0 ? "" : "±") + usd(c);

// ---------- значки мест: кубок за 1-е, серебряная и бронзовая медали за 2-е и 3-е (свои SVG, не эмодзи) ----------
const TROPHY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ti-gold" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#fff1b8"/><stop offset=".5" stop-color="#f6c443"/><stop offset="1" stop-color="#c5860f"/></linearGradient></defs>
<path d="M7.4 5.2H4.6v1.6a3.6 3.6 0 0 0 3.7 3.6M16.6 5.2h2.8v1.6a3.6 3.6 0 0 1-3.7 3.6" fill="none" stroke="#e3a51c" stroke-width="1.7" stroke-linecap="round"/>
<path d="M6.8 2.8h10.4v5.4a5.2 5.2 0 0 1-10.4 0z" fill="url(#ti-gold)"/>
<path d="M9.2 4.4v3.6a2.9 2.9 0 0 0 1.5 2.5" fill="none" stroke="#fffbe6" stroke-opacity=".75" stroke-width="1.2" stroke-linecap="round"/>
<path d="M10.6 13.2h2.8l.5 3.1h-3.8z" fill="#d89a1c"/>
<rect x="7.8" y="16.2" width="8.4" height="2.3" rx=".9" fill="url(#ti-gold)"/>
<rect x="6.6" y="18.4" width="10.8" height="2.8" rx="1.1" fill="#9c6a0b"/></svg>`;
function medalSvg(n) {
  const [hi, mid, lo, ink] = n === 2 ? ["#ffffff", "#cfd5e2", "#8a93a6", "#3d4352"] : ["#ffd6ae", "#d9894a", "#8f4f1e", "#4a2508"];
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ti-m${n}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${hi}"/><stop offset=".45" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>
<path d="M6.8 1h4.1l2.2 6.6H9.1z" fill="#7b4dff"/><path d="M17.2 1h-4.1l-2.2 6.6h4z" fill="#e0283a"/>
<circle cx="12" cy="14.9" r="8" fill="url(#ti-m${n})"/>
<circle cx="12" cy="14.9" r="6.1" fill="none" stroke="${ink}" stroke-opacity=".35" stroke-width=".9"/>
<text x="12" y="18.5" text-anchor="middle" font-size="10" font-weight="800" fill="${ink}" font-family="Inter Tight, Inter, sans-serif">${n}</text></svg>`;
}
function placeIcon(place) {
  const box = el("span", "picon");
  box.innerHTML = place === 1 ? TROPHY_SVG : medalSvg(place);       // только наши строки, без данных пользователей
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", place === 1 ? "1st place" : place === 2 ? "2nd place" : "3rd place");
  return box;
}

// ---------- окно целиком ----------
function renderCard() {
  const a = card;
  const reg = a.status === "registration", live = a.status === "running" || a.status === "paused", done = a.status === "finished";
  $("ti-backt").textContent = a.test ? "Test tournament" : "Tournament";

  // шапка: статус, название, большой таймер, главная кнопка
  const head = el("div", "thead");
  const tl = el("div", "tl");
  const tags = el("div", "tags");
  const stTxt = { registration: "Coming up", running: "Running", paused: "Paused", finished: "Ended" }[a.status] || a.status;
  tags.append(el("span", "st st-" + (reg ? "coming" : a.status), stTxt), el("span", "mtag", a.game === "plo4" ? "Omaha" : "Hold'em"));
  if (a.buy_in) tags.append(el("span", "mtag", `${usd(a.buy_in)} buy-in`));
  if (a.test) tags.append(el("span", "mtag", "test — no points"));
  const h2 = el("h2", "ti-name", a.name);
  h2.id = "ti-name";
  h2.dataset.notr = "";
  const clock = el("div", "clockline");
  const big = el("span", "bigclock");
  if (reg && a.starts_at) {
    big.append(el("small", "", "Starts in"), el("span", "ti-tick", ""));
    clock.append(big, el("span", "muted", `${dayName(a.starts_at)}, ${hm(a.starts_at)} · your time`));
  } else if (reg) {
    clock.append(el("span", "muted", "starts when the owner presses Start"));
  } else if (live) {
    big.append(el("small", "", "Running for"), el("span", "ti-tick", ""));
    const line = el("span", "muted", `started ${hm(a.started)} · level ${a.level} of ${a.levels.length}`);
    if (a.status === "running" && a.next && a.level_left != null) {
      line.append(" · ", el("span", "", "next level in"), " ", el("b", "mclock ti-left", ""));
    }
    clock.append(big, line);
  } else if (done) {
    big.append(el("small", "", "Ended"), a.ended ? `${dayName(a.ended)}, ${hm(a.ended)}` : "");
    clock.append(big);
    if (a.started && a.ended) clock.append(el("span", "muted", `${hm(a.started)} – ${hm(a.ended)} · lasted ${lasted(a.ended - a.started)}`));
  }
  tl.append(tags, h2, clock);
  head.append(tl, actions(a));

  // полоса цифр
  const kpis = el("div", "kpis");
  const anteSpan = (x) => (x ? el("span", "ante", ` ante ${nfmt(x)}`) : "");
  if (reg) {
    const tables = Math.max(1, Math.ceil(a.entrants / a.seats));
    kpis.append(kpi("Registered", [String(a.entrants), " ", el("span", "of", `of ${a.max_players}`)], tables === 1 ? "1 table" : `${tables} tables`),
                a.buy_in ? kpi("Prize pool", usd(a.prize_pool), "grows with each player", "gold") : kpi("Prize pool", "Free", "no buy-in"),
                kpi("Starting stack", nfmt(a.stack), `${Math.round(a.stack / a.levels[0].bb)} BB at level 1`),
                a.late_reg_level ? kpi("Late reg", `to lvl ${a.late_reg_level}`,
                                       a.level_starts[a.late_reg_level] ? `until about ${hm(a.level_starts[a.late_reg_level])}` : `until the end of level ${a.late_reg_level}`)
                                 : kpi("Late reg", "No", "no late reg"));
  } else if (live) {
    const tables = a.tables.length;
    kpis.append(kpi("Players left", [String(a.left), " ", el("span", "of", `of ${a.entrants}`)], tables === 1 ? "1 table" : `${tables} tables`),
                kpi(`Blinds · lvl ${a.level}`, [`${nfmt(a.sb)} / ${nfmt(a.bb)}`, anteSpan(a.ante)],
                    a.next ? `next ${nfmt(a.next.sb)} / ${nfmt(a.next.bb)}` + (a.next.ante ? ` · ante ${nfmt(a.next.ante)}` : "") : "last level"),
                a.buy_in ? kpi("Prize pool", usd(a.prize_pool), a.next_prize ? `next prize ${usd(a.next_prize.amount)} (${ordinalEn(a.next_prize.place)})` : "", "gold")
                         : kpi("Prize pool", "Free", "no buy-in"),
                kpi("Avg. stack", nfmt(a.avg_stack || 0), a.bb ? `${Math.round((a.avg_stack || 0) / a.bb)} BB` : ""));
  } else {
    const win = a.players.filter((p) => p.place === 1);
    const wv = [placeIcon(1), " "];
    win.forEach((p, i) => { if (i) wv.push(", "); wv.push(nick(p.name)); });
    kpis.append(kpi("Winner", wv, win.length && a.buy_in ? `won ${usd(win[0].prize)}` : "", "gold"),
                kpi("Players", String(a.entrants), a.rebuys ? `+ ${a.rebuys} rebuy${a.rebuys === 1 ? "" : "s"}` : "no rebuys"),
                a.buy_in ? kpi("Prize pool", usd(a.prize_pool), `${a.prizes.length} place${a.prizes.length === 1 ? "" : "s"} paid`) : kpi("Prize pool", "Free", "no buy-in"),
                a.me ? kpi("Your place", ordinalEn(a.me.place), a.buy_in ? (a.me.prize ? `won ${usd(a.me.prize)} · paid ${usd(a.me.paid)}` : `no prize · paid ${usd(a.me.paid)}`) : "")
                     : kpi("Levels played", [String(a.level), " ", el("span", "of", `of ${a.levels.length}`)], ""));
  }

  // тело: слева игроки и подробности, справа призы и блайнды (на телефоне: игроки → призы → блайнды → подробности)
  const body = el("div", "tbody");
  const left = el("div", "tcol"), right = el("div", "tcol");
  left.append(playersSec(a), detailsSec(a));
  right.append(prizesSec(a), blindsSec(a));
  body.append(left, right);
  $("ti-body").replaceChildren(head, kpis, body);
  tickCard();
}

// Главная кнопка по статусу
function actions(a) {
  const box = el("div", "tact");
  const me = a.me;
  const btn = (text, action) => { const b = el("button", "go", text); b.type = "button"; b.onclick = () => cardAct(action); return b; };
  if (a.status === "registration") {
    if (me) {
      const u = el("button", "linkbtn", "Unregister");
      u.type = "button";
      u.onclick = () => cardAct("unregister");
      const row = el("div", "row2");
      row.append(el("span", "youin", "✓ You're in"), u);
      box.append(row, el("span", "note", "you can unregister until the start"));
    } else if (a.can_register) box.append(btn("Register", "register"), el("span", "note", a.buy_in ? `buy-in ${usd(a.buy_in)}` : "free to play"));
    else box.append(el("span", "note closed", "Registration is closed"));
  } else if (a.status === "running" || a.status === "paused") {
    if (me && me.status === "playing") {
      const g = el("a", "go", "Back to my table");
      g.href = `table?t=${encodeURIComponent(me.table)}`;
      box.append(g, el("span", "note", `${tableNo(me.table)} · hands keep going without you`));
    } else if (me && me.can_rebuy) {
      box.append(btn("💰 Rebuy", "rebuy"), el("span", "note", "you get the starting stack again"));
    } else if (!me && a.can_register) {
      box.append(btn("Late register", "register"), el("span", "note", a.buy_in ? `buy-in ${usd(a.buy_in)}` : "free to play"));
    }
  }
  return box;
}
async function cardAct(action) {
  if (!card || card.status === "finished") return;
  try { await api("POST", `api/mtt/${card.id}/${action}`, {}); } catch (e) { toast(e.message); }
  await loadCard();
  if (typeof loadMtt === "function") loadMtt();
}

// Игроки: до старта — по алфавиту; в игре — по стеку, вылетевшие внизу; после — по местам
function playersSec(a) {
  const reg = a.status === "registration", done = a.status === "finished";
  const s = reg ? section("pl", "Registered", `A–Z · ${a.entrants} of ${a.max_players}`)
            : done ? section("pl", "Final places")
            : section("pl", "Players", "by chips · out at the bottom");
  if (!a.players.length) { s.append(el("p", "pempty", "No one yet. Be the first!")); return s; }
  const ol = el("ol", "ti-plist");
  let rank = 0, divider = false;
  for (const p of a.players) {
    const out = !reg && !done && p.status !== "playing";
    if (out && !divider) { ol.append(el("li", "divider", "Out")); divider = true; }
    const li = el("li", "prow" + (p.me ? " me" : "") + (out ? " out" : "") + (done && p.place <= 3 ? " p" + p.place : ""));
    const no = reg || (!out && !done) ? ++rank : p.place;
    const nm = el("span", "nm");
    nm.append(nick(p.name, "nk"));
    if (p.rebuys) nm.append(el("span", "rb", rebuysTxt(p.rebuys)));
    if (p.me) nm.append(el("span", "you", "you"));
    let where = "";
    if (!reg && !done && !out) where = tableNo(p.table);
    if (out) where = p.bust_level ? `out · level ${p.bust_level}` : "out";
    nm.append(el("span", "sub", where));
    const val = el("span", "val");
    // 0 фишек, а ещё «играет» — только что проиграл всё, директор вот-вот отметит вылет (не «0 BB» как у живого)
    if (!reg && !done && !out && p.chips === 0) { li.classList.add("out"); val.append("—", el("small", "", "busting…")); }
    else if (!reg && !done && !out) val.append(nfmt(p.chips), el("small", "", a.bb ? `${Math.round(p.chips / a.bb)} BB` : ""));
    else if (out) val.append(ordinalEn(p.place));
    else if (done) {
      if (a.buy_in) {
        val.append(p.prize ? usd(p.prize) : "—");
        if (p.prize) val.classList.add("won");
        val.append(el("small", "net" + (p.net > 0 ? " plus" : ""), netTxt(p.net)));
      } else val.append("—");
    }
    const noBox = el("span", "no");
    if (done && no >= 1 && no <= 3) noBox.append(placeIcon(no)); else noBox.textContent = String(no || "?");
    li.append(noBox, avatar(p.name, p.avatar, 28), nm, el("span", "mid", done ? "" : where), val);
    ol.append(li);
  }
  s.append(ol);
  return s;
}

// Подробности: игра, бай-ин, стек, ребаи, поздняя регистрация, столы, время
function detailsSec(a) {
  const reg = a.status === "registration", live = a.status === "running" || a.status === "paused", done = a.status === "finished";
  const s = section("dt", "Details");
  const dl = el("dl", "facts");
  const muted = (t) => el("span", "muted", t);
  fact(dl, "Game", gameName(a.game));
  if (a.buy_in) fact(dl, "Buy-in", usd(a.buy_in), " ", muted(reg ? "· each rebuy costs the same"
                     : `· ${a.entrants} entr${a.entrants === 1 ? "y" : "ies"} + ${a.rebuys} rebuy${a.rebuys === 1 ? "" : "s"}`));
  else fact(dl, "Buy-in", "Free");
  fact(dl, "Starting stack", `${nfmt(a.stack)} chips`);
  const lvlOpen = (n) => live && a.level <= n;
  if (!a.rebuy_level) fact(dl, "Rebuys", "No rebuys");
  else if (reg) fact(dl, "Rebuys", `until the end of level ${a.rebuy_level}`, " ", muted(`· for players who are out · ${nfmt(a.stack)} chips each`));
  else fact(dl, "Rebuys", done ? `were open until the end of level ${a.rebuy_level}` : lvlOpen(a.rebuy_level) ? `open until the end of level ${a.rebuy_level}` : `closed after level ${a.rebuy_level}`,
            " ", muted(`· ${a.rebuys} made`));
  if (!a.late_reg_level) fact(dl, "Late registration", "No late registration");
  else if (reg) fact(dl, "Late registration", `until the end of level ${a.late_reg_level}`, " ",
                     a.level_starts[a.late_reg_level] ? muted(`(about ${hm(a.level_starts[a.late_reg_level])})`) : "");
  else fact(dl, "Late registration", done ? `until the end of level ${a.late_reg_level}`
            : lvlOpen(a.late_reg_level) ? `open until the end of level ${a.late_reg_level}` : `closed after level ${a.late_reg_level}`);
  if (live && a.tables.length) {
    const box = el("div", "ti-tables");
    for (const t of a.tables) {
      const row = el("div", "trw");
      const w = el("a", "linkbtn", "👁 Watch");
      w.href = `table?t=${encodeURIComponent(t.code)}`;
      w.setAttribute("aria-label", `Watch ${tableNo(t.code)}`);
      row.append(el("span", "", `${tableNo(t.code)} · ${t.players} player${t.players === 1 ? "" : "s"}`), w);
      box.append(row);
    }
    fact(dl, "Tables", box);
  } else if (reg) {
    const n = Math.max(1, Math.ceil(a.entrants / a.seats));
    fact(dl, "Tables", `${a.seats} seats per table · ${n} table${n === 1 ? "" : "s"} now`, " ",
         muted(`(a new one opens at ${n * a.seats + 1} players)`));
  } else fact(dl, "Tables", `${a.seats} seats per table`);
  if (reg) fact(dl, "Start", a.starts_at ? `${dayName(a.starts_at)}, ${hm(a.starts_at)}` : "when the owner presses Start", " ", a.starts_at ? muted("· your local time") : "");
  else if (live && a.started) fact(dl, "Start", whenText(a.started));
  else if (done && a.started) fact(dl, "Played", `${dayName(a.started)}, ${hm(a.started)}` + (a.ended ? ` – ${hm(a.ended)}` : ""));
  s.append(dl);
  return s;
}

// Призы: фонд, места, кто выиграл (или «so far» до старта)
function prizesSec(a) {
  const reg = a.status === "registration", done = a.status === "finished";
  const s = section("pz", "Prize pool");
  if (!a.buy_in) {
    s.append(el("p", "pempty", "Free tournament: no prize pool. The winner gets the trophy."));
    return s;
  }
  const pool = el("div", "pool");
  const players = a.entrants, entries = a.entrants + a.rebuys;
  pool.append(el("b", "", usd(a.prize_pool)),
              el("span", "muted", reg ? `${players} × ${usd(a.buy_in)} so far`
                 : `${entries} entries × ${usd(a.buy_in)} (${players} players + ${a.rebuys} rebuy${a.rebuys === 1 ? "" : "s"})`));
  s.append(pool);
  if (!a.prizes.length || !a.prize_pool) {
    s.append(el("p", "ti-hint", "Prizes appear when players register."));
    return s;
  }
  if (done) {
    // законченный: имена и суммы уже слева в «Final places» — здесь только деление фонда одной строкой
    const split = el("p", "ti-split");
    a.prizes.forEach((amount, i) => {
      const item = el("span", "ti-split-i");
      item.append(el("b", "", ordinalEn(i + 1)), " ", `${Math.round(amount * 100 / a.prize_pool)}%`);
      split.append(item);
    });
    s.append(split, el("p", "ti-hint", "Play chips only: the site just keeps score between friends."));
    return s;
  }
  const ol = el("ol", "prizes");
  a.prizes.forEach((amount, i) => {
    const place = i + 1;
    const next = a.next_prize && a.next_prize.place === place;
    const li = el("li", (place === 1 ? "first" : "") + (next ? " next" : ""));
    const who = el("span", "ti-who");
    if (done) {
      const ws = a.players.filter((p) => p.place === place);
      ws.forEach((p, j) => { if (j) who.append(", "); who.append(nick(p.name)); if (p.me) who.append(" ", el("span", "you", "(you)")); });
    } else if (next) who.append("next prize");
    li.append(el("span", "ti-pl", ordinalEn(place)), who,
              el("span", "pct", `${Math.round(amount * 100 / a.prize_pool)}%`), el("span", "amt", usd(amount)));
    ol.append(li);
  });
  s.append(ol);
  let hint = "";
  if (reg && a.next_payout) {
    const np = a.next_payout;
    hint = `Changes as people join: ${np.from}${np.to ? "–" + np.to : "+"} entries pay ${np.pct.length} places (${np.pct.join(" / ")}%).`;
  } else if (!done && a.prizes.length < players) {
    hint = `${ordinalEn(a.prizes.length + 1)}–${ordinalEn(players)} get nothing. Shared places split their prizes.`;
  } else if (done) hint = "Play chips only: the site just keeps score between friends.";
  if (hint) s.append(el("p", "ti-hint", hint));
  return s;
}

// Блайнды: сыгранные бледные, текущий зелёный с оставшимся временем, черта конца поздней регистрации и ребаев
function blindsSec(a) {
  const reg = a.status === "registration", live = a.status === "running" || a.status === "paused", done = a.status === "finished";
  const firstAnte = a.levels.findIndex((l) => l.ante > 0);
  const s = section("bl", "Blind structure", levelLen(a.level_seconds) + (firstAnte < 0 ? " · no ante" : firstAnte === 0 ? " · ante from level 1" : ` · ante from level ${firstAnte + 1}`));
  const tbl = el("table", "blinds");
  const thead = el("thead");
  const hr = el("tr");
  [["Lvl", ""], ["Blinds", ""], ["Ante", "r"], [done ? "Started" : "Starts", "r"]].forEach(([t, c]) => hr.append(el("th", c, t)));
  thead.append(hr);
  const tb = el("tbody");
  const lines = {};
  const add = (lvl, text) => { lines[lvl] = lines[lvl] ? null : text; };
  if (a.late_reg_level) add(a.late_reg_level, "▲ Late registration ends here");
  if (a.rebuy_level) add(a.rebuy_level, "▲ Rebuys end here");
  if (a.late_reg_level && a.late_reg_level === a.rebuy_level) lines[a.late_reg_level] = "▲ Late registration and rebuys end here";
  const shown = done ? a.level : a.levels.length;
  for (let i = 0; i < shown; i++) {
    const l = a.levels[i], n = i + 1;
    const now = live && n === a.level, past = live && n < a.level, last = done && n === a.level;
    const tr = el("tr", now ? "now" : past ? "past" : last ? "last" : "");
    if (now) tr.setAttribute("aria-current", "true");
    const at = a.level_starts[i];
    const when = el("td", "r", at ? hm(at) : "—");
    if (now && a.status === "running" && a.level_left != null && a.next) when.append(" ", el("span", "left ti-left2", ""));
    if (last) when.append(" · final");
    tr.append(el("td", "", String(n)), el("td", "", `${nfmt(l.sb)} / ${nfmt(l.bb)}`), el("td", "r", l.ante ? nfmt(l.ante) : "—"), when);
    tb.append(tr);
    if (lines[n] && n < a.levels.length) {
      const lr = el("tr", "endline");
      const td = el("td", "", lines[n]);
      td.colSpan = 4;
      lr.append(td);
      tb.append(lr);
    }
  }
  tbl.append(thead, tb);
  const wrap = el("div", "blwrap");
  wrap.append(tbl);
  s.append(wrap);
  if (done && a.level < a.levels.length) {
    const from = a.level + 1, to = a.levels.length;
    s.append(el("p", "ti-hint", from === to ? `Level ${from} was not played.` : `Levels ${from}–${to} were not played.`));
  }
  if (reg && !a.starts_at) s.append(el("p", "ti-hint", "Start times appear when the start time is set."));
  return s;
}

// Таймеры: обратный отсчёт до старта, «идёт уже», до следующего уровня
function tickCard() {
  if (!card || cardId === null) return;
  const a = card, now = Date.now() / 1000, passed = (Date.now() - cardGot) / 1000;
  const tick = document.querySelector("#mttinfo .ti-tick");
  if (tick) {
    if (a.status === "registration" && a.starts_at) tick.textContent = a.starts_at - now > 0 ? dur(a.starts_at - now) : "any moment";
    else if (a.started) tick.textContent = dur(now - a.started);
  }
  if (a.level_left != null && a.status === "running") {
    const left = dur(Math.max(0, a.level_left - passed));
    document.querySelectorAll("#mttinfo .ti-left").forEach((x) => { x.textContent = left; });
    document.querySelectorAll("#mttinfo .ti-left2").forEach((x) => { x.textContent = `· ${left} left`; });
  }
}
setInterval(tickCard, 1000);
})();
