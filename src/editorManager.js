import { DEFAULT_FRAME_WIDTH, DEFAULT_MIN_FREQ, DEFAULT_MAX_FREQ } from "./constants.js";
import { encodeWAV, detectPitchFromSpectrum } from "./audio.js";
import {
  saveEditorToStorage, deleteEditorFromStorage,
  loadAllEditorsFromStorage, saveActiveEditorId, getActiveEditorId
} from "./db.js";

async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

export class EditorSession {
  constructor(id, name) {
    this.id = id || "editor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    this.name = name || "無題の解析";
    this.history = [];
    this.historyTimes = [];
    this.pitchHistory = [];
    this.pcmData = null;
    this.fullBuffer = null;
    this.sampleRate = 44100;
    this.scrollX = 0;
    this.frameWidth = DEFAULT_FRAME_WIDTH;
    this.viewMinFreq = DEFAULT_MIN_FREQ;
    this.viewMaxFreq = DEFAULT_MAX_FREQ;
    this.isNew = true;
    this.filePath = null;
  }
}

export class EditorManager {
  constructor(audio, renderer, filterManager) {
    this.audio = audio;
    this.renderer = renderer;
    this.filterManager = filterManager;
    this.editors = [];
    this.activeEditor = null;
    this.onStateChangeCallback = null;
  }

  setOnStateChange(cb) {
    this.onStateChangeCallback = cb;
  }

  notifyStateChange() {
    if (this.onStateChangeCallback) this.onStateChangeCallback();
  }

  getCurrentPcmSamples(applyFilter = false) {
    let rawPcm = null;
    if (this.audio.recordedPcmSamples.length > 0) {
      const total = this.audio.recordedPcmSamples.reduce((sum, c) => sum + c.length, 0);
      rawPcm = new Float32Array(total);
      let offset = 0;
      for (const c of this.audio.recordedPcmSamples) {
        rawPcm.set(c, offset);
        offset += c.length;
      }
    } else {
      rawPcm = this.activeEditor ? this.activeEditor.pcmData : null;
    }

    if (!rawPcm) return null;
    if (applyFilter && this.filterManager.hasActiveFilters()) {
      return this.filterManager.applyFilterToPcm(rawPcm, this.audio.getSampleRate());
    }
    return rawPcm;
  }

  async saveCurrentEditorState(currentScrollX, frameWidth) {
    if (!this.activeEditor) return;

    this.activeEditor.history = this.audio.history;
    this.activeEditor.historyTimes = this.audio.historyTimes;
    this.activeEditor.pitchHistory = this.audio.pitchHistory;
    this.activeEditor.scrollX = currentScrollX;
    this.activeEditor.sampleRate = this.audio.getSampleRate();
    this.activeEditor.frameWidth = frameWidth;
    this.activeEditor.viewMinFreq = this.renderer.viewMinFreq;
    this.activeEditor.viewMaxFreq = this.renderer.viewMaxFreq;

    const currentPcm = this.getCurrentPcmSamples(false);
    if (currentPcm) {
      this.activeEditor.pcmData = currentPcm;
    }
    this.activeEditor.fullBuffer = this.audio.fullBuffer;

    const dbData = {
      id: this.activeEditor.id,
      name: this.activeEditor.name,
      history: this.activeEditor.history,
      historyTimes: this.activeEditor.historyTimes,
      pitchHistory: this.activeEditor.pitchHistory,
      pcmData: this.activeEditor.pcmData,
      sampleRate: this.activeEditor.sampleRate,
      scrollX: this.activeEditor.scrollX,
      frameWidth: this.activeEditor.frameWidth,
      viewMinFreq: this.activeEditor.viewMinFreq,
      viewMaxFreq: this.activeEditor.viewMaxFreq,
      isNew: this.activeEditor.isNew,
      filePath: this.activeEditor.filePath
    };

    saveEditorToStorage(dbData).catch(console.error);
    saveActiveEditorId(this.activeEditor.id).catch(console.error);
    this.notifyStateChange();
  }

  async applyEditorToWorkspace(editor, verifyFile = true) {
    if (verifyFile && editor.filePath) {
      const exists = await invokeTauri("check_file_exists", { path: editor.filePath });
      if (!exists) {
        const errMsg = `エラー: 元の音声ファイルが見つかりません。\nファイルが削除または移動された可能性があります。\nパス: ${editor.filePath}`;
        alert(errMsg);
        throw new Error(errMsg);
      }
    }

    this.activeEditor = editor;

    this.audio.history = editor.history || [];
    this.audio.historyTimes = editor.historyTimes || [];
    this.audio.pitchHistory = editor.pitchHistory || [];
    this.audio.recordedPcmSamples = editor.pcmData ? [editor.pcmData] : [];

    if (editor.fullBuffer) {
      this.audio.fullBuffer = editor.fullBuffer;
    } else if (editor.pcmData) {
      this.audio.setupContext();
      const buf = this.audio.ctx.createBuffer(1, editor.pcmData.length, editor.sampleRate || 44100);
      buf.getChannelData(0).set(editor.pcmData);
      this.audio.fullBuffer = buf;
      editor.fullBuffer = buf;
    } else {
      this.audio.fullBuffer = null;
    }

    this.renderer.viewMinFreq = editor.viewMinFreq || DEFAULT_MIN_FREQ;
    this.renderer.viewMaxFreq = editor.viewMaxFreq || DEFAULT_MAX_FREQ;
    this.renderer.rebuildBakedLUT();

    this.notifyStateChange();
    return {
      scrollX: editor.scrollX || 0,
      frameWidth: editor.frameWidth || DEFAULT_FRAME_WIDTH
    };
  }

  async switchEditor(editor, currentScrollX, frameWidth) {
    if (this.activeEditor && this.activeEditor.id === editor.id) return null;
    if (this.audio.isMicActive) this.audio.stopMic();
    if (this.audio.isPlaying) this.audio.stopPlayback();

    await this.saveCurrentEditorState(currentScrollX, frameWidth);
    try {
      return await this.applyEditorToWorkspace(editor, true);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  async createNewEditor(currentScrollX, frameWidth) {
    if (this.audio.isMicActive) this.audio.stopMic();
    if (this.audio.isPlaying) this.audio.stopPlayback();

    await this.saveCurrentEditorState(currentScrollX, frameWidth);
    const num = this.editors.length + 1;
    const newEd = new EditorSession(null, `無題の解析 ${num}`);
    this.editors.push(newEd);
    return await this.applyEditorToWorkspace(newEd, false);
  }

  async closeActiveEditor() {
    if (!this.activeEditor) return null;

    if (this.audio.isMicActive) this.audio.stopMic();
    if (this.audio.isPlaying) this.audio.stopPlayback();

    const closingId = this.activeEditor.id;
    await deleteEditorFromStorage(closingId);

    this.editors = this.editors.filter((e) => e.id !== closingId);

    if (this.editors.length > 0) {
      return await this.applyEditorToWorkspace(this.editors[0], false);
    } else {
      this.audio.clear();
      const newEd = new EditorSession(null, "無題の解析 1");
      this.editors = [newEd];
      const res = await this.applyEditorToWorkspace(newEd, false);
      await this.saveCurrentEditorState(0, DEFAULT_FRAME_WIDTH);
      return res;
    }
  }

  async loadAudioFromBuffer(arrayBuffer, fileName, filePath, currentScrollX, frameWidth, onProgress) {
    if (this.audio.isMicActive) this.audio.stopMic();
    if (this.audio.isPlaying) this.audio.stopPlayback();

    await this.saveCurrentEditorState(currentScrollX, frameWidth);

    let targetEditor = this.activeEditor;
    if (!targetEditor || !targetEditor.isNew || this.audio.history.length > 0) {
      targetEditor = new EditorSession(null, fileName);
      this.editors.push(targetEditor);
    } else {
      targetEditor.name = fileName;
    }
    targetEditor.isNew = false;
    targetEditor.filePath = filePath;

    this.audio.setupContext();
    const fullBuffer = await this.audio.ctx.decodeAudioData(arrayBuffer);
    const sampleRate = fullBuffer.sampleRate;
    const pcmData = fullBuffer.getChannelData(0);

    const history = [];
    const historyTimes = [];
    const pitchHistory = [];

    const { FastFourierTransformer } = await import("./fft.js");
    const transformer = new FastFourierTransformer(4096);
    const stepSamples = Math.round(sampleRate / 60);
    const totalSteps = Math.floor((pcmData.length - 4096) / stepSamples);

    const chunkSize = 250;
    for (let f = 0; f < totalSteps; f += chunkSize) {
      const end = Math.min(totalSteps, f + chunkSize);
      for (let i = f; i < end; i++) {
        const start = i * stepSamples;
        const slice = pcmData.subarray(start, start + 4096);
        const freqData = transformer.process(slice);
        history.push(freqData);
        historyTimes.push(start / sampleRate);
        pitchHistory.push(detectPitchFromSpectrum(freqData, sampleRate));
      }
      if (onProgress) onProgress(Math.round((end / totalSteps) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }

    targetEditor.history = history;
    targetEditor.historyTimes = historyTimes;
    targetEditor.pitchHistory = pitchHistory;
    targetEditor.fullBuffer = fullBuffer;
    targetEditor.pcmData = new Float32Array(pcmData);
    targetEditor.sampleRate = sampleRate;
    targetEditor.scrollX = 0;

    const res = await this.applyEditorToWorkspace(targetEditor, false);
    await this.saveCurrentEditorState(0, targetEditor.frameWidth);
    return res;
  }

  async saveFile(applyFilter) {
    if (!this.activeEditor || !this.activeEditor.filePath) return false;
    const pcm = this.getCurrentPcmSamples(applyFilter);
    if (!pcm) return false;

    const wavBlob = encodeWAV(pcm, this.audio.getSampleRate());
    const arrayBuffer = await wavBlob.arrayBuffer();
    const uint8 = Array.from(new Uint8Array(arrayBuffer));

    await invokeTauri("save_audio_file", {
      path: this.activeEditor.filePath,
      data: uint8
    });
    return true;
  }

  async saveFileAs(applyFilter) {
    if (!this.activeEditor) return null;
    const pcm = this.getCurrentPcmSamples(applyFilter);
    if (!pcm) return null;

    const baseName = this.activeEditor.name.replace(/\.[^/.]+$/, "") + ".wav";
    const wavBlob = encodeWAV(pcm, this.audio.getSampleRate());
    const arrayBuffer = await wavBlob.arrayBuffer();
    const uint8 = Array.from(new Uint8Array(arrayBuffer));

    try {
      const res = await invokeTauri("save_audio_file_as", {
        defaultName: baseName,
        data: uint8
      });
      if (res) {
        const [newPath, newName] = res;
        this.activeEditor.filePath = newPath;
        this.activeEditor.name = newName;
        await this.saveCurrentEditorState(this.activeEditor.scrollX, this.activeEditor.frameWidth);
        return newName;
      }
      return null;
    } catch (e) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(wavBlob);
      a.download = baseName;
      a.click();
      return baseName;
    }
  }

  updateListUI(container, onSelect) {
    container.innerHTML = "";
    this.editors.forEach((ed) => {
      const item = document.createElement("div");
      item.className = "menu-dropdown-item editor-item" + (this.activeEditor && ed.id === this.activeEditor.id ? " active" : "");
      item.innerHTML = `<span class="check-mark">${this.activeEditor && ed.id === this.activeEditor.id ? "✓" : ""}</span><span class="editor-name">${ed.name}</span>`;
      item.addEventListener("click", () => onSelect(ed));
      container.appendChild(item);
    });
  }

  async initialize(onApply) {
    const savedEditors = await loadAllEditorsFromStorage();
    const lastActiveId = await getActiveEditorId();

    if (savedEditors && savedEditors.length > 0) {
      this.editors = savedEditors.map((d) => {
        const ed = new EditorSession(d.id, d.name);
        ed.history = d.history || [];
        ed.historyTimes = d.historyTimes || [];
        ed.pitchHistory = d.pitchHistory || [];
        ed.pcmData = d.pcmData || null;
        ed.sampleRate = d.sampleRate || 44100;
        ed.scrollX = d.scrollX || 0;
        ed.frameWidth = d.frameWidth || DEFAULT_FRAME_WIDTH;
        ed.viewMinFreq = d.viewMinFreq || DEFAULT_MIN_FREQ;
        ed.viewMaxFreq = d.viewMaxFreq || DEFAULT_MAX_FREQ;
        ed.isNew = d.isNew !== undefined ? d.isNew : false;
        ed.filePath = d.filePath || null;
        return ed;
      });

      const target = this.editors.find((e) => e.id === lastActiveId) || this.editors[0];
      try {
        const res = await this.applyEditorToWorkspace(target, true);
        if (onApply) onApply(res);
      } catch (err) {
        const res = await this.createNewEditor(0, DEFAULT_FRAME_WIDTH);
        if (onApply) onApply(res);
      }
    } else {
      const res = await this.createNewEditor(0, DEFAULT_FRAME_WIDTH);
      if (onApply) onApply(res);
    }
  }
}