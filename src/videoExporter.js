// MP4 動画エクスポート制御モジュール

export class VideoExporter {
  constructor(canvas, audio, filterManager) {
    this.canvas = canvas;
    this.audio = audio;
    this.filterManager = filterManager;
    this.recorder = null;
    this.isExporting = false;
  }

  getBestMimeType() {
    const candidates = [
      "video/mp4",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
      "video/webm;codecs=vp9,opus",
      "video/webm"
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return "";
  }

  async startExport({ onProgress, onComplete, onError }) {
    if (this.isExporting) return;

    this.audio.setupContext();
    const playBuf = this.audio.getFilteredBuffer(this.filterManager);
    if (!playBuf || playBuf.duration <= 0) {
      onError(new Error("出力可能な音声データがありません"));
      return;
    }

    const mimeType = this.getBestMimeType();
    if (!mimeType) {
      onError(new Error("お使いの環境では動画録画機能がサポートされていません"));
      return;
    }

    try {
      // 1. Canvas 映像ストリーム (60fps)
      const canvasStream = this.canvas.captureStream(60);

      // 2. 内部録画専用オーディオストリーム (スピーカーには流さない)
      const audioDest = this.audio.ctx.createMediaStreamDestination();

      // 3. 映像と音声を結合
      const combinedTracks = [
        ...canvasStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks()
      ];
      const combinedStream = new MediaStream(combinedTracks);

      const options = {
        mimeType,
        videoBitsPerSecond: 8000000,
        audioBitsPerSecond: 192000
      };
      this.recorder = new MediaRecorder(combinedStream, options);
      const chunks = [];

      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      this.recorder.onstop = () => {
        this.isExporting = false;
        const blob = new Blob(chunks, { type: mimeType || "video/mp4" });
        onComplete(blob);
      };

      this.isExporting = true;
      this.recorder.start(250);

      // 4. 先頭(0.0s)から消音再生を開始し、オーディオを audioDest に供給
      const totalDuration = playBuf.duration;

      this.audio.startPlayback(
        0,
        this.filterManager,
        (progress) => {
          if (!this.isExporting) return;
          const currentSec = progress * totalDuration;
          onProgress(progress, currentSec, totalDuration);
        },
        () => {
          if (this.isExporting && this.recorder && this.recorder.state !== "inactive") {
            this.recorder.stop();
          }
        },
        audioDest // 録画用ストリームにのみ音声を流す (スピーカーは消音)
      );
    } catch (err) {
      this.isExporting = false;
      this.audio.stopPlayback();
      onError(err);
    }
  }

  cancel() {
    if (this.isExporting) {
      this.isExporting = false;
      if (this.recorder && this.recorder.state !== "inactive") {
        try { this.recorder.stop(); } catch (e) {}
      }
      this.audio.stopPlayback();
    }
  }
}