// NoDiddyPoker — окно «статистика игрока» у стола (макет дизайнера v4; вкладку «Карьера» Саша убрал).
// Клик по игроку — его цифры (только того вида игры, что за этим столом: кэш или турнир) и твоя личная заметка о нём.
// Клик по себе — свои цифры (без заметки). У бота статистики нет. Сервер отдаёт только числа «действие / возможность»
// (api/player/<pid>/stats), раздач и карт здесь нет. Заметки видит только автор (api/notes).
(() => {
  const COLORS = ["", "#e0283a", "#ffb02e", "#3ee08a", "#2f8bff", "#c64bff"];
  const NOTE_MAX = 250;
  const PERIODS = [["all", "All time"], ["30d", "30 days"], ["7d", "7 days"], ["today", "Today"]];
  // цифра: ключ, подпись на плитке (покерный термин — не переводим), подсказка
  const STATS = [
    ["vpip", "VPIP", "Plays a hand: how often they put chips in before the flop (a free big blind doesn't count)"],
    ["pfr", "PFR", "Raises first: how often they raise before the flop"],
    ["tb", "3-BET", "Re-raises: how often they re-raise someone's raise before the flop"],
    ["f3b", "Fold 3B", "Gives up: how often they fold when someone re-raises them"],
    ["cb", "C-BET", "Keeps betting: raised before the flop and bets again on the flop"],
    ["fcb", "Fold CB", "Folds to it: folds on the flop when the raiser bets again"],
    ["st", "Steal", "Steals blinds: raises from the last seats when everyone folded to them"],
    ["cr", "Check-R", "Traps: checks, then raises when someone bets"],
  ];
  const FEW = 100, NONE = 20;          // меньше 100 раздач — цифры примерные (серые), меньше 20 — вместо цифр «—»

  let notes = {};                      // pid -> {color, text} — мои заметки
  let open = null;                     // {pid, seat, node, wasTurn}
  let period = "all";
  try { period = localStorage.getItem("poker-stats-period") || "all"; } catch (e) { /* без хранилища — «всё время» */ }
  if (!PERIODS.some(([k]) => k === period)) period = "all";

  window.noteColor = (pid) => (pid != null && notes[pid] ? notes[pid].color : "");

  async function api(method, path, body) {
    const r = await fetch(path, {
      method, cache: "no-store",
      headers: { "X-Profile": load(KEY_PROFILE) || "", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Something went wrong.");
    return j;
  }
  async function loadNotes() {
    if (!load(KEY_PROFILE)) return;
    try {
      notes = (await api("GET", "api/notes")).notes || {};
      if (state) render();                           // точки на местах
    } catch (e) { /* без заметок — просто без точек */ }
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const since = (t) => (t ? new Date(t * 1000).toLocaleDateString(window.i18n && i18n.lang === "ru" ? "ru-RU" : "en-GB",
    { day: "numeric", month: "short" }) : "");             // дата сразу на языке сайта (её i18n не переводит)

  function close() {
    document.querySelectorAll(".pstat, .ps-back").forEach((x) => x.remove());
    open = null;
  }
  window.closeStats = close;

  // Открыть окно для игрока на месте seat (node — его место на столе)
  window.openStats = async (seat, node) => {
    const p = state && state.seats[seat];
    if (!p || p.pid == null) return;                 // бот — статистики нет
    if (open && open.seat === seat) { close(); return; }   // второй клик — закрыть
    closeThrowbox();
    const self = Boolean(state.you && state.you.seat === seat);
    const kind = state.mtt ? "mtt" : "cash";
    open = { pid: p.pid, seat, node, self, kind, wasTurn: Boolean(state.you && state.you.options) };
    const ticket = open;
    let data;
    try {
      data = await api("GET", `api/player/${p.pid}/stats?kind=${kind}&period=${period}`);
    } catch (e) { if (open === ticket) close(); toast(e.message); return; }
    if (open !== ticket) return;                     // пока ждали — закрыли или открыли другого
    draw(data);
  };

  function draw(d) {
    document.querySelectorAll(".pstat, .ps-back").forEach((x) => x.remove());
    const self = open.self;
    const note = notes[d.id] || { color: "", text: "" };
    let color = note.color;
    const box = el("div", "pstat" + (self ? " self" : ""));
    box.style.setProperty("--tagc", color || "#2b2242");

    // шапка: фото, ник, точка заметки, плашка «турнир / кэш»
    const head = el("div", "ps-head");
    const ava = el("div", "ps-ava", d.avatar ? "" : [...d.name][0].toUpperCase());
    if (d.avatar) { ava.style.backgroundImage = `url("${d.avatar}")`; ava.classList.add("photo"); }
    else ava.style.background = `hsl(${hue(d.name)} 45% 38%)`;
    const who = el("div", "ps-who");
    const name = el("div", "ps-name");
    const nm = el("span", "", d.name);
    nm.dataset.notr = "";
    name.append(nm);
    if (self) name.append(el("span", "ps-you", "· You"));
    else if (color) name.append(el("span", "dot"));
    const sub = el("div", "ps-sub");
    sub.append(el("span", "ps-chip ctx " + d.kind, d.kind === "mtt" ? "🏆 Tournament stats" : "💵 Cash stats"));
    who.append(name, sub);
    const x = el("button", "ps-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.onclick = close;
    head.append(ava, who, x);

    const body = el("div", "ps-body");
    // «N hands · since 27 Nov» и период справа
    const row = el("div", "ps-row");
    const sample = el("span", "ps-sample");
    if (d.hands) {
      sample.append(el("b", "", fmt(d.hands)), " hands");
      if (d.since) sample.append(el("span", "ps-since", ` · since ${since(d.since)}`));
    } else sample.append("No hands yet");
    const per = el("button", "ps-period", (PERIODS.find(([k]) => k === period) || PERIODS[0])[1] + " ▾");
    per.type = "button";
    per.title = "Change the period";
    per.onclick = () => {                            // по кругу: всё время → 30 дней → 7 дней → сегодня
      const i = PERIODS.findIndex(([k]) => k === period);
      period = PERIODS[(i + 1) % PERIODS.length][0];
      try { localStorage.setItem("poker-stats-period", period); } catch (e) { /* ничего */ }
      const keep = open;
      api("GET", `api/player/${keep.pid}/stats?kind=${keep.kind}&period=${period}`)
        .then((nd) => { if (open === keep) draw(nd); })
        .catch((e) => toast(e.message));
    };
    row.append(sample, per);
    body.append(row);
    const few = d.hands < FEW;
    if (few && d.hands) body.append(el("div", "ps-warn", `⚠ Only ${d.hands} hands — numbers are rough until ~100.`));

    const grid = el("div", "ps-grid");
    for (const [key, label, hint] of STATS) {
      const [a, b] = d.stats[key] || [0, 0];
      const v = d.hands < NONE ? null : pct(a, b);
      const tile = el("div", "ps-st" + (few ? " dim" : ""));
      tile.title = hint + (b ? ` (${a} / ${b})` : "");
      const val = el("b", "", v == null ? "—" : `${v}%`);
      val.dataset.notr = "";
      const lab = el("span", "", label);
      lab.dataset.notr = "";
      tile.append(val, lab);
      grid.append(tile);
    }
    body.append(grid);

    // вскрытия: доходит / выигрывает
    const sd = el("div", "ps-sd");
    for (const [key, text, c] of [["wtsd", "Goes to showdown", "#9d6bff"], ["wsd", "Wins at showdown", "#3ee08a"]]) {
      const [a, b] = d.stats[key] || [0, 0];
      const v = d.hands < NONE ? null : pct(a, b);
      const line = el("div", "ps-sdrow");
      const bar = el("i");
      bar.style.setProperty("--v", `${v || 0}%`);
      bar.style.setProperty("--c", c);
      const num = el("b", "", v == null ? "—" : `${v}%`);
      num.dataset.notr = "";
      line.title = b ? `${a} / ${b}` : "";
      line.append(el("span", "", text), bar, num);
      sd.append(line);
    }
    body.append(sd);

    // моя заметка о нём (о себе заметок нет)
    if (!self) {
      const wrap = el("div", "ps-note");
      const lbl = el("div", "lbl");
      lbl.append(el("span", "", "Your note"), el("span", "lock", "🔒 only you see it"));
      const ta = el("textarea");
      ta.maxLength = NOTE_MAX;
      ta.placeholder = "e.g. bluffs a lot on the river";
      ta.value = note.text;
      const count = el("span", "ps-count", `${ta.value.length}/${NOTE_MAX}`);
      ta.oninput = () => { count.textContent = `${ta.value.length}/${NOTE_MAX}`; };
      const tags = el("div", "ps-noterow");
      const paint = () => tags.querySelectorAll(".ps-tag").forEach((b) => b.classList.toggle("on", b.dataset.c === color));
      for (const c of COLORS) {
        const b = el("button", "ps-tag" + (c ? "" : " none"));
        b.type = "button";
        b.dataset.c = c;
        b.style.setProperty("--c", c || "#0b0812");
        b.setAttribute("aria-label", c ? "Color" : "No color");
        b.onclick = () => { color = c; paint(); };
        tags.append(b);
      }
      const save = el("button", "ps-save", "Save");
      save.type = "button";
      save.onclick = async () => {
        save.disabled = true;
        try {
          notes = (await api("POST", `api/notes/${d.id}`, { color, text: ta.value })).notes || {};
          toast("Note saved — only you see it.");
          render();                                  // точка на его месте
          if (open && open.pid === d.id) draw(d);
        } catch (e) { toast(e.message); }
        save.disabled = false;
      };
      tags.append(count, save);
      paint();
      wrap.append(lbl, ta, tags);
      body.append(wrap);
    }
    // всё содержимое — во внутреннем блоке: на компьютере его увеличивает zoom (крупнее и читаемее), а рамка окна
    // остаётся без масштаба — её положение считается обычными пикселями (и в Chromium, и в WebKit одинаково)
    const inner = el("div", "ps-in");
    inner.append(head, body);
    box.append(inner);

    if (portrait) {                                   // телефон: шторка снизу поверх затемнённого стола
      const back = el("div", "ps-back");
      back.onclick = close;
      document.body.append(back, box);
      return;
    }
    document.body.append(box);
    place(box);
  }

  // Компьютер: рядом с местом игрока, в пикселях картинки 1280×960 (как окошко бросков); снизу не на кнопки хода
  function place(box) {
    const node = open && document.querySelector(`#seats .seat[data-throw-seat="${open.seat}"]`);
    const o = pic ? document.body.getBoundingClientRect() : { left: 0, top: 0 };
    const W = pic ? 1280 : innerWidth, H = pic ? 960 : innerHeight;
    const R = (b) => ({ top: (b.top - o.top) / Z, bottom: (b.bottom - o.top) / Z, left: (b.left - o.left) / Z, right: (b.right - o.left) / Z });
    const w = box.offsetWidth, h = box.offsetHeight;
    if (!node) { box.style.left = `${(W - w) / 2}px`; box.style.top = `${Math.max(8, (H - h) / 2)}px`; return; }
    const anchor = node.querySelector(".avatar") || node.querySelector(".plate") || node;
    const r = R(anchor.getBoundingClientRect());
    const pr = R((node.querySelector(".plate") || node).getBoundingClientRect());
    if (open.self) {                                  // себя: над своим местом
      box.style.left = `${Math.max(8, Math.min(W - w - 8, (pr.left + pr.right) / 2 - w / 2))}px`;
      box.style.top = `${Math.max(84, pr.top - h - 16)}px`;
      return;
    }
    const cx = (r.left + r.right) / 2, right = cx < W / 2;
    const left = right ? Math.max(pr.right, r.right) + 12 : Math.min(pr.left, r.left) - w - 12;
    const top = Math.max(84, Math.min(H - h - 230, r.top - 30));
    box.classList.add(right ? "to-right" : "to-left");
    box.style.left = `${Math.max(8, Math.min(W - w - 8, left))}px`;
    box.style.top = `${top}px`;
    box.style.setProperty("--ay", `${Math.max(18, Math.min(h - 18, (r.top + r.bottom) / 2 - top))}px`);
  }

  // Закрыть: Esc, клик мимо окна (на компьютере), смена размера окна, начался мой ход
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) close(); });
  document.addEventListener("pointerdown", (e) => {
    if (open && !portrait && !e.target.closest(".pstat, #seats .seat.hasstats")) close();
  });
  window.addEventListener("resize", () => { if (open) close(); });
  setInterval(() => {
    const myTurn = Boolean(state && state.you && state.you.options);
    if (open && myTurn && !open.wasTurn) close();     // мой ход — окно не мешает кнопкам
    if (open) open.wasTurn = myTurn;
    const pt = $("pthrow");                          // телефон: 🍅 в углу — только когда сам сидишь за столом
    if (pt) pt.hidden = !(state && state.you);
  }, 400);

  // Телефон: кнопка 🍅 в углу включает «режим бросков» — у соперников появляются значки 🍅
  const pt = $("pthrow");
  if (pt) pt.onclick = () => {
    const on = !document.body.classList.contains("throwmode");
    document.body.classList.toggle("throwmode", on);
    pt.classList.toggle("on", on);
    pt.setAttribute("aria-pressed", on ? "true" : "false");
    if (!on) closeThrowbox();
  };

  loadNotes();
})();
