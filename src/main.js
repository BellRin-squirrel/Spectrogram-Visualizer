import { DEFAULT_FRAME_WIDTH, DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, KEYBOARD_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH } from "./constants.js";
import { AudioManager } from "./audio.js";
import { SpectrogramRenderer } from "./renderer.js";
import { FrequencyFilterManager } from "./filter.js";
import { EditorManager } from "./editorManager.js";
import { initModals, openFilterModal, openSaveConfirmModal, openCloseConfirmModal } from "./modals.js";

// DOM 要素
const statusText = document.getElementById("statusText");
const spectrogramArea = document.getElementById("spectrogramArea");
const canvas = document.getElementById("spectrogramCanvas");
const scrollContainer = document.getElementById("scrollContainer");
const scrollDummy = document.getElementById("scrollDummy");
const editorListContainer = document.getElementById("editorListContainer");

const actionToggleRecord = document.getElementById("actionToggleRecord");
const actionSave = document.getElementById("actionSave");
const actionSaveAs = document.getElementById("actionSaveAs");

const emptyOverlay = document.getElementById("emptyOverlay");
const centerMicBtn = document.getElementById("centerMicBtn");
const fileInput = document.getElementById("fileInput");

// インスタンス化
const audio = new AudioManager();
const renderer = new SpectrogramRenderer(canvas);
const filterManager = new FrequencyFilterManager();
const editorManager = new EditorManager(audio, renderer, filterManager);

// 状態変数
let frameWidth = DEFAULT_FRAME_WIDTH;
let currentScrollX = 0;
let targetScrollX = 0;
let cssWidth = 0;
let cssHeight = 0;
let dpr = window.devicePixelRatio || 1;
let isProgrammaticScroll = false;
let draggingFilter = null;
let hoverCrosshair = null; // { x, y, area: 'spectrogram' | 'panel' }

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

  if (audio.isMicActive) {
    targetScrollX = maxScroll;
    currentScrollX = maxScroll;
    isProgrammaticScroll = true;
    scrollContainer.scrollLeft = maxScroll;
  } else {
    currentScrollX += (targetScrollX - currentScrollX) * 0.35;
    if (Math.abs(targetScrollX - currentScrollX) < 0.1) currentScrollX = targetScrollX;
    isProgrammaticScroll = true;
    scrollContainer.scrollLeft = Math.round(currentScrollX);
  }

  renderer.render(
    cssWidth, cssHeight, dpr,
    audio.history, audio.pitchHistory, currentScrollX, audio.getSampleRate(), audio.isPlaying,
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
  if (actionToggleRecord) actionToggleRecord.textContent = audio.isMicActive ? "マイク録音 停止" : "マイク録音 開始";
}

editorManager.setOnStateChange(() => {
  editorManager.updateListUI(editorListContainer, async (ed) => {
    const res = await editorManager.switchEditor(ed, currentScrollX, frameWidth);
    if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView(); }
  });
  updateMenuState();
});

// ファイルメニュー
document.getElementById("actionNew").addEventListener("click", async () => {
  const res = await editorManager.createNewEditor(currentScrollX, frameWidth);
  currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView();
});

document.getElementById("actionOpen").addEventListener("click", async () => {
  if (window.__TAURI__?.core?.invoke) {
    try {
      const res = await window.__TAURI__.core.invoke("open_audio_file");
      if (res) {
        const [filePath, fileName, bytes] = res;
        await loadAudio(new Uint8Array(bytes).buffer, fileName, filePath);
        return;
      }
    } catch (e) {}
  }
  fileInput.value = ""; fileInput.click();
});

async function loadAudio(arrayBuffer, name, path) {
  const res = await editorManager.loadAudioFromBuffer(arrayBuffer, name, path, currentScrollX, frameWidth, (p) => {
    statusText.textContent = `高精度FFT解析中 (${name}): ${p}%`;
  });
  currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView();
  statusText.textContent = `解析完了: ${name} (Spaceキーで再生)`;
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await loadAudio(await file.arrayBuffer(), file.name, null);
});

function handleSave(isSaveAs) {
  const active = editorManager.activeEditor;
  if (!active || (audio.history.length === 0 && !active.pcmData)) return;

  const execute = async (applyFilter) => {
    statusText.textContent = "保存中...";
    if (isSaveAs) {
      const savedName = await editorManager.saveFileAs(applyFilter);
      statusText.textContent = savedName ? `保存完了: ${savedName}` : "保存をキャンセルしました";
    } else {
      const ok = await editorManager.saveFile(applyFilter);
      statusText.textContent = ok ? `上書き保存完了: ${active.name}` : "上書き保存に失敗しました";
    }
  };

  if (filterManager.hasActiveFilters()) {
    openSaveConfirmModal({
      onSaveWithFilter: () => execute(true),
      onSaveWithoutFilter: () => execute(false),
      onCancel: () => { statusText.textContent = "保存をやめました"; }
    });
  } else {
    execute(false);
  }
}

actionSave.addEventListener("click", () => handleSave(false));
actionSaveAs.addEventListener("click", () => handleSave(true));

document.getElementById("actionClose").addEventListener("click", () => {
  const active = editorManager.activeEditor;
  if (!active) return;
  openCloseConfirmModal(active.name, async () => {
    const res = await editorManager.closeActiveEditor();
    if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; renderView(); }
  });
});

// フィルター操作
document.getElementById("actionAddFilter").addEventListener("click", () => {
  filterManager.addDefaultFilter(); renderView(); statusText.textContent = "周波数フィルターを設置しました (200Hz〜500Hz, 100%)";
});
document.getElementById("actionClearFilters").addEventListener("click", () => {
  filterManager.clearAll(); renderView(); statusText.textContent = "周波数フィルターを一括削除しました";
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
attachAction("actionGainUp", () => { statusText.textContent = `カラー感度: ${renderer.adjustColorGain(-150)}%`; renderView(); });
attachAction("actionGainDown", () => { statusText.textContent = `カラー感度: ${renderer.adjustColorGain(150)}%`; renderView(); });
attachAction("actionResetZoom", () => {
  frameWidth = DEFAULT_FRAME_WIDTH; renderer.viewMinFreq = DEFAULT_MIN_FREQ; renderer.viewMaxFreq = DEFAULT_MAX_FREQ;
  renderer.colorGain = 1.0; renderer.rebuildBakedLUT(); renderView(); statusText.textContent = "リセットしました";
});

// 録音処理
async function toggleRecording() {
  if (audio.isMicActive) {
    audio.stopMic();
    centerMicBtn.innerHTML = "🎙️ マイク録音開始";
    centerMicBtn.classList.remove("recording");
    statusText.textContent = "録音停止 (Spaceキーで中央位置から再生)";
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
    statusText.textContent = "録音中... (Spaceキーまたはメニューから停止)";
    await audio.startMic(() => renderView());
  } catch (err) {
    statusText.textContent = "マイクへのアクセス失敗: " + err.message;
  }
}
centerMicBtn.addEventListener("click", toggleRecording);
actionToggleRecord.addEventListener("click", toggleRecording);

function checkHoverFilterHandle(mouseX, mouseY) {
  if (!filterManager.hasActiveFilters()) return false;
  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  const centerX = LEFT_MARGIN + graphWidth / 2;

  if (Math.abs(mouseX - centerX) <= 24) {
    for (const f of filterManager.filters) {
      const topY = Math.min(renderer.freqToY(f.maxFreq, cssHeight), renderer.freqToY(f.minFreq, cssHeight));
      const bottomY = Math.max(renderer.freqToY(f.maxFreq, cssHeight), renderer.freqToY(f.minFreq, cssHeight));
      if (Math.abs(mouseY - topY) <= 10 || Math.abs(mouseY - bottomY) <= 10) return true;
    }
  }
  return false;
}

// マウスイベント (つまみドラッグ & ホバー十字線追従)
spectrogramArea.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const centerX = LEFT_MARGIN + (cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH) / 2;

  if (filterManager.hasActiveFilters() && Math.abs(mouseX - centerX) <= 24) {
    for (const f of filterManager.filters) {
      const topY = Math.min(renderer.freqToY(f.maxFreq, cssHeight), renderer.freqToY(f.minFreq, cssHeight));
      const bottomY = Math.max(renderer.freqToY(f.maxFreq, cssHeight), renderer.freqToY(f.minFreq, cssHeight));
      if (Math.abs(mouseY - topY) <= 12) { draggingFilter = { filter: f, type: f.maxFreq >= f.minFreq ? "high" : "low" }; return; }
      if (Math.abs(mouseY - bottomY) <= 12) { draggingFilter = { filter: f, type: f.maxFreq >= f.minFreq ? "low" : "high" }; return; }
    }
  }
});

// マウス移動: ホバー十字線 (クロスヘア) の更新 & つまみリサイズカーソル
spectrogramArea.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  const panelX = cssWidth - SPECTRUM_PANEL_WIDTH;

  if (draggingFilter) {
    spectrogramArea.style.cursor = "ns-resize";
    hoverCrosshair = null;
    return;
  }

  // 1. スペクトル表示領域内でのホバー
  if (mouseX > LEFT_MARGIN && mouseX < panelX && mouseY >= 0 && mouseY <= cssHeight) {
    hoverCrosshair = { x: mouseX, y: mouseY, area: "spectrogram" };
    renderView();
  } 
  // 2. 右側瞬間スペクトル波形領域内でのホバー
  else if (mouseX >= panelX && mouseX <= cssWidth && mouseY >= 0 && mouseY <= cssHeight) {
    hoverCrosshair = { x: mouseX, y: mouseY, area: "panel" };
    renderView();
  } else {
    if (hoverCrosshair) {
      hoverCrosshair = null;
      renderView();
    }
  }

  // カーソル形状
  spectrogramArea.style.cursor = checkHoverFilterHandle(mouseX, mouseY) ? "ns-resize" : "default";
});

spectrogramArea.addEventListener("mouseleave", () => {
  if (hoverCrosshair) {
    hoverCrosshair = null;
    renderView();
  }
  if (!draggingFilter) spectrogramArea.style.cursor = "default";
});

window.addEventListener("mousemove", (e) => {
  if (!draggingFilter) return;
  const rect = canvas.getBoundingClientRect();
  const newFreq = renderer.yToFreq(Math.max(0, Math.min(cssHeight, e.clientY - rect.top)), cssHeight);
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

  if (mouseX <= KEYBOARD_WIDTH) {
    const clickedFreq = renderer.yToFreq(mouseY, cssHeight);
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
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) statusText.textContent = `カラー感度: ${renderer.adjustColorGain(e.deltaY)}%`;
    else if (e.ctrlKey || e.metaKey) renderer.zoom(mouseY, e.deltaY, cssHeight);
    else renderer.pan(e.deltaY, cssHeight);
    renderView();
    return;
  }

  if (mouseX >= cssWidth - SPECTRUM_PANEL_WIDTH && (e.ctrlKey || e.metaKey)) {
    statusText.textContent = `スペクトル波形縮尺: ${renderer.adjustProfileScale(e.deltaY)}%`;
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

// Spaceキー
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    if (audio.isMicActive) {
      toggleRecording();
    } else if (audio.isPlaying) {
      audio.stopPlayback();
      statusText.textContent = `一時停止`;
      renderView();
    } else {
      const centerFrame = Math.round(currentScrollX / frameWidth);
      const startSec = audio.historyTimes[Math.max(0, Math.min(audio.history.length - 1, centerFrame))] || 0;
      audio.startPlayback(startSec, filterManager, (f) => {
        targetScrollX = f * frameWidth; currentScrollX = targetScrollX; renderView();
      }, () => { statusText.textContent = "再生終了"; renderView(); });
      statusText.textContent = `再生中 (${filterManager.hasActiveFilters() ? "フィルター適用" : "全帯域"})`;
    }
  }
});

// 初期化
initModals();
editorManager.initialize((res) => {
  if (res) { currentScrollX = res.scrollX; targetScrollX = res.scrollX; frameWidth = res.frameWidth; }
  resizeCanvas();
});