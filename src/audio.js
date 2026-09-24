import { FFT_SIZE } from "./constants.js";
import { FastFourierTransformer } from "./fft.js";

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.micStream = null;
    this.sourceNode = null;
    this.scriptNode = null;
    this.isMicActive = false;

    // 音声データ
    this.history = [];      // 各フレームの周波数データ (Uint8Array[])
    this.historyTimes = []; // 各フレームのタイムスタンプ (秒[])
    this.recordedPcmSamples = [];
    this.fullBuffer = null;

    // 再生状態
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

  // マイク録音の開始
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

  // マイク録音の停止
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

  // 指定秒数からの再生
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

  // 音声ファイルの解析
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