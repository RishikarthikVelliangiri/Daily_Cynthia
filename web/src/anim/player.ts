// Loads extracted move-animation data and plays MoveAnimations at 60 Hz for the battle scene.
import { image, type Sound } from '../ui/assets';
import { ParticleRenderer, type TextureSet } from './gl';
import { type AnimData, type BgFx, type MonFx, MoveAnimation, type ParticleAsset, type Side } from './system';
import type { SplFile, Vec3 } from './spl';

/** DP's main loop waits two vblanks per iteration (pret src/main.c), so battle logic, animation scripts and
 * particle updates all tick at 30 Hz. */
const FPS = 30;

export class AnimPlayer {
  private data: AnimData | null = null;
  private assets = new Map<number, Promise<ParticleAsset>>();
  private textures = new Map<ParticleAsset, TextureSet>();
  private renderer: ParticleRenderer | null = null;
  private se: Record<string, string> = {};
  private bgs: { n?: string; r?: string }[] = [];
  private bgImages = new Map<string, HTMLImageElement | null>();
  private oam: Record<string, { sheet: string; cells: ({ x: number; w: number; h: number; ox: number; oy: number } | null)[]; anims: [number, number][][] }> = {};
  current: MoveAnimation | null = null;
  private scratch = document.createElement('canvas');

  private constructor(private sound: Sound) {}

  /** null when the animation data was not extracted (older extract) or WebGL is unavailable. */
  static async load(sound: Sound): Promise<AnimPlayer | null> {
    try {
      const [scripts, pos, se, bgs, oam] = await Promise.all(['anim/scripts.json', 'anim/positions.json', 'anim/se.json', 'anim/bgs.json', 'anim/oam.json']
        .map(p => fetch(p).then(r => (r.ok ? r.json() : Promise.reject(new Error(p))))));
      const sub = await fetch('anim/sub.json').then(r => (r.ok ? r.json() : undefined), () => undefined); // older extracts lack it
      const p = new AnimPlayer(sound);
      p.data = { scripts, sub, world: pos.world as Vec3[][], axis: pos.axis };
      p.se = se;
      p.bgs = bgs;
      p.oam = oam;
      for (const k in oam) p.sheet(oam[k].sheet);
      for (let i = 0; i < 4; i++) p.statImage(i);
      bgs.forEach((e: { n?: string; r?: string }, i: number) => { p.effectImage(i, false); if (e.r) p.effectImage(i, true); }); // preload (~60 small PNGs)
      p.renderer = new ParticleRenderer();
      return p;
    } catch {
      return null;
    }
  }

  private particles(id: number): Promise<ParticleAsset> {
    let a = this.assets.get(id);
    if (!a) {
      const n = String(id).padStart(3, '0');
      a = Promise.all([fetch(`anim/particles/${n}.json`).then(r => r.json() as Promise<SplFile>), image(`anim/particles/${n}.png`)])
        .then(([file, sheet]) => ({ file, sheet }));
      this.assets.set(id, a);
    }
    return a;
  }

  /** True when the extract has the common (status / stat / weather) animations. */
  get hasCommon() { return !!this.data?.sub; }

  /** Creates the animation without running it (the caller steps it at 30 Hz). fx/bg are mutated live.
   * move: a move id or { sub } (common animation; attacker = the affected battler, target = the other one). */
  start(move: number | { sub: number }, attacker: Side, fx: Record<Side, MonFx>, bg: BgFx, groundHeight: (s: Side) => number, target?: Side): MoveAnimation | null {
    if (!this.data) return null;
    const anim = new MoveAnimation(this.data, {
      loadParticles: id => this.particles(id),
      playSe: (seq, pan) => {
        const f = this.se[String(seq)];
        if (f) void this.sound.playFilePanned(`anim/se/${f}`, Math.max(-1, Math.min(1, pan / 127)));
      },
      playCry: () => { /* the scene already plays cries on send-out; move scripts' cries (Growl, Roar…) are rare */ },
      seActive: () => this.sound.effectsPlaying > 0,
      groundHeight,
      animLength: (key, n) => (this.oam[key]?.anims[n] ?? []).reduce((t, f) => t + Math.max(1, f[1]), 0),
    }, move, attacker, fx, bg, 0, target);
    this.current = anim;
    return anim;
  }

  /** Runs one move animation to completion in real time at 30 Hz (frames are skipped, not slowed, if rendering lags). */
  play(move: number | { sub: number }, attacker: Side, fx: Record<Side, MonFx>, bg: BgFx, groundHeight: (s: Side) => number, target?: Side): Promise<void> {
    const anim = this.start(move, attacker, fx, bg, groundHeight, target);
    if (!anim) return Promise.resolve();
    return new Promise(resolve => {
      let t0 = performance.now(), stepped = 0;
      const tick = () => {
        if (anim.loading) { t0 = performance.now(); stepped = 0; setTimeout(tick, 1000 / 60); return; }
        const due = Math.floor(((performance.now() - t0) * FPS) / 1000) + 1;
        for (let k = 0; stepped < due && k < FPS; k++, stepped++) anim.step();
        if (anim.done) { this.current = null; resolve(); } else setTimeout(tick, 1000 / 60);
      };
      tick();
    });
  }

  /** Effect background image (null while loading or if missing). */
  effectImage(bg: number, reversed: boolean): HTMLImageElement | null {
    const e = this.bgs[bg];
    const file = e && ((reversed && e.r) || e.n);
    if (!file) return null;
    if (!this.bgImages.has(file)) {
      this.bgImages.set(file, null);
      image(`anim/bg/${file}`).then(img => this.bgImages.set(file, img), () => {});
    }
    return this.bgImages.get(file) ?? null;
  }

  private sheet(file: string) {
    if (!this.bgImages.has('oam/' + file)) {
      this.bgImages.set('oam/' + file, null);
      image(`anim/oam/${file}`).then(img => this.bgImages.set('oam/' + file, img), () => {});
    }
    return this.bgImages.get('oam/' + file) ?? null;
  }

  /** Stat-change overlay pattern (bg/stat0..3: up, down, heal, metal). */
  statImage(n: number): HTMLImageElement | null {
    const file = `stat${n}.png`;
    if (!this.bgImages.has(file)) {
      this.bgImages.set(file, null);
      image(`anim/bg/${file}`).then(img => this.bgImages.set(file, img), () => {});
    }
    return this.bgImages.get(file) ?? null;
  }

  /** Draws the running animation's hardware sprites whose sprite manager was drawn this frame; `behind` = BG
   * priority below the battlers (2+), else above the particles like the DS OBJ layer. */
  drawSprites(g: CanvasRenderingContext2D, behind: boolean) {
    const anim = this.current;
    if (!anim) return;
    const all = [...anim.sprites.values(), ...anim.extra].filter(sp => sp.visible && anim.shown.has(sp.mgr) && (sp.prio >= 2) === behind);
    all.sort((a, b) => b.order - a.order);
    for (const sp of all) {
      const res = this.oam[sp.key];
      const a = anim.alpha(sp);
      if (!res || a <= 0) continue;
      const img = this.sheet(res.sheet);
      const seq = res.anims[sp.anim] ?? res.anims[0] ?? [];
      const total = seq.reduce((n, f) => n + Math.max(1, f[1]), 0);
      let t = total ? sp.t % total : 0, ci = seq[0]?.[0] ?? 0;
      for (const [c, d] of seq) { if (t < Math.max(1, d)) { ci = c; break; } t -= Math.max(1, d); }
      const cell = res.cells[ci];
      if (!img || !cell) continue;
      g.save();
      g.globalAlpha = Math.min(1, a);
      g.translate(sp.x, sp.y);
      if (sp.rot) g.rotate((sp.rot / 65536) * Math.PI * 2);
      g.scale(sp.hflip ? -sp.scaleX : sp.scaleX, sp.scaleY);
      if (sp.fadeAmt > 0) { // palette blend toward a color over the cell's opaque pixels
        const c = this.scratch, sg = c.getContext('2d')!;
        c.width = cell.w; c.height = cell.h;
        sg.drawImage(img, cell.x, 0, cell.w, cell.h, 0, 0, cell.w, cell.h);
        sg.globalCompositeOperation = 'source-atop';
        sg.globalAlpha = Math.min(1, sp.fadeAmt / 16);
        const ch = (k: number) => Math.round((((sp.fadeColor >> k) & 31) * 255) / 31);
        sg.fillStyle = `rgb(${ch(0)},${ch(5)},${ch(10)})`;
        sg.fillRect(0, 0, cell.w, cell.h);
        g.drawImage(c, cell.ox, cell.oy);
      } else g.drawImage(img, cell.x, 0, cell.w, cell.h, cell.ox, cell.oy, cell.w, cell.h);
      g.restore();
    }
  }

  /** Draws the running animation's particles onto the top screen. */
  draw(g: CanvasRenderingContext2D) {
    const anim = this.current, r = this.renderer;
    if (!anim || !r) return;
    const batches = anim.quads().map(({ quads, sys }) => {
      let set = this.textures.get(sys.asset);
      if (!set) { set = r.upload(sys.asset.sheet, sys.asset.file.textures); this.textures.set(sys.asset, set); }
      return { quads, set };
    });
    if (!batches.some(b => b.quads.length)) return;
    r.render(batches);
    g.drawImage(r.canvas, 0, 0);
  }
}
