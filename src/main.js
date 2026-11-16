import { DEFAULT_FRAME_WIDTH, DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, KEYBOARD_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH, TIME_AXIS_HEIGHT } from "./constants.js";
import { AudioManager } from "./audio.js";
import { SpectrogramRenderer } from "./renderer.js";
import { FrequencyFilterManager } from "./filter.js";
import { EditorManager } from "./editorManager.js";
import { VideoExporter } from "./videoExporter.js";
import { initModals, openFilterModal, openSaveConfirmModal, openCloseConfirmModal } from "./modals.js";

// DOM 要素
const statusText = document.getElementById("statusText");
let statusExportText = document.getElementById("statusExportText");

// statusExportText が HTML に存在しない場合でも安全に自動生成して配置
if (!statusExportText && statusText) {
  const statusBar = document.getElementById("statusBar") || statusText.parentElement;
  if (statusBar) {
    statusExportText = document.createElement("div");
    statusExportText.id = "statusExportText";
    statusExportText.className = "status-right";
    statusBar.appendChild(statusExportText);
  }
}

const spectrogramArea = document.getElementById("spectrogramArea");
const canvas = document.getElementById("spectrogramCanvas");
const scrollContainer = document.getElementById("scrollContainer");
const scrollDummy = document.getElementById("scrollDummy");
const editorListContainer = document.getElementById("editorListContainer");

const actionToggleRecord = document.getElementById("actionToggleRecord");
const actionSave = document.getElementById("actionSave");
const actionSaveAs = document.getElementById("actionSaveAs");
const actionExportVideo = document.getElementById("actionExportVideo");

const emptyOverlay = document.getElementById("emptyOverlay");
const centerMicBtn = document.getElementById("centerMicBtn");
const fileInput = document.getElementById("fileInput");

// 動画出力モーダル要素
const videoExportModal = document.getElementById("videoExportModal");
const exportProgressBar = document.getElementById("exportProgressBar");
const exportStatusText = document.getElementById("exportStatusText");
const btnCancelExportVideo = document.getElementById("btnCancelExportVideo");

// インスタンス化
const audio = new AudioManager();
const renderer = new SpectrogramRenderer(canvas);
const filterManager = new FrequencyFilterManager();
const editorManager = new EditorManager(audio, renderer, filterManager);
const videoExporter = new VideoExporter(canvas, audio, filterManager);

// 状態変数
let frameWidth = DEFAULT_FRAME_WIDTH;
let currentScrollX = 0;
let targetScrollX = 0;
let cssWidth = 0;
let cssHeight = 0;
let dpr = window.devicePixelRatio || 1;
let isProgrammaticScroll = false;
let draggingFilter = null;
let hoverCrosshair = null;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  cssWidth = spectrogramArea.clientWidth;
  cssHeight = spectrogramArea.clientHeight;
  if (cssWidth <= 0 || cssHeight <= 0) return;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  renderView();
}
window.addEventListener("resize", resizeCanvas);

function renderView() {
  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  if (graphWidth <= 0) return;

  const totalFrames = audio.history.length;
  const maxScroll = Math.max(0, (totalFrames - 1) * frameWidth);
  const containerClientW = scrollContainer.clientWidth || graphWidth;
  scrollDummy.style.width = `${containerClientW + maxScroll}px`;

  // 録音中 または 再生中 (動画出力中含む): 遅延なく音の位置へ完全即時同期
  if (audio.isMicActive || audio.isPlaying) {
    currentScrollX = targetScrollX;
    isProgrammaticScroll = true;
    scrollContainer.scrollLeft = Math.round(currentScrollX);
  } else {
    currentScrollX += (targetScrollX - currentScrollX) * 0.35;
    if (Math.abs(targetScrollX - currentScrollX) < 0.1) currentScrollX = targetScrollX;
    isProgrammaticScroll = true;
    scrollContainer.scrollLeft = Math.round(currentScrollX);
  }

  renderer.render(
    cssWidth, cssHeight, dpr,
    audio.history, audio.pitchHistory, audio.historyTimes, currentScrollX, audio.getSampleRate(), audio.isPlaying,
    frameWidth, filterManager, draggingFilter ? null : hoverCrosshair
  );

  const active = editorManager.activeEditor;
  emptyOverlay.style.display = (active?.isNew && audio.history.length === 0 && !audio.isMicActive) ? "flex" : "none";
  updateMenuState();

  if (Math.abs(targetScrollX - currentScrollX) >= 0.1) requestAnimationFrame(renderView);
}

function updateMenuState() {
  const active = editorManager.activeEditor;
  if (!active) return;

  actionSave.classList.toggle("disabled", !active.filePath);
  const hasAudio = audio.history.length > 0 || (active.pcmData && active.pcmData.length > 0);
  actionSaveAs.classList.toggle("disabled", !hasAudio);
  actionExportVideo.classList.toggle("disabled", !hasAudio);

  if (actionToggleRecord) actionToggleRecord.innerHTML = audio.isMicActive 
    ? 'マイク録音 停止 <span class="shortcut-key">Space</span>' 
    : 'マイク録音 開始 <span class="shortcut-key">Space</span>';
}

editorManager.setOnStateChange(() => {
  editorManager.updateListUI(editorListContainer, async (ed) => {
    const res = await editorManager.switchEditor(ed, currentScrollX, frameWidth);
    if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView(); }
  });
  updateMenuState();
});

// ファイルメニュー
async function handleNew() {
  const res = await editorManager.createNewEditor(currentScrollX, frameWidth);
  currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView();
}
document.getElementById("actionNew").addEventListener("click", handleNew);

function isValidAudioFile(filename) {
  return /\.(wav|flac|mp3|ogg|m4a)$/i.test(filename);
}

async function handleOpen() {
  if (window.__TAURI__?.core?.invoke) {
    try {
      const res = await window.__TAURI__.core.invoke("pick_audio_file");
      if (res) {
        const [filePath, fileName] = res;

        if (statusText) {
          statusText.textContent = `読み込み中 (${fileName}): [1/3] 音声をデコード中... 0%`;
        }

        const rustStart = performance.now();
        // Tauri v2 の IPC Channel を確実に生成
        const channel = new window.__TAURI__.core.Channel();
        channel.onmessage = (percent) => {
          if (statusText) {
            statusText.textContent = `読み込み中 (${fileName}): [1/3] 音声をデコード中... ${percent}%`;
          }
        };

        const rawResponse = await window.__TAURI__.core.invoke("read_audio_file", {
          path: filePath,
          onProgress: channel
        });

        const rustDuration = Math.round(performance.now() - rustStart);
        const arrayBuffer = (rawResponse instanceof ArrayBuffer) ? rawResponse : rawResponse.buffer;

        await loadAudio(arrayBuffer, fileName, filePath, rustDuration);
      }
      return;
    } catch (e) {
      if (statusText) statusText.textContent = `読み込みエラー: ${e}`;
      return;
    }
  }
  fileInput.value = ""; fileInput.click();
}
document.getElementById("actionOpen").addEventListener("click", handleOpen);

async function loadAudio(arrayBuffer, name, path, rustDuration = null) {
  if (!isValidAudioFile(name)) {
    if (statusText) statusText.textContent = "非対応の形式です (.wav, .flac, .mp3, .ogg, .m4a のみ対応)";
    return;
  }

  const overallStart = performance.now();

  const res = await editorManager.loadAudioFromBuffer(
    arrayBuffer,
    name,
    path,
    currentScrollX,
    frameWidth,
    (info) => {
      if (info.phase === "decoding") {
        if (statusText) statusText.textContent = `読み込み中 (${name}): [2/3] 波形データを展開中...`;
      } else if (info.phase === "analyzing") {
        if (statusText) statusText.textContent = `読み込み中 (${name}): [3/3] スペクトル解析中: ${info.percent}%`;
      }
    }
  );

  currentScrollX = res.scrollX;
  targetScrollX = res.scrollX;
  frameWidth = res.frameWidth;
  renderView();

  const totalTime = Math.round(performance.now() - overallStart + (rustDuration || 0));
  const perf = res.perfData || {};

  // コンソールに詳細なパフォーマンステーブルを出力
  console.group(`%c[PERF PROFILE] 音声読み込み完了: ${name}`, "color: #04d361; font-weight: bold; font-size: 1.05em;");
  console.table({
    "Phase 1: Rust ファイルデコード": rustDuration !== null ? `${rustDuration} ms` : "N/A (ブラウザ直接)",
    "Phase 2: 波形データ展開 (WebAudio)": `${perf.decodeMs || 0} ms`,
    "Phase 3: FFT & ピッチ解析": `${perf.fftMs || 0} ms`,
    "総所要時間": `${totalTime} ms`
  });
  console.log(`音声長: ${(perf.durationSec || 0).toFixed(2)}s | サンプルレート: ${perf.sampleRate || 0}Hz | 総ステップ数: ${perf.totalSteps || 0}`);
  console.groupEnd();

  const rustSummary = rustDuration !== null ? `デコード: ${(rustDuration / 1000).toFixed(1)}s, ` : "";
  const decodeSummary = `展開: ${((perf.decodeMs || 0) / 1000).toFixed(1)}s, `;
  const fftSummary = `解析: ${((perf.fftMs || 0) / 1000).toFixed(1)}s`;
  if (statusText) {
    statusText.textContent = `解析完了: ${name} (${rustSummary}${decodeSummary}${fftSummary} / 合計: ${(totalTime / 1000).toFixed(1)}s)`;
  }
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await loadAudio(await file.arrayBuffer(), file.name, null);
});

// 音声ファイル保存
function handleSave(isSaveAs) {
  const active = editorManager.activeEditor;
  if (!active || (audio.history.length === 0 && !active.pcmData)) return;

  const actualSaveAs = isSaveAs || !active.filePath;

  const execute = async (applyFilter) => {
    if (statusText) statusText.textContent = "保存中...";
    if (actualSaveAs) {
      const savedName = await editorManager.saveFileAs(applyFilter);
      if (statusText) statusText.textContent = savedName ? `保存完了: ${savedName}` : "保存をキャンセルしました";
    } else {
      const ok = await editorManager.saveFile(applyFilter);
      if (statusText) statusText.textContent = ok ? `上書き保存完了: ${active.name}` : "上書き保存に失敗しました";
    }
  };

  if (filterManager.hasActiveFilters()) {
    openSaveConfirmModal({
      onSaveWithFilter: () => execute(true),
      onSaveWithoutFilter: () => execute(false),
      onCancel: () => { if (statusText) statusText.textContent = "保存をやめました"; }
    });
  } else {
    execute(false);
  }
}

actionSave.addEventListener("click", () => handleSave(false));
actionSaveAs.addEventListener("click", () => handleSave(true));

// 動画ファイル出力 (.mp4) - 事前に保存先を指定してからエンコード
actionExportVideo.addEventListener("click", async () => {
  const active = editorManager.activeEditor;
  if (!active || (audio.history.length === 0 && !active.pcmData)) return;

  const baseName = active.name.replace(/\.[^/.]+$/, "") + ".mp4";
  let targetFilePath = null;
  let targetFileName = baseName;
  let fileHandle = null;

  // 1. 事前に保存先を指定
  if (window.__TAURI__?.core?.invoke) {
    try {
      const res = await window.__TAURI__.core.invoke("pick_save_video_path", {
        defaultName: baseName
      });
      if (!res) {
        if (statusText) statusText.textContent = "動画出力をキャンセルしました";
        return;
      }
      targetFilePath = res[0];
      targetFileName = res[1];
    } catch (err) {
      console.warn("Tauri pick_save_video_path failed:", err);
      if (statusText) statusText.textContent = "保存先の指定に失敗しました: " + err;
      return;
    }
  } else if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: baseName,
        types: [{
          description: "MP4 Video",
          accept: { "video/mp4": [".mp4"] }
        }]
      });
      targetFileName = fileHandle.name;
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("showSaveFilePicker error:", err);
      }
      if (statusText) statusText.textContent = "動画出力をキャンセルしました";
      return;
    }
  }

  // 2. 保存先が確定したらエンコードを開始
  if (exportProgressBar) exportProgressBar.style.width = "0%";
  if (exportStatusText) exportStatusText.textContent = "準備中...";
  if (statusExportText) statusExportText.textContent = `動画出力準備中 (${targetFileName})...`;
  if (statusText) statusText.textContent = `動画出力中: ${targetFileName}`;
  if (videoExportModal) videoExportModal.style.display = "flex";

  // 先頭 (0.0s) からの描画に初期化
  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  currentScrollX = 0;
  targetScrollX = 0;
  renderView();

  videoExporter.startExport({
    onProgress: (progress, currentSec, totalDuration) => {
      currentScrollX = progress * maxScroll;
      targetScrollX = currentScrollX;
      renderView();

      const percent = Math.min(100, Math.round(progress * 100));
      if (exportProgressBar) exportProgressBar.style.width = `${percent}%`;
      const progressText = `${percent}% (${currentSec.toFixed(1)}s / ${totalDuration.toFixed(1)}s)`;
      if (exportStatusText) exportStatusText.textContent = `進行状況: ${progressText}`;
      if (statusExportText) statusExportText.textContent = `動画出力中: ${progressText}`;
    },
    onComplete: async (blob) => {
      if (videoExportModal) videoExportModal.style.display = "none";
      if (statusText) statusText.textContent = `動画ファイルを書き込み中: ${targetFileName}...`;
      if (statusExportText) statusExportText.textContent = "動画保存中...";

      const arrayBuffer = await blob.arrayBuffer();

      try {
        if (targetFilePath && window.__TAURI__?.core?.invoke) {
          await window.__TAURI__.core.invoke("save_video_file", {
            path: targetFilePath,
            data: new Uint8Array(arrayBuffer)
          });
          if (statusText) statusText.textContent = `動画を出力しました: ${targetFileName}`;
        } else if (fileHandle) {
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          if (statusText) statusText.textContent = `動画を出力しました: ${targetFileName}`;
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = targetFileName;
          a.click();
          if (statusText) statusText.textContent = `動画をダウンロードしました: ${targetFileName}`;
        }

        if (statusExportText) {
          statusExportText.textContent = "動画出力完了";
          setTimeout(() => {
            if (statusExportText && statusExportText.textContent === "動画出力完了") {
              statusExportText.textContent = "";
            }
          }, 5000);
        }
      } catch (err) {
        console.error("Save video failed:", err);
        if (statusText) statusText.textContent = `動画保存エラー: ${err.message || err}`;
        if (statusExportText) {
          statusExportText.textContent = "動画保存失敗";
          setTimeout(() => {
            if (statusExportText && statusExportText.textContent === "動画保存失敗") {
              statusExportText.textContent = "";
            }
          }, 5000);
        }
      } finally {
        currentScrollX = 0;
        targetScrollX = 0;
        renderView();
      }
    },
    onError: (err) => {
      if (videoExportModal) videoExportModal.style.display = "none";
      alert("動画の出力に失敗しました: " + err.message);
      if (statusText) statusText.textContent = "動画出力エラー: " + err.message;
      if (statusExportText) {
        statusExportText.textContent = "動画出力エラー";
        setTimeout(() => {
          if (statusExportText && statusExportText.textContent === "動画出力エラー") {
            statusExportText.textContent = "";
          }
        }, 5000);
      }
      renderView();
    }
  });
});

btnCancelExportVideo.addEventListener("click", () => {
  videoExporter.cancel();
  if (videoExportModal) videoExportModal.style.display = "none";
  if (statusText) statusText.textContent = "動画の出力を中止しました";
  if (statusExportText) {
    statusExportText.textContent = "動画出力中止";
    setTimeout(() => {
      if (statusExportText && statusExportText.textContent === "動画出力中止") {
        statusExportText.textContent = "";
      }
    }, 4000);
  }
  currentScrollX = 0;
  targetScrollX = 0;
  renderView();
});

// エディタを閉じる
function handleClose() {
  const active = editorManager.activeEditor;
  if (!active) return;
  openCloseConfirmModal(active.name, async () => {
    const res = await editorManager.closeActiveEditor();
    if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView(); }
  });
}
document.getElementById("actionClose").addEventListener("click", handleClose);

// フィルター操作
function handleAddFilter() {
  filterManager.addDefaultFilter(); 
  renderView(); 
  if (statusText) statusText.textContent = "周波数フィルターを設置しました (200Hz〜500Hz, 100%)";
}
document.getElementById("actionAddFilter").addEventListener("click", handleAddFilter);
document.getElementById("actionClearFilters").addEventListener("click", () => {
  filterManager.clearAll(); renderView(); if (statusText) statusText.textContent = "周波数フィルターを一括削除しました";
});
document.getElementById("actionManageFilters").addEventListener("click", () => {
  openFilterModal(filterManager, () => renderView());
});

// ズーム・感度
function attachAction(id, cb) {
  document.getElementById(id)?.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
}
function zoomTime(factor) {
  const centerFrame = currentScrollX / frameWidth;
  frameWidth = Math.max(0.2, Math.min(30, frameWidth * factor));
  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  targetScrollX = Math.max(0, Math.min(maxScroll, centerFrame * frameWidth));
  currentScrollX = targetScrollX;
  renderView();
}

attachAction("actionZoomInX", () => zoomTime(1.3));
attachAction("actionZoomOutX", () => zoomTime(1 / 1.3));
attachAction("actionZoomInY", () => { renderer.zoom(cssHeight / 2, -180, cssHeight); renderView(); });
attachAction("actionZoomOutY", () => { renderer.zoom(cssHeight / 2, 180, cssHeight); renderView(); });
attachAction("actionGainUp", () => { if (statusText) statusText.textContent = `カラー感度: ${renderer.adjustColorGain(-150)}%`; renderView(); });
attachAction("actionGainDown", () => { if (statusText) statusText.textContent = `カラー感度: ${renderer.adjustColorGain(150)}%`; renderView(); });
attachAction("actionResetZoom", () => {
  frameWidth = DEFAULT_FRAME_WIDTH; renderer.viewMinFreq = DEFAULT_MIN_FREQ; renderer.viewMaxFreq = DEFAULT_MAX_FREQ;
  renderer.colorGain = 1.0; renderer.rebuildBakedLUT(); renderView(); if (statusText) statusText.textContent = "リセットしました";
});

// 録音処理
async function toggleRecording() {
  if (audio.isMicActive) {
    audio.stopMic();
    centerMicBtn.innerHTML = "🎙️ マイク録音開始";
    centerMicBtn.classList.remove("recording");
    if (statusText) statusText.textContent = "録音停止 (Spaceキーで中央位置から再生)";
    await editorManager.saveCurrentEditorState(currentScrollX, frameWidth);
    renderView();
    return;
  }

  const active = editorManager.activeEditor;
  if (active && (audio.history.length > 0 || active.pcmData?.length > 0)) {
    const res = await editorManager.createNewEditor(currentScrollX, frameWidth);
    currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth;
  } else if (active) {
    active.isNew = false;
  }

  try {
    centerMicBtn.innerHTML = "⏹️ 録音停止";
    centerMicBtn.classList.add("recording");
    updateMenuState();
    if (statusText) statusText.textContent = "録音中... (Spaceキーまたはメニューから停止)";
    await audio.startMic(() => renderView());
  } catch (err) {
    if (statusText) statusText.textContent = "マイクへのアクセス失敗: " + err.message;
  }
}
centerMicBtn.addEventListener("click", toggleRecording);
actionToggleRecord.addEventListener("click", toggleRecording);

function checkHoverFilterHandle(mouseX, mouseY) {
  if (!filterManager.hasActiveFilters()) return false;
  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  const centerX = LEFT_MARGIN + graphWidth / 2;
  const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);

  if (Math.abs(mouseX - centerX) <= 24) {
    for (const f of filterManager.filters) {
      const topY = Math.min(renderer.freqToY(f.maxFreq, effH), renderer.freqToY(f.minFreq, effH));
      const bottomY = Math.max(renderer.freqToY(f.maxFreq, effH), renderer.freqToY(f.minFreq, effH));
      if (Math.abs(mouseY - topY) <= 10 || Math.abs(mouseY - bottomY) <= 10) return true;
    }
  }
  return false;
}

// マウスイベント
spectrogramArea.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const centerX = LEFT_MARGIN + (cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH) / 2;
  const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);

  if (filterManager.hasActiveFilters() && Math.abs(mouseX - centerX) <= 24) {
    for (const f of filterManager.filters) {
      const topY = Math.min(renderer.freqToY(f.maxFreq, effH), renderer.freqToY(f.minFreq, effH));
      const bottomY = Math.max(renderer.freqToY(f.maxFreq, effH), renderer.freqToY(f.minFreq, effH));
      if (Math.abs(mouseY - topY) <= 12) { draggingFilter = { filter: f, type: f.maxFreq >= f.minFreq ? "high" : "low" }; return; }
      if (Math.abs(mouseY - bottomY) <= 12) { draggingFilter = { filter: f, type: f.maxFreq >= f.minFreq ? "low" : "high" }; return; }
    }
  }
});

spectrogramArea.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const panelX = cssWidth - SPECTRUM_PANEL_WIDTH;

  if (draggingFilter) {
    spectrogramArea.style.cursor = "ns-resize";
    hoverCrosshair = null;
    return;
  }

  if (mouseX > LEFT_MARGIN && mouseX < panelX && mouseY >= 0 && mouseY <= cssHeight) {
    hoverCrosshair = { x: mouseX, y: mouseY, area: "spectrogram" };
    renderView();
  } else if (mouseX >= panelX && mouseX <= cssWidth && mouseY >= 0 && mouseY <= cssHeight) {
    hoverCrosshair = { x: mouseX, y: mouseY, area: "panel" };
    renderView();
  } else if (hoverCrosshair) {
    hoverCrosshair = null;
    renderView();
  }

  spectrogramArea.style.cursor = checkHoverFilterHandle(mouseX, mouseY) ? "ns-resize" : "default";
});

spectrogramArea.addEventListener("mouseleave", () => {
  if (hoverCrosshair) { hoverCrosshair = null; renderView(); }
  if (!draggingFilter) spectrogramArea.style.cursor = "default";
});

window.addEventListener("mousemove", (e) => {
  if (!draggingFilter) return;
  const rect = canvas.getBoundingClientRect();
  const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);
  const mouseY = Math.max(0, Math.min(effH, e.clientY - rect.top));
  const newFreq = renderer.yToFreq(mouseY, effH);

  if (draggingFilter.type === "high") filterManager.updateFilter(draggingFilter.filter.id, { maxFreq: newFreq });
  else filterManager.updateFilter(draggingFilter.filter.id, { minFreq: newFreq });
  renderView();
});
window.addEventListener("mouseup", () => { draggingFilter = null; spectrogramArea.style.cursor = "default"; });

spectrogramArea.addEventListener("click", (e) => {
  if (draggingFilter) return;
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);

  if (mouseX <= KEYBOARD_WIDTH) {
    const clickedFreq = renderer.yToFreq(mouseY, effH);
    const midiNote = Math.round(69 + 12 * Math.log2(clickedFreq / 440));
    const exactFreq = 440 * Math.pow(2, (midiNote - 69) / 12);
    audio.playPianoNote(exactFreq);
    return;
  }

  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  if (mouseX > LEFT_MARGIN && mouseX < cssWidth - SPECTRUM_PANEL_WIDTH) {
    if (audio.isPlaying) audio.stopPlayback();
    const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
    targetScrollX = Math.max(0, Math.min(maxScroll, currentScrollX + (mouseX - LEFT_MARGIN - Math.floor(graphWidth / 2))));
    requestAnimationFrame(renderView);
  }
});

// マウスホイール
spectrogramArea.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (mouseX <= LEFT_MARGIN) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      if (statusText) statusText.textContent = `カラー感度: ${renderer.adjustColorGain(e.deltaY)}%`;
    } else if (e.ctrlKey || e.metaKey) {
      renderer.zoom(mouseY, e.deltaY, cssHeight);
    } else {
      renderer.pan(e.deltaY, cssHeight);
    }
    renderView();
    return;
  }

  if (mouseX >= cssWidth - SPECTRUM_PANEL_WIDTH && (e.ctrlKey || e.metaKey)) {
    if (statusText) statusText.textContent = `スペクトル波形縮尺: ${renderer.adjustProfileScale(e.deltaY)}%`;
    renderView();
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
    const cursorFrame = (currentScrollX + (mouseX - LEFT_MARGIN - Math.floor(graphWidth / 2))) / frameWidth;
    frameWidth = Math.max(0.2, Math.min(30, frameWidth * Math.pow(1 + (e.shiftKey ? 0.0006 : 0.002), -e.deltaY)));
    const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
    targetScrollX = Math.max(0, Math.min(maxScroll, cursorFrame * frameWidth - (mouseX - LEFT_MARGIN - Math.floor(graphWidth / 2))));
    currentScrollX = targetScrollX;
    renderView();
    return;
  }

  if (audio.isPlaying) audio.stopPlayback();
  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  targetScrollX = Math.max(0, Math.min(maxScroll, targetScrollX + delta * (e.shiftKey ? 0.28 : 1.1)));
  requestAnimationFrame(renderView);
}, { passive: false });

scrollContainer.addEventListener("scroll", () => {
  if (isProgrammaticScroll) { isProgrammaticScroll = false; return; }
  if (Math.abs(scrollContainer.scrollLeft - currentScrollX) > 2) {
    targetScrollX = scrollContainer.scrollLeft; currentScrollX = targetScrollX; renderView();
  }
});

// キーボードショートカット
window.addEventListener("keydown", (e) => {
  const isCmdOrCtrl = e.ctrlKey || e.metaKey;
  const isInputFocused = e.target.tagName === "INPUT";

  if (isCmdOrCtrl) {
    const key = e.key.toLowerCase();
    if (key === "w") { e.preventDefault(); handleClose(); return; }
    if (key === "n") { e.preventDefault(); handleNew(); return; }
    if (key === "s") { e.preventDefault(); handleSave(false); return; }
    if (key === "o") { e.preventDefault(); handleOpen(); return; }
    if (key === "f") { e.preventDefault(); handleAddFilter(); return; }
    if (key === "p") {
      e.preventDefault();
      openFilterModal(filterManager, () => renderView());
      return;
    }
  }

  if (e.code === "Space" && !isInputFocused) {
    e.preventDefault();
    if (audio.isMicActive) {
      toggleRecording();
    } else if (audio.isPlaying) {
      audio.stopPlayback();
      if (statusText) statusText.textContent = "一時停止";
      renderView();
    } else {
      const maxScroll = Math.max(1, (audio.history.length - 1) * frameWidth);
      const totalDuration = audio.fullBuffer ? audio.fullBuffer.duration : (audio.historyTimes[audio.historyTimes.length - 1] || 0);

      const currentRatio = Math.max(0, Math.min(1.0, currentScrollX / maxScroll));
      const startSec = currentRatio * totalDuration;

      audio.startPlayback(
        startSec,
        filterManager,
        (progress) => {
          targetScrollX = progress * maxScroll;
          currentScrollX = targetScrollX;
          renderView();
        },
        () => {
          if (statusText) statusText.textContent = "再生終了";
          renderView();
        }
      );

      if (statusText) statusText.textContent = `再生中 (${filterManager.hasActiveFilters() ? "フィルター適用" : "全帯域"})`;
    }
  }
});

const isMac = navigator.userAgent.includes("Mac");
if (isMac) {
  document.querySelectorAll(".shortcut-key").forEach((el) => {
    el.textContent = el.textContent.replace("Ctrl+", "Cmd+");
  });
}

// 初期化
initModals();
editorManager.initialize((res) => {
  if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; }
  resizeCanvas();
});