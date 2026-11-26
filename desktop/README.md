# NoDiddyPoker для компьютера (Windows и Mac)

Программа — окно с живым сайтом https://alexandertarakanov.app/poker/ (Tauri v2: на Windows WebView2, на Mac WKWebView).
Сайт обновляется сам; программу пересобирать нужно, только если меняется сама обёртка.

- `dist/` — стартовая страница: проверяет связь и открывает покер; нет связи — «Нет связи, повторить».
- `src-tauri/src/main.rs` — окно 1440×900, F11 — полный экран, переходы только по `alexandertarakanov.app/poker/`,
  остальные ссылки — в обычном браузере.
- `src-tauri/capabilities/` — сайту разрешено только включать полный экран. Ни файлов, ни shell, ни системы.

## Сборка

Только в GitHub Actions (workflow **Desktop app**), не на сервере:
- вручную: Actions → Desktop app → Run workflow (версия, например `0.1.1`);
- или тегом: `git tag desktop-v0.1.1 && git push origin desktop-v0.1.1`.

Файлы появляются в GitHub Release `desktop-v…`: `*_x64-setup.exe` (установщик), `*_x64-portable.exe` (без установки),
`*_universal.dmg` (Mac, Intel и Apple Silicon). Итог сборки (размеры, ошибки) — в ветке `desktop-status`, файл `STATUS.md`.
Иконки делаются при сборке из `static/icon512.png`. Подписи кода нет — первый запуск разрешить вручную.
В описании Release — контрольные суммы SHA-256 (и файл `SHA256SUMS.txt`).

Безопасность сборки: задача `build` (где работают npm-пакеты и crates) имеет только право чтения, выкладывает
отдельная задача `publish`. Версии зависимостей — в `package-lock.json` и `Cargo.lock` (`npm ci`, `cargo --locked`),
сторонние actions закреплены хешем коммита. Обновлять зависимости — сознательно, отдельным коммитом.
