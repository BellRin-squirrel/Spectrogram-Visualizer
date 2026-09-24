import {
  FFT_SIZE, KEYBOARD_WIDTH, AXIS_WIDTH, LEFT_MARGIN,
  DATA_MIN_FREQ, DATA_MAX_FREQ, VIEW_LIMIT_MIN, VIEW_LIMIT_MAX,
  DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ, COLOR_LUT_32
} from "./constants.js";

export class SpectrogramRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.viewMinFreq = DEFAULT_MIN_FREQ;
    this.viewMaxFreq = DEFAULT_MAX_FREQ;
    this.baseGain = 1.47;
    this.colorGain = 1.0;
  }

  freqToY(freq, h) {
    const lMin = Math.log10(this.viewMinFreq);
    const lMax = Math.log10(this.viewMaxFreq);
    const ratio = (Math.log10(freq) - lMin) / (lMax - lMin);
    return (1 - ratio) * h;
  }

  // 縦軸ズーム: VIEW_LIMIT_MIN (2Hz) 〜 VIEW_LIMIT_MAX (500kHz) まで縮小可能
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

    if (newLMin < absLMin) {
      newLMin = absLMin;
      newLMax = newLMin + newSpan;
    }
    if (newLMax > absLMax) {
      newLMax = absLMax;
      newLMin = newLMax - newSpan;
    }

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

    if (newLMin < absLMin) {
      newLMin = absLMin;
      newLMax = newLMin + lSpan;
    }
    if (newLMax > absLMax) {
      newLMax = absLMax;
      newLMin = newLMax - lSpan;
    }

    this.viewMinFreq = Math.pow(10, newLMin);
    this.viewMaxFreq = Math.pow(10, newLMax);
  }

  adjustColorGain(deltaY) {
    const factor = Math.pow(1.002, -deltaY);
    this.colorGain = Math.max(0.2, Math.min(4.0, this.colorGain * factor));
    return Math.round(this.colorGain * 100);
  }

  render(cssWidth, cssHeight, dpr, audioHistory, currentScrollX, sampleRate, isPlaying, frameWidth = 2) {
    const graphWidth = cssWidth - LEFT_MARGIN;
    if (graphWidth <= 0 || cssHeight <= 0) return;

    const halfGraph = Math.floor(graphWidth / 2);
    const physGraphW = Math.round(graphWidth * dpr);
    const physH = this.canvas.height;
    const physLeftMargin = Math.round(LEFT_MARGIN * dpr);
    const physFrameW = Math.max(1, Math.round(frameWidth * dpr));

    const imgData = this.ctx.createImageData(physGraphW, physH);
    const data32 = new Uint32Array(imgData.data.buffer);
    data32.fill(0xff0d0906); // デフォルトの暗色背景

    const nyquist = sampleRate / 2;
    const bufferLength = FFT_SIZE / 2;

    // y座標ごとのサンプリングパラメータ
    const sampleMap = new Array(physH);
    for (let py = 0; py < physH; py++) {
      const ratioTop = (physH - 1 - py) / (physH - 1);
      const freq = this.viewMinFreq * Math.pow(this.viewMaxFreq / this.viewMinFreq, ratioTop);

      // 描画対象周波数を上下で超えた場合は「未描画余白領域 (isOutOfRange = true)」とする
      const isOutOfRange = (freq < DATA_MIN_FREQ) || (freq > DATA_MAX_FREQ) || (freq > nyquist);

      if (isOutOfRange) {
        sampleMap[py] = { isOutOfRange: true };
        continue;
      }

      const exactBin = (freq / nyquist) * bufferLength;
      const ratioBottom = Math.max(0, (physH - 2 - py) / (physH - 1));
      const freqNext = this.viewMinFreq * Math.pow(this.viewMaxFreq / this.viewMinFreq, ratioBottom);
      const nextBin = (freqNext / nyquist) * bufferLength;
      const span = Math.abs(nextBin - exactBin);

      const b0 = Math.max(0, Math.min(bufferLength - 1, Math.floor(exactBin)));
      const b1 = Math.max(0, Math.min(bufferLength - 1, b0 + 1));

      sampleMap[py] = {
        isOutOfRange: false,
        b0, b1,
        frac: exactBin - b0,
        spanBins: Math.max(1, Math.round(span))
      };
    }

    const totalFrames = audioHistory.length;
    const startFrame = Math.floor((currentScrollX - halfGraph) / frameWidth);
    const endFrame = Math.min(totalFrames, Math.ceil((currentScrollX + halfGraph) / frameWidth) + 1);

    const effectiveGain = this.baseGain * this.colorGain;

    for (let f = Math.max(0, startFrame); f < endFrame; f++) {
      const frameData = audioHistory[f];
      const cssX = halfGraph + (f * frameWidth - currentScrollX);
      const pxStart = Math.round(cssX * dpr);
      if (pxStart + physFrameW < 0 || pxStart >= physGraphW) continue;

      const pxEnd = Math.min(physGraphW, pxStart + physFrameW);

      for (let py = 0; py < physH; py++) {
        const smp = sampleMap[py];
        // 描画対象外の領域は背景色のままスキップ
        if (smp.isOutOfRange) continue;

        let val = 0;
        if (smp.spanBins <= 1) {
          val = frameData[smp.b0] * (1 - smp.frac) + frameData[smp.b1] * smp.frac;
        } else {
          let maxV = frameData[smp.b0];
          const upper = Math.min(bufferLength - 1, smp.b0 + smp.spanBins);
          for (let b = smp.b0 + 1; b <= upper; b++) {
            if (frameData[b] > maxV) maxV = frameData[b];
          }
          val = maxV;
        }

        const adjustedVal = Math.max(0, Math.min(255, Math.round(val * effectiveGain)));
        const color = COLOR_LUT_32[adjustedVal];
        const rowOffset = py * physGraphW;
        for (let px = pxStart; px < pxEnd; px++) {
          data32[rowOffset + px] = color;
        }
      }
    }
    this.ctx.putImageData(imgData, physLeftMargin, 0);

    // 2. UI（鍵盤・目盛り・境界リミット線）の描画
    this.ctx.save();
    this.ctx.scale(dpr, dpr);

    this.drawKeyboard(cssHeight);
    this.drawAxis(cssHeight, graphWidth);

    // データ有効境界線 (20Hz および 80kHz) の表示
    this.drawDataBoundaries(cssHeight, graphWidth);

    // 中央インジケータ線
    const activeLineX = LEFT_MARGIN + halfGraph;
    this.ctx.strokeStyle = isPlaying ? "rgba(255, 215, 0, 0.85)" : "rgba(4, 211, 97, 0.8)";
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(activeLineX, 0);
    this.ctx.lineTo(activeLineX, cssHeight);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    this.ctx.restore();
  }

  // データ境界ライン (20Hz & 80kHz)
  drawDataBoundaries(h, graphW) {
    [DATA_MIN_FREQ, DATA_MAX_FREQ].forEach((freq) => {
      if (freq >= this.viewMinFreq && freq <= this.viewMaxFreq) {
        const y = Math.round(this.freqToY(freq, h));
        this.ctx.strokeStyle = "rgba(72, 99, 247, 0.5)"; // 境界を示すシアンブルー
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(LEFT_MARGIN, y);
        this.ctx.lineTo(LEFT_MARGIN + graphW, y);
        this.ctx.stroke();
      }
    });
  }

  drawKeyboard(h) {
    this.ctx.fillStyle = "#18181b";
    this.ctx.fillRect(0, 0, KEYBOARD_WIDTH, h);

    const isBlackKey = [false, true, false, true, false, false, true, false, true, false, true, false];

    // 鍵盤も有効データ範囲 (20Hz 〜 80kHz) のみ描画
    const effMin = Math.max(DATA_MIN_FREQ, this.viewMinFreq);
    const effMax = Math.min(DATA_MAX_FREQ, this.viewMaxFreq);
    if (effMin >= effMax) return;

    const nMin = Math.max(12, Math.floor(69 + 12 * Math.log2(effMin / 440)) - 1);
    const nMax = Math.min(160, Math.ceil(69 + 12 * Math.log2(effMax / 440)) + 1);

    for (let n = nMin; n <= nMax; n++) {
      const noteInOctave = ((n % 12) + 12) % 12;
      if (!isBlackKey[noteInOctave]) {
        const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
        const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);
        const keyH = yBottom - yTop;

        if (yBottom >= 0 && yTop <= h) {
          this.ctx.fillStyle = "#f4f4f5";
          this.ctx.fillRect(0, yTop, KEYBOARD_WIDTH, keyH);
          this.ctx.strokeStyle = "#a1a1aa";
          this.ctx.lineWidth = 0.5;
          this.ctx.beginPath();
          this.ctx.moveTo(0, yTop);
          this.ctx.lineTo(KEYBOARD_WIDTH, yTop);
          this.ctx.stroke();

          if (noteInOctave === 0 && keyH >= 7) {
            this.ctx.fillStyle = "#52525b";
            this.ctx.font = "bold 9px sans-serif";
            this.ctx.textAlign = "right";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(`C${Math.floor(n / 12) - 1}`, KEYBOARD_WIDTH - 3, yTop + keyH / 2);
          }
        }
      }
    }

    const blackKeyWidth = Math.round(KEYBOARD_WIDTH * 0.6);
    for (let n = nMin; n <= nMax; n++) {
      const noteInOctave = ((n % 12) + 12) % 12;
      if (isBlackKey[noteInOctave]) {
        const yBottom = this.freqToY(440 * Math.pow(2, (n - 0.5 - 69) / 12), h);
        const yTop = this.freqToY(440 * Math.pow(2, (n + 0.5 - 69) / 12), h);

        if (yBottom >= 0 && yTop <= h) {
          this.ctx.fillStyle = "#18181b";
          this.ctx.fillRect(0, yTop, blackKeyWidth, yBottom - yTop);
          this.ctx.strokeStyle = "#3f3f46";
          this.ctx.lineWidth = 0.5;
          this.ctx.strokeRect(0, yTop, blackKeyWidth, yBottom - yTop);
        }
      }
    }

    this.ctx.strokeStyle = "#3f3f46";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(KEYBOARD_WIDTH, 0);
    this.ctx.lineTo(KEYBOARD_WIDTH, h);
    this.ctx.stroke();
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
      // 有効データ範囲内のみ目盛りを描画
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