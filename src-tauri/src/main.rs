#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::path::Path;
use tauri::ipc::Response;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// PCMサンプル列から標準16bit WAVバイナリを構築
fn pcm_to_wav_bytes(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut header = Vec::with_capacity(44 + samples.len() * 2);

    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + data_len).to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes()); // PCM
    header.extend_from_slice(&channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * (channels as u32) * 2;
    header.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * 2;
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&16u16.to_le_bytes()); // 16bit
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_len.to_le_bytes());

    for &s in samples {
        let clamped = s.max(-1.0).min(1.0);
        let val = if clamped < 0.0 {
            (clamped * 32768.0) as i16
        } else {
            (clamped * 32767.0) as i16
        };
        header.extend_from_slice(&val.to_le_bytes());
    }

    header
}

// ファイル存在確認
#[tauri::command]
fn check_file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

// OSネイティブファイル選択ダイアログ
#[tauri::command]
fn pick_audio_file() -> Result<Option<(String, String)>, String> {
    let file = rfd::FileDialog::new()
        .add_filter(
            "対応音声ファイル (*.wav, *.flac, *.mp3, *.ogg, *.m4a)",
            &["wav", "flac", "mp3", "ogg", "m4a"],
        )
        .pick_file();

    if let Some(path) = file {
        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        Ok(Some((path_str, name)))
    } else {
        Ok(None)
    }
}

// Rust側でどんな形式 (M4A/MP3/FLAC/OGG) も標準WAVへ100%確実にデコードして返す
#[tauri::command]
fn read_audio_file(path: String) -> Result<Response, String> {
    let file = File::open(&path).map_err(|e| format!("ファイルを開けません: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(&path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("フォーマット解析失敗: {}", e))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "音声トラックが見つかりません".to_string())?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("デコーダー生成失敗: {}", e))?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);

    let mut sample_buf = None;
    let mut pcm_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(format!("パケット読込エラー: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_buf.is_none() {
                    let spec = *audio_buf.spec();
                    let duration = audio_buf.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<f32>::new(duration, spec));
                }

                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(audio_buf);
                    pcm_samples.extend_from_slice(buf.samples());
                }
            }
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("デコードエラー: {}", e)),
        }
    }

    let wav_bytes = pcm_to_wav_bytes(&pcm_samples, channels as u16, sample_rate);
    Ok(Response::new(wav_bytes))
}

// OSネイティブ上書き保存
#[tauri::command]
fn save_audio_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

// OSネイティブ名前を付けて保存
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
            pick_audio_file,
            read_audio_file,
            save_audio_file,
            save_audio_file_as
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}