// NoDiddyPoker для компьютера: живой сайт https://alexandertarakanov.app/poker/ в своём окне.
// - Сначала открывается маленькая страница из программы (dist/): проверяет связь и переходит на сайт.
// - В окне можно ходить только по https://alexandertarakanov.app/poker/… (точно: схема, хост, без порта, путь).
//   Чужие http/https-ссылки открываются в обычном браузере; остальные схемы (data:, blob:, file:…) — запрещены.
// - Новые окна страница сама не создаёт. Стол (/poker/table?t=<код>) программа открывает в своём окне
//   (не больше 5, турнир — одно окно на все столы турнира); другой свой адрес — в главном окне; чужой — в браузере.
// - Сайту разрешено только: полный экран (F11) и своя команда «мой ход» (attention: мигнуть в панели задач,
//   вперёд — только если программа уже на переднем плане, не чаще раза в 2 с). Ни файлов, ни shell, ни системы.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const SITE_HOST: &str = "alexandertarakanov.app";
const MAX_TABLE_WINDOWS: usize = 5; // окон столов не больше 5 (у игрока до 4 столов + запас); защита от «бомбы окон»

// Скрипт на страницах окон. window.__ndpDesktop = 2 — сайт знает, что программа сама открывает окна столов;
// window.__ndpDesktopVersion — версия программы (сайт показывает её и предлагает обновить старую).
// F11 (на Mac ещё Ctrl+Cmd+F) — полный экран ЭТОГО окна. __ndpAttention() — «мой ход»: окно выходит вперёд и мигает в панели задач.
const INIT: &str = concat!(r#"
(function () {
  if (window.__ndpDesktop) return;
  window.__ndpDesktop = 2;
  window.__ndpDesktopVersion = ""#, env!("CARGO_PKG_VERSION"), r#"";
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
    invoke("attention", {}).catch(function () {});
  };
})();
"#);

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

/// Когда последний раз открывали чужой адрес снаружи (не чаще раза в 1,5 с — сайт не засыплет игрока вкладками).
static LAST_OUTSIDE: Mutex<Option<Instant>> = Mutex::new(None);

/// Чужой адрес — в обычном браузере, но только http/https и не чаще раза в 1,5 с.
fn open_outside(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let mut last = LAST_OUTSIDE.lock().unwrap();
    if last.map(|t| t.elapsed() < Duration::from_millis(1500)).unwrap_or(false) {
        return;
    }
    *last = Some(Instant::now());
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Когда последний раз звали «мой ход» у каждого окна (не чаще раза в 2 с на окно).
struct Attention(Mutex<HashMap<String, Instant>>);

/// «Мой ход» (зовёт сайт из окна стола). Окно мигает в панели задач; вперёд выходит, только если программа
/// и так на переднем плане (одно из её окон в фокусе) — фокус у другой программы не перехватываем.
#[tauri::command]
fn attention(window: WebviewWindow, state: tauri::State<'_, Attention>) {
    {
        let mut last = state.0.lock().unwrap();
        let label = window.label().to_string();
        if last.get(&label).map(|t| t.elapsed() < Duration::from_secs(2)).unwrap_or(false) {
            return;
        }
        last.insert(label, Instant::now());
    }
    if window.is_focused().unwrap_or(false) {
        return; // игрок и так смотрит на это окно
    }
    let ours_in_front = window.app_handle().webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
    if ours_in_front {
        let _ = window.set_focus();
    } else {
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
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
        // заголовок окна = заголовок страницы: на столе полосы сверху нет, название игры и блайнды — в заголовке
        .on_document_title_changed(|w, title| {
            let t: String = title.chars().filter(|c| !c.is_control()).take(120).collect();
            let _ = w.set_title(if t.trim().is_empty() { "NoDiddyPoker" } else { t.as_str() });
        })
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
    // окно стола: 960×720 — картинка сайта 1280×960 в масштабе 0.75; меньше 800×600 не сделать.
    // Пропорцию 4:3 держит lock_4x3. Развернуть на весь экран можно — тогда сайт рисует картинку по центру с полями.
    if let Ok(w) = window(app, &label, WebviewUrl::External(url), (960.0, 720.0), (800.0, 600.0)) {
        lock_4x3(&w);
    }
}

/// Окно стола всегда 4:3 (внутренняя часть, без рамки и заголовка) — как картинка стола на сайте, без полей.
fn lock_4x3(w: &WebviewWindow) {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = w.hwnd() {
            lock43::install(hwnd.0 as _);
        }
    }
    #[cfg(target_os = "macos")]
    {
        mac43::watch(w);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = w;
    }
}

/// Windows: пока игрок тянет край окна, система шлёт WM_SIZING с будущей рамкой окна. Мы сразу правим её до 4:3
/// по тому краю, который тянут (стандартный способ Windows: окно не дёргается). Развернуть и «прилепить» к краю экрана
/// (Snap) это не мешает — WM_SIZING там нет, сайт тогда покажет картинку по центру с полями.
#[cfg(windows)]
mod lock43 {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowRect, WMSZ_BOTTOMLEFT, WMSZ_BOTTOM, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT,
        WMSZ_TOPRIGHT, WM_NCDESTROY, WM_SIZING,
    };

    const ID: usize = 0x0434; // номер нашей «подписки» на сообщения окна

    pub fn install(hwnd: HWND) {
        unsafe {
            SetWindowSubclass(hwnd, Some(on_message), ID, 0);
        }
    }

    unsafe extern "system" fn on_message(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(on_message), ID);
        } else if msg == WM_SIZING && lp != 0 && fix(hwnd, wp as u32, &mut *(lp as *mut RECT)) {
            return 1;
        }
        DefSubclassProc(hwnd, msg, wp, lp)
    }

    /// Поправить будущую рамку окна r (в пикселях экрана) так, чтобы внутренняя часть была 4:3.
    unsafe fn fix(hwnd: HWND, edge: u32, r: &mut RECT) -> bool {
        let mut wr: RECT = std::mem::zeroed();
        let mut cr: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut wr) == 0 || GetClientRect(hwnd, &mut cr) == 0 {
            return false;
        }
        // рамка и заголовок окна (всё, что вокруг страницы)
        let fw = (wr.right - wr.left) - (cr.right - cr.left);
        let fh = (wr.bottom - wr.top) - (cr.bottom - cr.top);
        let mut cw = (r.right - r.left - fw).max(4);
        let mut ch = (r.bottom - r.top - fh).max(3);
        // тянут левый/правый край — главная ширина; верх/низ — высота; угол — то, что больше
        let by_width = match edge {
            WMSZ_LEFT | WMSZ_RIGHT => true,
            WMSZ_TOP | WMSZ_BOTTOM => false,
            _ => cw * 3 >= ch * 4,
        };
        if by_width {
            ch = (cw * 3 + 2) / 4;
        } else {
            cw = (ch * 4 + 1) / 3;
        }
        // не больше рабочей области экрана (без панели задач)
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi) != 0 {
            let maxw = (mi.rcWork.right - mi.rcWork.left) - fw;
            let maxh = (mi.rcWork.bottom - mi.rcWork.top) - fh;
            if maxw > 0 && maxh > 0 {
                if cw > maxw {
                    cw = maxw;
                    ch = cw * 3 / 4;
                }
                if ch > maxh {
                    ch = maxh;
                    cw = ch * 4 / 3;
                }
            }
        }
        let (w, h) = (cw + fw, ch + fh);
        // двигаем те края, которые тянут; остальные стоят на месте
        if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
            r.left = r.right - w;
        } else {
            r.right = r.left + w;
        }
        if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
            r.top = r.bottom - h;
        } else {
            r.bottom = r.top + h;
        }
        true
    }
}

/// Mac (запасной путь, проще WinAPI): игрок отпустил край (~250 мс без изменений) — окно подгоняется под 4:3
/// по стороне, которую тянули. Своё изменение уже 4:3 и новых поправок не вызывает. Полный экран и «развернуть» не трогаем.
#[cfg(target_os = "macos")]
mod mac43 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{PhysicalSize, WebviewWindow, WindowEvent};

    pub fn watch(w: &WebviewWindow) {
        let win = w.clone();
        let turn = Arc::new(AtomicU64::new(0));
        let last = Arc::new(Mutex::new(w.inner_size().map(|s| (s.width, s.height)).unwrap_or((960, 720))));
        w.on_window_event(move |e| {
            if !matches!(e, WindowEvent::Resized(_)) {
                return;
            }
            let n = turn.fetch_add(1, Ordering::SeqCst) + 1;
            let (win, turn, last) = (win.clone(), turn.clone(), last.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                if turn.load(Ordering::SeqCst) != n {
                    return; // игрок ещё тянет
                }
                if win.is_fullscreen().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
                    return;
                }
                let Ok(s) = win.inner_size() else { return };
                let (w, h) = (s.width as i64, s.height as i64);
                let (lw, lh) = std::mem::replace(&mut *last.lock().unwrap(), (s.width, s.height));
                if (w * 3 - h * 4).abs() <= 8 {
                    return; // уже 4:3 (±2 px)
                }
                let by_width = (w - lw as i64).abs() * 3 >= (h - lh as i64).abs() * 4;
                let (mut tw, mut th) = if by_width { (w, (w * 3 + 2) / 4) } else { ((h * 4 + 1) / 3, h) };
                if let Ok(Some(m)) = win.current_monitor() {
                    let maxh = m.size().height as i64 * 9 / 10;
                    if th > maxh {
                        th = maxh;
                        tw = th * 4 / 3;
                    }
                }
                *last.lock().unwrap() = (tw as u32, th as u32);
                let _ = win.set_size(PhysicalSize::new(tw as u32, th as u32));
            });
        });
    }
}

fn main() {
    tauri::Builder::default()
        // ссылки открывает только наш код выше; свой скрипт плагина на страницы не вставляем
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(Attention(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![attention])
        .setup(|app| {
            let w = window(app.handle(), "main", WebviewUrl::App("index.html".into()), (1440.0, 900.0), (800.0, 520.0))?;
            let _ = w.center();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NoDiddyPoker could not start");
}
