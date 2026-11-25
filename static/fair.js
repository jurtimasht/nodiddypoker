// NoDiddyPoker — честная перемешка в браузере: придумать свой секрет и проверить раздачу.
// Как это устроено — в README (Provably fair shuffle). Сервер — fair.py, отдельная проверка — verify_hand.py.
// Фраза игрока и случайные байты из браузера не уходят: на сервер идёт только секрет, сделанный из них.
const Fair = (() => {
  const KEY = "poker-fair";             // что этот браузер видел сам: последние 100 перемешек
  const KEY_PHRASE = "poker-phrase";
  const KEEP = 100;
  const CARDS = [..."23456789TJQKA"].flatMap((r) => [..."shdc"].map((s) => r + s));
  const ok = () => Boolean(globalThis.crypto && crypto.subtle);     // по обычному http (не localhost) его нет

  // ---------- хеши ----------
  const enc = new TextEncoder();
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (s) => Uint8Array.from(String(s).match(/../g) || [], (x) => parseInt(x, 16));
  const be32 = (n) => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);
  const join = (list) => {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  };
  const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // Перед каждой частью — её длина (как в fair.py)
  const H = (...parts) => sha(join(parts.flatMap((p) => {
    const b = p instanceof Uint8Array ? p : enc.encode(String(p));
    return [be32(b.length), b];
  })));
  async function hmac(key, data) {                       // ключ всегда 32 байта
    const pad = (x) => Uint8Array.from({ length: 64 }, (_, i) => (i < key.length ? key[i] : 0) ^ x);
    return sha(join([pad(0x5c), await sha(join([pad(0x36), data]))]));
  }

  // Общее число всех секретов -> [какая колода играет, порядок карт]
  async function permute(combined) {
    let buffer = [], counter = 0;
    const below = async (n) => {
      const limit = 2 ** 32 - (2 ** 32 % n);             // «хвост», который не делится поровну, отбрасываем
      for (;;) {
        if (!buffer.length) {
          const view = new DataView((await H("ndp/stream", combined, be32(counter++))).buffer);
          buffer = [0, 4, 8, 12, 16, 20, 24, 28].map((i) => view.getUint32(i));
        }
        const x = buffer.shift();
        if (x < limit) return x % n;
      }
    };
    const deck = await below(4);
    const order = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = await below(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return [deck, order];
  }
  const combine = (p) => H("ndp/combine", unhex(p.id), p.table, p.hand, unhex(p.root),
    ...p.seeds.flatMap((s) => [s.seat, unhex(s.seed)]));
  const seedHash = async (id, root, seat, seed) => hex(await H("ndp/seed", unhex(id), unhex(root), seat, seed));
  const makeSeed = (phrase, nonce) => H("ndp/phrase", phrase, nonce);

  // Какая карта где лежит в колоде: по правилам, а не со слов сервера
  function positions(seen) {
    const out = new Map();
    for (const [seat, cards] of Object.entries(seen.hole)) {
      cards.forEach((c, k) => { if (c !== "back") out.set(Number(seat) * seen.hole_count + k, c); });
    }
    let pos = seen.seats * seen.hole_count;
    const boards = seen.double_board ? [seen.board, seen.board2] : [seen.board];
    for (const [start, count] of [[0, 3], [3, 1], [4, 1]]) {
      pos += 1;                                          // сожжённая карта
      for (const b of boards) {
        for (let k = 0; k < count; k++) if (start + k < b.length) out.set(pos + k, b[start + k]);
        pos += count;
      }
    }
    return out;
  }

  // ---------- проверка раздачи ----------
  // Возвращает [{key, ok: true | false | null, n}]: null — проверить нельзя (например, этого не видел)
  async function verify(p, rec) {
    const out = [];
    const add = (key, good, n = null) => out.push({ key, ok: good, n });
    if (!p || p.v !== 1 || !Array.isArray(p.seeds) || p.decks.length !== 4) return [{ key: "format", ok: false, n: null }];
    const bySeat = Object.fromEntries(p.seeds.map((s) => [s.seat, s]));

    // 1. Колоды были запечатаны до того, как кто-то раскрыл секрет: этот браузер видел печать сам
    if (!rec) add("lock", null);
    else {
      const listed = !rec.hashes || (Object.keys(rec.hashes).length === p.seeds.length
        && p.seeds.every((s) => rec.hashes[s.seat] && rec.hashes[s.seat].hash === s.hash && rec.hashes[s.seat].by === s.by));
      add("lock", rec.root === p.root && listed);
    }
    // 2. Мой секрет (моя фраза) — внутри
    const mine = rec && rec.used;
    if (!mine) add("mine", null);
    else {
      const s = bySeat[mine.seat];
      const seed = hex(await makeSeed(mine.phrase, unhex(mine.nonce)));
      add("mine", Boolean(s) && s.by === "player" && s.seed === seed);
    }
    // 3. Каждый секрет подходит к своему отпечатку
    let seeds = p.seeds.every((s, i) => !i || p.seeds[i - 1].seat < s.seat);
    for (const s of p.seeds) seeds = seeds && (await seedHash(p.id, p.root, s.seat, unhex(s.seed))) === s.hash;
    add("seeds", seeds);
    const people = p.seeds.filter((s) => s.by === "player").length;
    add("people", people ? true : null, people);
    // 4. Из секретов вышла именно эта колода и этот порядок
    const combined = await combine(p);
    const [played, order] = await permute(combined);
    add("pick", played === p.deck && hex(combined).slice(0, 8) === p.fp);
    // 5. Три лишние колоды — настоящие, и все четыре сходятся с печатью
    let genuine = true;
    const deckHashes = [];
    for (let i = 0; i < 4; i++) {
      const d = p.decks[i];
      let commits;
      if (i === played) {
        genuine = genuine && Array.isArray(d.commits) && d.commits.length === 52 && !d.key;
        commits = (d.commits || []).map(unhex);
      } else {
        genuine = genuine && Array.isArray(d.cards) && [...d.cards].sort().join() === [...CARDS].sort().join();
        commits = await Promise.all((d.cards || []).map(async (c, k) => H("ndp/card", await hmac(unhex(d.key || ""), be32(k)), c)));
      }
      deckHashes.push(await H("ndp/deck", join(commits)));
    }
    add("decks", genuine && hex(await H("ndp/root", unhex(p.id), ...deckHashes)) === p.root);
    // 6. Каждая карта, которую я видел, лежала именно на своём месте
    const want = positions(p.seen), commits = p.decks[played].commits || [];
    const opened = new Map(p.open.map((o) => [o.pos, o]));
    let cards = opened.size === want.size && p.open.length === want.size && new Set(want.values()).size === want.size;
    for (const [pos, card] of want) {
      const o = opened.get(pos);
      cards = cards && Boolean(o) && o.card === card && hex(await H("ndp/card", unhex(o.salt), card)) === commits[order[pos]];
    }
    add("cards", cards, want.size);
    add("retries", p.aborted && p.aborted.length ? null : true, (p.aborted || []).length);
    return out;
  }

  // ---------- память браузера ----------
  function memory() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  const record = (id) => memory().find((r) => r.id === id) || null;
  function change(id, edit) {                            // прочитать — поменять — записать разом: вкладок может быть несколько
    const list = memory();
    let rec = list.find((r) => r.id === id);
    if (!rec) { rec = { id, mine: [] }; list.push(rec); }
    edit(rec);
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP))); } catch (e) {}
    return rec;
  }
  function phrase(value) {
    try {
      if (value === undefined) return localStorage.getItem(KEY_PHRASE) || "";
      localStorage.setItem(KEY_PHRASE, value);
    } catch (e) {}
    return value || "";
  }

  // ---------- участие в перемешке ----------
  // ctx: {seat — моё место или null, send(data), warn(text)}
  async function onNote(msg, ctx) {
    if (!ok()) return;
    const { id, root } = msg;
    const known = record(id);
    if (msg.phase === "aborted") {
      ctx.warn(msg.reason);
      if (known && known.revealed != null && msg.seats.includes(known.revealed)) ctx.warn("The server says your seed did not arrive, but this browser sent it.");
      return;
    }
    if (known && known.root !== root) { ctx.warn("Warning: the locked deck was changed. Your seed was not sent."); return; }
    if (msg.phase === "commit") {
      if (known && known.mine.length) return;
      change(id, (r) => { r.root = root; r.hand = msg.hand; });
      if (ctx.seat == null) return;
      const text = phrase(), nonce = crypto.getRandomValues(new Uint8Array(32));
      const seed = await makeSeed(text, nonce);
      const hash = await seedHash(id, root, ctx.seat, seed);
      change(id, (r) => r.mine.push({ seat: ctx.seat, phrase: text, nonce: hex(nonce), seed: hex(seed), hash }));
      ctx.send({ type: "seed_commit", id, value: hash });
    } else if (msg.phase === "reveal") {
      // Список отпечатков запоминаем один раз: подменить его потом нельзя
      if (known && known.hashes && JSON.stringify(known.hashes) !== JSON.stringify(msg.hashes)) {
        ctx.warn("Warning: the list of seeds was changed. Your seed was not sent.");
        return;
      }
      const rec = change(id, (r) => { r.root = root; r.hand = msg.hand; r.hashes = msg.hashes; });
      const mine = rec.mine.find((m) => msg.hashes[m.seat] && msg.hashes[m.seat].hash === m.hash && msg.hashes[m.seat].by === "player");
      if (!mine || mine.seat !== ctx.seat) return;       // не успел или ответила другая вкладка
      change(id, (r) => { r.used = mine; r.revealed = mine.seat; });
      ctx.send({ type: "seed_reveal", id, value: mine.seed });
    }
  }

  return { ok, hex, unhex, H, hmac, permute, combine, seedHash, makeSeed, positions, verify, record, phrase, onNote };
})();
if (typeof module !== "undefined") module.exports = Fair;       // для проверки в Node (test_fair.py)
