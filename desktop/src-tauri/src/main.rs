// NoDiddyPoker для компьютера: живой сайт https://alexandertarakanov.app/poker/ в своём окне.
// - Сначала открывается маленькая страница из программы (dist/): проверяет связь и переходит на сайт.
// - В окне можно ходить только по https://alexandertarakanov.app/poker/… (точно: схема, хост, без порта, путь).
//   Чужие http/https-ссылки открываются в обычном браузере; остальные схемы (data:, blob:, file:…) — запрещены.
// - Новые окна страница сама не создаёт. Стол (/poker/table?t=<код>) программа открывает в своём окне
//   (не больше 5, турнир — одно окно на все столы турнира); другой свой адрес — в главном окне; чужой — в браузере.
// - Сайту разрешено только: полный экран (F11), вывести своё окно вперёд и мигнуть в панели задач («мой ход»).
//   Ни файлов, ни shell, ни системы.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const SITE_HOST: &str = "alexandertarakanov.app";
const MAX_TABLE_WINDOWS: usize = 5; // окон столов не больше 5 (у игрока до 4 столов + запас); защита от «бомбы окон»

// Скрипт на страницах окон. window.__ndpDesktop = 2 — сайт знает, что программа сама открывает окна столов.
// F11 (на Mac ещё Ctrl+Cmd+F) — полный экран ЭТОГО окна. __ndpAttention() — «мой ход»: окно выходит вперёд и мигает в панели задач.
const INIT: &str = r#"
(function () {
  if (window.__ndpDesktop) return;
  window.__ndpDesktop = 2;
  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    return t && t.invoke ? t.invoke(cmd, args) : Promise.reject("no ipc");
  }
  function label() {
    var t = window.__TAURI_INTERNALS__;
    return t && t.metadata && t.metadata.currentWindow ? t.metadata.currentWindow.label : "main";
  }
  document.addEventListener("keydown", function (e) {
    var mac = e.metaKey && e.ctrlKey && (e.key === "f" || e.key === "F");
    if (e.key !== "F11" && !mac) return;
    e.preventDefault();
    invoke("plugin:window|is_fullscreen", { label: label() })
      .then(function (on) { return invoke("plugin:window|set_fullscreen", { label: label(), value: !on }); })
      .catch(function () {});
  }, true);
  window.__ndpAttention = function () {
    invoke("plugin:window|set_focus", { label: label() }).catch(function () {});
    invoke("plugin:window|request_user_attention", { label: label(), value: { type: "Critical" } }).catch(function () {});
  };
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

/// Куда окну можно перейти: стартовая страница, покер, служебные страницы Cloudflare, about:blank.
fn allowed(url: &Url) -> bool {
    start_page(url) || on_site(url, true) || on_site(url, false) || url.as_str() == "about:blank"
}

/// Чужой адрес — в обычном браузере, но только http/https.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Адрес стола https://alexandertarakanov.app/poker/table?t=<код> → код (только a-z, 0-9, «-», до 40 знаков).
fn table_code(url: &Url) -> Option<String> {
    if !on_site(url, true) || url.path() != "/poker/table" {
        return None;
    }
    let code = url.query_pairs().find(|(k, _)| k == "t")?.1.into_owned();
    let ok = !code.is_empty() && code.len() <= 40 && code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then_some(code)
}

/// Метка окна стола: у всех столов турнира одна («table-mtt»: при пересадке окно само меняет адрес), у кэша — своя.
fn table_label(code: &str) -> String {
    let mtt = code.starts_with('m') && code[1..].contains('-') && code[1..].chars().all(|c| c.is_ascii_digit() || c == '-');
    if mtt { "table-mtt".to_string() } else { format!("table-{code}") }
}

/// Окно программы (главное или окно стола): одни и те же правила переходов, новых окон и скрипт.
fn window(app: &AppHandle, label: &str, url: WebviewUrl, size: (f64, f64), min: (f64, f64)) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let win_app = app.clone();
    WebviewWindowBuilder::new(app, label, url)
        .title("NoDiddyPoker")
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(true)
        .maximizable(true)
        .initialization_script(INIT)
        .on_navigation(move |url| {
            if allowed(url) {
                return true;
            }
            open_outside(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            // Страница новых окон сама не создаёт (ответ всегда Deny). Стол — окно создаёт программа;
            // другой свой адрес — в главном окне; чужой — в обычном браузере.
            if let Some(code) = table_code(&url) {
                open_table(&win_app, &code, url);
            } else if on_site(&url, true) {
                if let Some(main) = win_app.get_webview_window("main") {
                    let _ = main.navigate(url);
                    let _ = main.set_focus();
                }
            } else {
                open_outside(&win_app, &url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

/// Окно стола: уже открыто — показать (и перейти на нужный стол турнира); нет — создать (не больше MAX_TABLE_WINDOWS).
fn open_table(app: &AppHandle, code: &str, url: Url) {
    let label = table_label(code);
    if let Some(w) = app.get_webview_window(&label) {
        if w.url().map(|u| u != url).unwrap_or(true) {
            let _ = w.navigate(url);
        }
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let open = app.webview_windows().keys().filter(|l| l.starts_with("table-")).count();
    if open >= MAX_TABLE_WINDOWS {
        return;
    }
    // окно стола: 960×720 — стол сайта в масштабе 0.75 (сцена 4:3); меньше 640×480 не сделать
    let _ = window(app, &label, WebviewUrl::External(url), (960.0, 720.0), (640.0, 480.0));
}

fn main() {
    tauri::Builder::default()
        // ссылки открывает только наш код выше; свой скрипт плагина на страницы не вставляем
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            let w = window(app.handle(), "main", WebviewUrl::App("index.html".into()), (1440.0, 900.0), (800.0, 520.0))?;
            let _ = w.center();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NoDiddyPoker could not start");
}
