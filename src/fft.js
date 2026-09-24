// 高精度 FFT エンジン (Cooley-Tukey Radix-2 + Hanning Window)
export class FastFourierTransformer {
  constructor(size) {
    this.size = size;
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
  }

  process(realInput) {
    const n = this.size;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      real[i] = (realInput[i] || 0) * this.window[i];
    }

    // ビット反転
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < j) {
        let temp = real[i]; real[i] = real[j]; real[j] = temp;
      }
      let k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    // バタフライ演算
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let tableIdx = 0;
        for (let k = 0; k < half; k++) {
          const c = this.cosTable[tableIdx];
          const s = this.sinTable[tableIdx];
          const tr = real[i + k + half] * c - imag[i + k + half] * s;
          const ti = real[i + k + half] * s + imag[i + k + half] * c;
          real[i + k + half] = real[i + k] - tr;
          imag[i + k + half] = imag[i + k] - ti;
          real[i + k] += tr;
          imag[i + k] += ti;
          tableIdx += step;
        }
      }
    }

    const out = new Uint8Array(n / 2);
    const minDb = -85;
    const maxDb = -15;
    const range = maxDb - minDb;

    for (let i = 0; i < n / 2; i++) {
      const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (n / 2);
      const db = 20 * Math.log10(mag + 1e-6);
      const norm = Math.max(0, Math.min(1, (db - minDb) / range));
      out[i] = Math.round(norm * 255);
    }
    return out;
  }
}