// NoDiddyPoker (adminmtt.js) — Admin › Tournaments: список, создание (шаблоны, таблица блайндов, длительность) и пульт турнира.
// Пользуется помощниками из admin.js ($, el, api, toast, fmt, avatar, data, refresh).
// Адреса внутри раздела: #tournaments (список), #new, #edit-<id>, #copy-<id>, #console.

// ---------- шаблоны ----------
// Шаблоны (Turbo / Regular / Deep) приходят с сервера (tournament.TEMPLATES): анте — с первого уровня.
const mttTemplates = () => (data.mtt && data.mtt.templates) || {};
const POINTS = [10, 6, 4, 2, 1];
// Деньги: всё в центах, на экране — доллары ($25, $52.08). Проценты призов — как на сервере (tournament.PAYOUTS).
const usd = (cents) => "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const PAYOUTS = [[3, [100]], [6, [65, 35]], [10, [50, 30, 20]], [17, [40, 25, 18, 10, 7]], [27, [33, 21, 15, 11, 8, 6, 6]], [1e9, [30, 20, 14, 10, 8, 6, 5, 4, 3]]];
function prizeList(pool, entries) {
  const pct = (PAYOUTS.find(([upto]) => Math.max(1, entries) <= upto) || PAYOUTS[PAYOUTS.length - 1])[1];
  const p = pct.map((x) => Math.floor(pool * x / 100));
  if (p.length) p[0] += pool - p.reduce((a, b) => a + b, 0);
  return p;
}

// ---------- время ----------
function hm(minutes) {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m` : `${m} min`;
}
const clockHM = (minutes) => `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
const mmss = (secs) => `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
function when(ts) {
  if (!ts) return "When I press Start";
  return new Date(ts * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Сколько примерно длится турнир: кончается на уровне, где BB ≈ 2% всех фишек; диапазон ±1 уровень
function estimate(cfg, players) {
  const total = Math.max(2, players) * cfg.stack;
  let idx = cfg.levels.findIndex((l) => l.bb >= 0.02 * total);
  if (idx < 0) idx = cfg.levels.length - 1;
  const per = cfg.level_seconds / 60;
  return { mid: (idx + 1) * per, low: Math.max(1, idx) * per, high: Math.min(cfg.levels.length, idx + 2) * per, level: idx + 1 };
}

// ---------- состояние раздела ----------
const mttui = { form: null, template: "regular", changed: 0, editId: null, results: new Set(), bots: 3, startMode: "button" };
function mttView() {
  const h = location.hash.replace("#", "");
  if (h === "new" || h.startsWith("edit-") || h.startsWith("copy-")) return "form";
  if (h === "console") return "console";
  return "list";
}
function mttAdmin(body) {
  return api("POST", "api/mtt/admin", body).then((res) => {
    if (res.list) data.mtt.list = res.list;
    if (res.active !== undefined) data.mtt.active = res.active;
    renderTournaments();
    return res;
  });
}
function act(body, okText) {
  return mttAdmin(body).then((res) => { if (okText) toast(okText); return res; }).catch((e) => { toast(e.message); throw e; });
}

// ---------- главный вход: что показать в разделе Tournaments ----------
function renderTournaments() {
  if (!data.mtt) return;
  const live = data.mtt.list.filter((t) => ["running", "paused"].includes(t.status)).length;
  $("livecount").hidden = !live;
  $("livecount").textContent = `${live} live`;
  const view = mttView();
  $("mttlistview").hidden = view !== "list";
  $("mttform").hidden = view !== "form";
  $("mttconsole").hidden = view !== "console";
  if (view === "list") renderList();
  if (view === "form") renderForm();
  if (view === "console") renderConsole();
}
window.addEventListener("hashchange", () => { mttui.form = null; renderTournaments(); });
function tabFor() {               // #new, #console и т.п. — это раздел Tournaments
  return ["form", "console"].includes(mttView()) ? "tournaments" : null;
}

// ---------- список ----------
const ST_LABEL = { draft: "Draft", registration: "Registration", running: "Running", paused: "Paused", finished: "Finished", cancelled: "Cancelled" };
// Длина уровня честно: 30 с — «30-sec levels», 60 с и кратные минуте — «N-min levels»
const mttLevelLen = (sec) => (sec % 60 ? `${sec}-sec levels` : `${sec / 60}-min levels`);
function summary(c) {
  const parts = [`${c.game === "plo4" ? "Omaha" : "Hold'em"}`, `${fmt(c.stack)} chips`, mttLevelLen(c.level_seconds)];
  if (c.buy_in) parts.unshift(`${usd(c.buy_in)} buy-in`);
  const ante = (c.levels || []).findIndex((l) => l.ante > 0);
  if (ante >= 0) parts.push(ante === 0 ? "ante from the start" : `ante from level ${ante + 1}`);
  if (c.rebuy_level) parts.push(`rebuys to level ${c.rebuy_level}`);
  if (c.test) parts.push("test");
  return parts.join(" · ");
}
function btn(text, cls, onclick) {
  const b = el("button", "mini" + (cls ? " " + cls : ""), text);
  b.type = "button";
  b.onclick = onclick;
  return b;
}
function link(text, cls, href) {
  const a = el("a", cls, text);
  a.href = href;
  return a;
}
function renderList() {
  const list = data.mtt.list;
  const active = data.mtt.active;
  const groups = [["Now", ["running", "paused"]], ["Coming up", ["registration"]], ["Drafts", ["draft"]], ["Finished", ["finished", "cancelled"]]];
  const out = [];
  const head = el("div", "listhead");
  head.append(link("＋ New tournament", "go newt", "#new"));
  out.push(head);
  for (const [title, statuses] of groups) {
    const rows = list.filter((t) => statuses.includes(t.status));
    if (!rows.length) continue;
    const h = el("h3", "agroup", title);
    if (title === "Drafts") h.append(el("span", "muted small sub", " players don't see these"));
    out.push(h);
    for (const t of rows) {
      const isActive = active && active.id === t.id;
      const row = el("div", "trow mrow st-" + t.status);
      const info = el("div", "tinfo");
      const name = el("div", "tname");
      const said = el("span", "", t.name);
      said.dataset.notr = "";
      name.append(said);
      info.append(name, el("div", "tmeta", summary(t.config)));
      const whenBox = el("div", "mwhen");
      if (["running", "paused"].includes(t.status) && isActive) {
        whenBox.append(el("b", "", `Level ${active.level} of ${active.levels.length}`), el("span", "muted small", `${active.left} / ${active.entrants} left`));
      } else if (t.status === "finished") {
        const win = (t.results || []).find((r) => r.place === 1);
        whenBox.append(el("b", "", t.ended ? when(t.ended) : ""), el("span", "", win ? "🏆 " + win.name : ""));
      } else {
        whenBox.append(el("b", "", when(t.starts_at)), el("span", "muted small", t.status === "draft" ? "not published" : ""));
      }
      if (isActive && t.status === "registration") whenBox.append(el("span", "muted small", `${active.entrants} registered`));
      const acts = el("div", "macts");
      if (["running", "paused", "registration"].includes(t.status) && isActive) acts.append(link("Open console", "go small", "#console"));
      if (t.status === "draft") {
        acts.append(btn("Publish", "gold", () => publish(t.id)), link("Edit", "mini", `#edit-${t.id}`));
      }
      if (t.status === "finished") acts.append(btn(mttui.results.has(t.id) ? "Hide results" : "Results", "", () => {
        mttui.results.has(t.id) ? mttui.results.delete(t.id) : mttui.results.add(t.id);
        renderList();
      }));
      acts.append(link("Copy", "mini", `#copy-${t.id}`));
      // Delete: черновик, законченный или отменённый (идущий — сначала Cancel). Турнир пропадает из всех списков
      if (["draft", "finished", "cancelled"].includes(t.status)) acts.append(btn("Delete", "danger", async () => {
        if (await Dialog.ask({ text: `Delete tournament ${t.name}? This can't be undone.`, ok: "Delete", danger: true }))
          act({ action: "delete", id: t.id }, "Tournament deleted.");
      }));
      row.append(el("span", "st st-" + t.status, ST_LABEL[t.status] || t.status), info, whenBox, acts);
      out.push(row);
      if (t.status === "finished" && mttui.results.has(t.id)) out.push(resultsTable(t.results || []));
    }
  }
  if (out.length === 1) out.push(el("p", "muted", "No tournaments yet — create one."));
  out.push(el("p", "muted small", "Delete removes a tournament from all lists. Points and money already won stay on the leaderboard. A running tournament has to be cancelled first."));
  $("mttlistview").replaceChildren(...out);
}
function resultsTable(rows) {
  const box = el("div", "mres");
  for (const r of rows) {
    const line = el("div", "mresrow");
    const who = el("span", "", r.name);
    who.dataset.notr = "";
    line.append(el("b", "", `${r.place}.`), who, el("span", "muted", (r.prize ? usd(r.prize) : "") + (r.trophy ? " 🏆" : "")));
    box.append(line);
  }
  return box;
}
async function publish(id) {
  if (data.mtt.active && ["registration", "running", "paused"].includes(data.mtt.active.status)) {
    toast("Another tournament is already open — finish or cancel it first.");
    return;
  }
  try {
    await act({ action: "open", id }, "Published — registration is open.");
    location.hash = "#console";
  } catch (e) {}
}

// ---------- создание / правка ----------
function blankForm() {
  const tpl = mttTemplates().regular;
  return { name: "", game: "nlhe", starts_at: null, max_players: 8, stack: tpl.stack, level_seconds: tpl.level_seconds,
           levels: tpl.levels.map((l) => ({ ...l })), seats: 7, late_on: true, late_reg_level: tpl.late_reg_level,
           rebuy_on: true, rebuy_level: tpl.rebuy_level, points: [...POINTS], test: false, turn_seconds: 15, buy_in: 2500 };
}
function formFrom(row, copy) {
  const c = row.config;
  return { name: copy ? row.name + " (copy)" : row.name, game: c.game, starts_at: copy ? null : row.starts_at,
           max_players: c.max_players, stack: c.stack, level_seconds: c.level_seconds, levels: c.levels.map((l) => ({ ...l })),
           seats: c.seats, late_on: c.late_reg_level > 0, late_reg_level: c.late_reg_level || 4, rebuy_on: c.rebuy_level > 0,
           rebuy_level: c.rebuy_level || 4, points: [...(c.points || POINTS)], test: c.test, turn_seconds: c.turn_seconds,
           buy_in: c.buy_in || 0 };
}
function formConfig(f) {
  return { game: f.game, stack: f.stack, level_seconds: f.level_seconds, levels: f.levels, seats: f.seats, max_players: f.max_players,
           turn_seconds: f.turn_seconds, late_reg_level: f.late_on ? f.late_reg_level : 0, rebuy_level: f.rebuy_on ? f.rebuy_level : 0,
           points: f.points, test: f.test, buy_in: f.buy_in };
}
function ensureForm() {
  if (mttui.form) return;
  const h = location.hash.replace("#", "");
  const id = Number(h.split("-")[1]);
  const row = data.mtt.list.find((t) => t.id === id);
  mttui.editId = h.startsWith("edit-") && row && row.status === "draft" ? id : null;
  mttui.form = row && h !== "new" ? formFrom(row, h.startsWith("copy-")) : blankForm();
  mttui.startMode = mttui.form.starts_at ? "time" : "button";
  mttui.changed = 0;
}
function applyTemplate(key) {
  const t = mttTemplates()[key], f = mttui.form;
  mttui.template = key;
  Object.assign(f, { stack: t.stack, level_seconds: t.level_seconds, levels: t.levels.map((l) => ({ ...l })),
                     late_on: t.late_reg_level > 0, late_reg_level: t.late_reg_level || 4,
                     rebuy_on: t.rebuy_level > 0, rebuy_level: t.rebuy_level || 4 });
  mttui.changed = 0;
  renderForm();
}
function touched() { mttui.changed += 1; renderSide(); }

function field(label, input, hint) {
  const box = el("label", "fld");
  box.append(el("span", "flabel", label), input);
  if (hint) box.append(el("span", "fhint muted small", hint));
  return box;
}
function numInput(value, onchange, attrs = {}) {
  const i = el("input");
  i.type = "number";
  i.inputMode = "numeric";
  i.value = value;
  Object.assign(i, attrs);
  i.oninput = () => { onchange(Math.round(Number(i.value) || 0)); touched(); };
  return i;
}
function seg(options, current, onpick, disabled = []) {
  const box = el("div", "seg");
  box.setAttribute("role", "radiogroup");
  for (const [value, label] of options) {
    const b = el("button", "segb" + (value === current ? " on" : ""), label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", value === current ? "true" : "false");
    if (disabled.includes(value)) { b.disabled = true; b.append(el("span", "soontag", "soon")); }
    b.onclick = () => onpick(value);
    box.append(b);
  }
  return box;
}
function toggle(on, label, onflip) {
  const b = el("button", "toggle" + (on ? " on" : ""));
  b.type = "button";
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", on ? "true" : "false");
  b.append(el("span", "knob"), el("span", "tlabel", label));
  b.onclick = () => onflip(!on);
  return b;
}
function levelSelect(value, onpick) {
  const s = el("select");
  mttui.form.levels.forEach((_, i) => {
    const o = el("option", "", String(i + 1));
    o.value = i + 1;
    if (i + 1 === value) o.selected = true;
    s.append(o);
  });
  s.onchange = () => { onpick(Number(s.value)); touched(); renderForm(); };
  return s;
}
function card(n, title, ...children) {
  const c = el("section", "card fcard");
  const h = el("h3", "fhead");
  h.append(el("span", "fnum", String(n)), title);
  c.append(h, ...children);
  return c;
}

function renderForm() {
  ensureForm();
  const f = mttui.form;
  const main = el("div", "fmain");
  // 1. шаблон
  const tpls = el("div", "tpls");
  for (const [key, t] of Object.entries(mttTemplates())) {
    const est = estimate({ ...t }, 7);
    const b = el("button", "tpl" + (mttui.template === key ? " on" : ""));
    b.type = "button";
    b.append(el("b", "", t.title), el("span", "tdur", `~${hm(est.mid)}`), el("span", "muted small", `${fmt(t.stack)} chips · ${mttLevelLen(t.level_seconds)}`));
    b.onclick = () => applyTemplate(key);
    tpls.append(b);
  }
  main.append(card(1, "Start from a template", tpls,
    el("p", "muted small", "A template fills in everything below. You can change any field after." + (mttui.changed ? ` Changed ${mttui.changed} field${mttui.changed === 1 ? "" : "s"}.` : ""))));
  // 2. основное
  const name = el("input");
  name.maxLength = 40;
  name.value = f.name;
  name.placeholder = "Friday Night MTT";
  name.oninput = () => { f.name = name.value; renderSide(); };
  const startBox = el("div", "row2");
  const dt = el("input");
  dt.type = "datetime-local";
  if (f.starts_at) {
    const d = new Date(f.starts_at * 1000);
    dt.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  dt.oninput = () => { f.starts_at = dt.value ? Math.floor(new Date(dt.value).getTime() / 1000) : null; renderSide(); };
  dt.disabled = mttui.startMode !== "time";
  startBox.append(field("Date and time", dt, "Registration opens as soon as you publish."),
                  field("Max players", numInput(f.max_players, (v) => { f.max_players = v; }, { min: 2, max: 100 })));
  main.append(card(2, "Basics", field("Name", name),
    field("Game", seg([["nlhe", "Hold'em"], ["plo4", "Omaha"]], f.game, (v) => { f.game = v; renderForm(); }, ["plo4"])),
    field("Start", seg([["button", "When I press Start"], ["time", "At a set time"]], mttui.startMode, (v) => {
      mttui.startMode = v;
      if (v === "button") f.starts_at = null;
      renderForm();
    })), startBox));
  // 3. стек и блайнды
  const sl = el("select");
  for (const m of [3, 4, 5, 6, 8, 10, 12, 15, 20, 30]) {
    const o = el("option", "", `${m} min`);
    o.value = m * 60;
    if (m * 60 === f.level_seconds) o.selected = true;
    sl.append(o);
  }
  if (![...sl.options].some((o) => o.selected)) {
    const o = el("option", "", f.level_seconds % 60 ? `${f.level_seconds} sec` : `${f.level_seconds / 60} min`);
    o.value = f.level_seconds; o.selected = true; sl.append(o);
  }
  sl.onchange = () => { f.level_seconds = Number(sl.value); touched(); renderForm(); };
  const stackRow = el("div", "row2");
  stackRow.append(field("Starting stack", numInput(f.stack, (v) => { f.stack = v; }, { min: 100, step: 1000 }),
                        f.levels[0] ? `= ${fmt(Math.round(f.stack / f.levels[0].bb))} BB at level 1` : ""),
                  field("Level length", sl, "Same for every level"));
  const table = el("table", "blinds");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["Lvl", "Starts", "SB", "BB", "Ante", ""]) hr.append(el("th", h === "Starts" ? "starts" : "", h));
  thead.append(hr);
  const tbody = el("tbody");
  const warnings = [];
  f.levels.forEach((l, i) => {
    const tr = el("tr");
    const cell = (key) => {
      const td = el("td");
      const inp = numInput(l[key], (v) => { l[key] = v; }, { min: 0 });
      inp.setAttribute("aria-label", `Level ${i + 1} ${key.toUpperCase()}`);
      td.append(inp);
      return td;
    };
    const del = btn("×", "x", () => { if (f.levels.length > 1) { f.levels.splice(i, 1); touched(); renderForm(); } });
    del.setAttribute("aria-label", `Remove level ${i + 1}`);
    const dtd = el("td");
    dtd.append(del);
    tr.append(el("td", "lvl", String(i + 1)), el("td", "starts muted", clockHM(i * f.level_seconds / 60)), cell("sb"), cell("bb"), cell("ante"), dtd);
    tbody.append(tr);
    const endLate = Math.max(f.late_on ? f.late_reg_level : 0, f.rebuy_on ? f.rebuy_level : 0);
    if (i + 1 === endLate) {
      const mark = el("tr", "endmark");
      const td = el("td", "", (f.late_on && f.rebuy_on ? "▲ Late registration and rebuys end here" : f.late_on ? "▲ Late registration ends here" : "▲ Rebuys end here"));
      td.colSpan = 6;
      mark.append(td);
      tbody.append(mark);
    }
    if (!(l.sb > 0 && l.sb < l.bb)) warnings.push(`Level ${i + 1}: SB must be more than 0 and less than BB.`);
    else if (i && l.bb < f.levels[i - 1].bb) warnings.push(`Level ${i + 1}: blinds go down.`);
    else if (l.ante && l.ante < l.bb / 10) warnings.push(`Level ${i + 1}: ante ${fmt(l.ante)} is less than 1/10 of BB — that's fine, just checking it's not a typo.`);
  });
  table.append(thead, tbody);
  const tools = el("div", "ltools");
  tools.append(btn("+ Level", "", () => {
    const last = f.levels[f.levels.length - 1] || { sb: 25, bb: 50, ante: 0 };
    f.levels.push({ sb: Math.round(last.sb * 1.5), bb: Math.round(last.bb * 1.5), ante: Math.round(last.ante * 1.5) });
    touched(); renderForm();
  }), btn("Reset to template", "", () => applyTemplate(mttui.template)), el("span", "muted small", "Ante — every player pays it each hand."));
  const scroll = el("div", "tscroll");
  scroll.append(table);
  main.append(card(3, "Stack and blinds", stackRow, el("div", "flabel", "Blind structure"), scroll, tools,
    ...warnings.map((w) => el("p", "warn small", "⚠ " + w))));
  // 4. столы и вход
  const n = Math.max(2, f.max_players), tablesN = Math.ceil(n / f.seats);
  const seatsHint = tablesN > 1 ? `${n} players → ${tablesN} tables of ${f.seats}. When ${f.seats} are left, they move to one final table.`
                                : `${n} players → one table.`;
  const late = el("div", "subcard");
  late.append(toggle(f.late_on, "Late registration", (v) => { f.late_on = v; touched(); renderForm(); }));
  if (f.late_on) {
    const r = el("div", "inl");
    r.append("until the end of level", levelSelect(f.late_reg_level, (v) => { f.late_reg_level = v; }),
             el("span", "muted small", `≈ ${hm(f.late_reg_level * f.level_seconds / 60)} after start`));
    late.append(r);
  }
  const reb = el("div", "subcard");
  reb.append(toggle(f.rebuy_on, "Rebuys", (v) => { f.rebuy_on = v; touched(); renderForm(); }));
  if (f.rebuy_on) {
    const r = el("div", "inl");
    r.append("until the end of level", levelSelect(f.rebuy_level, (v) => { f.rebuy_level = v; }));
    reb.append(r, el("p", "muted small", "Only when you have 0 chips. You get the starting stack again."));
  }
  const two = el("div", "row2");
  two.append(late, reb);
  main.append(card(4, "Tables and entries",
    field("Seats per table", seg([2, 3, 4, 5, 6, 7].map((x) => [x, String(x)]), f.seats, (v) => { f.seats = v; touched(); renderForm(); }), seatsHint),
    two));
  // 5. бай-ин и призы
  const buy = el("input");
  buy.type = "number";
  buy.min = 0;
  buy.step = "0.01";
  buy.inputMode = "decimal";
  buy.value = (f.buy_in / 100).toString();
  const preview = el("div", "payprev");
  const drawPreview = () => {
    const n = Math.min(f.max_players, 7) || 7;
    const pool = f.buy_in * n;
    const pr = prizeList(pool, n);
    preview.replaceChildren(el("span", "muted small", `With ${n} players: prize pool ${usd(pool)} → `),
      ...pr.map((c, i) => el("span", "paychip", `${i + 1}${["st", "nd", "rd"][i] || "th"} ${usd(c)}`)));
  };
  buy.oninput = () => { f.buy_in = Math.max(0, Math.round(Number(buy.value || 0) * 100)); drawPreview(); renderSide(); };
  drawPreview();
  main.append(card(5, "Buy-in and prizes", field("Buy-in, $", buy, "Every entry and every rebuy costs this. The prize pool is all of it together."),
    preview, el("p", "muted small", "Paid places depend on how many enter: up to 3 — winner takes all, 4–6 — two places, 7–10 — three (50/30/20%), more — up to 9 places."),
    el("p", "muted small", "🏆 The winner gets a trophy next to the nickname, and the win is posted to News. The site only counts the money — friends settle up themselves.")));
  // 6. пробный запуск
  const test = el("div", "subcard");
  test.append(toggle(f.test, "Add bots — to try the tournament alone or with 1–2 friends", (v) => { f.test = v; renderForm(); }));
  if (f.test) {
    const r = el("div", "inl");
    r.append("Bots:", numInput(mttui.bots, (v) => { mttui.bots = Math.max(1, Math.min(20, v)); }, { min: 1, max: 20 }));
    test.append(r);
  }
  test.append(el("p", "muted small", "A tournament with bots gives no points and no trophy."));
  main.append(card(6, "Test run", test));

  const side = el("aside", "fside");
  side.id = "fside";
  const wrap = el("div", "fwrap");
  const top = el("div", "fhero");
  top.append(el("div", "crumbs", ""), el("h2", "atitle", mttui.editId ? "Edit tournament" : "New tournament"),
             el("span", "st st-draft", mttui.editId ? "Draft" : "Draft — not saved yet"));
  top.querySelector(".crumbs").append(link("Tournaments", "", "#tournaments"), " › ", mttui.editId ? "Edit" : "New tournament");
  wrap.append(main, side);
  $("mttform").replaceChildren(top, wrap);
  renderSide();
}

function renderSide() {
  const f = mttui.form;
  const side = $("fside");
  if (!f || !side) return;
  const cfg = formConfig(f);
  const players = 7;
  const est = estimate(cfg, players);
  const hero = el("div", "est");
  hero.append(el("span", "eyebrow", "Expected length"), el("b", "", `~${hm(est.mid)}`),
              el("span", "muted small", `usually ${clockHM(est.low)} – ${clockHM(est.high)} with ${players} players`));
  const firstAnte = cfg.levels.findIndex((l) => l.ante > 0);
  const rows = [
    ["Starts", f.starts_at ? when(f.starts_at) : "When I press Start"],
    ["Game", `${f.game === "plo4" ? "Omaha" : "Hold'em"}, ${f.seats} per table`],
    ["Stack", `${fmt(f.stack)} · ${cfg.levels[0] ? fmt(Math.round(f.stack / cfg.levels[0].bb)) : "?"} BB`],
    ["Levels", `${cfg.levels.length} × ${f.level_seconds % 60 ? f.level_seconds + " sec" : f.level_seconds / 60 + " min"}`],
    ["Ante from", firstAnte === 0 ? "the start" : firstAnte > 0 ? `level ${firstAnte + 1}` : "no ante"],
    ["Late reg · rebuys", `${f.late_on ? "to level " + f.late_reg_level : "no"} · ${f.rebuy_on ? "to level " + f.rebuy_level : "no"}`],
    ["Buy-in", f.buy_in ? usd(f.buy_in) : "free"],
    ["Prize pool", f.buy_in ? `${usd(f.buy_in * players)} with ${players} players` : "—"],
  ];
  const list = el("dl", "sum");
  for (const [k, v] of rows) list.append(el("dt", "", k), el("dd", "", v));
  const box = el("div", "card scard");
  box.append(hero, list);
  const pub = el("button", "go pub", "Publish — open registration");
  pub.type = "button";
  pub.onclick = () => saveTournament(true);
  const draft = el("button", "mini wide", mttui.editId ? "Save draft" : "Save as draft");
  draft.type = "button";
  draft.onclick = () => saveTournament(false);
  side.replaceChildren(box, pub, draft, el("p", "muted small center", "Players will see it on the MTT tab right after you publish."));
}

async function saveTournament(open) {
  const f = mttui.form;
  if (!f.name.trim()) { toast("Give the tournament a name."); return; }
  if (mttui.startMode === "time" && !f.starts_at) { toast("Pick the date and time."); return; }
  const body = { action: mttui.editId ? "update" : "create", id: mttui.editId, name: f.name, config: formConfig(f), starts_at: f.starts_at };
  try {
    const res = await act(body);
    const id = mttui.editId || res.id;
    if (open) {
      await act({ action: "open", id });
      if (f.test) await act({ action: "add_bots", id, n: mttui.bots });
      toast("Published — registration is open.");
      location.hash = "#console";
    } else {
      toast("Saved as a draft.");
      location.hash = "#tournaments";
    }
  } catch (e) {}
}

// ---------- пульт ----------
let countdownTimer = null;
function renderConsole() {
  const a = data.mtt.active;
  const box = $("mttconsole");
  if (!a) { box.replaceChildren(el("p", "muted", "No tournament is open."), link("← Tournaments", "more", "#tournaments")); return; }
  const out = [];
  const crumbs = el("div", "crumbs");
  crumbs.append(link("Tournaments", "", "#tournaments"), " › ");
  const cname = el("span", "", a.name);
  cname.dataset.notr = "";
  crumbs.append(cname);
  const title = el("div", "ctitle");
  const tname = el("h2", "atitle", a.name);
  tname.dataset.notr = "";
  title.append(tname, el("span", "st st-" + a.status, ST_LABEL[a.status] || a.status),
               el("span", "muted small", a.started ? `started ${new Date(a.started * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${a.seats} per table`
                                                   : `${when(a.starts_at)} · ${a.seats} per table` + (a.test ? " · test" : "")));
  out.push(crumbs, title);
  if (a.error) out.push(el("p", "warn", "⚠ " + a.error));

  // часы и управление
  const top = el("div", "ctop");
  const clock = el("div", "card clock");
  const left = a.level_left == null ? a.level_seconds : a.level_left;
  const big = el("div", "big", mmss(left));
  big.id = "mttclock";
  big.dataset.left = left;
  big.dataset.at = Date.now();
  big.dataset.run = a.status === "running" ? "1" : "";
  const info = el("div", "linfo");
  info.append(el("span", "eyebrow", `Level ${a.level} of ${a.levels.length}`));
  const bl = el("div", "blinds-now", `${fmt(a.sb)} / ${fmt(a.bb)}`);
  if (a.ante) bl.append(el("span", "ante", ` ante ${fmt(a.ante)}`));
  info.append(bl, el("span", "muted small", a.next ? `Next: ${fmt(a.next.sb)} / ${fmt(a.next.bb)}` + (a.next.ante ? ` · ante ${fmt(a.next.ante)}` : "") : "This is the last level"));
  const bar = el("div", "lbar");
  const fill = el("i");
  fill.style.width = `${Math.max(0, Math.min(100, 100 - (left / a.level_seconds) * 100))}%`;
  bar.append(fill);
  const cl = el("div", "cl");
  cl.append(big, el("span", "eyebrow", a.status === "registration" ? "level length" : a.status === "paused" ? "paused" : "to next level"));
  clock.append(cl, info, bar);

  const ctr = el("div", "cside");
  const btns = el("div", "cbtns");
  if (a.status === "registration") {
    const start = el("button", "go", "▶ Start now");
    start.type = "button";
    start.disabled = a.entrants < 2;
    start.onclick = async () => { if (await Dialog.ask({ text: "Start the tournament now?", ok: "Start" })) act({ action: "start", id: a.id }, "Started."); };
    btns.append(start);
  } else if (a.status === "running") {
    const p = el("button", "go", "⏸ Pause");
    p.type = "button";
    p.onclick = () => act({ action: "pause", id: a.id }, "Paused.");
    btns.append(p);
  } else if (a.status === "paused") {
    const r = el("button", "go", "▶ Resume");
    r.type = "button";
    r.onclick = () => act({ action: "resume", id: a.id }, "Resumed.");
    btns.append(r);
  }
  if (["running", "paused"].includes(a.status)) {
    const nx = el("button", "mini big2", "⏭ Next level now");
    nx.type = "button";
    nx.disabled = !a.next;
    nx.onclick = () => act({ action: "next_level", id: a.id });
    btns.append(nx);
  }
  const stats = el("div", "cstats");
  const stat = (b, s) => { const d = el("div", "stat"); d.append(el("b", "", b), el("span", "", s)); return d; };
  if (a.status === "registration") {
    stats.append(stat(String(a.entrants), `registered (max ${a.max_players})`), stat(fmt(a.stack), "starting stack"));
  } else {
    stats.append(stat(`${a.left} / ${a.entrants}`, "players left"),
                 stat(fmt(a.avg_stack), `average stack · ${a.bb ? Math.round(a.avg_stack / a.bb) : 0} BB`),
                 stat(String(a.tables.length), "tables"), stat(String(a.rebuys), "rebuys"));
  }
  ctr.append(btns, stats);
  if (a.buy_in) {
    stats.append(stat(usd(a.prize_pool), `prize pool · buy-in ${usd(a.buy_in)}`));
    const pays = el("div", "payprev");
    pays.append(el("span", "muted small", "Prizes: "), ...a.prizes.map((c, i) => el("span", "paychip", `${i + 1}${["st", "nd", "rd"][i] || "th"} ${usd(c)}`)));
    ctr.append(pays);
  }
  if (a.auto_resume_in) ctr.append(el("p", "warn small", `Restored after a restart — continues by itself in ${Math.ceil(a.auto_resume_in / 60)} min, or press Resume.`));
  // поздняя регистрация
  if (a.status !== "finished" && a.status !== "cancelled") {
    const lr = el("div", "lreg");
    const open = a.can_register;
    lr.append(el("span", "", a.late_reg_level ? (open ? `🕑 Late registration open until the end of level ${a.late_reg_level}.` : `🕑 Late registration closed after level ${a.late_reg_level}.`)
                                              : (a.status === "registration" ? "🕑 Registration is open." : "🕑 No late registration.")));
    if (a.status !== "registration") {
      const target = Math.min(a.levels.length, Math.max(a.level, a.late_reg_level) + 2);
      if (target >= a.level) lr.append(btn(open ? `Extend to level ${target}` : `Reopen until level ${target}`, "", () => act({ action: "extend_reg", id: a.id, level: target }, "Late registration extended.")));
    }
    ctr.append(lr);
  }
  if (a.status === "registration" && a.test) {
    const bots = el("div", "lreg");
    bots.append(el("span", "", "🤖 Test tournament: bots play, no points."),
                btn("+ 3 bots", "", () => act({ action: "add_bots", id: a.id, n: 3 })),
                btn("Remove bots", "", () => act({ action: "remove_bots", id: a.id })));
    ctr.append(bots);
  }
  top.append(clock, ctr);
  out.push(top);

  // игроки + журнал
  const grid = el("div", "cgrid");
  const pc = el("section", "card cplayers");
  const ph = el("div", "head");
  ph.append(el("h2", "", "Players"), el("span", "muted small", a.status === "registration" ? `${a.entrants} registered` : `by stack · ${a.left} of ${a.entrants} left`));
  pc.append(ph);
  const list = el("ul", "plist2");
  let pos = 0;
  for (const p of a.players) {
    const out2 = p.status === "out";
    const li = el("li", "prow" + (out2 ? " out" : "") + (p.me ? " me" : ""));
    if (p.status === "playing") pos += 1;
    const nm = el("span", "pn");
    const nick = el("span", "", p.name);
    nick.dataset.notr = "";
    nm.append(nick);
    if (p.me) nm.append(el("span", "you", " you"));
    if (p.rebuys) nm.append(el("span", "reb", ` (${p.rebuys} rebuy${p.rebuys > 1 ? "s" : ""})`));
    if (p.away) nm.append(el("span", "muted small", " · sitting out"));
    const right = el("span", "pst");
    if (out2) right.textContent = `${ordinal(p.place)} · out at level ${p.bust_level || "?"}`;
    else if (p.status === "playing") right.append(el("b", "", fmt(p.chips)), el("span", "muted", ` (${a.bb ? Math.round(p.chips / a.bb) : 0} BB)`));
    else right.textContent = "registered";
    li.append(el("span", "pos", out2 ? String(p.place || "") : p.status === "playing" ? String(pos) : ""), avatar(p.name, p.avatar, 30), nm, right);
    if (p.status === "playing" && p.table) {
      const watch = link("👁", "mini icon", `table?t=${encodeURIComponent(p.table)}`);
      watch.title = `Watch table ${p.table.split("-").pop()}`;
      watch.setAttribute("aria-label", `Watch table ${p.table.split("-").pop()}`);
      const kick = btn("✕", "danger icon", async () => {
        if (await Dialog.ask({ text: `Remove ${p.name}? Their chips leave the game and they finish in the next place out.`, ok: "Remove", danger: true }))
          act(p.bot ? { action: "kick", id: a.id, name: p.name } : { action: "kick", id: a.id, pid: p.pid }, `${p.name} removed.`);
      });
      kick.setAttribute("aria-label", `Remove ${p.name}`);
      li.append(watch, kick);
    }
    list.append(li);
  }
  if (!a.players.length) list.append(el("li", "muted small", "Nobody has registered yet."));
  pc.append(list, el("p", "muted small", "👁 opens that player's table. ✕ removes a player (asks first): their chips leave the game, place = next out."));
  const sidecol = el("div", "ccol");
  const log = el("section", "card clog");
  log.append(el("h2", "", "Log"));
  const ll = el("ul", "logl");
  for (const ev of a.log || []) {
    const li = el("li");
    li.append(el("time", "", ev.t ? new Date(ev.t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""), el("span", "", ev.text));
    ll.append(li);
  }
  if (!(a.log || []).length) ll.append(el("li", "muted small", "Nothing yet."));
  log.append(ll);
  sidecol.append(log);
  if (a.status === "finished" && a.results) {
    const rc = el("section", "card");
    rc.append(el("h2", "", "Results"), resultsTable(a.results));
    sidecol.append(rc);
  }
  if (!["finished", "cancelled"].includes(a.status)) {
    const stop = el("section", "card cstop");
    const cb = el("button", "danger wide", "Cancel tournament…");
    cb.type = "button";
    cb.onclick = () => openCancel(a);
    stop.append(el("h2", "", "Stop the tournament"), el("p", "muted small", "Hands stop, nobody gets prizes. Can't be undone."), cb);
    sidecol.append(stop);
  } else {
    sidecol.append(link("← All tournaments", "more", "#tournaments"));
  }
  grid.append(pc, sidecol);
  out.push(grid);
  box.replaceChildren(...out);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tickClock, 1000);
}
function tickClock() {
  const c = $("mttclock");
  if (!c || !c.dataset.run) return;
  const left = Math.max(0, Number(c.dataset.left) - (Date.now() - Number(c.dataset.at)) / 1000);
  c.textContent = mmss(left);
}
function ordinal(n) {
  if (!n) return "?";
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return n + s;
}
function openCancel(a) {
  const dlg = $("canceldlg");
  $("canceltext").textContent = a.status === "registration"
    ? `${a.entrants} players are registered. Registration closes and nobody plays. Can't be undone.`
    : `${a.left} players are still in. Hands stop, nobody gets prizes or the trophy. Can't be undone.`;
  dlg.hidden = false;
  $("cancelno").focus();
  $("cancelno").onclick = () => { dlg.hidden = true; };
  $("cancelyes").onclick = async () => { dlg.hidden = true; try { await act({ action: "cancel", id: a.id }, "Tournament cancelled."); } catch (e) {} };
}
