#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        Ok(None)
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_file_exists,
            open_audio_file,
            save_audio_file,
            save_audio_file_as
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}