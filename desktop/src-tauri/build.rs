fn main() {
    // своя команда «attention» («мой ход»): разрешение allow-attention выдаётся окнам в capabilities
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["attention"])),
    )
    .expect("failed to run tauri-build");
}
