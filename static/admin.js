// NoDiddyPoker — страница владельца (Admin): турниры, игроки, новости, код приглашения, обновление сайта.
// Открывается только владельцу (сервер остальным отвечает «не найдено»). Данные — /api/admin/state.

const $ = (id) => document.getElementById(id);
const KEY_PROFILE = "poker-profile";
function load(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
function save(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) {} }


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


let data = { admin: null, news: [], update: null, me: null };

const dayName = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : day.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
};
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

function renderNewsAdmin() {
  const news = data.news || [];
  $("newsadmin").replaceChildren(...news.map((n) => {
    const li = newsItem(n);
    const tools = el("div", "ntools");
    const pin = el("button", "mini", n.pinned ? "Unpin" : "Pin");
    pin.type = "button";
    pin.onclick = () => newsAction({ action: "pin", id: n.id, pin: !n.pinned });
    const del = el("button", "mini danger", "Delete");
    del.type = "button";
    del.onclick = () => { if (confirm(T("Delete this news item?"))) newsAction({ action: "delete", id: n.id }); };
    tools.append(pin, del);
    li.append(tools);
    return li;
  }));
}
async function newsAction(body) {
  try { data.news = (await api("POST", "api/news", body)).news; renderNewsAdmin(); return true; }
  catch (e) { toast(e.message); return false; }
}
$("newsform").onsubmit = async (event) => {
  event.preventDefault();
  if (await newsAction({ action: "post", text: $("newstext").value, pin: $("newspin").checked })) {
    $("newstext").value = "";
    $("newspin").checked = false;
    toast("Posted — everyone sees it on Home.");
  }
};


// ---------- инструменты хозяина ----------
let inviteTyping = false;
$("invitecode").oninput = () => { inviteTyping = true; };
function renderAdmin() {
  const a = data.admin;
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
      if (!confirm(T(`Reset the password of ${p.name}? They get a new temporary password and are logged out everywhere.`))) return;
      try {
        const res = await api("POST", "api/admin", { action: "reset_password", id: p.id });
        data.admin = res.admin;
        prompt(T(`New password for ${res.name} — send it to them. They can change it in their profile.`), res.password);
        renderAdmin();
      } catch (e) { toast(e.message); }
    };
    const del = el("button", "mini danger", "Delete");
    del.onclick = async () => {
      if (!confirm(T(`Delete the account ${p.name}? Their stats and photo are deleted too. This can't be undone.`))) return;
      try { data.admin = (await api("POST", "api/admin", { action: "delete", id: p.id })).admin; toast(`${p.name} deleted.`); renderAdmin(); }
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
        if (!confirm(T("Install the new version? The site restarts when nobody is sitting at a table (tables are cleared)."))) return;
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


// ---------- сброс статистики (только хозяин) ----------
$("reset").onclick = async () => {
  if (!confirm(T("Reset all-time statistics for EVERY player? Profiles and photos stay."))) return;
  try { await api("POST", "api/stats/reset", {}); toast("Statistics reset."); } catch (e) { toast(e.message); }
};


// ---------- разделы: Tournaments / Players / News / Invite code / Site (адрес #players и т.д.) ----------
const SECTIONS = ["tournaments", "players", "news", "invite", "site"];
function currentSection() {
  const s = location.hash.replace("#", "");
  return SECTIONS.includes(s) ? s : "tournaments";
}
function showSection() {
  const cur = currentSection();
  for (const s of SECTIONS) $("sec-" + s).hidden = s !== cur;
  document.querySelectorAll(".atabs a").forEach((a) => {
    const on = a.dataset.sec === cur;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}
window.addEventListener("hashchange", () => { showSection(); window.scrollTo(0, 0); });

// ---------- турниры: список (создание и пульт — следующий шаг) ----------
const ST_LABEL = { draft: "Draft", registration: "Registration", running: "Running", paused: "Paused", finished: "Finished", cancelled: "Cancelled" };
function renderTournaments() {
  const list = data.mtt ? data.mtt.list : [];
  const live = list.filter((t) => ["running", "paused"].includes(t.status)).length;
  $("livecount").hidden = !live;
  $("livecount").textContent = `${live} live`;
  const groups = [["Now", ["running", "paused"]], ["Coming up", ["registration"]], ["Drafts", ["draft"]], ["Finished", ["finished", "cancelled"]]];
  const out = [];
  for (const [title, statuses] of groups) {
    const rows = list.filter((t) => statuses.includes(t.status));
    if (!rows.length) continue;
    out.push(el("h3", "agroup", title));
    for (const t of rows) {
      const row = el("div", "trow mrow st-" + t.status);
      const st = el("span", "st st-" + t.status, ST_LABEL[t.status] || t.status);
      const info = el("div", "tinfo");
      const name = el("div", "tname", "");
      const said = el("span", "", t.name);
      said.dataset.notr = "";
      name.append(said);
      const c = t.config || {};
      info.append(name, el("div", "tmeta", `${c.game === "plo4" ? "Omaha" : "Hold'em"} · ${fmt(c.stack || 0)} chips · ${Math.round((c.level_seconds || 0) / 60)}-min levels` + (t.test ? " · test" : "")));
      row.append(st, info);
      out.push(row);
    }
  }
  if (!out.length) out.push(el("p", "muted", "No tournaments yet."));
  $("mttlist").replaceChildren(...out);
}

async function refresh() {
  try {
    const [state, mtt] = await Promise.all([api("GET", "api/admin/state"), api("GET", "api/mtt/admin")]);
    data = { ...data, ...state, mtt };
    render();
  } catch (e) { toast(e.message); }
}
function render() {
  renderAdmin();
  renderNewsAdmin();
  renderUpdate();
  renderTournaments();
}

showSection();
refresh();
setInterval(refresh, 5000);
