#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;

// ファイルの存在確認
#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// OSネイティブのファイル選択ダイアログ (WAV, FLAC, MP3, OGG)
#[tauri::command]
fn open_audio_file() -> Result<Option<(String, String, Vec<u8>)>, String> {
    let file = rfd::FileDialog::new()
        .add_filter("対応音声ファイル (*.wav, *.flac, *.mp3, *.ogg)", &["wav", "flac", "mp3", "ogg"])
        .pick_file();

    if let Some(path) = file {
        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(Some((path_str, name, bytes)))
    } else {
        Ok(None) // ユーザーキャンセル
    }
}

// OSネイティブの上書き保存
#[tauri::command]
fn save_audio_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

// OSネイティブの名前を付けて保存ダイアログ
#[tauri::command]
fn save_audio_file_as(default_name: String, data: Vec<u8>) -> Result<Option<(String, String)>, String> {
    let file = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("WAV Audio (*.wav)", &["wav"])
        .add_filter("FLAC Audio (*.flac)", &["flac"])
        .add_filter("MP3 Audio (*.mp3)", &["mp3"])
        .add_filter("OGG Audio (*.ogg)", &["ogg"])
        .save_file();

    if let Some(mut path) = file {
        if path.extension().is_none() {
            path.set_extension("wav");
        }
        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        std::fs::write(&path, &data).map_err(|e| e.to_string())?;
        Ok(Some((path_str, name)))
    } else {
        Ok(None)
    }
}

// エディタ一覧を含むメニューバーの構築
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

#[tauri::command]
fn sync_editor_menu(
    app: tauri::AppHandle,
    editors: Vec<(String, String, bool)>,
) -> Result<(), String> {
    let menu = build_full_menu(&app, &editors).map_err(|e| e.to_string())?;
    let _ = app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_file_exists,
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