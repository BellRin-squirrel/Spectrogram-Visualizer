import { DEFAULT_FRAME_WIDTH, DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, KEYBOARD_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH } from "./constants.js";
import { AudioManager, encodeWAV, detectPitchFromSpectrum } from "./audio.js";
import { SpectrogramRenderer } from "./renderer.js";
import {
  saveEditorToStorage, deleteEditorFromStorage,
  loadAllEditorsFromStorage, saveActiveEditorId, getActiveEditorId
} from "./db.js";

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

async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

const audio = new AudioManager();
const renderer = new SpectrogramRenderer(canvas);

class EditorSession {
  constructor(id, name) {
    this.id = id || "editor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    this.name = name || "無題の解析";
    this.history = [];
    this.historyTimes = [];
    this.pitchHistory = [];
    this.pcmData = null;
    this.sampleRate = 44100;
    this.scrollX = 0;
    this.isNew = true;
    this.filePath = null;
  }
}

let editors = [];
let activeEditor = null;

let frameWidth = DEFAULT_FRAME_WIDTH;
let currentScrollX = 0;
let targetScrollX = 0;
let cssWidth = 0;
let cssHeight = 0;
let dpr = window.devicePixelRatio || 1;

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
    scrollContainer.scrollLeft = maxScroll;
  } else {
    currentScrollX += (targetScrollX - currentScrollX) * 0.35;
    if (Math.abs(targetScrollX - currentScrollX) < 0.1) {
      currentScrollX = targetScrollX;
    }
    scrollContainer.scrollLeft = Math.round(currentScrollX);
  }

  renderer.render(
    cssWidth, cssHeight, dpr,
    audio.history, audio.pitchHistory, currentScrollX, audio.getSampleRate(), audio.isPlaying,
    frameWidth
  );

  if (activeEditor && activeEditor.isNew && audio.history.length === 0 && !audio.isMicActive) {
    emptyOverlay.style.display = "flex";
  } else {
    emptyOverlay.style.display = "none";
  }

  updateMenuState();

  if (Math.abs(targetScrollX - currentScrollX) >= 0.1) {
    requestAnimationFrame(renderView);
  }
}

function updateMenuState() {
  if (!activeEditor) return;

  if (activeEditor.filePath) {
    actionSave.classList.remove("disabled");
  } else {
    actionSave.classList.add("disabled");
  }

  const hasAudioData = audio.history.length > 0 || (activeEditor.pcmData && activeEditor.pcmData.length > 0);
  if (hasAudioData) {
    actionSaveAs.classList.remove("disabled");
  } else {
    actionSaveAs.classList.add("disabled");
  }

  if (actionToggleRecord) {
    actionToggleRecord.textContent = audio.isMicActive ? "マイク録音 停止" : "マイク録音 開始";
  }
}

function getCurrentPcmSamples() {
  if (audio.recordedPcmSamples.length > 0) {
    const total = audio.recordedPcmSamples.reduce((sum, c) => sum + c.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const c of audio.recordedPcmSamples) {
      pcm.set(c, offset);
      offset += c.length;
    }
    return pcm;
  }
  return activeEditor.pcmData || null;
}

async function persistCurrentEditor() {
  if (!activeEditor) return;
  activeEditor.history = audio.history;
  activeEditor.historyTimes = audio.historyTimes;
  activeEditor.pitchHistory = audio.pitchHistory;
  activeEditor.scrollX = currentScrollX;
  activeEditor.sampleRate = audio.getSampleRate();

  if (!activeEditor.filePath) {
    activeEditor.pcmData = getCurrentPcmSamples();
  }

  await saveEditorToStorage(activeEditor);
  await saveActiveEditorId(activeEditor.id);
  updateEditorListUI();
}

async function switchEditor(editor) {
  if (audio.isMicActive) audio.stopMic();
  if (audio.isPlaying) audio.stopPlayback();

  await persistCurrentEditor();

  activeEditor = editor;
  audio.history = editor.history || [];
  audio.historyTimes = editor.historyTimes || [];
  audio.pitchHistory = editor.pitchHistory || [];
  audio.recordedPcmSamples = editor.pcmData ? [editor.pcmData] : [];
  audio.fullBuffer = null;

  currentScrollX = editor.scrollX || 0;
  targetScrollX = currentScrollX;

  await saveActiveEditorId(activeEditor.id);
  updateEditorListUI();
  renderView();
  statusText.textContent = `エディタ: ${activeEditor.name}`;
}

async function createNewEditor() {
  await persistCurrentEditor();
  const num = editors.length + 1;
  const newEd = new EditorSession(null, `無題の解析 ${num}`);
  editors.push(newEd);
  await switchEditor(newEd);
}

// アプリ内メニュー & OSネイティブメニューバーの双方へエディタ一覧を同期
function updateEditorListUI() {
  // 1. HTML側のドロップダウンメニューを更新
  editorListContainer.innerHTML = "";
  editors.forEach((ed) => {
    const item = document.createElement("div");
    item.className = "menu-dropdown-item editor-item" + (ed.id === activeEditor.id ? " active" : "");
    item.innerHTML = `<span class="check-mark">${ed.id === activeEditor.id ? "✓" : ""}</span><span class="editor-name">${ed.name}</span>`;
    item.addEventListener("click", () => switchEditor(ed));
    editorListContainer.appendChild(item);
  });

  // 2. Mac/Windowsのネイティブメニューバーへ同期
  const payload = editors.map((e) => [e.id, e.name, e.id === activeEditor.id]);
  invokeTauri("sync_editor_menu", { editors: payload });
}

function isValidAudioFile(filename) {
  return /\.(wav|flac|mp3|ogg)$/i.test(filename);
}

async function triggerOpenFile() {
  try {
    const res = await invokeTauri("open_audio_file");
    if (res) {
      const [filePath, fileName, bytes] = res;
      const uint8 = new Uint8Array(bytes);
      await loadAudioFromBuffer(uint8.buffer, fileName, filePath);
      return;
    } else if (res === null) {
      return;
    }
  } catch (err) {
    console.warn("Native dialog fallback:", err);
  }

  fileInput.value = "";
  fileInput.click();
}

async function triggerSave() {
  if (!activeEditor || !activeEditor.filePath) return;
  const pcm = getCurrentPcmSamples();
  if (!pcm) {
    statusText.textContent = "保存する音声データがありません";
    return;
  }

  statusText.textContent = `上書き保存中: ${activeEditor.name}...`;
  try {
    const wavBlob = encodeWAV(pcm, audio.getSampleRate());
    const arrayBuffer = await wavBlob.arrayBuffer();
    const uint8 = Array.from(new Uint8Array(arrayBuffer));

    await invokeTauri("save_audio_file", {
      path: activeEditor.filePath,
      data: uint8
    });
    statusText.textContent = `上書き保存完了: ${activeEditor.name}`;
  } catch (err) {
    console.error("保存失敗:", err);
    statusText.textContent = "上書き保存に失敗しました: " + err.message;
  }
}

async function triggerSaveAs() {
  if (!activeEditor) return;
  const pcm = getCurrentPcmSamples();
  if (!pcm) {
    statusText.textContent = "保存する音声データがありません";
    return;
  }

  const baseName = activeEditor.name.replace(/\.[^/.]+$/, "") + ".wav";
  statusText.textContent = "保存先を選択中...";

  try {
    const wavBlob = encodeWAV(pcm, audio.getSampleRate());
    const arrayBuffer = await wavBlob.arrayBuffer();
    const uint8 = Array.from(new Uint8Array(arrayBuffer));

    const res = await invokeTauri("save_audio_file_as", {
      defaultName: baseName,
      data: uint8
    });

    if (res) {
      const [newPath, newName] = res;
      activeEditor.filePath = newPath;
      activeEditor.name = newName;
      await persistCurrentEditor();
      statusText.textContent = `保存完了: ${newName}`;
      return;
    } else if (res === null) {
      statusText.textContent = "保存をキャンセルしました";
      return;
    }
  } catch (err) {
    console.warn("Native save fallback:", err);
  }

  const wavBlob = encodeWAV(pcm, audio.getSampleRate());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(wavBlob);
  a.download = baseName;
  a.click();
  statusText.textContent = `ダウンロード保存しました: ${baseName}`;
}

async function triggerCloseEditor() {
  if (!activeEditor) return;
  await deleteEditorFromStorage(activeEditor.id);
  editors = editors.filter((e) => e.id !== activeEditor.id);
  if (editors.length > 0) {
    await switchEditor(editors[0]);
  } else {
    await createNewEditor();
  }
}

document.getElementById("actionNew").addEventListener("click", () => createNewEditor());
document.getElementById("actionOpen").addEventListener("click", () => triggerOpenFile());
actionSave.addEventListener("click", () => triggerSave());
actionSaveAs.addEventListener("click", () => triggerSaveAs());
document.getElementById("actionClose").addEventListener("click", () => triggerCloseEditor());

function attachKeepOpenAction(elementId, callback) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    callback();
  });
}

function zoomTime(factor) {
  const centerFrame = currentScrollX / frameWidth;
  const newWidth = Math.max(0.2, Math.min(30, frameWidth * factor));
  if (newWidth !== frameWidth) {
    frameWidth = newWidth;
    const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
    targetScrollX = Math.max(0, Math.min(maxScroll, centerFrame * frameWidth));
    currentScrollX = targetScrollX;
    renderView();
  }
}

attachKeepOpenAction("actionZoomInX", () => {
  zoomTime(1.3);
  statusText.textContent = "時間軸を拡大しました";
});
attachKeepOpenAction("actionZoomOutX", () => {
  zoomTime(1 / 1.3);
  statusText.textContent = "時間軸を縮小しました";
});
attachKeepOpenAction("actionZoomInY", () => {
  renderer.zoom(cssHeight / 2, -180, cssHeight);
  renderView();
  statusText.textContent = "周波数軸を拡大しました";
});
attachKeepOpenAction("actionZoomOutY", () => {
  renderer.zoom(cssHeight / 2, 180, cssHeight);
  renderView();
  statusText.textContent = "周波数軸を縮小しました";
});
attachKeepOpenAction("actionGainUp", () => {
  const percent = renderer.adjustColorGain(-150);
  renderView();
  statusText.textContent = `カラー感度: ${percent}%`;
});
attachKeepOpenAction("actionGainDown", () => {
  const percent = renderer.adjustColorGain(150);
  renderView();
  statusText.textContent = `カラー感度: ${percent}%`;
});
attachKeepOpenAction("actionResetZoom", () => {
  frameWidth = DEFAULT_FRAME_WIDTH;
  renderer.viewMinFreq = DEFAULT_MIN_FREQ;
  renderer.viewMaxFreq = DEFAULT_MAX_FREQ;
  renderer.colorGain = 1.0;
  renderer.rebuildBakedLUT();
  renderView();
  statusText.textContent = "拡大縮小・感度を初期値にリセットしました";
});

actionToggleRecord.addEventListener("click", () => toggleRecording());

// Macネイティブメニューバーからのイベント受信
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen("native-menu-event", (event) => {
    const id = event.payload;
    if (id === "menu_new") createNewEditor();
    else if (id === "menu_open") triggerOpenFile();
    else if (id === "menu_save") triggerSave();
    else if (id === "menu_save_as") triggerSaveAs();
    else if (id === "menu_close") triggerCloseEditor();
    else if (id === "menu_toggle_record") toggleRecording();
    else if (id === "menu_zoom_in_x") zoomTime(1.3);
    else if (id === "menu_zoom_out_x") zoomTime(1 / 1.3);
    else if (id === "menu_zoom_in_y") {
      renderer.zoom(cssHeight / 2, -180, cssHeight);
      renderView();
    } else if (id === "menu_zoom_out_y") {
      renderer.zoom(cssHeight / 2, 180, cssHeight);
      renderView();
    } else if (id === "menu_gain_up") {
      const p = renderer.adjustColorGain(-150);
      renderView();
      statusText.textContent = `カラー感度: ${p}%`;
    } else if (id === "menu_gain_down") {
      const p = renderer.adjustColorGain(150);
      renderView();
      statusText.textContent = `カラー感度: ${p}%`;
    } else if (id === "menu_reset_zoom") {
      frameWidth = DEFAULT_FRAME_WIDTH;
      renderer.viewMinFreq = DEFAULT_MIN_FREQ;
      renderer.viewMaxFreq = DEFAULT_MAX_FREQ;
      renderer.colorGain = 1.0;
      renderer.rebuildBakedLUT();
      renderView();
      statusText.textContent = "リセットしました";
    } else if (id.startsWith("select_editor:")) {
      const targetId = id.replace("select_editor:", "");
      const target = editors.find((e) => e.id === targetId);
      if (target) switchEditor(target);
    }
  });
}

// 非同期チャンク解析
async function loadAudioFromBuffer(arrayBuffer, fileName, filePath = null) {
  statusText.textContent = `デコード中: ${fileName}...`;
  audio.setupContext();

  try {
    audio.fullBuffer = await audio.ctx.decodeAudioData(arrayBuffer);
    audio.history = [];
    audio.historyTimes = [];
    audio.pitchHistory = [];

    const sampleRate = audio.fullBuffer.sampleRate;
    const pcmData = audio.fullBuffer.getChannelData(0);
    audio.recordedPcmSamples = [new Float32Array(pcmData)];

    const transformer = new (await import("./fft.js")).FastFourierTransformer(4096);
    const stepSamples = Math.round(sampleRate / 60);
    const totalSteps = Math.floor((pcmData.length - 4096) / stepSamples);

    const chunkSize = 250;
    for (let f = 0; f < totalSteps; f += chunkSize) {
      const end = Math.min(totalSteps, f + chunkSize);
      for (let i = f; i < end; i++) {
        const start = i * stepSamples;
        const slice = pcmData.subarray(start, start + 4096);
        const freqData = transformer.process(slice);
        audio.history.push(freqData);
        audio.historyTimes.push(start / sampleRate);

        const pitch = detectPitchFromSpectrum(freqData, sampleRate);
        audio.pitchHistory.push(pitch);
      }

      const percent = Math.round((end / totalSteps) * 100);
      statusText.textContent = `高精度FFT解析中 (${fileName}): ${percent}%`;
      await new Promise((r) => setTimeout(r, 0));
    }

    if (activeEditor && activeEditor.isNew && audio.history.length > 0) {
      activeEditor.name = fileName;
      activeEditor.isNew = false;
      activeEditor.filePath = filePath;
    } else {
      await persistCurrentEditor();
      const newEd = new EditorSession(null, fileName);
      newEd.isNew = false;
      newEd.filePath = filePath;
      editors.push(newEd);
      activeEditor = newEd;
    }

    currentScrollX = 0;
    targetScrollX = 0;
    await persistCurrentEditor();
    renderView();
    statusText.textContent = `解析完了: ${fileName} (Spaceキーで再生)`;
  } catch (err) {
    console.error("解析失敗:", err);
    statusText.textContent = "音声の解析に失敗しました: " + err.message;
  }
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) {
    const buffer = await file.arrayBuffer();
    await loadAudioFromBuffer(buffer, file.name, null);
  }
  fileInput.value = "";
});

async function toggleRecording() {
  if (audio.isMicActive) {
    audio.stopMic();
    centerMicBtn.innerHTML = "🎙️ マイク録音開始";
    centerMicBtn.classList.remove("recording");
    statusText.textContent = "録音停止 (Spaceキーで中央位置から再生)";
    updateMenuState();
    await persistCurrentEditor();
    renderView();
    return;
  }

  try {
    if (activeEditor) activeEditor.isNew = false;
    centerMicBtn.innerHTML = "⏹️ 録音停止";
    centerMicBtn.classList.add("recording");
    updateMenuState();
    statusText.textContent = "録音中... (Spaceキーまたはメニューから停止)";
    await audio.startMic(() => renderView());
  } catch (err) {
    console.error("マイクエラー:", err);
    statusText.textContent = "マイクへのアクセス失敗: " + err.message;
  }
}

centerMicBtn.addEventListener("click", toggleRecording);

// クリックイベント
spectrogramArea.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (mouseX <= KEYBOARD_WIDTH) {
    const clickedFreq = renderer.yToFreq(mouseY, cssHeight);
    const midiNote = Math.round(69 + 12 * Math.log2(clickedFreq / 440));
    const exactFreq = 440 * Math.pow(2, (midiNote - 69) / 12);
    audio.playPianoNote(exactFreq);
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midiNote / 12) - 1;
    statusText.textContent = `鍵盤演奏: ${noteNames[((midiNote % 12) + 12) % 12]}${octave} (${Math.round(exactFreq)}Hz)`;
    return;
  }

  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  if (mouseX > LEFT_MARGIN && mouseX < cssWidth - SPECTRUM_PANEL_WIDTH) {
    const halfGraph = Math.floor(graphWidth / 2);
    const graphX = mouseX - LEFT_MARGIN;

    if (audio.isPlaying) audio.stopPlayback();

    const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
    const newTarget = currentScrollX + (graphX - halfGraph);
    targetScrollX = Math.max(0, Math.min(maxScroll, newTarget));

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
      const percent = renderer.adjustColorGain(e.deltaY);
      statusText.textContent = `カラー感度: ${percent}%`;
    } else if (e.ctrlKey || e.metaKey) {
      renderer.zoom(mouseY, e.deltaY, cssHeight);
    } else {
      renderer.pan(e.deltaY, cssHeight);
    }
    renderView();
    return;
  }

  const graphWidth = cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH;
  const halfGraph = Math.floor(graphWidth / 2);
  const graphX = mouseX - LEFT_MARGIN;

  if (e.ctrlKey || e.metaKey) {
    const cursorFrame = (currentScrollX + (graphX - halfGraph)) / frameWidth;
    const zoomSpeed = e.shiftKey ? 0.0006 : 0.002;
    const zoomFactor = Math.pow(1 + zoomSpeed, -e.deltaY);
    const newFrameWidth = Math.max(0.2, Math.min(30, frameWidth * zoomFactor));

    if (newFrameWidth !== frameWidth) {
      frameWidth = newFrameWidth;
      const newMaxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
      const newScroll = cursorFrame * frameWidth - (graphX - halfGraph);
      targetScrollX = Math.max(0, Math.min(newMaxScroll, newScroll));
      currentScrollX = targetScrollX;
    }
    renderView();
    return;
  }

  if (audio.isPlaying) audio.stopPlayback();

  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const scrollSpeed = e.shiftKey ? 0.28 : 1.1;
  targetScrollX = Math.max(0, Math.min(maxScroll, targetScrollX + delta * scrollSpeed));
  requestAnimationFrame(renderView);
}, { passive: false });

scrollContainer.addEventListener("scroll", () => {
  if (Math.abs(scrollContainer.scrollLeft - currentScrollX) > 2) {
    targetScrollX = scrollContainer.scrollLeft;
    currentScrollX = targetScrollX;
    renderView();
  }
});

function getCenterTimeSec() {
  if (audio.history.length === 0) return 0;
  const centerFrame = Math.round(currentScrollX / frameWidth);
  const clamped = Math.max(0, Math.min(audio.history.length - 1, centerFrame));
  return audio.historyTimes[clamped] || 0;
}

// Spaceキー
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    if (audio.isMicActive) {
      toggleRecording();
    } else if (audio.isPlaying) {
      audio.stopPlayback();
      statusText.textContent = `一時停止: ${getCenterTimeSec().toFixed(2)}s`;
      renderView();
    } else {
      const startSec = getCenterTimeSec();
      const started = audio.startPlayback(
        startSec,
        (frameIdx) => {
          targetScrollX = frameIdx * frameWidth;
          currentScrollX = targetScrollX;
          renderView();
        },
        () => {
          statusText.textContent = "再生終了";
          renderView();
        }
      );
      if (started) {
        statusText.textContent = `再生中: ${startSec.toFixed(2)}s 〜 (Spaceで一時停止)`;
      }
    }
  }
});

// 初期化
async function initializeApp() {
  const savedEditors = await loadAllEditorsFromStorage();
  const lastActiveId = await getActiveEditorId();

  if (savedEditors && savedEditors.length > 0) {
    editors = savedEditors.map((d) => {
      const ed = new EditorSession(d.id, d.name);
      ed.history = d.history || [];
      ed.historyTimes = d.historyTimes || [];
      ed.pitchHistory = d.pitchHistory || [];
      ed.pcmData = d.pcmData || null;
      ed.sampleRate = d.sampleRate || 44100;
      ed.scrollX = d.scrollX || 0;
      ed.isNew = d.isNew !== undefined ? d.isNew : false;
      ed.filePath = d.filePath || null;
      return ed;
    });
    const target = editors.find((e) => e.id === lastActiveId) || editors[0];
    await switchEditor(target);
  } else {
    await createNewEditor();
  }
  resizeCanvas();
}

initializeApp();