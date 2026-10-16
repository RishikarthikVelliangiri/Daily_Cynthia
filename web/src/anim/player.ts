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

  private constructor(private sound: Sound) {}

  /** null when the animation data was not extracted (older extract) or WebGL is unavailable. */
  static async load(sound: Sound): Promise<AnimPlayer | null> {
    try {
      const [scripts, pos, se, bgs, oam] = await Promise.all(['anim/scripts.json', 'anim/positions.json', 'anim/se.json', 'anim/bgs.json', 'anim/oam.json']
        .map(p => fetch(p).then(r => (r.ok ? r.json() : Promise.reject(new Error(p))))));
      const p = new AnimPlayer(sound);
      p.data = { scripts, world: pos.world as Vec3[][], axis: pos.axis };
      p.se = se;
      p.bgs = bgs;
      p.oam = oam;
      for (const k in oam) p.sheet(oam[k].sheet);
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

  /** Creates the animation without running it (the caller steps it at 30 Hz). fx/bg are mutated live. */
  start(move: number, attacker: Side, fx: Record<Side, MonFx>, bg: BgFx, groundHeight: (s: Side) => number): MoveAnimation | null {
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
    }, move, attacker, fx, bg);
    this.current = anim;
    return anim;
  }

  /** Runs one move animation to completion in real time at 30 Hz (frames are skipped, not slowed, if rendering lags). */
  play(move: number, attacker: Side, fx: Record<Side, MonFx>, bg: BgFx, groundHeight: (s: Side) => number): Promise<void> {
    const anim = this.start(move, attacker, fx, bg, groundHeight);
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

  /** Draws the running animation's hardware sprites (above particles, like the DS OBJ layer). */
  drawSprites(g: CanvasRenderingContext2D) {
    for (const sp of this.current?.sprites.values() ?? []) {
      const res = this.oam[sp.key];
      if (!sp.visible || !res || sp.alpha <= 0) continue;
      const img = this.sheet(res.sheet);
      const cell = res.cells[res.anims[sp.anim]?.[0]?.[0] ?? 0];
      if (!img || !cell) continue;
      g.save();
      g.globalAlpha = Math.min(1, sp.alpha);
      g.translate(sp.x, sp.y);
      g.scale(sp.scaleX, sp.scaleY);
      g.drawImage(img, cell.x, 0, cell.w, cell.h, cell.ox, cell.oy, cell.w, cell.h);
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
