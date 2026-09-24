import { DEFAULT_FRAME_WIDTH, LEFT_MARGIN } from "./constants.js";
import { AudioManager } from "./audio.js";
import { SpectrogramRenderer } from "./renderer.js";

// DOM 要素
const micBtn = document.getElementById("micBtn");
const fileInput = document.getElementById("fileInput");
const clearBtn = document.getElementById("clearBtn");
const centerLockBtn = document.getElementById("centerLockBtn");
const statusText = document.getElementById("statusText");

const spectrogramArea = document.getElementById("spectrogramArea");
const canvas = document.getElementById("spectrogramCanvas");
const scrollContainer = document.getElementById("scrollContainer");
const scrollDummy = document.getElementById("scrollDummy");

// インスタンス化
const audio = new AudioManager();
const renderer = new SpectrogramRenderer(canvas);

// 状態変数
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
  const graphWidth = cssWidth - LEFT_MARGIN;
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

  if (!centerLock && Math.abs(targetScrollX - currentScrollX) >= 0.1) {
    requestAnimationFrame(renderView);
  }
}

// クリック時: クリック位置が中央に来るように移動
spectrogramArea.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  if (mouseX <= LEFT_MARGIN) return;

  const graphWidth = cssWidth - LEFT_MARGIN;
  const halfGraph = Math.floor(graphWidth / 2);
  const graphX = mouseX - LEFT_MARGIN;

  if (centerLock) setCenterLock(false);
  if (audio.isPlaying) audio.stopPlayback();

  const maxScroll = Math.max(0, (audio.history.length - 1) * frameWidth);
  const newTarget = currentScrollX + (graphX - halfGraph);
  targetScrollX = Math.max(0, Math.min(maxScroll, newTarget));

  requestAnimationFrame(renderView);
});

// マウスホイール (拡大縮小・スクロール・感度調整)
spectrogramArea.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // 1. スペクトル描画領域外（左側の鍵盤・目盛りエリア）での操作
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

  // 2. スペクトル描画領域内での操作
  const graphWidth = cssWidth - LEFT_MARGIN;
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

  // 左右方向の時間移動
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

clearBtn.addEventListener("click", () => {
  audio.clear();
  currentScrollX = 0;
  targetScrollX = 0;
  scrollContainer.scrollLeft = 0;
  renderView();
  statusText.textContent = "履歴をクリアしました";
});

// マイク録音トグル
micBtn.addEventListener("click", async () => {
  if (audio.isMicActive) {
    audio.stopMic();
    micBtn.textContent = "マイク録音 開始";
    micBtn.classList.remove("active");
    statusText.textContent = "録音停止 (Spaceキーで中央位置から再生可能)";
    renderView();
    return;
  }

  try {
    setCenterLock(true);
    micBtn.textContent = "録音 停止";
    micBtn.classList.add("active");
    statusText.textContent = "録音中... (Spaceキーで録音停止)";
    await audio.startMic(() => renderView());
  } catch (err) {
    console.error("マイクエラー:", err);
    statusText.textContent = "マイクへのアクセス失敗: " + err.message;
  }
});

function getCenterTimeSec() {
  if (audio.history.length === 0) return 0;
  const centerFrame = Math.round(currentScrollX / frameWidth);
  const clamped = Math.max(0, Math.min(audio.history.length - 1, centerFrame));
  return audio.historyTimes[clamped] || 0;
}

// Spaceキーのハンドリング
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT") {
    e.preventDefault();
    if (audio.isMicActive) {
      micBtn.click();
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

// ファイル読込
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  statusText.textContent = `高精度FFT解析中: ${file.name}...`;
  try {
    await audio.parseAudioFile(file);
    currentScrollX = 0;
    targetScrollX = 0;
    setCenterLock(false);
    renderView();
    statusText.textContent = `解析完了: ${file.name} (クリックで位置指定、Spaceで再生)`;
  } catch (err) {
    console.error("ファイル読込失敗:", err);
    statusText.textContent = "音声ファイルの解析に失敗しました: " + err.message;
  }
});

// 初期リサイズ
resizeCanvas();