import {
  FFT_SIZE, KEYBOARD_WIDTH, AXIS_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH, TIME_AXIS_HEIGHT,
  DATA_MIN_FREQ, DATA_MAX_FREQ, VIEW_LIMIT_MIN, VIEW_LIMIT_MAX,
  DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, COLOR_LUT_32
} from "./constants.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export class SpectrogramRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.viewMinFreq = DEFAULT_MIN_FREQ;
    this.viewMaxFreq = DEFAULT_MAX_FREQ;
    this.baseGain = 1.47;
    this.colorGain = 1.0;
    this.spectrumProfileScale = 1.0;

    this.bakedColorLUT = new Uint32Array(256);
    this.rebuildBakedLUT();

    this.cachedImgData = null;
    this.cachedImgW = 0;
    this.cachedImgH = 0;
    this.offCanvas = document.createElement("canvas");
    this.offCtx = this.offCanvas.getContext("2d");
  }

  rebuildBakedLUT() {
    const effectiveGain = this.baseGain * this.colorGain;
    for (let i = 0; i < 256; i++) {
      const adjusted = Math.max(0, Math.min(255, Math.round(i * effectiveGain)));
      this.bakedColorLUT[i] = COLOR_LUT_32[adjusted];
    }
  }

  freqToY(freq, h) {
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const ratio = (Math.log10(freq) - lMin) / (lMax - lMin);
    return (1 - ratio) * h;
  }

  yToFreq(y, h) {
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const ratio = 1 - (y / h);
    return Math.pow(10, lMin + ratio * (lMax - lMin));
  }

  freqToNearestNote(freq) {
    if (!freq || freq <= 0) return "";
    const midiNote = Math.round(69 + 12 * Math.log2(freq / 440));
    const noteInOct = ((midiNote % 12) + 12) % 12;
    const octave = Math.floor(midiNote / 12) - 1;
    return `${NOTE_NAMES[noteInOct]}${octave}`;
  }

  zoom(mouseY, deltaY, cssHeight) {
    const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const lSpan = lMax - lMin;
    const absLMin = Math.log10(VIEW_LIMIT_MIN);
    const absLMax = Math.log10(VIEW_LIMIT_MAX);

    const ratio = Math.max(0, Math.min(1, (effH - mouseY) / effH));
    const lCursor = lMin + ratio * lSpan;
    const zoomFactor = Math.pow(1.002, deltaY);

    let newSpan = Math.max(0.15, Math.min(absLMax - absLMin, lSpan * zoomFactor));
    let newLMin = lCursor - ratio * newSpan;
    let newLMax = lCursor + (1 - ratio) * newSpan;

    if (newLMin < absLMin) { newLMin = absLMin; newLMax = newLMin + newSpan; }
    if (newLMax > absLMax) { newLMax = absLMax; newLMin = newLMax - newSpan; }

    this.viewMinFreq = Math.pow(10, newLMin);
    this.viewMaxFreq = Math.pow(10, newLMax);
  }

  pan(deltaY, cssHeight) {
    const effH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const lSpan = lMax - lMin;
    const absLMin = Math.log10(VIEW_LIMIT_MIN);
    const absLMax = Math.log10(VIEW_LIMIT_MAX);

    const shift = (-deltaY / effH) * lSpan * 0.45;
    let newLMin = lMin + shift;
    let newLMax = lMax + shift;

    if (newLMin < absLMin) { newLMin = absLMin; newLMax = newLMin + lSpan; }
    if (newLMax > absLMax) { newLMax = absLMax; newLMin = newLMax - lSpan; }

    this.viewMinFreq = Math.pow(10, newLMin);
    this.viewMaxFreq = Math.pow(10, newLMax);
  }

  adjustColorGain(deltaY) {
    const factor = Math.pow(1.002, -deltaY);
    this.colorGain = Math.max(0.2, Math.min(4.0, this.colorGain * factor));
    this.rebuildBakedLUT();
    return Math.round(this.colorGain * 100);
  }

  adjustProfileScale(deltaY) {
    const factor = Math.pow(1.002, -deltaY);
    this.spectrumProfileScale = Math.max(0.2, Math.min(5.0, this.spectrumProfileScale * factor));
    return Math.round(this.spectrumProfileScale * 100);
  }

  render(cssWidth, cssHeight, dpr, audioHistory, pitchHistory, audioHistoryTimes, currentScrollX, sampleRate, isPlaying, frameWidth = 2, filterManager = null, hoverCrosshair = null) {
    const graphWidth = Math.floor(cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH);
    if (graphWidth <= 0 || cssHeight <= 0) return;

    // スペクトログラム有効高さ (下部時間軸ルーラーを除く)
    const effectiveH = Math.max(10, cssHeight - TIME_AXIS_HEIGHT);

    const halfGraph = Math.floor(graphWidth / 2);
    const imgW = graphWidth;
    const imgH = effectiveH;

    if (!this.cachedImgData || this.cachedImgW !== imgW || this.cachedImgH !== imgH) {
      this.cachedImgW = imgW;
      this.cachedImgH = imgH;
      this.cachedImgData = this.ctx.createImageData(imgW, imgH);
      this.offCanvas.width = imgW;
      this.offCanvas.height = imgH;
    }

    const data32 = new Uint32Array(this.cachedImgData.data.buffer);
    data32.fill(0xff0d0906);

    const nyquist = sampleRate / 2;
    const bufferLength = FFT_SIZE / 2;

    const sampleMap = new Array(imgH);
    for (let py = 0; py < imgH; py++) {
      const ratioTop = (imgH - 1 - py) / (imgH - 1);
      const freq = this.viewMinFreq * Math.pow(this.viewMaxFreq / this.viewMinFreq, ratioTop);
      const isOutOfRange = (freq < DATA_MIN_FREQ) || (freq > DATA_MAX_FREQ) || (freq > nyquist);

      if (isOutOfRange) {
        sampleMap[py] = { isOutOfRange: true };
        continue;
      }

      const exactBin = (freq / nyquist) * bufferLength;
      const b0 = Math.max(0, Math.min(bufferLength - 1, Math.floor(exactBin)));
      const b1 = Math.max(0, Math.min(bufferLength - 1, b0 + 1));
      sampleMap[py] = {
        isOutOfRange: false,
        b0, b1,
        frac: exactBin - b0
      };
    }

    const totalFrames = audioHistory.length;
    const bakedLUT = this.bakedColorLUT;

    for (let px = 0; px < imgW; px++) {
      const fFloat = (currentScrollX - halfGraph + px) / frameWidth;
      const f0 = Math.floor(fFloat);
      const f1 = f0 + 1;
      const wt = fFloat - f0;

      if (f0 < 0 || f0 >= totalFrames) continue;

      const frame0 = audioHistory[f0];
      const frame1 = f1 < totalFrames ? audioHistory[f1] : frame0;

      for (let py = 0; py < imgH; py++) {
        const smp = sampleMap[py];
        if (smp.isOutOfRange) continue;

        const v0 = frame0[smp.b0] * (1 - smp.frac) + frame0[smp.b1] * smp.frac;
        const v1 = frame1[smp.b0] * (1 - smp.frac) + frame1[smp.b1] * smp.frac;
        const val = Math.floor(v0 * (1 - wt) + v1 * wt);

        data32[py * imgW + px] = bakedLUT[val];
      }
    }

    this.offCtx.putImageData(this.cachedImgData, 0, 0);

    this.ctx.save();
    this.ctx.scale(dpr, dpr);

    // スペクトログラム画像を拡大転送
    this.ctx.drawImage(this.offCanvas, LEFT_MARGIN, 0, graphWidth, effectiveH);

    // 周波数フィルターの描画
    if (filterManager) {
      this.drawFrequencyFilters(effectiveH, graphWidth, filterManager);
    }

    // ピアノ鍵盤 ＆ 周波数目盛り (effectiveH の範囲)
    this.drawKeyboard(effectiveH);
    this.drawAxis(effectiveH, graphWidth);
    this.drawDataBoundaries(effectiveH, graphWidth);

    // 基音スプライン曲線
    this.drawPitchTrack(effectiveH, graphWidth, halfGraph, pitchHistory, currentScrollX, frameWidth);

    // 横軸 (時間・秒数ルーラー ＆ 縦グリッド線) の描画
    this.drawTimeAxis(cssWidth, cssHeight, effectiveH, graphWidth, halfGraph, audioHistoryTimes, currentScrollX, frameWidth);

    // センターライン
    const activeLineX = LEFT_MARGIN + halfGraph;
    this.ctx.strokeStyle = "#ffd700";
    this.ctx.lineWidth = 1.8;
    this.ctx.beginPath();
    this.ctx.moveTo(activeLineX, 0);
    this.ctx.lineTo(activeLineX, effectiveH);
    this.ctx.stroke();

    // 右側スペクトル曲線グラフ
    const centerFrame = Math.round(currentScrollX / frameWidth);
    const activeSpectrum = (centerFrame >= 0 && centerFrame < totalFrames) ? audioHistory[centerFrame] : null;
    const centerPitch = (centerFrame >= 0 && centerFrame < pitchHistory.length) ? pitchHistory[centerFrame] : null;
    this.drawSpectrumProfile(cssWidth, cssHeight, activeSpectrum, sampleMap, imgH, centerPitch, sampleRate);

    // 上下・左右クロスヘア線 (周波数・音名・時間バッジ)
    if (hoverCrosshair) {
      this.drawCrosshairs(cssWidth, cssHeight, effectiveH, graphWidth, halfGraph, audioHistoryTimes, currentScrollX, frameWidth, hoverCrosshair);
    }

    this.ctx.restore();
  }

  // 横軸（時間・秒数）ルーラー ＆ 縦の破線グリッド描画
  drawTimeAxis(totalW, totalH, effH, graphW, halfGraph, audioHistoryTimes, currentScrollX, frameWidth) {
    const panelX = totalW - SPECTRUM_PANEL_WIDTH;

    // 1. タイムルーラー背景帯
    this.ctx.fillStyle = "#141416";
    this.ctx.fillRect(0, effH, panelX, TIME_AXIS_HEIGHT);

    // 上部境界線
    this.ctx.strokeStyle = "#27272a";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, effH);
    this.ctx.lineTo(panelX, effH);
    this.ctx.stroke();

    // 1フレームあたりの時間幅の算出
    let timePerFrame = 1 / 120; // デフォルト 120fps
    if (audioHistoryTimes && audioHistoryTimes.length >= 2) {
      timePerFrame = (audioHistoryTimes[audioHistoryTimes.length - 1] - audioHistoryTimes[0]) / (audioHistoryTimes.length - 1);
    }

    // 1秒あたりの描画ピクセル幅
    const pxPerSec = frameWidth / timePerFrame;
    if (pxPerSec <= 0) return;

    // 画面左端と右端に対応する時間 (秒)
    const tStart = ((currentScrollX - halfGraph) / frameWidth) * timePerFrame;
    const tEnd = ((currentScrollX + halfGraph) / frameWidth) * timePerFrame;

    // 目盛りの時間間隔 (秒) をズーム率に応じて自動選択
    const stepCandidates = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const targetPxInterval = 75; // 目盛りの理想的なピクセル間隔
    const idealStep = targetPxInterval / pxPerSec;
    let step = stepCandidates[stepCandidates.length - 1];
    for (const c of stepCandidates) {
      if (c >= idealStep) {
        step = c;
        break;
      }
    }

    // 目盛りの開始時間 (stepの倍数にスナップ)
    const firstTick = Math.floor(tStart / step) * step;

    this.ctx.font = "bold 9px ui-monospace, sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    for (let t = firstTick; t <= tEnd + step; t += step) {
      // 秒数に対応する画面X座標
      const frameIdx = t / timePerFrame;
      const x = LEFT_MARGIN + halfGraph + (frameIdx * frameWidth - currentScrollX);

      if (x < LEFT_MARGIN || x > panelX) continue;

      // 1. スペクトログラム領域内の縦の破線グリッド
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      this.ctx.setLineDash([2, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, effH);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // 2. ルーラー内の目盛り刻み線 (ティック)
      this.ctx.strokeStyle = "#71717a";
      this.ctx.beginPath();
      this.ctx.moveTo(x, effH);
      this.ctx.lineTo(x, effH + 4);
      this.ctx.stroke();

      // 3. 秒数テキスト (例: 0s, 1.5s, 10s...)
      let label = "";
      if (t < 0) {
        label = ""; // 録音開始前は非表示
      } else if (step < 0.1) {
        label = `${t.toFixed(2)}s`;
      } else if (step < 1) {
        label = `${t.toFixed(1)}s`;
      } else if (t < 60) {
        label = `${Math.round(t)}s`;
      } else {
        const m = Math.floor(t / 60);
        const s = Math.round(t % 60);
        label = `${m}m${s > 0 ? s + "s" : ""}`;
      }

      if (label) {
        this.ctx.fillStyle = "#8d8d99";
        this.ctx.fillText(label, x, effH + 11);
      }
    }
  }

  // 十字線 (周波数バッジ ＆ 時間秒数バッジ) の描画
  drawCrosshairs(totalW, totalH, effH, graphW, halfGraph, audioHistoryTimes, currentScrollX, frameWidth, hover) {
    this.ctx.save();
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([3, 3]);

    const freq = this.yToFreq(hover.y, effH);
    const noteName = this.freqToNearestNote(freq);
    const labelText = `${Math.round(freq).toLocaleString()} Hz (${noteName})`;

    this.ctx.font = "bold 9px ui-monospace, sans-serif";
    const badgeW = this.ctx.measureText(labelText).width + 12;
    const badgeH = 16;

    let timePerFrame = 1 / 120;
    if (audioHistoryTimes && audioHistoryTimes.length >= 2) {
      timePerFrame = (audioHistoryTimes[audioHistoryTimes.length - 1] - audioHistoryTimes[0]) / (audioHistoryTimes.length - 1);
    }

    if (hover.area === "spectrogram") {
      const panelX = totalW - SPECTRUM_PANEL_WIDTH;
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";

      // 垂直線 (上下方向)
      this.ctx.beginPath();
      this.ctx.moveTo(hover.x, 0);
      this.ctx.lineTo(hover.x, effH);
      this.ctx.stroke();

      // 水平線 (左右方向)
      this.ctx.beginPath();
      this.ctx.moveTo(LEFT_MARGIN, hover.y);
      this.ctx.lineTo(panelX, hover.y);
      this.ctx.stroke();

      // 周波数 ＋ 音名バッジ (左端)
      if (freq >= DATA_MIN_FREQ && freq <= DATA_MAX_FREQ && hover.y <= effH) {
        this.ctx.setLineDash([]);
        this.ctx.fillStyle = "rgba(18, 18, 20, 0.88)";
        this.ctx.fillRect(LEFT_MARGIN + 2, hover.y - badgeH / 2, badgeW, badgeH);
        this.ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        this.ctx.strokeRect(LEFT_MARGIN + 2, hover.y - badgeH / 2, badgeW, badgeH);

        this.ctx.fillStyle = "#38bdf8";
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(labelText, LEFT_MARGIN + 7, hover.y);
      }

      // 時間 (秒数) バッジ (垂直線の足元)
      const hoverFrame = (currentScrollX - halfGraph + (hover.x - LEFT_MARGIN)) / frameWidth;
      const hoverSec = hoverFrame * timePerFrame;
      if (hoverSec >= 0) {
        this.ctx.setLineDash([]);
        const timeLabel = `${hoverSec.toFixed(2)}s`;
        const timeBadgeW = this.ctx.measureText(timeLabel).width + 10;

        this.ctx.fillStyle = "rgba(18, 18, 20, 0.88)";
        this.ctx.fillRect(hover.x - timeBadgeW / 2, effH - 18, timeBadgeW, 16);
        this.ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        this.ctx.strokeRect(hover.x - timeBadgeW / 2, effH - 18, timeBadgeW, 16);

        this.ctx.fillStyle = "#ffd700"; // ゴールド色で時間を表示
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(timeLabel, hover.x, effH - 10);
      }
    } else if (hover.area === "panel") {
      const panelX = totalW - SPECTRUM_PANEL_WIDTH;
      this.ctx.strokeStyle = "rgba(0, 229, 255, 0.55)";

      // 垂直線
      this.ctx.beginPath();
      this.ctx.moveTo(hover.x, 0);
      this.ctx.lineTo(hover.x, totalH);
      this.ctx.stroke();

      // 水平線
      this.ctx.beginPath();
      this.ctx.moveTo(panelX, hover.y);
      this.ctx.lineTo(totalW, hover.y);
      this.ctx.stroke();

      if (freq >= DATA_MIN_FREQ && freq <= DATA_MAX_FREQ) {
        this.ctx.setLineDash([]);
        this.ctx.fillStyle = "rgba(16, 18, 24, 0.92)";
        this.ctx.fillRect(panelX + 3, hover.y - badgeH / 2, badgeW, badgeH);
        this.ctx.strokeStyle = "rgba(0, 229, 255, 0.45)";
        this.ctx.strokeRect(panelX + 3, hover.y - badgeH / 2, badgeW, badgeH);

        this.ctx.fillStyle = "#00e5ff";
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(labelText, panelX + 8, hover.y);
      }
    }

    this.ctx.restore();
  }

  drawFrequencyFilters(h, graphW, filterManager) {
    if (!filterManager.hasActiveFilters()) return;

    this.ctx.save();
    const handleW = 34;
    const handleH = 8;
    const centerX = LEFT_MARGIN + graphW / 2;

    for (const f of filterManager.filters) {
      const yHigh = this.freqToY(f.maxFreq, h);
      const yLow = this.freqToY(f.minFreq, h);

      const topY = Math.min(yHigh, yLow);
      const bottomY = Math.max(yHigh, yLow);
      const bandHeight = bottomY - topY;

      this.ctx.fillStyle = f.color + "33";
      this.ctx.fillRect(LEFT_MARGIN, topY, graphW, bandHeight);

      this.ctx.strokeStyle = f.color;
      this.ctx.lineWidth = 1.5;

      this.ctx.beginPath();
      this.ctx.moveTo(LEFT_MARGIN, topY);
      this.ctx.lineTo(LEFT_MARGIN + graphW, topY);
      this.ctx.stroke();

      this.ctx.beginPath();
      this.ctx.moveTo(LEFT_MARGIN, bottomY);
      this.ctx.lineTo(LEFT_MARGIN + graphW, bottomY);
      this.ctx.stroke();

      this.ctx.fillStyle = f.color;
      this.ctx.fillRect(centerX - handleW / 2, topY - handleH / 2, handleW, handleH);
      this.ctx.strokeStyle = "#ffffff";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(centerX - handleW / 2, topY - handleH / 2, handleW, handleH);

      this.ctx.fillStyle = f.color;
      this.ctx.fillRect(centerX - handleW / 2, bottomY - handleH / 2, handleW, handleH);
      this.ctx.strokeStyle = "#ffffff";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(centerX - handleW / 2, bottomY - handleH / 2, handleW, handleH);

      const gainLabel = ` (${f.gain || 100}%)`;
      this.ctx.fillStyle = "#ffffff";
      this.ctx.font = "bold 9px ui-monospace, sans-serif";
      this.ctx.textAlign = "left";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(`${Math.round(f.maxFreq)} Hz${gainLabel}`, centerX + handleW / 2 + 6, topY);
      this.ctx.fillText(`${Math.round(f.minFreq)} Hz${gainLabel}`, centerX + handleW / 2 + 6, bottomY);
    }

    this.ctx.restore();
  }

  drawPitchTrack(h, graphW, halfGraph, pitchHistory, currentScrollX, frameWidth) {
    if (!pitchHistory || pitchHistory.length === 0) return;

    const startFrame = Math.max(0, Math.floor((currentScrollX - halfGraph) / frameWidth) - 2);
    const endFrame = Math.min(pitchHistory.length, Math.ceil((currentScrollX + halfGraph) / frameWidth) + 2);

    const segments = [];
    let currentSegment = [];
    let prevFreq = null;

    for (let f = startFrame; f < endFrame; f++) {
      const pitch = pitchHistory[f];
      const x = LEFT_MARGIN + halfGraph + (f * frameWidth - currentScrollX);

      if (pitch && pitch >= this.viewMinFreq && pitch <= this.viewMaxFreq) {
        const y = this.freqToY(pitch, h);

        if (prevFreq && Math.abs(Math.log2(pitch / prevFreq)) >= 0.5) {
          if (currentSegment.length > 0) {
            segments.push(currentSegment);
            currentSegment = [];
          }
        }
        currentSegment.push({ x, y });
        prevFreq = pitch;
      } else {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        prevFreq = null;
      }
    }
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    if (segments.length === 0) return;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(LEFT_MARGIN, 0, graphW, h);
    this.ctx.clip();

    const buildSmoothPath = () => {
      this.ctx.beginPath();
      segments.forEach((pts) => {
        if (pts.length === 1) {
          this.ctx.arc(pts[0].x, pts[0].y, 1.5, 0, Math.PI * 2);
          return;
        }
        if (pts.length === 2) {
          this.ctx.moveTo(pts[0].x, pts[0].y);
          this.ctx.lineTo(pts[1].x, pts[1].y);
          return;
        }

        this.ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[Math.max(0, i - 1)];
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const p3 = pts[Math.min(pts.length - 1, i + 2)];

          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = p1.y + (p2.y - p0.y) / 6;
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = p2.y - (p3.y - p1.y) / 6;

          this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
      });
    };

    buildSmoothPath();
    this.ctx.strokeStyle = "rgba(9, 9, 11, 0.85)";
    this.ctx.lineWidth = 3.6;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.stroke();

    buildSmoothPath();
    this.ctx.strokeStyle = "#00f5ff";
    this.ctx.lineWidth = 1.8;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.stroke();

    this.ctx.restore();
  }

  drawKeyboard(h) {
    this.ctx.fillStyle = "#18181b";
    this.ctx.fillRect(0, 0, KEYBOARD_WIDTH, h);

    const isBlackKey = [false, true, false, true, false, false, true, false, true, false, true, false];
    const effMin = Math.max(DATA_MIN_FREQ, this.viewMinFreq);
    const effMax = Math.min(DATA_MAX_FREQ, this.viewMaxFreq);
    if (effMin >= effMax) return;

    const nMin = Math.max(12, Math.floor(69 + 12 * Math.log2(effMin / 440)) - 1);
    const nMax = Math.min(160, Math.ceil(69 + 12 * Math.log2(effMax / 440)) + 1);

    const avgKeyH = h / Math.max(1, (nMax - nMin));
    const showAllLabels = avgKeyH >= 8.5;
    const blackKeyW = Math.round(KEYBOARD_WIDTH * 0.58);

    for (let n = nMin; n <= nMax; n++) {
      const noteInOct = ((n % 12) + 12) % 12;
      const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
      const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);
      const keyH = yBottom - yTop;

      if (yBottom < 0 || yTop > h) continue;

      const isBlack = isBlackKey[noteInOct];

      const grad = this.ctx.createLinearGradient(0, yTop, KEYBOARD_WIDTH, yTop);
      grad.addColorStop(0, "#ececef");
      grad.addColorStop(0.7, "#f8f8fa");
      grad.addColorStop(1, "#ffffff");
      this.ctx.fillStyle = grad;

      if (!isBlack) {
        this.ctx.fillRect(0, yTop, KEYBOARD_WIDTH, keyH);
      } else {
        this.ctx.fillRect(blackKeyW, yTop, KEYBOARD_WIDTH - blackKeyW, keyH);
      }
    }

    this.ctx.strokeStyle = "#cbd5e1";
    this.ctx.lineWidth = 0.8;

    for (let n = nMin; n <= nMax; n++) {
      const noteInOct = ((n % 12) + 12) % 12;
      const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
      const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);
      const isBlack = isBlackKey[noteInOct];

      if (isBlack) {
        const yMid = (yTop + yBottom) / 2;
        this.ctx.beginPath();
        this.ctx.moveTo(blackKeyW, yMid);
        this.ctx.lineTo(KEYBOARD_WIDTH, yMid);
        this.ctx.stroke();
      } else {
        if (noteInOct === 5 || noteInOct === 0) {
          this.ctx.beginPath();
          this.ctx.moveTo(0, yTop);
          this.ctx.lineTo(KEYBOARD_WIDTH, yTop);
          this.ctx.stroke();
        }
      }
    }

    for (let n = nMin; n <= nMax; n++) {
      const noteInOct = ((n % 12) + 12) % 12;
      if (isBlackKey[noteInOct]) {
        const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
        const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);
        const keyH = yBottom - yTop;

        if (yBottom < 0 || yTop > h) continue;

        this.ctx.fillStyle = "rgba(15, 23, 42, 0.4)";
        this.ctx.fillRect(blackKeyW, yTop + 0.5, 2.5, keyH);

        const bGrad = this.ctx.createLinearGradient(0, yTop, blackKeyW, yTop);
        bGrad.addColorStop(0, "#09090b");
        bGrad.addColorStop(0.85, "#27272a");
        bGrad.addColorStop(1, "#18181b");
        this.ctx.fillStyle = bGrad;
        this.ctx.fillRect(0, yTop, blackKeyW, keyH);

        this.ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
        this.ctx.fillRect(blackKeyW - 1, yTop, 1, keyH);

        this.ctx.strokeStyle = "#09090b";
        this.ctx.lineWidth = 0.5;
        this.ctx.strokeRect(0, yTop, blackKeyW, keyH);
      }
    }

    for (let n = nMin; n <= nMax; n++) {
      const noteInOct = ((n % 12) + 12) % 12;
      const isBlack = isBlackKey[noteInOct];
      const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
      const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);
      const keyH = yBottom - yTop;

      if (yBottom < 0 || yTop > h) continue;

      const octave = Math.floor(n / 12) - 1;
      const noteName = `${NOTE_NAMES[noteInOct]}${octave}`;

      if (showAllLabels && keyH >= 8) {
        if (!isBlack) {
          this.ctx.fillStyle = noteInOct === 0 ? "#020617" : "#334155";
          this.ctx.font = noteInOct === 0 
            ? "bold 8.5px ui-monospace, 'Segoe UI', sans-serif" 
            : "600 7.5px ui-monospace, 'Segoe UI', sans-serif";
          this.ctx.textAlign = "right";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(noteName, KEYBOARD_WIDTH - 3, Math.round(yTop + keyH / 2));
        } else {
          this.ctx.fillStyle = "#ffffff";
          this.ctx.font = "bold 7px ui-monospace, 'Segoe UI', sans-serif";
          this.ctx.textAlign = "right";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(noteName, blackKeyW - 3, Math.round(yTop + keyH / 2));
        }
      } else if (!showAllLabels && noteInOct === 0 && keyH >= 2.5) {
        this.ctx.fillStyle = "#38bdf8";
        this.ctx.font = "bold 9px ui-monospace, 'Segoe UI', sans-serif";
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(`C${octave}`, KEYBOARD_WIDTH + 3, Math.round(yTop + keyH / 2));
      }
    }

    this.ctx.strokeStyle = "#3f3f46";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(KEYBOARD_WIDTH, 0);
    this.ctx.lineTo(KEYBOARD_WIDTH, h);
    this.ctx.stroke();
  }

  drawSpectrumProfile(totalW, h, activeSpectrum, sampleMap, imgH, fundamentalPitch, sampleRate) {
    const panelX = totalW - SPECTRUM_PANEL_WIDTH;

    this.ctx.fillStyle = "rgba(16, 18, 24, 0.96)";
    this.ctx.fillRect(panelX, 0, SPECTRUM_PANEL_WIDTH, h);

    this.ctx.strokeStyle = "#27272a";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(panelX, 0);
    this.ctx.lineTo(panelX, h);
    this.ctx.stroke();

    this.ctx.fillStyle = "#71717a";
    this.ctx.font = "bold 9px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.fillText("SPECTRUM (CENTER)", panelX + 8, 14);

    if (!activeSpectrum) return;

    const points = [];
    const step = 3;
    const scaleFactor = this.spectrumProfileScale;

    for (let py = 0; py < imgH; py += step) {
      const smp = sampleMap[py];
      const y = py / (imgH / h);
      if (smp.isOutOfRange) {
        points.push({ x: panelX, y });
        continue;
      }

      const val = activeSpectrum[smp.b0] * (1 - smp.frac) + activeSpectrum[smp.b1] * smp.frac;
      const normalized = Math.min(1, ((val * this.baseGain * this.colorGain) / 255) * scaleFactor);
      const x = panelX + normalized * (SPECTRUM_PANEL_WIDTH - 28);
      points.push({ x, y });
    }

    if (points.length > 1) {
      this.ctx.beginPath();
      this.ctx.moveTo(panelX, points[0].y);
      points.forEach((pt) => this.ctx.lineTo(pt.x, pt.y));
      this.ctx.lineTo(panelX, points[points.length - 1].y);
      this.ctx.closePath();

      const fillGrad = this.ctx.createLinearGradient(panelX, 0, panelX + SPECTRUM_PANEL_WIDTH, 0);
      fillGrad.addColorStop(0, "rgba(4, 211, 97, 0.05)");
      fillGrad.addColorStop(0.6, "rgba(0, 229, 255, 0.22)");
      fillGrad.addColorStop(1, "rgba(255, 215, 0, 0.45)");
      this.ctx.fillStyle = fillGrad;
      this.ctx.fill();

      this.ctx.beginPath();
      this.ctx.moveTo(points[0].x, points[0].y);
      points.forEach((pt) => this.ctx.lineTo(pt.x, pt.y));
      this.ctx.strokeStyle = "#00e5ff";
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
    }

    if (fundamentalPitch && fundamentalPitch > 0) {
      const nyquist = sampleRate / 2;
      const bufLen = activeSpectrum.length;

      for (let k = 1; k <= 16; k++) {
        const targetFreq = fundamentalPitch * k;
        if (targetFreq > this.viewMaxFreq || targetFreq > DATA_MAX_FREQ) break;
        if (targetFreq < this.viewMinFreq) continue;

        const centerBin = (targetFreq / nyquist) * bufLen;
        const bMin = Math.max(1, Math.round(centerBin * 0.93));
        const bMax = Math.min(bufLen - 2, Math.round(centerBin * 1.07));

        let maxV = -1;
        let peakB = -1;
        for (let b = bMin; b <= bMax; b++) {
          if (activeSpectrum[b] > maxV) {
            maxV = activeSpectrum[b];
            peakB = b;
          }
        }

        if (peakB > 0 && maxV > 20) {
          const exactFreq = (peakB / bufLen) * nyquist;
          const y = this.freqToY(exactFreq, h);
          if (y < 16 || y > h - 4) continue;

          const normalized = Math.min(1, ((maxV * this.baseGain * this.colorGain) / 255) * scaleFactor);
          const dotX = panelX + normalized * (SPECTRUM_PANEL_WIDTH - 28);

          this.ctx.fillStyle = k === 1 ? "#ffd700" : "#00e5ff";
          this.ctx.beginPath();
          this.ctx.arc(dotX, y, k === 1 ? 3.2 : 2.2, 0, Math.PI * 2);
          this.ctx.fill();

          this.ctx.fillStyle = k === 1 ? "#ffd700" : "#a1a1aa";
          this.ctx.font = k === 1 ? "bold 9px ui-monospace, sans-serif" : "8px ui-monospace, sans-serif";
          this.ctx.textAlign = "left";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(`H${k}`, Math.min(panelX + SPECTRUM_PANEL_WIDTH - 24, dotX + 5), y);
        }
      }
    }
  }

  drawDataBoundaries(h, graphW) {
    [DATA_MIN_FREQ, DATA_MAX_FREQ].forEach((freq) => {
      if (freq >= this.viewMinFreq && freq <= this.viewMaxFreq) {
        const y = Math.round(this.freqToY(freq, h));
        this.ctx.strokeStyle = "rgba(72, 99, 247, 0.55)";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(LEFT_MARGIN, y);
        this.ctx.lineTo(LEFT_MARGIN + graphW, y);
        this.ctx.stroke();
      }
    });
  }

  drawAxis(h, graphW) {
    this.ctx.fillStyle = "#18181b";
    this.ctx.fillRect(KEYBOARD_WIDTH, 0, AXIS_WIDTH, h);

    this.ctx.strokeStyle = "#3f3f46";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(LEFT_MARGIN, 0);
    this.ctx.lineTo(LEFT_MARGIN, h);
    this.ctx.stroke();

    const freqs = [
      20, 30, 40, 50, 60, 70, 80, 100, 150, 200, 300, 400, 500, 700,
      1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000, 20000,
      30000, 40000, 50000, 60000, 70000, 80000
    ];

    this.ctx.font = "10px sans-serif";
    this.ctx.textAlign = "right";
    this.ctx.textBaseline = "middle";

    let lastLabelY = -100;
    freqs.forEach((freq) => {
      if (freq < this.viewMinFreq || freq > this.viewMaxFreq || freq < DATA_MIN_FREQ || freq > DATA_MAX_FREQ) return;
      const y = Math.round(this.freqToY(freq, h));

      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      this.ctx.setLineDash([2, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(LEFT_MARGIN, y);
      this.ctx.lineTo(LEFT_MARGIN + graphW, y);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.strokeStyle = "#71717a";
      this.ctx.beginPath();
      this.ctx.moveTo(LEFT_MARGIN - 5, y);
      this.ctx.lineTo(LEFT_MARGIN, y);
      this.ctx.stroke();

      if (Math.abs(y - lastLabelY) >= 20 && y >= 15 && y <= h - 10) {
        this.ctx.fillStyle = "#a1a1aa";
        this.ctx.fillText(freq.toLocaleString(), LEFT_MARGIN - 7, y);
        lastLabelY = y;
      }
    });

    this.ctx.fillStyle = "#71717a";
    this.ctx.textAlign = "center";
    this.ctx.fillText("(Hz)", KEYBOARD_WIDTH + AXIS_WIDTH / 2, 10);
  }
}