// Loads ROM-extracted images/font/audio served from extracted/ (Vite publicDir).

export interface GfxMeta {
  championBg: string;
  hpbox_enemy: CellMeta; hpbox_player: CellMeta; platform_enemy: CellMeta; platform_player: CellMeta;
  hpPalette: number[][];
  species: Record<string, { yOffset: number; height: number[] }>;
  font: { glyphW: number; glyphH: number; perRow: number; firstChar: number; widths: number[]; chars: Record<string, number> };
}
export interface CellMeta { originX: number; originY: number; w: number; h: number }

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`missing ${src}`));
    img.src = src;
  });
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
export function image(src: string) {
  if (!imageCache.has(src)) imageCache.set(src, loadImage(src));
  return imageCache.get(src)!;
}

export const pokemonSprite = (species: number, back: boolean, female = false) =>
  `gfx/pokemon/${back ? 'back' : 'front'}${female ? '-female' : ''}/${String(species).padStart(3, '0')}.png`;

// ---------------------------------------------------------------- ROM font

export type Rgb = string; // css color
export interface TextStyle { color: Rgb; shadow: Rgb }
export const STYLE_DARK: TextStyle = { color: '#383838', shadow: '#d8d8d8' };   // DP dark text on light boxes
export const STYLE_LIGHT: TextStyle = { color: '#f8f8f8', shadow: '#686868' };  // white text on dark/colored boxes

export class RomFont {
  private cache = new Map<string, HTMLCanvasElement>();
  constructor(private atlas: HTMLImageElement, private meta: GfxMeta['font']) {}

  /** Atlas recolored: R channel -> text color, G -> shadow, B (glyph background) -> transparent. */
  private tinted(style: TextStyle): HTMLCanvasElement {
    const key = style.color + style.shadow;
    let c = this.cache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = this.atlas.width; c.height = this.atlas.height;
    const g = c.getContext('2d')!;
    g.drawImage(this.atlas, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const parse = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const fg = parse(style.color), sh = parse(style.shadow);
    // Threshold rather than test for non-zero: anti-fingerprinting browsers add ±1 noise to getImageData.
    for (let i = 0; i < d.data.length; i += 4) {
      const [r, gg, a] = [d.data[i], d.data[i + 1], d.data[i + 3]];
      const col = a < 128 ? null : r > 127 ? fg : gg > 127 ? sh : null;
      if (col) { d.data[i] = col[0]; d.data[i + 1] = col[1]; d.data[i + 2] = col[2]; d.data[i + 3] = 255; }
      else d.data[i + 3] = 0;
    }
    g.putImageData(d, 0, 0);
    this.cache.set(key, c);
    return c;
  }

  code(ch: string): number { return this.meta.chars[ch] ?? this.meta.chars['?']; }
  charWidth(ch: string): number { return this.meta.widths[this.code(ch) - this.meta.firstChar] ?? 6; }
  width(s: string): number { let w = 0; for (const ch of s) w += this.charWidth(ch); return w; }

  /** Draws one line (no wrapping). Returns the x after the text. */
  draw(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, style: TextStyle = STYLE_DARK): number {
    const src = this.tinted(style);
    const { glyphW, glyphH, perRow, firstChar } = this.meta;
    for (const ch of s) {
      if (ch === ' ') { x += this.charWidth(' '); continue; }
      const i = this.code(ch) - firstChar;
      ctx.drawImage(src, (i % perRow) * glyphW, Math.floor(i / perRow) * glyphH, glyphW, glyphH, x, y, glyphW, glyphH);
      x += this.charWidth(ch);
    }
    return x;
  }
}

// ---------------------------------------------------------------- audio

export interface AudioManifest {
  bgm: Record<string, { file: string; loopStart: number; loopEnd: number }>;
  se: Record<string, string>;
  cryFormat: string;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private bgm: AudioBufferSourceNode | null = null;
  private bgmName = '';
  private master: GainNode | null = null;
  muted = false;
  constructor(private manifest: AudioManifest | null) {}

  /** Must be called from a user gesture (browser autoplay rules). */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.master.gain.value = this.muted ? 0 : 1;
    }
    void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  private load(path: string) {
    if (!this.buffers.has(path)) {
      this.buffers.set(path, fetch(path).then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(b => this.ctx!.decodeAudioData(b)).catch(() => null));
    }
    return this.buffers.get(path)!;
  }

  async playBgm(name: string) {
    if (!this.ctx || !this.manifest || this.bgmName === name) return;
    this.stopBgm();
    this.bgmName = name;
    const m = this.manifest.bgm[name];
    if (!m) return;
    const buf = await this.load(`audio/${m.file}`);
    if (!buf || this.bgmName !== name) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = m.loopStart;
    src.loopEnd = m.loopEnd;
    src.connect(this.master!);
    src.start();
    this.bgm = src;
  }

  stopBgm() {
    this.bgm?.stop();
    this.bgm = null;
    this.bgmName = '';
  }

  async playSe(name: string) {
    if (!this.ctx || !this.manifest?.se[name]) return;
    await this.playFile(`audio/${this.manifest.se[name]}`);
  }

  async playCry(species: number) {
    if (!this.ctx || !this.manifest) return;
    await this.playFile(`audio/cry/${String(species).padStart(3, '0')}.${this.manifest.cryFormat}`);
  }

  private async playFile(path: string): Promise<void> {
    return this.playFilePanned(path, 0);
  }

  /** Sound effects currently playing (battle animation scripts wait for these). */
  effectsPlaying = 0;

  /** pan: -1 (left) .. 1 (right), the DS's ±127 effect pan. */
  async playFilePanned(path: string, pan: number): Promise<void> {
    if (!this.ctx || this.ctx.state !== 'running') return; // suspended (no user gesture yet): nothing would end
    this.effectsPlaying++;
    try {
      const buf = await this.load(path);
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (pan && this.ctx.createStereoPanner) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        src.connect(p).connect(this.master!);
      } else src.connect(this.master!);
      src.start();
      await new Promise<void>(r => (src.onended = () => r()));
    } finally {
      this.effectsPlaying--;
    }
  }
}
