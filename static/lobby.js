// NoDiddyPoker — лобби: ник, фото профиля, стол, таблица лидеров.
// Профиль узнаётся по ключу, который хранится в этом браузере (localStorage) и отправляется в заголовке X-Profile.

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
  if (res.redirected || res.status === 401) { location.reload(); throw new Error("Please log in again"); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Error " + res.status);
  return json;
}

function message(text) { $("msg").textContent = text || ""; }

async function refresh() {
  try {
    data = await api("GET", "api/lobby");
    render();
  } catch (e) { message(e.message); }
}

function render() {
  const me = data.me;

  // Профиль
  $("newform").hidden = Boolean(me);
  $("mine").hidden = !me;
  if (!me && !$("newname").value) $("newname").value = load("poker-name");   // ник со старой версии стола
  if (me) {
    const photo = $("photo");
    photo.style.backgroundColor = `hsl(${hue(me.name)} 45% 38%)`;
    photo.style.backgroundImage = me.avatar ? `url("${me.avatar}")` : "none";
    photo.style.backgroundSize = "cover";
    photo.style.backgroundPosition = "center";
    $("letter").textContent = me.avatar ? "" : [...me.name][0].toUpperCase();
    $("myname").textContent = me.name;
    $("delphoto").hidden = !me.avatar;
  }

  // Кэш-столы
  const mine = data.mine;                                   // за каким столом я сижу (или null)
  $("tables").replaceChildren(...data.tables.map((t) => {
    const row = el("div", "trow" + (mine === t.id ? " mine" : ""));
    const info = el("div", "tinfo");
    info.append(el("div", "tname", t.name), el("div", "tstakes", gameText(t)),
                el("div", "tbuy muted", t.buyins ? `buy-in ${t.buyins.map(fmt).join(" / ")}` : `buy-in from ${fmt(t.min_buyin)}`));
    const who = el("div", "twho");
    const faces = el("div", "faces");
    t.seated.slice(0, 7).forEach((p) => { const a = avatar(p.name, p.avatar, 28); a.title = p.name; faces.append(a); });
    who.append(faces, el("div", "tcount", `${t.seated.length}/${t.seats} seated`));
    const full = t.seated.length >= t.seats;
    const go = el("a", "go", mine === t.id ? "Back →" : full ? "Full" : "Join");
    go.href = `table?t=${encodeURIComponent(t.id)}`;
    const blocked = !me || (mine && mine !== t.id) || (full && mine !== t.id);
    go.classList.toggle("off", blocked);
    go.onclick = (event) => {
      if (!me) { event.preventDefault(); toast("Pick a nickname first."); $("newname").focus(); }
      else if (mine && mine !== t.id) { event.preventDefault(); toast("You are seated at another table — leave it first."); }
      else if (full && mine !== t.id) { event.preventDefault(); toast("This table is full."); }
    };
    row.append(info, who, go);
    return row;
  }));
  const mineTable = data.tables.find((t) => t.id === mine);
  $("seatednote").hidden = !mineTable;
  if (mineTable) $("seatednote").textContent = `You are seated at ${mineTable.name} — hands are being dealt. Get back before your turn or you will start sitting out.`;
  $("gohint").textContent = me ? "You choose your buy-in when you sit down. One table at a time." : "Pick a nickname first.";

  // Кто онлайн: играет / отошёл / смотрит стол / в лобби
  const online = data.online || [];
  $("onlinecount").textContent = online.length;
  if (!online.length) {
    $("people").replaceChildren(el("li", "muted small", "Nobody is online right now."));
  } else {
    const label = { playing: (w) => `playing · ${w}`, away: (w) => `sitting out · ${w}`, watching: (w) => `watching · ${w}`, lobby: () => "in the lobby" };
    $("people").replaceChildren(...online.map((p) => {
      const li = el("li", "person st-" + p.state + (me && p.id === me.id ? " me" : ""));   // st-… — чтобы не совпасть с другими стилями
      const info = el("div", "pinfo");
      info.append(el("div", "pname", p.name + (me && p.id === me.id ? " (you)" : "")), el("div", "pwhere", label[p.state](p.where)));
      li.append(avatar(p.name, p.avatar, 28), info, el("span", "pdot"));
      return li;
    }));
  }

  // Лидеры
  $("since").textContent = "since " + new Date(data.since * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const body = $("leaders");
  if (!data.leaders.length) {
    const tr = el("tr");
    const td = el("td", "muted", "No hands played yet.");
    td.colSpan = 6;
    tr.append(td);
    body.replaceChildren(tr);
  } else {
    body.replaceChildren(...data.leaders.map((r, i) => {
      const tr = el("tr");
      if (me && r.id === me.id) tr.className = "me";
      const who = el("td", "player");
      who.append(avatar(r.name, r.avatar, 30), el("span", "", r.name));
      const pct = r.hands ? Math.round(100 * r.wins / r.hands) : 0;
      const profit = el("td", "profit " + (r.profit > 0 ? "up" : r.profit < 0 ? "down" : ""));
      profit.append(el("b", "", (r.profit > 0 ? "+" : r.profit < 0 ? "−" : "") + fmt(Math.abs(r.profit))),
                    el("small", "", ` ${(r.profit > 0 ? "+" : r.profit < 0 ? "−" : "")}${Number((Math.abs(r.profit) / data.bb).toFixed(1)).toLocaleString("en-US")} BB`));
      tr.append(el("td", "rank", i < 3 ? ["🥇", "🥈", "🥉"][i] : String(i + 1)), who,
                el("td", "", fmt(r.hands)), el("td", "", `${fmt(r.wins)} · ${pct}%`), el("td", "", fmt(r.best_pot)), profit);
      return tr;
    }));
  }
  $("reset").hidden = !data.owner;                               // сбросить может только хозяин
}

// Что за игра за столом: «NL Hold'em · 50/100», «PLO4 · Pot limit · 50/100», «PLO5 · Bomb pot 5 BB»
function gameText(t) {
  const name = t.game === "plo4" ? "PLO4 · pot limit" : t.game === "plo5" ? "PLO5 · pot limit" : "NL Hold'em";
  const text = t.bomb ? `${name} · bomb pot ${t.bomb / t.bb} BB` : `${name} · ${fmt(t.sb)}/${fmt(t.bb)}`;
  return t.double_board ? text + " · double board" : text;
}

// ---------- профиль ----------
$("newform").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const res = await api("POST", "api/profile", { name: $("newname").value });
    save(KEY_PROFILE, res.secret);
    message("");
    toast("Done! Now add a photo and join the table.");
    refresh();
  } catch (e) { message(e.message); }
};

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

// ---------- вкладки: Cash game / MTT (выбор запоминается на этом устройстве) ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  // Не прячем совсем, а делаем невидимой — так блок не меняет размер при переключении
  for (const [id, on] of [["pane-cash", name === "cash"], ["pane-mtt", name === "mtt"]]) {
    $(id).classList.toggle("off", !on);
    $(id).setAttribute("aria-hidden", on ? "false" : "true");
    $(id).inert = !on;
  }
  save("poker-tab", name === "cash" ? "" : name);
}
document.querySelectorAll(".tab").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
showTab(load("poker-tab") === "mtt" ? "mtt" : "cash");

// ---------- сброс статистики (только хозяин) ----------
$("reset").onclick = async () => {
  if (!confirm("Reset all-time statistics for EVERY player? Profiles and photos stay.")) return;
  try { data = await api("POST", "api/stats/reset", {}); render(); toast("Statistics reset."); } catch (e) { toast(e.message); }
};

// ---------- «я ещё на сайте» ----------
// Пока лобби открыто, сервер знает, что ты не закрыл сайт, и держит твоё место за столом.
// Закроешь сайт совсем (ни стола, ни лобби) — через 15 секунд встанешь из-за стола.
let seated = false;
function presence() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}${location.pathname.replace(/\/+$/, "")}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", lobby: true, token: load("poker-token"), profile: load(KEY_PROFILE) }));
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "presence") {
      seated = msg.seated;
      if (data && (data.mine || null) !== (msg.table || null)) refresh();   // сел или встал — обновить кнопки столов
    }
  };
  ws.onclose = () => setTimeout(presence, 3000);
}
presence();

refresh();
setInterval(refresh, 5000);          // лидеры и стол обновляются сами
