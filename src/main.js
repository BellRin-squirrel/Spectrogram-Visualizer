let audioCtx = null;
let analyser = null;
let micStream = null;
let sourceNode = null;
let isMicActive = false;
let animationId = null;

// 音声履歴データ (Uint8Array の配列)
let audioHistory = [];
let autoScroll = true;

const micBtn = document.getElementById("micBtn");
const fileInput = document.getElementById("fileInput");
const clearBtn = document.getElementById("clearBtn");
const autoScrollBtn = document.getElementById("autoScrollBtn");
const audioElement = document.getElementById("audioElement");
const audioCtrlWrapper = document.getElementById("audioCtrlWrapper");
const statusText = document.getElementById("statusText");

const spectrogramArea = document.getElementById("spectrogramArea");
const canvas = document.getElementById("spectrogramCanvas");
const ctx = canvas.getContext("2d");

const scrollContainer = document.getElementById("scrollContainer");
const scrollDummy = document.getElementById("scrollDummy");

// 設定パラメータ
const FFT_SIZE = 4096;          // 周波数解像度向上のため4096
const FRAME_WIDTH = 2;          // 1スライスの横幅 (px)
const AXIS_WIDTH = 65;          // 縦軸（周波数ラベル）の描画幅 (px)
const MIN_FREQ = 50;            // 対数軸の下限 (Hz)
const MAX_FREQ = 10000;         // 対数軸の上限 (10kHz)

// 指定されたカラーパレット用 LUT（ルックアップテーブル）を生成
// 音量大 -> 赤, 橙, 黄, 黄緑, 青, 濃い青 -> 音量極小
const COLOR_LUT = new Array(256);
(function initColorLUT() {
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r, g, b;

    if (t < 0.2) {
      // 濃い青 (10, 15, 65) -> 青 (20, 75, 230)
      const p = t / 0.2;
      r = Math.floor(10 + p * 10);
      g = Math.floor(15 + p * 60);
      b = Math.floor(65 + p * 165);
    } else if (t < 0.45) {
      // 青 (20, 75, 230) -> 黄緑 (40, 210, 45)
      const p = (t - 0.2) / 0.25;
      r = Math.floor(20 + p * 20);
      g = Math.floor(75 + p * 135);
      b = Math.floor(230 - p * 185);
    } else if (t < 0.7) {
      // 黄緑 (40, 210, 45) -> 黄 (255, 235, 0)
      const p = (t - 0.45) / 0.25;
      r = Math.floor(40 + p * 215);
      g = Math.floor(210 + p * 25);
      b = Math.floor(45 - p * 45);
    } else if (t < 0.88) {
      // 黄 (255, 235, 0) -> 橙 (255, 125, 0)
      const p = (t - 0.7) / 0.18;
      r = 255;
      g = Math.floor(235 - p * 110);
      b = 0;
    } else {
      // 橙 (255, 125, 0) -> 赤 (255, 20, 20)
      const p = (t - 0.88) / 0.12;
      r = 255;
      g = Math.floor(125 - p * 105);
      b = Math.floor(p * 20);
    }
    COLOR_LUT[i] = `rgb(${r},${g},${b})`;
  }
})();

// キャンバスのリサイズ対応
function resizeCanvas() {
  canvas.width = spectrogramArea.clientWidth;
  canvas.height = spectrogramArea.clientHeight;
  renderView();
}
window.addEventListener("resize", resizeCanvas);

// AudioContext の初期化
function setupAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.15;
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

// 描画更新: 画面内に見えるフレームだけを描画（超高速）
function renderView() {
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;

  ctx.fillStyle = "#060913";
  ctx.fillRect(0, 0, w, h);

  const graphWidth = w - AXIS_WIDTH;
  const totalFrames = audioHistory.length;
  const dummyWidth = Math.max(graphWidth, totalFrames * FRAME_WIDTH);
  scrollDummy.style.width = `${dummyWidth}px`;

  // 自動スクロール処理
  if (autoScroll && totalFrames * FRAME_WIDTH > graphWidth) {
    scrollContainer.scrollLeft = dummyWidth - graphWidth;
  }

  const scrollLeft = scrollContainer.scrollLeft;

  // 画面内に収まるフレームのインデックス範囲を計算
  const startFrame = Math.max(0, Math.floor(scrollLeft / FRAME_WIDTH));
  const visibleFrameCount = Math.ceil(graphWidth / FRAME_WIDTH) + 1;
  const endFrame = Math.min(totalFrames, startFrame + visibleFrameCount);

  const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
  const nyquist = sampleRate / 2;
  const bufferLength = FFT_SIZE / 2;

  // 対数スケールマッピング事前計算 (各y座標におけるFFTビン番号)
  const logBinMap = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    // 上(y=0)がMAX_FREQ、下(y=h-1)がMIN_FREQ
    const ratio = (h - 1 - y) / (h - 1);
    const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, ratio);
    const bin = Math.round((freq / nyquist) * bufferLength);
    logBinMap[y] = Math.max(0, Math.min(bufferLength - 1, bin));
  }

  // スペクトログラムの描画
  for (let f = startFrame; f < endFrame; f++) {
    const frameData = audioHistory[f];
    const x = AXIS_WIDTH + (f * FRAME_WIDTH - scrollLeft);

    // 縦1列ごとにピクセル描画
    let currentY = 0;
    while (currentY < h) {
      const binIdx = logBinMap[currentY];
      const val = frameData[binIdx];
      ctx.fillStyle = COLOR_LUT[val];

      // 同じビンが連続する高周波帯はまとめて塗りつぶす（描画最適化）
      let nextY = currentY + 1;
      while (nextY < h && logBinMap[nextY] === binIdx) {
        nextY++;
      }
      ctx.fillRect(x, currentY, FRAME_WIDTH, nextY - currentY);
      currentY = nextY;
    }
  }

  // 縦軸（対数周波数スケールとグリッド線）の描画
  drawFrequencyAxis(h, graphWidth);
}

// 片対数スケールの軸・グリッド描画
function drawFrequencyAxis(h, graphWidth) {
  // 背景マスク
  ctx.fillStyle = "#18181b";
  ctx.fillRect(0, 0, AXIS_WIDTH, h);
  ctx.strokeStyle = "#29292e";
  ctx.beginPath();
  ctx.moveTo(AXIS_WIDTH, 0);
  ctx.lineTo(AXIS_WIDTH, h);
  ctx.stroke();

  // 表示する代表周波数
  const ticks = [
    { freq: 10000, label: "10 kHz" },
    { freq: 5000, label: "5 kHz" },
    { freq: 2000, label: "2 kHz" },
    { freq: 1000, label: "1 kHz" },
    { freq: 500, label: "500 Hz" },
    { freq: 200, label: "200 Hz" },
    { freq: 100, label: "100 Hz" },
    { freq: 50, label: "50 Hz" },
  ];

  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  ticks.forEach((tick) => {
    // 対数座標計算
    const ratio = (Math.log10(tick.freq) - Math.log10(MIN_FREQ)) / (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ));
    const y = Math.round(h - 1 - ratio * (h - 1));

    // グリッド破線（データ表示部）
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(AXIS_WIDTH, y);
    ctx.lineTo(AXIS_WIDTH + graphWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 軸の目盛線
    ctx.strokeStyle = "#7c7c8a";
    ctx.beginPath();
    ctx.moveTo(AXIS_WIDTH - 6, y);
    ctx.lineTo(AXIS_WIDTH, y);
    ctx.stroke();

    // 目盛テキスト
    ctx.fillStyle = "#8d8d99";
    ctx.fillText(tick.label, AXIS_WIDTH - 8, y);
  });
}

// 録音・再生中のデータ収集ループ
function processAudioLoop() {
  animationId = requestAnimationFrame(processAudioLoop);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  // 履歴にフレームを追加
  audioHistory.push(dataArray);

  renderView();
}

// ユーザーがスクロールした時の処理
scrollContainer.addEventListener("scroll", () => {
  const maxScroll = scrollDummy.clientWidth - (canvas.width - AXIS_WIDTH);
  // スクロールバーが右端（最新）から離れた場合は追従を自動OFF
  if (Math.abs(scrollContainer.scrollLeft - maxScroll) > 10) {
    if (autoScroll) {
      setAutoScroll(false);
    }
  } else {
    if (!autoScroll) {
      setAutoScroll(true);
    }
  }
  renderView();
});

// マウスホイールで横スクロール可能にする
spectrogramArea.addEventListener("wheel", (e) => {
  e.preventDefault();
  scrollContainer.scrollLeft += e.deltaY;
  renderView();
});

function setAutoScroll(state) {
  autoScroll = state;
  if (autoScroll) {
    autoScrollBtn.classList.add("active");
    autoScrollBtn.textContent = "追従: ON";
  } else {
    autoScrollBtn.classList.remove("active");
    autoScrollBtn.textContent = "追従: OFF";
  }
}

autoScrollBtn.addEventListener("click", () => {
  setAutoScroll(!autoScroll);
  if (autoScroll) {
    renderView();
  }
});

clearBtn.addEventListener("click", () => {
  audioHistory = [];
  scrollContainer.scrollLeft = 0;
  renderView();
  statusText.textContent = "履歴をクリアしました";
});

// マイク録音トグル
micBtn.addEventListener("click", async () => {
  setupAudioContext();

  if (isMicActive) {
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
    }
    cancelAnimationFrame(animationId);
    isMicActive = false;
    micBtn.textContent = "マイク録音 開始";
    micBtn.classList.remove("active");
    statusText.textContent = "録音停止";
    return;
  }

  audioElement.pause();
  audioCtrlWrapper.style.display = "none";

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (sourceNode) sourceNode.disconnect();
    sourceNode = audioCtx.createMediaStreamSource(micStream);
    sourceNode.connect(analyser);

    isMicActive = true;
    setAutoScroll(true);
    micBtn.textContent = "録音 停止";
    micBtn.classList.add("active");
    statusText.textContent = "リアルタイム録音中... (最大10kHz・片対数)";
    processAudioLoop();
  } catch (err) {
    console.error("マイクエラー:", err);
    statusText.textContent = "マイクへのアクセス失敗: " + err.message;
  }
});

// 音声ファイル読み込み
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  setupAudioContext();

  if (isMicActive) {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    isMicActive = false;
    micBtn.textContent = "マイク録音 開始";
    micBtn.classList.remove("active");
  }

  const objectUrl = URL.createObjectURL(file);
  audioElement.src = objectUrl;
  audioCtrlWrapper.style.display = "block";

  if (sourceNode) sourceNode.disconnect();
  sourceNode = audioCtx.createMediaElementSource(audioElement);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  statusText.textContent = `読み込み完了: ${file.name}`;

  audioElement.onplay = () => {
    cancelAnimationFrame(animationId);
    setAutoScroll(true);
    processAudioLoop();
    statusText.textContent = `再生中: ${file.name}`;
  };

  audioElement.onpause = () => {
    cancelAnimationFrame(animationId);
    statusText.textContent = `一時停止: ${file.name}`;
  };

  audioElement.onended = () => {
    cancelAnimationFrame(animationId);
    statusText.textContent = `再生終了: ${file.name}`;
  };
});

// 初期リサイズと描画実行
resizeCanvas();