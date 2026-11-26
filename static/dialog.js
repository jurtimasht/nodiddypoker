// NoDiddyPoker — своё окно вместо стандартных окон браузера (confirm, alert, prompt) (стол, лобби, админка).
// Тексты пишем по-английски — i18n.js сам переведёт их на экране (как всё остальное).
//
//   await Dialog.ask({ text, ok: "Leave", danger: true })  → true / false   («Are you sure?» + Cancel)
//   await Dialog.tell({ title: "Error", text })            → окно с одной кнопкой OK
//   await Dialog.copy({ title, text, value })               → текст для копирования (ссылка, новый пароль)
//   Dialog.dismiss()                                         → закрыть открытое окно как «Cancel» (ход уже ушёл и т.п.)
//
// Esc и клик по фону — Cancel, Enter — главная кнопка. Фокус не уходит из окна, после закрытия возвращается назад.
(() => {
  let current = null;            // { resolve, back, prevFocus }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function close(result) {
    if (!current) return;
    const { resolve, back, prevFocus, onKey } = current;
    current = null;
    document.removeEventListener("keydown", onKey, true);
    back.classList.add("out");
    setTimeout(() => back.remove(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
    if (prevFocus && document.contains(prevFocus) && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    resolve(result);
  }

  function open({ title, text, ok = "OK", cancel = null, danger = false, value = null, copyLabel = "Copy text" }) {
    if (current) close(false);                     // новое окно поверх — прошлое считаем «Cancel»
    return new Promise((resolve) => {
      const back = el("div", "ndp-dlg-back");
      const box = el("div", "ndp-dlg" + (danger ? " danger" : ""));
      box.setAttribute("role", cancel ? "alertdialog" : "dialog");
      box.setAttribute("aria-modal", "true");
      const id = "ndpdlg" + Math.random().toString(36).slice(2, 8);
      const h = el("h2", "ndp-dlg-title", title);
      h.id = id + "t";
      const p = el("p", "ndp-dlg-text", text || "");
      p.id = id + "d";
      box.setAttribute("aria-labelledby", h.id);
      box.setAttribute("aria-describedby", p.id);
      box.append(h, p);
      let field = null;
      if (value != null) {                         // то, что нужно скопировать: поле только для чтения + «Copy»
        const wrap = el("div", "ndp-dlg-copy");
        field = el("input");
        field.readOnly = true;
        field.value = value;
        field.dataset.notr = "";
        field.setAttribute("aria-label", title);
        const cp = el("button", "ndp-dlg-btn", copyLabel);
        cp.type = "button";
        cp.onclick = async () => {
          field.select();
          try { await navigator.clipboard.writeText(value); cp.textContent = "Copied ✓"; }
          catch (e) { try { document.execCommand("copy"); cp.textContent = "Copied ✓"; } catch (e2) {} }
        };
        wrap.append(field, cp);
        box.append(wrap);
      }
      const row = el("div", "ndp-dlg-row");
      let no = null;
      if (cancel) {
        no = el("button", "ndp-dlg-btn", cancel);
        no.type = "button";
        no.onclick = () => close(false);
        row.append(no);
      }
      const yes = el("button", "ndp-dlg-btn main" + (danger ? " danger" : ""), ok);
      yes.type = "button";
      yes.onclick = () => close(true);
      row.append(yes);
      box.append(row);
      back.append(box);
      back.addEventListener("mousedown", (e) => { if (e.target === back) back.dataset.down = "1"; });
      back.addEventListener("click", (e) => { if (e.target === back && back.dataset.down) close(false); back.dataset.down = ""; });
      const onKey = (e) => {
        if (!current || current.back !== back) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); return; }
        if (e.key === "Enter") {                   // на кнопке — нажимается она сама; иначе — главная кнопка
          if (document.activeElement && document.activeElement.tagName === "BUTTON" && box.contains(document.activeElement)) return;
          e.preventDefault(); e.stopPropagation(); close(true); return;
        }
        if (e.key === "Tab") {                     // фокус ходит только по кнопкам окна
          const items = [...box.querySelectorAll("button, input")];
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          const next = items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length];
          next.focus();
        }
      };
      document.addEventListener("keydown", onKey, true);
      current = { resolve, back, prevFocus: document.activeElement, onKey };
      document.body.append(back);
      (field || yes).focus({ preventScroll: true });
      if (field) field.select();
    });
  }

  window.Dialog = {
    ask: (o) => open({ title: "Are you sure?", cancel: "Cancel", ...o }),
    tell: (o) => open({ title: "Something went wrong", ...o }).then(() => undefined),
    copy: (o) => open({ ok: "Close", ...o }).then(() => undefined),
    dismiss: () => close(false),
    get open() { return Boolean(current); },
  };
})();
