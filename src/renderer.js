import {
  FFT_SIZE, KEYBOARD_WIDTH, AXIS_WIDTH, LEFT_MARGIN, SPECTRUM_PANEL_WIDTH,
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
    this.spectrumProfileScale = 1.0; // 右側波形の左右方向の縮尺 (1.0 = 100%)

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

  zoom(mouseY, deltaY, cssHeight) {
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const lSpan = lMax - lMin;
    const absLMin = Math.log10(VIEW_LIMIT_MIN);
    const absLMax = Math.log10(VIEW_LIMIT_MAX);

    const ratio = Math.max(0, Math.min(1, (cssHeight - mouseY) / cssHeight));
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
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const lSpan = lMax - lMin;
    const absLMin = Math.log10(VIEW_LIMIT_MIN);
    const absLMax = Math.log10(VIEW_LIMIT_MAX);

    const shift = (-deltaY / cssHeight) * lSpan * 0.45;
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

  // 右側波形グラフの左右縮尺を調整 (0.2x 〜 5.0x)
  adjustProfileScale(deltaY) {
    const factor = Math.pow(1.002, -deltaY);
    this.spectrumProfileScale = Math.max(0.2, Math.min(5.0, this.spectrumProfileScale * factor));
    return Math.round(this.spectrumProfileScale * 100);
  }

  render(cssWidth, cssHeight, dpr, audioHistory, pitchHistory, currentScrollX, sampleRate, isPlaying, frameWidth = 2) {
    const graphWidth = Math.floor(cssWidth - LEFT_MARGIN - SPECTRUM_PANEL_WIDTH);
    if (graphWidth <= 0 || cssHeight <= 0) return;

    const halfGraph = Math.floor(graphWidth / 2);
    const imgW = graphWidth;
    const imgH = cssHeight;

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

    this.ctx.drawImage(this.offCanvas, LEFT_MARGIN, 0, graphWidth, cssHeight);

    this.drawKeyboard(cssHeight);
    this.drawAxis(cssHeight, graphWidth);
    this.drawDataBoundaries(cssHeight, graphWidth);

    this.drawPitchTrack(cssHeight, graphWidth, halfGraph, pitchHistory, currentScrollX, frameWidth);

    // センターライン
    const activeLineX = LEFT_MARGIN + halfGraph;
    this.ctx.strokeStyle = "#ffd700";
    this.ctx.lineWidth = 1.8;
    this.ctx.beginPath();
    this.ctx.moveTo(activeLineX, 0);
    this.ctx.lineTo(activeLineX, cssHeight);
    this.ctx.stroke();

    // 右側スペクトル曲線グラフ (倍音ピーク精密スナップ描画)
    const centerFrame = Math.round(currentScrollX / frameWidth);
    const activeSpectrum = (centerFrame >= 0 && centerFrame < totalFrames) ? audioHistory[centerFrame] : null;
    const centerPitch = (centerFrame >= 0 && centerFrame < pitchHistory.length) ? pitchHistory[centerFrame] : null;
    this.drawSpectrumProfile(cssWidth, cssHeight, activeSpectrum, sampleMap, imgH, centerPitch, sampleRate);

    this.ctx.restore();
  }

  drawPitchTrack(h, graphW, halfGraph, pitchHistory, currentScrollX, frameWidth) {
    if (!pitchHistory || pitchHistory.length === 0) return;

    const startFrame = Math.max(0, Math.floor((currentScrollX - halfGraph) / frameWidth) - 1);
    const endFrame = Math.min(pitchHistory.length, Math.ceil((currentScrollX + halfGraph) / frameWidth) + 1);

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(LEFT_MARGIN, 0, graphW, h);
    this.ctx.clip();

    this.ctx.strokeStyle = "rgba(255, 0, 127, 0.9)";
    this.ctx.lineWidth = 1.0;

    this.ctx.beginPath();
    let isDrawing = false;
    let prevFreq = null;

    for (let f = startFrame; f < endFrame; f++) {
      const pitch = pitchHistory[f];
      const x = LEFT_MARGIN + halfGraph + (f * frameWidth - currentScrollX);

      if (pitch && pitch >= this.viewMinFreq && pitch <= this.viewMaxFreq) {
        const y = this.freqToY(pitch, h);

        if (isDrawing && prevFreq && Math.abs(Math.log2(pitch / prevFreq)) < 0.6) {
          this.ctx.lineTo(x, y);
        } else {
          this.ctx.moveTo(x, y);
          isDrawing = true;
        }
        prevFreq = pitch;
      } else {
        isDrawing = false;
        prevFreq = null;
      }
    }
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

  // 右側スペクトル曲線グラフ (倍音ピークスナップ ＆ 左右縮尺対応)
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
    const scaleFactor = this.spectrumProfileScale; // 左右方向の縮尺

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

    // 倍音 (H1, H2, H3...) の局所ピーク自動探索（山の頂上へスナップ）
    if (fundamentalPitch && fundamentalPitch > 0) {
      const nyquist = sampleRate / 2;
      const bufLen = activeSpectrum.length;

      for (let k = 1; k <= 16; k++) {
        const targetFreq = fundamentalPitch * k;
        if (targetFreq > this.viewMaxFreq || targetFreq > DATA_MAX_FREQ) break;
        if (targetFreq < this.viewMinFreq) continue;

        // 理論周波数の近傍 ±7% から実際のスペクトルの山（最大ピーク）を特定
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

        // 有効な山が存在する場合にスナップ
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