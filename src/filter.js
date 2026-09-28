import { FastFourierTransformer } from "./fft.js";

const FILTER_STORAGE_KEY = "spectrogram_filters_v2";

export class FrequencyFilterManager {
  constructor() {
    this.filters = [];
    this.loadFromStorage();

    // 完全再構成 (COLA) を満たす平方根ハニング窓 (Sine窓) を事前生成
    this.fftSize = 2048;
    this.hopSize = 1024;
    this.transformer = new FastFourierTransformer(this.fftSize);
    this.sineWindow = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.sineWindow[i] = Math.sin((Math.PI * (i + 0.5)) / this.fftSize);
    }
  }

  addDefaultFilter() {
    const defaultColors = ["#00f0ff", "#ff007f", "#ffd700", "#00ff66", "#a855f7"];
    const color = defaultColors[this.filters.length % defaultColors.length];
    const newFilter = {
      id: "filter_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      minFreq: 200,
      maxFreq: 500,
      gain: 100,
      color: color
    };
    this.filters.push(newFilter);
    this.saveToStorage();
    return newFilter;
  }

  addFilter(minFreq, maxFreq, gain = 100, color = "#00f0ff") {
    const newFilter = {
      id: "filter_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      minFreq: Math.min(minFreq, maxFreq),
      maxFreq: Math.max(minFreq, maxFreq),
      gain: Math.max(0, Math.min(10000, gain)),
      color: color
    };
    this.filters.push(newFilter);
    this.saveToStorage();
    return newFilter;
  }

  updateFilter(id, updates) {
    const f = this.filters.find((item) => item.id === id);
    if (f) {
      if (updates.minFreq !== undefined) f.minFreq = Math.max(20, Math.min(80000, updates.minFreq));
      if (updates.maxFreq !== undefined) f.maxFreq = Math.max(20, Math.min(80000, updates.maxFreq));
      if (f.minFreq > f.maxFreq) {
        const tmp = f.minFreq; f.minFreq = f.maxFreq; f.maxFreq = tmp;
      }
      if (updates.gain !== undefined) f.gain = Math.max(0, Math.min(10000, updates.gain));
      if (updates.color !== undefined) f.color = updates.color;
      this.saveToStorage();
    }
  }

  removeFilter(id) {
    this.filters = this.filters.filter((f) => f.id !== id);
    this.saveToStorage();
  }

  clearAll() {
    this.filters = [];
    this.saveToStorage();
  }

  hasActiveFilters() {
    return this.filters.length > 0;
  }

  // 周波数ごとのゲイン計算 (重なりは乗算、境界線は微小なコサインロールオフで滑らかに)
  getFrequencyMultiplier(freq) {
    if (this.filters.length === 0) return 1.0;

    let matched = false;
    let multiplier = 1.0;

    for (const f of this.filters) {
      if (freq >= f.minFreq && freq <= f.maxFreq) {
        matched = true;
        multiplier *= (f.gain / 100.0);
      } else {
        // 境界付近の微小スロープ (リンギング防止)
        const margin = Math.max(10, freq * 0.02);
        if (freq >= f.minFreq - margin && freq < f.minFreq) {
          const ratio = (freq - (f.minFreq - margin)) / margin;
          const factor = 0.5 * (1 - Math.cos(Math.PI * ratio));
          matched = true;
          multiplier *= (1.0 + (f.gain / 100.0 - 1.0) * factor);
        } else if (freq > f.maxFreq && freq <= f.maxFreq + margin) {
          const ratio = (f.maxFreq + margin - freq) / margin;
          const factor = 0.5 * (1 - Math.cos(Math.PI * ratio));
          matched = true;
          multiplier *= (1.0 + (f.gain / 100.0 - 1.0) * factor);
        }
      }
    }

    return matched ? multiplier : 0.0;
  }

  saveToStorage() {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(this.filters));
    } catch (e) {}
  }

  loadFromStorage() {
    try {
      const data = localStorage.getItem(FILTER_STORAGE_KEY);
      if (data) {
        this.filters = JSON.parse(data).map((f) => ({
          ...f,
          gain: f.gain !== undefined ? f.gain : 100
        }));
      }
    } catch (e) {
      this.filters = [];
    }
  }

  // 1チャンネルのPCMサンプルに高精度フィルタリングを適用
  applyFilterToSingleChannel(pcmSamples, sampleRate) {
    if (!this.hasActiveFilters()) return pcmSamples;

    const N = this.fftSize;
    const hop = this.hopSize;
    const output = new Float32Array(pcmSamples.length);
    const nyquist = sampleRate / 2;

    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const window = this.sineWindow;

    // 各ビンの周波数倍率を事前計算 (処理の超高速化)
    const binMultipliers = new Float32Array(N / 2 + 1);
    for (let b = 0; b <= N / 2; b++) {
      const freq = (b / (N / 2)) * nyquist;
      binMultipliers[b] = this.getFrequencyMultiplier(freq);
    }

    for (let pos = 0; pos + N <= pcmSamples.length; pos += hop) {
      // 1. 分析時: 平方根Hanning窓を適用
      for (let i = 0; i < N; i++) {
        real[i] = pcmSamples[pos + i] * window[i];
        imag[i] = 0;
      }

      this.transformer.fftCore(real, imag, false);

      // 2. ゲイン適用
      for (let b = 0; b <= N / 2; b++) {
        const mult = binMultipliers[b];
        real[b] *= mult;
        imag[b] *= mult;
        if (b > 0 && b < N / 2) {
          real[N - b] *= mult;
          imag[N - b] *= mult;
        }
      }

      this.transformer.fftCore(real, imag, true);

      // 3. 合成時: 再び平方根Hanning窓を適用してOLA (sin^2 + cos^2 = 1.0 で完全復元)
      for (let i = 0; i < N; i++) {
        output[pos + i] += real[i] * window[i];
      }
    }

    return output;
  }

  // ステレオ (マルチチャンネル) 対応フィルタリング
  applyFilterToAudioBuffer(audioCtx, sourceBuffer) {
    if (!this.hasActiveFilters()) return sourceBuffer;

    const numChannels = sourceBuffer.numberOfChannels;
    const length = sourceBuffer.length;
    const sampleRate = sourceBuffer.sampleRate;
    const outBuf = audioCtx.createBuffer(numChannels, length, sampleRate);

    for (let ch = 0; ch < numChannels; ch++) {
      const inputPcm = sourceBuffer.getChannelData(ch);
      const filtered = this.applyFilterToSingleChannel(inputPcm, sampleRate);
      outBuf.getChannelData(ch).set(filtered);
    }

    return outBuf;
  }
}