// NoDiddyPoker для компьютера: живой сайт https://alexandertarakanov.app/poker/ в своём окне.
// - Сначала открывается маленькая страница из программы (dist/): проверяет связь и переходит на сайт.
// - В окне можно ходить только по https://alexandertarakanov.app/poker/… (точно: схема, хост, без порта, путь).
//   Чужие http/https-ссылки открываются в обычном браузере; остальные схемы (data:, blob:, file:…) — запрещены.
// - Новые окна (window.open, «в новой вкладке», средняя кнопка мыши, формы, iframe) не создаются:
//   свой адрес открывается в этом же окне, чужой — в браузере.
// - Сайту разрешено одно: включить/выключить полный экран (F11). Ни файлов, ни shell, ни системы.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const SITE_HOST: &str = "alexandertarakanov.app";

// Скрипт на страницах окна: F11 (на Mac ещё Ctrl+Cmd+F) — полный экран.
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
})();
"#;

/// Наш сайт: ровно https://alexandertarakanov.app (без порта), путь /poker или /poker/…
fn on_site(url: &Url, poker: bool) -> bool {
    let path = url.path();
    url.scheme() == "https"
        && url.host_str() == Some(SITE_HOST)
        && url.port().is_none()
        && if poker { path == "/poker" || path.starts_with("/poker/") } else { path.starts_with("/cdn-cgi/") }
}

/// Стартовая страница программы: tauri://localhost (Mac) или http(s)://tauri.localhost (Windows).
fn start_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

/// Куда окну можно перейти: стартовая страница, покер, служебные страницы Cloudflare (проверка «вы человек»), about:blank.
fn allowed(url: &Url) -> bool {
    start_page(url) || on_site(url, true) || on_site(url, false) || url.as_str() == "about:blank"
}

/// Чужой адрес — в обычном браузере, но только http/https.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn main() {
    tauri::Builder::default()
        // ссылки открывает только наш код ниже; свой скрипт плагина на страницы не вставляем
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            let nav_app = app.handle().clone();
            let win_app = app.handle().clone();
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
                    open_outside(&nav_app, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    // новое окно не создаём: свой адрес — в главном окне, чужой — в браузере
                    if on_site(&url, true) {
                        if let Some(main) = win_app.get_webview_window("main") {
                            let _ = main.navigate(url);
                        }
                    } else {
                        open_outside(&win_app, &url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NoDiddyPoker could not start");
}
