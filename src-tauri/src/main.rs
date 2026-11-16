#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, Response};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// 読み込み位置を追跡する MediaSource ラッパー
struct ProgressSource<R: Read + Seek + Send + Sync> {
    inner: R,
    pos: Arc<AtomicU64>,
}

impl<R: Read + Seek + Send + Sync> Read for ProgressSource<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.pos.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

impl<R: Read + Seek + Send + Sync> Seek for ProgressSource<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos = self.inner.seek(pos)?;
        self.pos.store(new_pos, Ordering::Relaxed);
        Ok(new_pos)
    }
}

impl<R: Read + Seek + Send + Sync> MediaSource for ProgressSource<R> {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

fn pcm_to_wav_bytes(samples: &[f32], channels: u16, sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut header = Vec::with_capacity(44 + samples.len() * 2);

    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + data_len).to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * (channels as u32) * 2;
    header.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * 2;
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&16u16.to_le_bytes());
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

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

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

// 同期デコード本体 (spawn_blocking 内で実行)
fn decode_audio_file_sync(path: String, on_progress: Channel<u32>) -> Result<Response, String> {
    let file = File::open(&path).map_err(|e| format!("ファイルを開けません: {}", e))?;
    let total_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let pos_tracker = Arc::new(AtomicU64::new(0));

    let progress_source = ProgressSource {
        inner: file,
        pos: Arc::clone(&pos_tracker),
    };

    let mss = MediaSourceStream::new(Box::new(progress_source), Default::default());

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

    let _ = on_progress.send(0);
    let mut last_percent = 0;

    // フォーマット解析 (プローブ) 完了時点の位置を基準とする
    let start_pos = pos_tracker.load(Ordering::Relaxed).min(total_bytes);
    let effective_total = total_bytes.saturating_sub(start_pos);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(_) => {
                // すでに音声データが取得できていればファイルの終端（末尾タグ等）とみなして正常終了
                if !pcm_samples.is_empty() {
                    break;
                } else {
                    return Err("音声パケットを読み込めませんでした".to_string());
                }
            }
        };

        // デコード進捗率（％）を計算してフロントエンドへ通知
        if effective_total > 0 {
            let current = pos_tracker.load(Ordering::Relaxed);
            let effective_current = current.saturating_sub(start_pos);
            let pct = ((effective_current as f64 / effective_total as f64) * 100.0).min(99.0) as u32;
            if pct > last_percent {
                last_percent = pct;
                let _ = on_progress.send(pct);
            }
        }

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
            Err(e) => {
                if !pcm_samples.is_empty() {
                    break;
                }
                return Err(format!("デコードエラー: {}", e));
            }
        }
    }

    let _ = on_progress.send(100);

    let wav_bytes = pcm_to_wav_bytes(&pcm_samples, channels as u16, sample_rate);
    Ok(Response::new(wav_bytes))
}

// 非同期コマンド (ワーカースレッドで実行し、UIメインスレッドを絶対にブロックしない)
#[tauri::command]
async fn read_audio_file(path: String, on_progress: Channel<u32>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || decode_audio_file_sync(path, on_progress))
        .await
        .map_err(|e| format!("非同期タスクエラー: {}", e))?
}

#[tauri::command]
fn save_audio_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

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

// 事前に動画の保存先パスを選択するダイアログ
#[tauri::command]
fn pick_save_video_path(default_name: String) -> Result<Option<(String, String)>, String> {
    let file = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("MP4 Video (*.mp4)", &["mp4"])
        .save_file();

    if let Some(mut path) = file {
        if path.extension().is_none() {
            path.set_extension("mp4");
        }
        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        Ok(Some((path_str, name)))
    } else {
        Ok(None)
    }
}

// 動画ファイル保存
#[tauri::command]
fn save_video_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

// 従来の動画保存ダイアログ (互換性維持)
#[tauri::command]
fn save_video_file_as(default_name: String, data: Vec<u8>) -> Result<Option<(String, String)>, String> {
    let file = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("MP4 Video (*.mp4)", &["mp4"])
        .save_file();

    if let Some(mut path) = file {
        if path.extension().is_none() {
            path.set_extension("mp4");
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
            save_audio_file_as,
            save_video_file_as,
            pick_save_video_path,
            save_video_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}