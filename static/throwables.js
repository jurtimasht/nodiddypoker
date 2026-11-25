// NoDiddyPoker — предметы, которые можно кинуть в соперника: рисунки (SVG) и анимации.
// Про стол этот файл ничего не знает: table.js говорит, откуда и куда летит, а здесь — как это выглядит.
// Новый предмет: рисунок в THROW_ART, строка в THROWABLES, попадание в THROW_HIT, id — в THROWABLES в server.py,
// перевод названия — в i18n.js.

// ---------- рисунки (поле 100×100) ----------
// Перчатка: сначала тёмный контур всех частей, потом сами части — так между пальцами нет лишних линий
const GLOVE_PARTS = `
  <rect x="26" y="21" width="12.5" height="42" rx="6.2"/>
  <rect x="39" y="11" width="12.5" height="52" rx="6.2"/>
  <rect x="52" y="9" width="12.5" height="54" rx="6.2"/>
  <rect x="65" y="18" width="12.5" height="46" rx="6.2"/>
  <rect x="26" y="45" width="51.5" height="36" rx="15"/>
  <rect x="17" y="40" width="14" height="38" rx="7" transform="rotate(-42 25 74)"/>`;
const THROW_ART = {
  clap: `<svg viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="glv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9c6ff"/><stop offset=".5" stop-color="#a678ff"/><stop offset="1" stop-color="#6a35e8"/></linearGradient>
      <linearGradient id="cuf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5566"/><stop offset="1" stop-color="#b5162a"/></linearGradient>
    </defs>
    <g fill="#1b0f33" stroke="#1b0f33" stroke-width="7" stroke-linejoin="round">${GLOVE_PARTS}<rect x="31" y="77" width="42" height="15" rx="6"/></g>
    <g fill="url(#glv)">${GLOVE_PARTS}</g>
    <g stroke="#3d1d8f" stroke-width="2" stroke-linecap="round" opacity=".55"><path d="M38.7 30V48M51.7 24V48M64.7 27V48"/></g>
    <g stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".55"><path d="M31 28v10M44 18v12M57 16v12M70 25v10"/></g>
    <rect x="31" y="77" width="42" height="15" rx="6" fill="url(#cuf)"/>
    <path d="M36 82h26" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".45"/>
    <path d="M52 51c-3 5-10 8-10 13a5.2 5.2 0 0 0 8.4 4l-2 6h7.2l-2-6a5.2 5.2 0 0 0 8.4-4c0-5-7-8-10-13z" fill="#2a1650" opacity=".75"/>
  </svg>`,
  poop: `<svg viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="poo" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="#b97a3f"/><stop offset=".55" stop-color="#85501f"/><stop offset="1" stop-color="#552c10"/></linearGradient>
    </defs>
    <g fill="url(#poo)" stroke="#26120a" stroke-width="4" stroke-linejoin="round">
      <path d="M7 80c0-11 8-18 19-18h48c11 0 19 7 19 18 0 10-8 15-18 15H25C15 95 7 90 7 80z"/>
      <path d="M19 61c0-10 8-16 17-16h29c9 0 16 6 16 16 0 9-7 13-15 13H34c-8 0-15-4-15-13z"/>
      <path d="M31 45c0-8 5-12 11-14 7-2 9-7 6-17-1-4 3-7 6-4 12 8 17 17 15 26 4 2 6 5 6 9 0 8-6 11-12 11H44c-7 0-13-4-13-11z"/>
    </g>
    <g fill="none" stroke="#ffe2b8" stroke-linecap="round" opacity=".5">
      <path d="M15 77c1-5 5-8 10-9" stroke-width="4"/><path d="M27 58c1-4 4-6 8-7" stroke-width="4"/><path d="M38 43c1-3 4-5 7-6" stroke-width="3.5"/>
    </g>
    <path d="M88 84c-2 5-7 7-13 7M77 64c-2 4-6 6-11 6M70 47c-1 4-5 5-9 5" fill="none" stroke="#ff5a3c" stroke-width="2.5" stroke-linecap="round" opacity=".4"/>
    <g fill="#f5c542" stroke="#7a5410" stroke-width="1.5"><ellipse cx="60" cy="82" rx="4.5" ry="3.5" transform="rotate(-20 60 82)"/><ellipse cx="38" cy="86" rx="4" ry="3" transform="rotate(25 38 86)"/><ellipse cx="54" cy="62" rx="4" ry="3" transform="rotate(15 54 62)"/></g>
  </svg>`,
};
const FLY_ART = `<svg viewBox="0 0 20 20"><g class="wings" fill="#dfe8ff" opacity=".8"><ellipse cx="6" cy="7" rx="5" ry="2.6" transform="rotate(30 6 7)"/><ellipse cx="14" cy="7" rx="5" ry="2.6" transform="rotate(-30 14 7)"/></g><ellipse cx="10" cy="11" rx="3.4" ry="4.8" fill="#17131f" stroke="#8f86a8" stroke-width=".8"/><circle cx="8.6" cy="7.5" r="1.2" fill="#e0283a"/><circle cx="11.4" cy="7.5" r="1.2" fill="#e0283a"/></svg>`;

const THROWABLES = [
  { id: "clap", title: "Nice hand" },
  { id: "poop", title: "Shit" },
];

// ---------- мелкие помощники ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function bit(parent, cls, html = "") {            // кусочек рисунка: центр — в точке (0, 0) родителя
  const node = document.createElement("div");
  node.className = cls;
  node.innerHTML = html;                          // только наши рисунки, без текста от людей
  parent.append(node);
  return node;
}
const move = (node, frames, duration, opts = {}) => node.animate(frames, { duration, fill: "both", ...opts });

// ---------- полёт ----------
const WIND_MS = 160;            // замах: предмет появляется в руке
function throwFlight(wrap, id, from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const dist = Math.hypot(dx, dy);
  const ms = Math.max(560, Math.min(900, 420 + dist * 0.5));
  const lift = 60 + dist * 0.14;
  const point = (t) => [from[0] + dx * t, from[1] + dy * t - 4 * lift * t * (1 - t)];
  const mover = bit(wrap, "thr-mover");
  const sprite = bit(mover, "thr-sprite", THROW_ART[id]);
  const steps = Array.from({ length: 25 }, (_, i) => i / 24);

  move(sprite, [{ scale: 0 }, { scale: 1.3, offset: .6 }, { scale: 1 }], WIND_MS, { easing: "ease-out" });
  move(mover, steps.map((t) => {
    const [x, y] = point(t);
    return { transform: `translate(${x}px, ${y}px) scale(${0.7 + 0.3 * t + 1.6 * t * (1 - t)})` };
  }), ms, { delay: WIND_MS });
  // Перчатка крутится, куча кувыркается и «болтается» в воздухе
  const turn = dx < 0 ? -1 : 1;
  move(sprite, id === "clap"
    ? [{ transform: "rotate(0)" }, { transform: `rotate(${720 * turn}deg)` }]
    : steps.map((t) => ({ transform: `rotate(${360 * t * turn}deg) scale(${1 + .14 * Math.sin(t * 22)}, ${1 - .14 * Math.sin(t * 22)})` })),
  ms, { delay: WIND_MS });
  // След: искры за перчаткой, капли за кучей
  for (let i = 1; i < 12; i++) {
    const [x, y] = point(i / 12);
    const dot = bit(wrap, `thr-dot ${id}`);
    const size = rnd(.5, 1.2);
    const fall = id === "poop" ? rnd(30, 70) : rnd(-8, 14);
    move(dot, [
      { opacity: 1, transform: `translate(${x + rnd(-8, 8)}px, ${y + rnd(-8, 8)}px) scale(${size})` },
      { opacity: 0, transform: `translate(${x + rnd(-14, 14)}px, ${y + fall}px) scale(${size * .3})` },
    ], rnd(350, 600), { delay: WIND_MS + ms * i / 12, fill: "forwards", easing: id === "poop" ? "ease-in" : "ease-out" });
  }
  return { mover, sprite, to, ms: WIND_MS + ms };
}

// ---------- попадания ----------
// Осколки во все стороны, потом вниз (как будто есть вес)
function burst(hit, count, make, power, gravity, ms) {
  for (let i = 0; i < count; i++) {
    const node = make(i);
    const a = (i / count) * Math.PI * 2 + rnd(-.25, .25), v = power * rnd(.6, 1.15);
    const x = Math.cos(a) * v, y = Math.sin(a) * v - power * .25, spin = rnd(-300, 300);
    move(node, [
      { opacity: 1, transform: "translate(0, 0) scale(.4) rotate(0)", easing: "cubic-bezier(.1,.7,.4,1)" },
      { opacity: 1, transform: `translate(${x}px, ${y}px) scale(1) rotate(${spin * .6}deg)`, offset: .4, easing: "ease-in" },
      { opacity: 0, transform: `translate(${x * 1.25}px, ${y + gravity}px) scale(.7) rotate(${spin}deg)` },
    ], ms * rnd(.8, 1.15));
  }
}
function ring(hit, id) {
  move(bit(hit, `thr-ring ${id}`), [{ opacity: 1, transform: "scale(.25)" }, { opacity: 0, transform: "scale(1.4)" }], 450, { easing: "ease-out" });
}

// Клякса: каждый раз своя — плавная линия через точки на разном расстоянии от центра
function splatPath(r, spikes) {
  const n = spikes * 2, pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + rnd(-.3, .3)) / n) * Math.PI * 2, d = i % 2 ? r * rnd(.62, .85) : r * rnd(.95, 1.5);
    pts.push([Math.cos(a) * d, Math.sin(a) * d]);
  }
  const mid = (p, q) => `${((p[0] + q[0]) / 2).toFixed(1)} ${((p[1] + q[1]) / 2).toFixed(1)}`;
  let d = `M${mid(pts[n - 1], pts[0])}`;
  pts.forEach((p, i) => { d += `Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${mid(p, pts[(i + 1) % n])}`; });
  return d + "Z";
}

const SUITS = [["♠", "#c9b1ff"], ["♥", "#ff4d5f"], ["♦", "#8a7dff"], ["♣", "#ff8cc6"]];
const THROW_HIT = {
  // Перчатка долетела: к ней добавляется вторая, они хлопают четыре раза; искры, масти и надпись
  clap(hit, flight) {
    const total = 2300, beat = 260, claps = 4;
    flight.mover.remove();
    const hands = bit(hit, "thr-hands");
    for (const side of [-1, 1]) {
      const hand = bit(hands, "thr-hand", THROW_ART.clap);
      // левая рука — зеркальная, большие пальцы внутрь; ладони повёрнуты друг к другу
      const pose = (gap, tilt) => `translateX(${side * gap}px) scaleX(${side}) rotate(${tilt}deg) perspective(260px) rotateY(48deg)`;
      const frames = [{ transform: pose(40, 24), opacity: side < 0 ? 0 : 1, offset: 0 }];
      for (let i = 0; i < claps; i++) {
        const at = (beat * i + 110) / total;
        frames.push({ transform: pose(13, 2), opacity: 1, offset: at, easing: "ease-out" });
        frames.push({ transform: pose(i < claps - 1 ? 34 : 13, i < claps - 1 ? 22 : 2), opacity: 1, offset: (beat * i + 110 + beat * .55) / total, easing: "ease-in" });
      }
      frames.push({ transform: pose(13, 2), opacity: 1, offset: 1 });
      move(hand, frames, total);
    }
    for (let i = 0; i < claps; i++) {
      setTimeout(() => {
        ring(hit, "clap");
        burst(hit, 9, () => bit(hit, "thr-spark"), 52, 6, 380);
        if (i % 2 === 0) {
          burst(hit, 10, (k) => {
            const s = bit(hit, "thr-suit");
            [s.textContent, s.style.color] = SUITS[k % 4];
            return s;
          }, 88, 70, 1100);
        }
      }, beat * i + 110);
    }
    // Надпись — над руками (карты не закрывает); у верхних мест над ними нет места — тогда сбоку
    const side = flight.to[1] < 100;
    const word = bit(hit, "thr-word" + (side ? " side" : ""));
    const shift = side ? "0" : "-50%";
    word.textContent = "Nice hand!";
    move(word, [
      { opacity: 0, transform: `translate(${shift}, 0) scale(.2) rotate(-14deg)` },
      { opacity: 1, transform: `translate(${shift}, 0) scale(1.25) rotate(-5deg)`, offset: .6 },
      { opacity: 1, transform: `translate(${shift}, 0) scale(1) rotate(-5deg)` },
    ], 360, { delay: 120, easing: "ease-out" });
    move(hit, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 -26px" }], 420, { delay: total - 420, easing: "ease-in" });
    return total;
  },

  // Куча шлёпается: сплющивается, под ней расползается клякса, летят брызги, вниз текут потёки, прилетают мухи
  poop(hit, flight) {
    const total = 3000;
    const brown = ["#8a5524", "#6b3c17", "#a3672f"];
    const splat = bit(hit, "thr-splat");
    const drips = [-24, -7, 11, 27].map((x) => {
      const len = rnd(16, 36), w = rnd(6, 10);
      return `<path class="drip" pathLength="1" d="M${x + rnd(-3, 3)} 14v${(14 + len).toFixed(0)}" stroke-width="${w.toFixed(1)}"/>`;
    }).join("");
    splat.innerHTML = `<svg viewBox="-60 -60 120 120"><g class="drips">${drips}</g>
      <path d="${splatPath(38, 7)}" fill="#6b3c17" stroke="#26120a" stroke-width="3"/>
      <path d="${splatPath(24, 6)}" fill="#8a5524" opacity=".8"/>
      <path d="M-24 -14c4-8 10-11 17-12" fill="none" stroke="#ffe2b8" stroke-width="3.5" stroke-linecap="round" opacity=".4"/></svg>`;
    move(splat, [{ transform: "scale(.15)" }, { transform: "scale(1.18)", offset: .45 }, { transform: "scale(.96)", offset: .7 }, { transform: "scale(1)" }], 340, { easing: "ease-out" });
    splat.querySelectorAll(".drip").forEach((d, i) =>
      move(d, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], rnd(900, 1500), { delay: 220 + i * 110, easing: "cubic-bezier(.3,0,.5,1)" }));

    hit.append(flight.mover);                                   // куча остаётся сверху кляксы и дрожит, как желе
    flight.mover.getAnimations().forEach((a) => a.cancel());
    flight.sprite.getAnimations().forEach((a) => a.cancel());
    flight.sprite.style.transformOrigin = "50% 85%";
    move(flight.sprite, [
      { transform: "scale(1)" }, { transform: "scale(1.7, .35)", offset: .08 }, { transform: "scale(.75, 1.25)", offset: .22 },
      { transform: "scale(1.15, .72)", offset: .38 }, { transform: "scale(.86, .95)", offset: .54 },
      { transform: "scale(.98, .8)", offset: .7 }, { transform: "scale(.9, .86)" },
    ], 950, { easing: "ease-out" });
    ring(hit, "poop");
    burst(hit, 16, (i) => {
      const drop = bit(hit, "thr-drop"), size = rnd(5, 13);
      drop.style.cssText = `width:${size}px;height:${size}px;margin:${-size / 2}px;background:${brown[i % 3]}`;
      return drop;
    }, 84, 95, 900);
    // Вонь: волнистые линии поднимаются вверх
    for (let i = 0; i < 3; i++) {
      const stink = bit(hit, "thr-stink", `<svg viewBox="0 0 20 50"><path d="M10 48c-9-8 9-15 0-23s9-15 0-23"/></svg>`);
      const x = (i - 1) * 22;
      move(stink, [
        { opacity: 0, transform: `translate(${x}px, -20px) scaleY(.4)` },
        { opacity: .85, transform: `translate(${x}px, -44px) scaleY(1)`, offset: .4 },
        { opacity: 0, transform: `translate(${x + rnd(-6, 6)}px, -74px) scaleY(1.1)` },
      ], 1200, { delay: 500 + i * 190, iterations: 2 });
    }
    // Мухи кружат по наклонным овалам
    for (let i = 0; i < 2; i++) {
      const fly = bit(hit, "thr-fly", FLY_ART);
      const dir = i ? -1 : 1, start = i * 2.4;
      move(fly, Array.from({ length: 33 }, (_, k) => {
        const a = start + dir * (k / 32) * Math.PI * 5, far = k < 4 ? 1 + (4 - k) * .5 : 1;
        return { opacity: k === 0 ? 0 : 1, transform: `translate(${Math.cos(a) * 44 * far}px, ${Math.sin(a) * 15 * far - 22 + Math.sin(k * 1.7) * 5}px) scaleX(${Math.sin(a) * dir > 0 ? -1 : 1})` };
      }), total - 600, { delay: 600 });
    }
    move(hit, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 14px" }], 450, { delay: total - 450, easing: "ease-in" });
    return total;
  },
};

// Весь бросок: layer — слой поверх стола, from/to — точки в его пикселях, onHit — в момент попадания
function playThrow(layer, id, from, to, onHit) {
  if (!THROW_ART[id]) return;
  const wrap = bit(layer, "throw");
  const land = () => {
    const hit = bit(wrap, "thr-hit");
    hit.style.left = `${to[0]}px`;
    hit.style.top = `${to[1]}px`;
    return hit;
  };
  if (calm()) {                  // «меньше движения» в настройках: предмет просто появляется у цели и гаснет
    const sprite = bit(land(), "thr-sprite", THROW_ART[id]);
    move(sprite, [{ opacity: 1 }, { opacity: 1, offset: .7 }, { opacity: 0 }], 1800);
    setTimeout(() => wrap.remove(), 1800);
    return;
  }
  const flight = throwFlight(wrap, id, from, to);
  setTimeout(() => {
    const total = THROW_HIT[id](land(), flight);
    onHit();
    setTimeout(() => wrap.remove(), total);
  }, flight.ms);
}
