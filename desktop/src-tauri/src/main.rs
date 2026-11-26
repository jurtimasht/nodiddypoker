// NoDiddyPoker для компьютера: живой сайт https://alexandertarakanov.app/poker/ в своём окне.
// - Сначала открывается маленькая страница из программы (dist/): проверяет связь и переходит на сайт.
// - В окне можно ходить только по alexandertarakanov.app/poker/…; ссылки на другие сайты открываются
//   в обычном браузере (через плагин opener, его вызывает только этот код — сайту он не доступен).
// - Сайту из окна разрешено одно: включить/выключить полный экран (F11). Ни файлов, ни системы.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const SITE_HOST: &str = "alexandertarakanov.app";

// Скрипт на каждой странице окна: F11 (на Mac ещё Ctrl+Cmd+F) — полный экран;
// ссылки «в новой вкладке» и window.open — в этом же окне (чужие сайты уйдут в браузер, см. on_navigation).
const INIT: &str = r#"
(function () {
  if (window.__ndpDesktop) return;
  window.__ndpDesktop = true;
  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    return t && t.invoke ? t.invoke(cmd, args) : Promise.reject("no ipc");
  }
  document.addEventListener("keydown", function (e) {
    var mac = e.metaKey && e.ctrlKey && (e.key === "f" || e.key === "F");
    if (e.key !== "F11" && !mac) return;
    e.preventDefault();
    invoke("plugin:window|is_fullscreen", { label: "main" })
      .then(function (on) { return invoke("plugin:window|set_fullscreen", { label: "main", value: !on }); })
      .catch(function () {});
  }, true);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[target]") : null;
    if (!a || !a.href || a.target === "_self") return;
    e.preventDefault();
    location.href = a.href;
  }, true);
  window.open = function (u) {
    if (u) location.href = new URL(u, location.href).href;
    return null;
  };
})();
"#;

/// Куда окну можно перейти: своя стартовая страница и покер на сайте (плюс служебные страницы Cloudflare).
fn allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true, // стартовая страница на Windows
        "https" => {
            url.host_str() == Some(SITE_HOST)
                && (url.path().starts_with("/poker") || url.path().starts_with("/cdn-cgi/"))
        }
        _ => false,
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("NoDiddyPoker")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 520.0)
                .resizable(true)
                .maximizable(true)
                .center()
                .initialization_script(INIT)
                .on_navigation(move |url| {
                    if allowed(url) {
                        return true;
                    }
                    // чужой сайт (или почта) — в обычном браузере, окно остаётся на покере
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NoDiddyPoker could not start");
}
