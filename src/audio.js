import { FFT_SIZE } from "./constants.js";
import { FastFourierTransformer } from "./fft.js";

// PCM (Float32Array) を正規の 16bit WAV バイナリ (Blob) にエンコード
export function encodeWAV(samples, sampleRate = 44100) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.micStream = null;
    this.sourceNode = null;
    this.scriptNode = null;
    this.isMicActive = false;

    this.history = [];
    this.historyTimes = [];
    this.recordedPcmSamples = [];
    this.fullBuffer = null;

    this.activeSource = null;
    this.isPlaying = false;
    this.playStartCtxTime = 0;
    this.playStartOffsetSec = 0;
  }

  setupContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.35;
      this.analyser.minDecibels = -85;
      this.analyser.maxDecibels = -15;
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  getSampleRate() {
    return this.ctx ? this.ctx.sampleRate : 44100;
  }

  playPianoNote(freq) {
    this.setupContext();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.32, now);
    masterGain.connect(ctx.destination);

    const hammer = ctx.createOscillator();
    const hammerGain = ctx.createGain();
    hammer.type = "triangle";
    hammer.frequency.setValueAtTime(Math.min(2000, freq * 0.7), now);
    hammerGain.gain.setValueAtTime(0.35, now);
    hammerGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    hammer.connect(hammerGain);
    hammerGain.connect(masterGain);
    hammer.start(now);
    hammer.stop(now + 0.03);

    const harmonics = [
      [1.0, 1.0, 1.0],
      [2.0, 0.45, 0.75],
      [3.0, 0.22, 0.55],
      [4.0, 0.12, 0.38],
      [5.0, 0.06, 0.25],
      [6.0, 0.03, 0.18],
    ];

    harmonics.forEach(([mult, amp, decayRatio]) => {
      const hFreq = freq * mult;
      if (hFreq > 20000) return;

      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(hFreq, now);

      const decayTime = Math.max(0.35, Math.min(3.2, (1100 / freq) * decayRatio));
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(amp, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decayTime);

      osc.connect(g);
      g.connect(masterGain);

      osc.start(now);
      osc.stop(now + decayTime + 0.05);
    });
  }

  async startMic(onProcessFrame) {
    this.setupContext();
    this.stopPlayback();

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (this.sourceNode) this.sourceNode.disconnect();
    this.sourceNode = this.ctx.createMediaStreamSource(this.micStream);
    this.sourceNode.connect(this.analyser);

    this.scriptNode = this.ctx.createScriptProcessor(4096, 1, 1);
    this.scriptNode.onaudioprocess = (e) => {
      if (!this.isMicActive) return;
      this.recordedPcmSamples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.sourceNode.connect(this.scriptNode);
    this.scriptNode.connect(this.ctx.destination);

    this.isMicActive = true;
    const baseOffsetSec = this.historyTimes[this.historyTimes.length - 1] || 0;
    const recordStartTime = performance.now() - baseOffsetSec * 1000;

    const loop = () => {
      if (!this.isMicActive) return;
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      this.analyser.getByteFrequencyData(dataArray);

      const elapsedSec = (performance.now() - recordStartTime) / 1000;
      this.history.push(dataArray);
      this.historyTimes.push(elapsedSec);

      onProcessFrame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stopMic() {
    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    this.isMicActive = false;
    this.fullBuffer = this.buildBufferFromPcm();
  }

  buildBufferFromPcm() {
    if (this.recordedPcmSamples.length === 0) return null;
    const totalLength = this.recordedPcmSamples.reduce((acc, cur) => acc + cur.length, 0);
    const buffer = this.ctx.createBuffer(1, totalLength, this.ctx.sampleRate);
    const channelData = buffer.getChannelData(0);

    let offset = 0;
    for (const chunk of this.recordedPcmSamples) {
      channelData.set(chunk, offset);
      offset += chunk.length;
    }
    return buffer;
  }

  startPlayback(startSec, onUpdate, onEnd) {
    this.setupContext();

    if (!this.fullBuffer && this.recordedPcmSamples.length > 0) {
      this.fullBuffer = this.buildBufferFromPcm();
    }
    if (!this.fullBuffer || startSec >= this.fullBuffer.duration) return false;

    this.stopPlayback();

    this.activeSource = this.ctx.createBufferSource();
    this.activeSource.buffer = this.fullBuffer;
    this.activeSource.connect(this.ctx.destination);

    this.isPlaying = true;
    this.playStartCtxTime = this.ctx.currentTime;
    this.playStartOffsetSec = startSec;
    this.activeSource.start(0, startSec);

    const syncLoop = () => {
      if (!this.isPlaying) return;
      const currentSec = this.playStartOffsetSec + (this.ctx.currentTime - this.playStartCtxTime);
      if (currentSec >= this.fullBuffer.duration) {
        this.stopPlayback();
        if (onEnd) onEnd();
        return;
      }

      let f = 0;
      while (f < this.historyTimes.length - 1 && this.historyTimes[f + 1] <= currentSec) {
        f++;
      }
      onUpdate(f);
      requestAnimationFrame(syncLoop);
    };
    requestAnimationFrame(syncLoop);

    this.activeSource.onended = () => {
      if (this.isPlaying) {
        this.stopPlayback();
        if (onEnd) onEnd();
      }
    };
    return true;
  }

  stopPlayback() {
    if (this.activeSource) {
      try { this.activeSource.stop(); } catch (e) {}
      this.activeSource.disconnect();
      this.activeSource = null;
    }
    this.isPlaying = false;
  }

  async parseAudioFile(file) {
    this.setupContext();
    this.stopPlayback();
    if (this.isMicActive) this.stopMic();

    const arrayBuffer = await file.arrayBuffer();
    this.fullBuffer = await this.ctx.decodeAudioData(arrayBuffer);

    this.history = [];
    this.historyTimes = [];

    const sampleRate = this.fullBuffer.sampleRate;
    const pcmData = this.fullBuffer.getChannelData(0);
    this.recordedPcmSamples = [new Float32Array(pcmData)];

    const transformer = new FastFourierTransformer(FFT_SIZE);
    const stepSamples = Math.round(sampleRate / 60);
    const totalSteps = Math.floor((pcmData.length - FFT_SIZE) / stepSamples);

    for (let f = 0; f < totalSteps; f++) {
      const start = f * stepSamples;
      const slice = pcmData.subarray(start, start + FFT_SIZE);
      const freqData = transformer.process(slice);

      this.history.push(freqData);
      this.historyTimes.push(start / sampleRate);
    }
  }

  clear() {
    this.stopPlayback();
    if (this.isMicActive) this.stopMic();
    this.history = [];
    this.historyTimes = [];
    this.recordedPcmSamples = [];
    this.fullBuffer = null;
  }
}