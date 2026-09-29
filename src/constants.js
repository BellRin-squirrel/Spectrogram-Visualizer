// レイアウトパラメータ (CSSピクセル単位)
export const FFT_SIZE = 4096;
export const DEFAULT_FRAME_WIDTH = 2;   // デフォルトの1スライス横幅 (px)
export const KEYBOARD_WIDTH = 50;       // ピアノ鍵盤の幅
export const AXIS_WIDTH = 54;           // 周波数目盛り幅
export const LEFT_MARGIN = KEYBOARD_WIDTH + AXIS_WIDTH; // 104px
export const SPECTRUM_PANEL_WIDTH = 160;// 右側スペクトル曲線グラフの幅 (px)
export const TIME_AXIS_HEIGHT = 20;     // 下部横軸 (時間・秒数ルーラー) の高さ (px)

// 周波数範囲パラメータ
export const DATA_MIN_FREQ = 20;        // 描画対象データの下限 (20Hz)
export const DATA_MAX_FREQ = 80000;     // 描画対象データの上限 (80kHz)
export const VIEW_LIMIT_MIN = 2;        // ズームアウト可能な下限限界 (2Hz)
export const VIEW_LIMIT_MAX = 500000;   // ズームアウト可能な上限限界 (500kHz)
export const DEFAULT_MIN_FREQ = 50;     // デフォルト表示下限 (50Hz)
export const DEFAULT_MAX_FREQ = 80000;  // デフォルト表示上限 (80kHz)

// 12段階キーカラーの多点Smoothstep補間LUT (リトルエンディアン: 0xAABBGGRR)
export const COLOR_LUT_32 = new Uint32Array(256);
(function initColorLUT() {
  const stops = [
    { pos: 0.00, r: 8,   g: 10,  b: 38  }, // 濃紺
    { pos: 0.08, r: 12,  g: 25,  b: 85  },
    { pos: 0.18, r: 18,  g: 55,  b: 155 }, // 藍・青
    { pos: 0.30, r: 24,  g: 105, b: 215 },
    { pos: 0.42, r: 28,  g: 170, b: 195 }, // シアン
    { pos: 0.52, r: 35,  g: 195, b: 90  }, // 黄緑
    { pos: 0.62, r: 105, g: 215, b: 35  }, // 明るい黄緑
    { pos: 0.72, r: 210, g: 230, b: 15  }, // 黄
    { pos: 0.81, r: 255, g: 175, b: 0   }, // 山吹・黄金
    { pos: 0.89, r: 255, g: 100, b: 0   }, // 橙
    { pos: 0.95, r: 255, g: 30,  b: 15  }, // 赤
    { pos: 1.00, r: 255, g: 255, b: 240 }  // ピーク (白熱)
  ];

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let stopIdx = 0;
    while (stopIdx < stops.length - 1 && stops[stopIdx + 1].pos < t) {
      stopIdx++;
    }
    const s0 = stops[stopIdx];
    const s1 = stops[Math.min(stops.length - 1, stopIdx + 1)];
    const range = s1.pos - s0.pos || 1;
    let localT = Math.max(0, Math.min(1, (t - s0.pos) / range));
    const smoothT = localT * localT * (3 - 2 * localT);

    const r = Math.round(s0.r + (s1.r - s0.r) * smoothT);
    const g = Math.round(s0.g + (s1.g - s0.g) * smoothT);
    const b = Math.round(s0.b + (s1.b - s0.b) * smoothT);

    COLOR_LUT_32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
})();