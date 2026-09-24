import { DEFAULT_FRAME_WIDTH, DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, KEYBOARD_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH } from "./constants.js";
import { AudioManager, encodeWAV } from "./audio.js";
import { SpectrogramRenderer } from "./renderer.js";
import {
  saveEditorToStorage, deleteEditorFromStorage,
  loadAllEditorsFromStorage, saveActiveEditorId, getActiveEditorId
} from "./db.js";

// DOM 要素
const statusText = document.getElementById("statusText");
const centerLockBtn = document.getElementById("centerLockBtn");
const spectrogramArea = document.getElementById("spectrogramArea");
const canvas = document.getElementById("spectrogramCanvas");
const scrollContainer = document.getElementById("scrollContainer");
const scrollDummy = document.getElementById("scrollDummy");

const fileTabBtn = document.getElementById("fileTabBtn");
const fileMenuDropdown = document.getElementById("fileMenuDropdown");
const editorListContainer = document.getElementById("editorListContainer");
const editTabBtn = document.getElementById("editTabBtn");
const editMenuDropdown = document.getElementById("editMenuDropdown");
const viewTabBtn = document.getElementById("viewTabBtn");
const viewMenuDropdown = document.getElementById("viewMenuDropdown");
const actionToggleRecord = document.getElementById("actionToggleRecord");
const actionSave = document.getElementById("actionSave");
const actionSaveAs = document.getElementById("actionSaveAs");

const emptyOverlay = document.getElementById("emptyOverlay");
const centerMicBtn = document.getElementById("centerMicBtn");
const fileInput = document.getElementById("fileInput");

// インスタンス化
const audio = new AudioManager();
const renderer = new SpectrogramRenderer(canvas);

class EditorSession {
  constructor(id, name) {
    this.id = id || "editor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    this.name = name || "無題の解析";
    this.history = [];
    this.historyTimes = [];
    this.pcmData = null;
    this.sampleRate = 44100;
    this.scrollX = 0;
    this.isNew = true;
    this.fileHandle = null;
  }
}

let editors = [];
let activeEditor = null;

let frameWidth = DEFAULT_FRAME_WIDTH;
let centerLock = true;
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

  if (centerLock) {
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
    audio.history, currentScrollX, audio.getSampleRate(), audio.isPlaying,
    frameWidth
  );

  if (activeEditor && activeEditor.isNew && audio.history.length === 0 && !audio.isMicActive) {
    emptyOverlay.style.display = "flex";
  } else {
    emptyOverlay.style.display = "none";
  }

  updateMenuState();

  if (!centerLock && Math.abs(targetScrollX - currentScrollX) >= 0.1) {
    requestAnimationFrame(renderView);
  }
}

function updateMenuState() {
  if (!activeEditor) return;

  if (activeEditor.fileHandle) {
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
  activeEditor.scrollX = currentScrollX;
  activeEditor.sampleRate = audio.getSampleRate();
  activeEditor.pcmData = getCurrentPcmSamples();

  const dbData = { ...activeEditor, fileHandle: null };
  await saveEditorToStorage(dbData);
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
  audio.recordedPcmSamples = editor.pcmData ? [editor.pcmData] : [];
  audio.fullBuffer = null;

  currentScrollX = editor.scrollX || 0;
  targetScrollX = currentScrollX;
  setCenterLock(false);

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

function updateEditorListUI() {
  editorListContainer.innerHTML = "";
  editors.forEach((ed) => {
    const item = document.createElement("div");
    item.className = "menu-dropdown-item editor-item" + (ed.id === activeEditor.id ? " active" : "");
    item.innerHTML = `<span class="check-mark">${ed.id === activeEditor.id ? "✓" : ""}</span><span class="editor-name">${ed.name}</span>`;
    item.addEventListener("click", () => {
      switchEditor(ed);
    });
    editorListContainer.appendChild(item);
  });
}

// ファイルメニュー
document.getElementById("actionNew").addEventListener("click", () => createNewEditor());

document.getElementById("actionOpen").addEventListener("click", async () => {
  if (window.showOpenFilePicker) {
    try {
      // 厳密に4形式のみ指定
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: "対応音声ファイル (*.wav, *.flac, *.mp3, *.ogg)",
          accept: {
            "audio/wav": [".wav"],
            "audio/flac": [".flac"],
            "audio/mpeg": [".mp3"],
            "audio/ogg": [".ogg"]
          }
        }],
        excludeAcceptAllOption: true
      });
      const file = await handle.getFile();
      if (isValidAudioFile(file.name)) {
        await loadAudioIntoEditor(file, handle);
      }
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  fileInput.click();
});

function isValidAudioFile(filename) {
  return /\.(wav|flac|mp3|ogg)$/i.test(filename);
}

// 上書き保存
actionSave.addEventListener("click", async () => {
  if (!activeEditor || !activeEditor.fileHandle) return;
  const pcm = getCurrentPcmSamples();
  if (!pcm) {
    statusText.textContent = "保存する音声データがありません";
    return;
  }

  statusText.textContent = `上書き保存中: ${activeEditor.name}...`;
  try {
    const wavBlob = encodeWAV(pcm, audio.getSampleRate());
    const writable = await activeEditor.fileHandle.createWritable();
    await writable.write(wavBlob);
    await writable.close();
    statusText.textContent = `上書き保存完了: ${activeEditor.name}`;
  } catch (err) {
    console.error("保存失敗:", err);
    statusText.textContent = "上書き保存に失敗しました: " + err.message;
  }
});

// 名前を付けて保存
actionSaveAs.addEventListener("click", async () => {
  if (!activeEditor) return;
  const pcm = getCurrentPcmSamples();
  if (!pcm) {
    statusText.textContent = "保存する音声データがありません";
    return;
  }

  const baseName = activeEditor.name.replace(/\.[^/.]+$/, "");
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${baseName}.wav`,
        types: [
          { description: "WAV Audio (.wav)", accept: { "audio/wav": [".wav"] } },
          { description: "FLAC Audio (.flac)", accept: { "audio/flac": [".flac"] } },
          { description: "MP3 Audio (.mp3)", accept: { "audio/mp3": [".mp3"] } },
          { description: "OGG Audio (.ogg)", accept: { "audio/ogg": [".ogg"] } }
        ]
      });

      const wavBlob = encodeWAV(pcm, audio.getSampleRate());
      const writable = await handle.createWritable();
      await writable.write(wavBlob);
      await writable.close();

      activeEditor.name = handle.name;
      activeEditor.fileHandle = handle;
      await persistCurrentEditor();
      statusText.textContent = `保存完了: ${handle.name}`;
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }

  const wavBlob = encodeWAV(pcm, audio.getSampleRate());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(wavBlob);
  a.download = `${baseName}.wav`;
  a.click();
  statusText.textContent = `ダウンロード保存しました: ${baseName}.wav`;
});

document.getElementById("actionClose").addEventListener("click", async () => {
  if (!activeEditor) return;
  await deleteEditorFromStorage(activeEditor.id);
  editors = editors.filter((e) => e.id !== activeEditor.id);
  if (editors.length > 0) {
    await switchEditor(editors[0]);
  } else {
    await createNewEditor();
  }
});

// 表示メニュー (クリックしても閉じないズーム＆感度調整)
function attachKeepOpenAction(elementId, callback) {
  const el = document.getElementById(elementId);
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
    if (centerLock) setCenterLock(false);
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
  renderView();
  statusText.textContent = "拡大縮小・感度を初期値にリセットしました";
});

// 編集メニュー: 録音
actionToggleRecord.addEventListener("click", () => toggleRecording());

async function loadAudioIntoEditor(file, handle = null) {
  if (!isValidAudioFile(file.name)) {
    statusText.textContent = "非対応の形式です (.wav, .flac, .mp3, .ogg のみ対応)";
    return;
  }
  statusText.textContent = `高精度FFT解析中: ${file.name}...`;
  try {
    if (activeEditor && activeEditor.isNew && audio.history.length === 0) {
      activeEditor.name = file.name;
      activeEditor.isNew = false;
      activeEditor.fileHandle = handle;
    } else {
      await persistCurrentEditor();
      const newEd = new EditorSession(null, file.name);
      newEd.isNew = false;
      newEd.fileHandle = handle;
      editors.push(newEd);
      activeEditor = newEd;
    }

    await audio.parseAudioFile(file);
    currentScrollX = 0;
    targetScrollX = 0;
    setCenterLock(false);
    await persistCurrentEditor();
    renderView();
    statusText.textContent = `解析完了: ${file.name} (Spaceキーで再生)`;
  } catch (err) {
    console.error("ファイル読込失敗:", err);
    statusText.textContent = "音声ファイルの解析に失敗しました: " + err.message;
  }
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await loadAudioIntoEditor(file, null);
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
    setCenterLock(true);
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

    if (centerLock) setCenterLock(false);
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
      if (centerLock) setCenterLock(false);
    }
    renderView();
    return;
  }

  if (centerLock) setCenterLock(false);
  if (audio.isPlaying) audio.stopPlayback();

  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const scrollSpeed = e.shiftKey ? 0.28 : 1.1;
  targetScrollX = Math.max(0, Math.min(maxScroll, targetScrollX + delta * scrollSpeed));
  requestAnimationFrame(renderView);
}, { passive: false });

scrollContainer.addEventListener("scroll", () => {
  if (!centerLock && Math.abs(scrollContainer.scrollLeft - currentScrollX) > 2) {
    targetScrollX = scrollContainer.scrollLeft;
    currentScrollX = targetScrollX;
    renderView();
  }
});

function setCenterLock(state) {
  centerLock = state;
  centerLockBtn.classList.toggle("active", centerLock);
  centerLockBtn.textContent = centerLock ? "中央追従: ON" : "中央追従: OFF";
}

centerLockBtn.addEventListener("click", () => {
  setCenterLock(!centerLock);
  if (centerLock) {
    targetScrollX = Math.max(0, (audio.history.length - 1) * frameWidth);
    currentScrollX = targetScrollX;
  }
  renderView();
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
        setCenterLock(false);
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
      ed.pcmData = d.pcmData || null;
      ed.sampleRate = d.sampleRate || 44100;
      ed.scrollX = d.scrollX || 0;
      ed.isNew = d.isNew !== undefined ? d.isNew : false;
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