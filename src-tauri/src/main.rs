#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;

// OSネイティブのファイル選択ダイアログ
#[tauri::command]
fn open_audio_file() -> Result<Option<(String, String, Vec<u8>)>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose file with prompt \"音声ファイルを選択\" of type {\"wav\", \"flac\", \"mp3\", \"ogg\"})")
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Ok(None);
        }

        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path_str.is_empty() {
            return Ok(None);
        }

        let path = std::path::Path::new(&path_str);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

        Ok(Some((path_str, name, bytes)))
    }

    #[cfg(target_os = "windows")]
    {
        let script = r#"
            Add-Type -AssemblyName System.Windows.Forms
            $f = New-Object System.Windows.Forms.OpenFileDialog
            $f.Filter = "対応音声ファイル (*.wav, *.flac, *.mp3, *.ogg)|*.wav;*.flac;*.mp3;*.ogg"
            if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                $f.FileName
            }
        "#;
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .output()
            .map_err(|e| e.to_string())?;

        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path_str.is_empty() {
            return Ok(None);
        }

        let path = std::path::Path::new(&path_str);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

        Ok(Some((path_str, name, bytes)))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(None)
    }
}

// OSネイティブの上書き保存
#[tauri::command]
fn save_audio_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

// OSネイティブの名前を付けて保存
#[tauri::command]
fn save_audio_file_as(default_name: String, data: Vec<u8>) -> Result<Option<(String, String)>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "POSIX path of (choose file name with prompt \"保存先を選択\" default name \"{}\")",
            default_name
        );
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Ok(None);
        }

        let mut path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path_str.is_empty() {
            return Ok(None);
        }

        if !path_str.ends_with(".wav") && !path_str.ends_with(".flac") && !path_str.ends_with(".mp3") && !path_str.ends_with(".ogg") {
            path_str.push_str(".wav");
        }

        std::fs::write(&path_str, &data).map_err(|e| e.to_string())?;
        let path = std::path::Path::new(&path_str);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        Ok(Some((path_str, name)))
    }

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"
            Add-Type -AssemblyName System.Windows.Forms
            $f = New-Object System.Windows.Forms.SaveFileDialog
            $f.FileName = "{}"
            $f.Filter = "WAV (*.wav)|*.wav|FLAC (*.flac)|*.flac|MP3 (*.mp3)|*.mp3|OGG (*.ogg)|*.ogg"
            if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
                $f.FileName
            }}
            "#,
            default_name
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| e.to_string())?;

        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path_str.is_empty() {
            return Ok(None);
        }

        std::fs::write(&path_str, &data).map_err(|e| e.to_string())?;
        let path = std::path::Path::new(&path_str);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        Ok(Some((path_str, name)))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(None)
    }
}

// エディタ一覧を含むメニューバーの動的構築関数
fn build_full_menu(
    handle: &tauri::AppHandle,
    editor_items: &[(String, String, bool)],
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let app_menu = SubmenuBuilder::new(handle, "Spectrogram Visualizer")
        .about(Some(AboutMetadata {
            name: Some("Spectrogram Visualizer".into()),
            version: Some("0.1.0".into()),
            ..Default::default()
        }))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let mut file_menu_builder = SubmenuBuilder::new(handle, "ファイル");
    file_menu_builder = file_menu_builder
        .item(&MenuItemBuilder::with_id("menu_new", "新しい音声解析").accelerator("CmdOrCtrl+N").build(handle)?)
        .item(&MenuItemBuilder::with_id("menu_open", "ファイルを開く...").accelerator("CmdOrCtrl+O").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("menu_save", "保存 (上書き)").accelerator("CmdOrCtrl+S").build(handle)?)
        .item(&MenuItemBuilder::with_id("menu_save_as", "名前を付けて保存...").accelerator("CmdOrCtrl+Shift+S").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("menu_close", "エディタを閉じる").accelerator("CmdOrCtrl+W").build(handle)?);

    if !editor_items.is_empty() {
        file_menu_builder = file_menu_builder.separator();
        for (id, name, is_active) in editor_items {
            let label = if *is_active {
                format!("✓ {}", name)
            } else {
                format!("   {}", name)
            };
            let item_id = format!("select_editor:{}", id);
            file_menu_builder = file_menu_builder.item(
                &MenuItemBuilder::with_id(item_id, label).build(handle)?
            );
        }
    }
    let file_menu = file_menu_builder.build()?;

    let edit_menu = SubmenuBuilder::new(handle, "編集")
        .item(&MenuItemBuilder::with_id("menu_toggle_record", "マイク録音の開始/停止").accelerator("CmdOrCtrl+R").build(handle)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(handle, "表示")
        .item(&MenuItemBuilder::with_id("menu_zoom_in_x", "時間軸を拡大 (ズームイン)").accelerator("CmdOrCtrl+Plus").build(handle)?)
        .item(&MenuItemBuilder::with_id("menu_zoom_out_x", "時間軸を縮小 (ズームアウト)").accelerator("CmdOrCtrl+-").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("menu_zoom_in_y", "周波数軸を拡大").build(handle)?)
        .item(&MenuItemBuilder::with_id("menu_zoom_out_y", "周波数軸を縮小").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("menu_gain_up", "カラー感度を上げる (濃くする)").build(handle)?)
        .item(&MenuItemBuilder::with_id("menu_gain_down", "カラー感度を下げる (薄くする)").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("menu_reset_zoom", "拡大縮小・感度をリセット").build(handle)?)
        .build()?;

    MenuBuilder::new(handle)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu])
        .build()
}

// エディタ一覧の変更をOSメニューバーに同期するコマンド
#[tauri::command]
fn sync_editor_menu(
    app: tauri::AppHandle,
    editors: Vec<(String, String, bool)>,
) -> Result<(), String> {
    let menu = build_full_menu(&app, &editors).map_err(|e| e.to_string())?;
    // set_menu の戻り値 (Option<Menu>) を破棄して Ok(()) を返す
    let _ = app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_audio_file,
            save_audio_file,
            save_audio_file_as,
            sync_editor_menu
        ])
        .setup(|app| {
            let handle = app.handle();
            let initial_menu = build_full_menu(handle, &[])?;
            let _ = app.set_menu(initial_menu)?;

            app.on_menu_event(|app_handle, event| {
                let id_str = event.id().as_ref();
                let _ = app_handle.emit("native-menu-event", id_str);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}