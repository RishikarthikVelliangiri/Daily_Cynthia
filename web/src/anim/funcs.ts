// Move-specific battle animation functions (CallFunc / AddSpriteWithFunc), ported from pret pokeplatinum
// src/battle_anim/script_funcs_*.c. Each starts a per-frame task on the MoveAnimation; names follow pret.
import type { MonCopy, MoveAnimation, OamSprite } from './system';
import {
  anchoredY, DEFAULT_POS, DEG, FX, groundOffset, Parabolic, PosLerp, Revolution, ScaleLerp, ScreenScrollX, Shake, type Side, Sinusoid,
  stepValue, ValueLerp, ValueLerpFx,
} from './helpers';

type Fn = (this: MoveAnimation, v: number[]) => void;
type SpriteFn = (this: MoveAnimation, sp: OamSprite, v: number[]) => void;
const COLOR_BLACK = 0, COLOR_WHITE = 0x7fff, COLOR_RED = 0x001f;
const opp = (s: Side): Side => (s === 'p1' ? 'p2' : 'p1');
const dirX = (s: Side) => (s === 'p2' ? -1 : 1); // BattleAnimUtil_GetTransformDirectionX
const dirY = dirX; // GetTransformDirectionY (enemy = -1)

/** PokemonSprite_StartFade: palette blend toward `color` stepping 1 every delay+1 frames; fx.fading while active. */
export function monFade(a: MoveAnimation, side: Side, from: number, to: number, delay: number, color: number) {
  const fx = a.fx[side];
  let cur = from, counter = 0;
  fx.fading = true;
  a.sysTask(() => {
    if (counter > 0) { counter--; return true; }
    counter = delay;
    fx.fadeColor = color; fx.fadeAmt = cur;
    if (cur === to) { fx.fading = false; return false; }
    cur += cur > to ? -1 : 1;
    return true;
  });
}

/** AlphaFadeContext: lerps the global blend EVA/EVB in its own system task. */
function alphaFade(a: MoveAnimation, sa: number, ea: number, sb: number, eb: number, steps: number) {
  const l = new PosLerp(sa, ea, sb, eb, steps);
  const st = { done: false };
  a.sysTask(() => {
    if (!l.update()) { st.done = true; return false; }
    a.blendA = Math.max(0, l.x); a.blendB = Math.max(0, l.y);
    return true;
  });
  return st;
}

/** SetSpriteBgBlending / SetSpriteBlending: -1 = default (26, 5). */
function setBlend(a: MoveAnimation, sa: number, sb: number) {
  a.blendA = sa === -1 ? 26 : sa; a.blendB = sb === -1 ? 5 : sb;
}

/** Applies a ScaleLerp to a battler, keeping it on the ground (BattleAnimUtil_GetGroundAnchoredScaleOffset). */
function scaleMon(a: MoveAnimation, side: Side, s: ScaleLerp, baseY: number, height = a.ground(side), top = false) {
  const fx = a.fx[side];
  fx.scaleX = s.x; fx.scaleY = s.y;
  fx.y = top ? anchoredY(baseY, height, s.curY, true) : baseY + groundOffset(height, s.curY);
}

/** RevolutionContext_InitOvalRevolutions: `revs` loops of a 32x8 oval, `steps` frames each (x radius * dir). */
const ovalRevolution = (revs: number, steps: number, dir = 1) => {
  const r = new Revolution(0, DEG(360), 0, DEG(360), 32 * dir, -8, steps);
  r.steps *= revs;
  return r;
};

/** Afterimage_Init/Update (position mode): sprites start hidden and join one by one `delay` frames apart, each
 * replaying the same transform from (x, y). */
class Afterimage {
  private ts: { update(): boolean; x: number; y: number }[];
  private counter = 0; private active = 0;
  constructor(make: () => { update(): boolean; x: number; y: number }, private x: number, private y: number, private delay: number,
    private sprites: (MonCopy | OamSprite | null)[]) {
    this.ts = sprites.map(make);
    sprites.forEach(s => { if (s) s.visible = false; });
  }
  update(): boolean {
    const on = this.sprites.map(() => true);
    if (this.delay <= this.counter && this.active < this.sprites.length) { const s = this.sprites[this.active]; if (s) s.visible = true; this.active++; this.counter = 0; }
    if (this.active < this.sprites.length) this.counter++;
    for (let i = 0; i < this.active; i++) {
      on[i] = this.ts[i].update();
      const s = this.sprites[i];
      if (!s) continue;
      if (on[i]) { s.x = this.x + this.ts[i].x; s.y = this.y + this.ts[i].y; } else s.visible = false;
    }
    return on.some(Boolean);
  }
}

const copy = (a: MoveAnimation, id: number): MonCopy | null => a.copies.get(id) ?? null;
/** LCRNG_Next (the game's linear congruential RNG), for paw/vine placement jitter. */
let lcrngState = 0x5a3c;
const lcrng = () => { lcrngState = (Math.imul(lcrngState, 1103515245) + 24691) >>> 0; return lcrngState >>> 16; };
const tick = (sp: OamSprite | MonCopy | null) => { if (sp && 't' in sp) sp.t++; };

export const MORE_FUNCS: Record<number, Fn> = {
  // 5 Strength(shrinkScale, growScale, shrinkFrames, growFrames)
  5(v) {
    const side = this.attacker, fx = this.fx[side], baseY = fx.y, h = this.ground(side);
    const scale = new ScaleLerp().init(100, 100, v[0], v[2]);
    const shake = new Shake(2, 0, 0, 10);
    let state = 0, blinks = 0;
    this.task(() => {
      switch (state) {
        case 0:
          if (scale.update()) { shake.update(); fx.scaleX = scale.x; fx.scaleY = scale.y; fx.x += shake.x; fx.y = baseY + groundOffset(h, scale.curY); }
          else state++;
          break;
        case 1: monFade(this, side, 0, 10, 0, COLOR_RED); state++; break;
        case 2: if (!fx.fading) { monFade(this, side, 10, 0, 0, COLOR_RED); state++; } break;
        case 3:
          if (!fx.fading) {
            if (++blinks >= 3) { scale.init(v[0], 100, v[1], v[3]); state++; } else state = 1;
          }
          break;
        case 4: case 5:
          if (scale.update()) scaleMon(this, side, scale, baseY, h);
          else if (state === 4) state++;
          else { fx.scaleX = 256; fx.scaleY = 256; fx.y = baseY; return false; }
          break;
      }
      return true;
    });
  },
  // 6 Bulk Up: squish/stretch then grow and settle
  6() {
    const side = this.attacker, baseY = this.fx[side].y, h = this.ground(side);
    const steps: [number, number, number, number, number][] = [
      [100, 150, 100, 50, 10], [150, 50, 50, 150, 10], [50, 100, 150, 100, 5], [100, 150, 100, 150, 5], [150, 100, 150, 100, 5]];
    let i = 0;
    const s = new ScaleLerp().initXY(...steps[0].slice(0, 4) as [number, number, number, number], 100, steps[0][4]);
    this.task(() => {
      if (s.update()) { scaleMon(this, side, s, baseY, h); return true; }
      if (++i >= steps.length) { const fx = this.fx[side]; fx.scaleX = 256; fx.scaleY = 256; fx.y = baseY; return false; }
      const [sx, ex, sy, ey, f] = steps[i];
      s.initXY(sx, ex, sy, ey, 100, f);
      return true;
    });
  },
  // 7 Double Team: four gray translucent copies slide out and back 8 times, then fade
  7() {
    const side = this.attacker, ax = this.fx[side].x, ay = this.fx[side].y;
    const sprites = [0, 1, 2, 3].map(i => copy(this, i));
    let a = 8, b = 6;
    this.blendA = a; this.blendB = b;
    const enemy = side === 'p2';
    sprites.forEach((c, i) => {
      if (!c) return;
      c.xlu = true;
      const near = (i < 2) !== enemy; // R1/L1 vs R2/L2 priorities swap on the enemy side
      c.order = near ? 10 : 20;
      c.tint = (i === 0 || i === 1) !== enemy ? [128, 128, 128] : [196, 196, 196];
    });
    const table = [[0, 32, 7], [0, 32, 10], [32, 0, 7], [32, 0, 10]];
    const pos = [new PosLerp(), new PosLerp(), new PosLerp(), new PosLerp()];
    let iteration = 0, state = 0;
    this.task(() => {
      if (state === 0) {
        const pi = (iteration % 2) * 2, red = Math.trunc((iteration + 1) / 2);
        pos[0].init(ax + table[pi][0], ax + table[pi][1], ay, ay, table[pi][2] - red);
        pos[1].init(ax - table[pi][0], ax - table[pi][1], ay, ay, table[pi][2] - red);
        pos[2].init(ax + table[pi + 1][0], ax + table[pi + 1][1], ay, ay, table[pi + 1][2] - red);
        pos[3].init(ax - table[pi + 1][0], ax - table[pi + 1][1], ay, ay, table[pi + 1][2] - red);
        iteration++; state = 1;
      }
      if (state === 1) {
        let complete = 0;
        pos.forEach((p, i) => { if (!p.update()) complete++; else if (sprites[i]) { sprites[i]!.x = p.x; sprites[i]!.y = p.y; } });
        if (complete === 4) state = iteration === 9 ? 2 : 0;
      } else if (state === 2) {
        if (a > 0) a--;
        if (b < 15) b++;
        this.blendA = a; this.blendB = b;
        if (a === 0 && b === 15) return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 13 Growth: grow to 115% and back twice with a white blink
  13() {
    const side = this.attacker, fx = this.fx[side];
    const s = new ScaleLerp();
    let state = 0, it = 0, up = true;
    this.task(() => {
      if (state === 0) {
        if (up) { s.init(100, 100, 115, 6); monFade(this, side, 0, 6, 0, COLOR_WHITE); }
        else { s.init(115, 100, 100, 6); monFade(this, side, 6, 0, 0, COLOR_WHITE); }
        up = !up; it++; state = 1;
      } else {
        if (!s.update() && !fx.fading) { if (it < 4) state = 0; else return false; }
        fx.scaleX = s.x; fx.scaleY = s.y;
      }
      return true;
    });
  },
  // 14 Meditate: stretch wide, then tall, then back
  14() {
    const side = this.attacker, baseY = this.fx[side].y, h = this.ground(side);
    const t = [[100, 150, 100, 50, 8], [150, 50, 50, 150, 8], [50, 100, 150, 100, 8]];
    const s = new ScaleLerp();
    let i = 0, state = 0;
    this.task(() => {
      if (state === 0) { const [sx, ex, sy, ey, f] = t[i]; s.initXY(sx, ex, sy, ey, 100, f); i++; state = 1; return true; }
      if (!s.update()) { if (i < t.length) state = 0; else return false; }
      scaleMon(this, side, s, baseY, h);
      return true;
    });
  },
  // 15 Teleport: squish into a line, rise, shrink away (battler hidden at the end)
  15() {
    const side = this.attacker, fx = this.fx[side], baseY = fx.y, h = this.ground(side);
    const t = [[100, 10, 100, 180, 10], [10, 10, 180, 0, 5]];
    const s = new ScaleLerp(), p = new PosLerp();
    let state = 0, type = 0, ay = baseY;
    this.task(() => {
      switch (state) {
        case 0: { const [sx, ex, sy, ey, f] = t[type++]; s.initXY(sx, ex, sy, ey, 100, f); state++; break; }
        case 1: if (!s.update()) state++; scaleMon(this, side, s, ay, h); break;
        case 2: p.init(0, 0, fx.y, 0, 5); state++; break;
        case 3: if (!p.update()) state++; fx.y = p.y; break;
        case 4: { const [sx, ex, sy, ey, f] = t[type]; s.initXY(sx, ex, sy, ey, 100, f); ay = fx.y; state++; break; }
        case 5: if (!s.update()) state++; scaleMon(this, side, s, ay, h, true); break;
        default: fx.y = baseY; fx.hide = true; fx.scaleX = 256; fx.scaleY = 256; return false;
      }
      return true;
    });
  },
  // 16 Flash: the background fades to white while the attacker fades to black, holds, then both return
  16() {
    const side = this.attacker, fx = this.fx[side];
    let state = 0, delay = 0;
    const bgFade = bgPaletteFade(this, COLOR_WHITE);
    this.task(() => {
      switch (state) {
        case 0: bgFade.start(-2, 0, 16); monFade(this, side, 0, 16, 0, COLOR_BLACK); state++; break;
        case 1: if (!bgFade.active && !fx.fading) state++; break;
        case 2: if (++delay > 5) state++; break;
        case 3: bgFade.start(-2, 16, 0); monFade(this, side, 16, 0, 0, COLOR_BLACK); state++; break;
        case 4: if (!bgFade.active && !fx.fading) state++; break;
        default: return false;
      }
      return true;
    });
  },
  // 19 Splash: three hops with squash and stretch
  19() {
    const side = this.attacker, ay = this.fx[side].y, h = this.ground(side);
    const st = [[100, 120, 100, 80, 5], [120, 100, 80, 120, 5], [100, 100, 120, 100, 5]];
    const pt = [[0, 16, 5], [16, 0, 5], [0, 0, 5]];
    const s = new ScaleLerp(), p = new PosLerp();
    let it = 0, cycles = 0, state = 0;
    this.task(() => {
      if (state === 0) {
        const [sx, ex, sy, ey, f] = st[it]; s.initXY(sx, ex, sy, ey, 100, f);
        p.init(0, 0, ay + pt[it][0], ay + pt[it][1], pt[it][2]);
        it++; state = 1;
        return true;
      }
      let done = 0;
      if (!s.update()) done++;
      if (!p.update()) done++;
      if (done >= 2) {
        if (it >= 3) { cycles++; it = 0; if (cycles >= 3) return false; }
        state = 0;
      }
      const fx = this.fx[side];
      fx.scaleX = s.x; fx.scaleY = s.y; fx.y = p.y + groundOffset(h, s.curY);
      return true;
    });
  },
  // 21 Harden: after 10 frames a gray copy covers the attacker for 10 frames
  21() {
    const c = copy(this, 0), w = copy(this, 1);
    if (c) { c.tint = [256, 256, 256]; c.visible = false; }
    if (w) w.visible = false; // OBJ window sprite: masks the battler; the gray copy shows in its place
    let state = 0, timer = 0;
    this.task(() => {
      if (state === 0) { if (++timer >= 10) { timer = 0; state++; } }
      else if (state === 1) { if (c) c.visible = true; state++; }
      else if (state === 2) { if (++timer >= 10) { if (c) c.visible = false; state++; } }
      else return false;
      this.drawMgr(-1);
      return true;
    });
  },
  // 22 Minimize: three translucent copies shrink into the ground three times, then the copies grow back
  22() {
    const side = this.attacker, ay = this.fx[side].y, h = this.ground(side);
    setBlend(this, -1, -1); this.blendA = 12; this.blendB = 6;
    const sp = [0, 1, 2].map(i => ({ c: copy(this, i), state: 0, frames: 0, s: new ScaleLerp() }));
    sp.forEach((e, i) => { if (e.c) { e.c.xlu = true; e.c.order = i + 1; } });
    const delays = [2, 7, 13];
    let state = 0, cycles = 0;
    const apply = (e: typeof sp[0]) => { if (e.c) { e.c.scaleX = e.s.fx; e.c.scaleY = e.s.fy; e.c.y = ay + groundOffset(h, e.s.curY); } };
    this.task(() => {
      const fx = this.fx[side];
      if (state === 0) { fx.partial = { x: 0, y: 0, w: 0, h: 0 }; state++; }
      else if (state === 1) {
        let done = 0;
        sp.forEach((e, i) => {
          if (e.state === 0) { if (++e.frames >= delays[i]) { e.s.initXY(100, 5, 100, 5, 100, 5); e.state++; } }
          else if (e.state === 1) { if (!e.s.update()) e.state++; else apply(e); }
          else done++;
        });
        if (done >= 3) {
          if (++cycles < 3) sp.forEach(e => { if (e.c) { e.c.y = ay; e.c.scaleX = 1; e.c.scaleY = 1; } e.state = 0; e.frames = 0; });
          else state++;
        }
      } else if (state === 2) {
        sp.forEach(e => { if (e.c) e.c.xlu = false; e.s.initXY(5, 100, 5, 100, 100, 5); });
        state++;
      } else if (state === 3) {
        let done = 0;
        sp.forEach(e => { if (!e.s.update()) done++; else apply(e); });
        if (done >= 3) state++;
      } else { fx.partial = null; return false; }
      this.drawMgr(-1);
      return true;
    });
  },
  // 26 Nightmare(moveAttacker): a fading copy drifts off the battler
  26(v) {
    const side = v[0] ? this.attacker : this.defender, fx = this.fx[side];
    const c = copy(this, 0);
    const p = new PosLerp(fx.x, fx.x - 20 * dirX(side), fx.y, fx.y + 20 * dirY(side), 20);
    setBlend(this, -1, -1);
    alphaFade(this, 31, 0, 0, 31, 15);
    if (c) c.xlu = true;
    this.task(() => {
      if (!p.update()) return false;
      if (c) { c.x = p.x; c.y = p.y; }
      this.drawMgr(-1);
      return true;
    });
  },
  // 27 Flail(mode, shakeX, shakeY, interval, amount): attacker wiggles, or the defender shakes
  27(v) {
    const atk = this.attacker, def = this.defender;
    this.fx[atk].pivotY = 100;
    if (v[0] === 0) {
      const angles = [[DEG(20), 3], [DEG(15), 3], [DEG(10), 2], [DEG(5), 2], [DEG(0), 1]];
      let c1 = 0, c2 = 0, lerp: ValueLerp | null = null;
      this.task(() => {
        if (!lerp) {
          const [ang, f] = angles[c2];
          lerp = c1 === 0 ? new ValueLerp(-ang, ang, f) : new ValueLerp(ang, -ang, f);
          if (c1 === 1) c2++;
          c1 ^= 1;
        }
        if (lerp.update()) this.fx[atk].rot = lerp.value & 0xffff;
        else if (c2 >= 5) { this.fx[atk].rot = 0; return false; }
        else lerp = null;
        return true;
      });
    } else {
      const fx = this.fx[def], bx = fx.x, by = fx.y;
      const s = new Shake(v[1], v[2], v[3], v[4]);
      this.task(() => {
        if (!s.update()) return false;
        fx.x = bx + s.x; fx.y = by + s.y;
        return true;
      });
    }
  },
  // 28 Magnitude: shake strength from the rolled power
  28() {
    const power = { 150: 6, 110: 5, 90: 4, 70: 3, 50: 2, 30: 1 }[this.power] ?? 0;
    const sides: Side[] = ['p1', 'p2'], base = sides.map(s => this.fx[s].x);
    const s = new Shake(2 + power, power, 0, 10);
    this.task(() => {
      if (!s.update()) { this.bg.x = 0; this.bg.y = 0; return false; }
      sides.forEach((sd, i) => (this.fx[sd].x = base[i] + s.x));
      this.bg.x = s.x; this.bg.y = s.y;
      return true;
    });
  },
  // 39 Odor Sleuth: two copies sweep side to side over the defender
  39() {
    const a = copy(this, 0), d = copy(this, 1);
    const pd = this.fx[this.defender];
    const s = new Shake(20, 0, 0, 10);
    this.task(() => {
      if (!s.update()) return false;
      if (a) { a.x = pd.x + s.x; a.y = pd.y + s.y; }
      if (d) { d.x = -pd.x + s.x; d.y = pd.y + s.y; }
      this.drawMgr(-1);
      return true;
    });
  },
  // 35 ScalePokemonSprite(role, spriteAlpha, start, end, ref, cycles, frames<<16|restore, spriteID)
  35(v) {
    const side = v[0] === 0 ? this.attacker : this.defender;
    const baseY = this.fx[side].y, h = this.ground(side);
    const c = copy(this, v[7]);
    if (!c) return;
    c.order = 100; c.prio = 1; c.xlu = true;
    setBlend(this, v[1], 16 - v[1]);
    const s = new ScaleLerp();
    let state = 0, cycles = v[5];
    this.task(() => {
      switch (state) {
        case 0: s.init(v[2], v[4], v[3], v[6] >>> 16); c.scaleX = s.fx; c.scaleY = s.fy; state++; break;
        case 1: { const on = s.update(); c.scaleX = s.fx; c.scaleY = s.fy; if (on) c.y = baseY + groundOffset(h, s.curY); else state++; break; }
        case 2: s.init(v[3], v[4], v[2], v[6] & 0xffff); state++; break;
        case 3: {
          const on = s.update(); c.scaleX = s.fx; c.scaleY = s.fy;
          if (on) c.y = baseY + groundOffset(h, s.curY); else if (--cycles <= 0) state++; else state = 0;
          break;
        }
        default: return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 38 AlphaFadePokemonSprite(spriteMask, sa, ea, sb, eb, frames)
  38(v) {
    for (let i = 0; i < 4; i++) if (v[0] & (1 << i)) { const c = copy(this, i); if (c) c.xlu = true; }
    setBlend(this, v[1], v[3]);
    const f = alphaFade(this, v[1], v[2], v[3], v[4], v[5]);
    this.task(() => { if (f.done) return false; this.drawMgr(-1); return true; });
  },
  // 59 Shadow Punch: the attacker darts forward and back trailed by two gray translucent afterimages
  59() {
    const side = this.attacker, fx = this.fx[side], px = fx.x, py = fx.y;
    setBlend(this, -1, -1); this.blendA = 8; this.blendB = 8;
    const a1 = copy(this, 0), a2 = copy(this, 1);
    for (const c of [a1, a2]) if (c) { c.prio = 2; c.tint = [196, 196, 196]; c.xlu = true; }
    const main = new PosLerp(), p1 = new PosLerp(), p2 = new PosLerp();
    let it = 0, state = 0;
    this.task(() => {
      if (state === 0) {
        const [s, e] = it === 0 ? [px, px + 48] : [px + 48, px];
        main.init(s, e, py, py, 3); p1.init(s, e, py, py, 6); p2.init(s, e, py, py, it === 0 ? 8 : 9);
        it++; state = 1;
      } else if (state === 1) {
        let done = 0;
        if (!p1.update()) done++; else if (a1) { a1.x = p1.x; a1.y = p1.y; }
        if (!main.update()) done++; else { fx.x = main.x; fx.y = main.y; }
        if (!p2.update()) done++; else if (a2) { a2.x = p2.x; a2.y = p2.y; }
        if (done >= 3) { if (it === 1) state = 0; else state = 2; }
      } else return false;
      this.drawMgr(-1);
      return true;
    });
  },
  // 70 Role Play: an attacker copy beside it flashes white and flattens away while the defender flashes white
  70() {
    const atk = this.attacker, s0 = copy(this, 0), s1 = copy(this, 1), sd = copy(this, 2);
    if (!s0 || !s1) return;
    s0.x = s1.x - 32 * dirX(atk); s0.y = s1.y; s0.visible = true;
    s0.prio = atk === 'p1' ? 1 : 2; s0.order = 0; s0.xlu = true;
    let sx = 1, sy = 1, steps = 0, alpha = 0, bgA = 15, state = 0;
    setBlend(this, -1, -1); this.blendA = alpha; this.blendB = bgA;
    const fade = (c: MonCopy | null, from: number, to: number) => { // PaletteFadeContext: 1 step per frame toward white
      const st = { active: true };
      let f = from;
      this.sysTask(() => { if (c) { c.fadeColor = COLOR_WHITE; c.fadeAmt = f; } if (f === to) { st.active = false; return false; } f += f < to ? 1 : -1; return true; });
      return st;
    };
    fade(s0, 0, 15);
    let df = fade(sd, 0, 15);
    const run = () => {
      if (state === 0) {
        if (steps > 14) {
          sy -= 0.2; sx += 0.2;
          if (sy <= 0.2) { state++; s0.visible = false; } else { s0.scaleX = sx; s0.scaleY = sy; }
        } else { alpha++; bgA--; this.blendA = alpha; this.blendB = bgA; steps++; }
      } else if (state === 1) {
        if (!df.active) { df = fade(sd, 15, 0); state++; }
      } else if (!df.active) return false;
      this.drawMgr(-1);
      return true;
    };
    this.task(run, true);
  },
  // 71 Snatch(target): the battler runs off one side, across behind the foe, and back
  71() {
    const side = this.attacker, fx = this.fx[side];
    const [ax, ay] = DEFAULT_POS[side], [, dy] = DEFAULT_POS[opp(side)];
    const h = fx.y - ay, d = side === 'p1' ? 1 : -1;
    const xs = d > 0 ? [256 + 80 - 1, -80, ax] : [-80, 256 + 80 - 1, ax];
    const ys = [ay + h, dy + h, ay + h];
    const p = new PosLerp();
    let it = 0, init = true, startX = fx.x;
    this.task(() => {
      if (init) { p.init(startX, xs[it], ys[it], ys[it], 15); init = false; }
      if (!p.update()) {
        if (++it > 2) return false;
        init = true; startX = fx.x;
      }
      fx.x = p.x; fx.y = p.y;
      return true;
    });
  },
  // 79 Sketch: the defender is redrawn in 2-px strips from the bottom up, at half opacity
  79() {
    const fx = this.fx[this.defender];
    const old = fx.alpha;
    fx.alpha = 8;
    let viewHeight = 0, viewWidth = 0, origin = 0, state = 0;
    this.task(() => {
      switch (state) {
        case 0:
          viewWidth += 79;
          if (viewWidth >= 80) { state++; origin ^= 1; viewWidth = 0; }
          else fx.partial = { x: origin ? 80 - viewWidth : 0, y: 80 - (viewHeight + 2) * 2, w: viewWidth, h: 2 };
          break;
        case 1: state++; break;
        case 2: viewHeight++; state = viewHeight > 38 ? 3 : 0; break;
        case 3: fx.partial = null; state++; break;
        default: fx.alpha = old; return false;
      }
      return true;
    });
  },
  // 75 SetPokemonSpritePriority(spriteID, frames, bg, priority, battler, mode, window): draws a copy for N frames
  75(v) {
    const c = copy(this, v[0]);
    if (!c) return;
    if (v[2] !== 0xff) c.prio = v[2] === 1 ? 3 : v[2] === 2 ? 2 : 1;
    if (v[3] !== 0xff) c.order = v[3];
    if (v[4] === 2 || v[4] === 3) { c.visible = false; return; } // partner roles: no partner in singles
    let state = 0;
    this.task(() => {
      if (++state >= v[1]) { c.visible = false; this.drawMgr(-1); return false; }
      this.drawMgr(-1);
      return true;
    }, true);
  },
  // 76 ScrollSwitchedBg(frames): a sine wave scrolls the move background's rows 0-160 for N frames
  76(v) {
    const eff = this.bg.effect;
    const scroll = new ScreenScrollX(0, 160, DEG(1), 32, 200);
    let timer = 0;
    this.sysTask(() => {
      const e = this.bg.effect;
      if (!e || e !== eff || timer > v[0]) { if (e) e.rowX = null; return false; }
      e.rowX = scroll.update();
      return true;
    });
    this.task(() => ++timer < v[0]);
  },
  // 78 RenderPokemonSprites(frames): draws the pokemon sprite copies for N frames (default 3)
  78(v) {
    let frames = v[0] || 3;
    this.task(() => { if (frames === 0) return false; frames--; this.drawMgr(-1); return true; }, true);
  },
  // 8 Quick Attack: the attacker loops an oval, two translucent afterimages follow 2 frames apart
  8() {
    const side = this.attacker, fx = this.fx[side], ax = fx.x, ay = fx.y + 8, dir = dirX(side);
    const rev = ovalRevolution(1, 8, dir);
    const imgs = [copy(this, 0), copy(this, 1)];
    imgs.forEach(c => { if (c) { c.order = 100; c.prio = 1; c.xlu = true; } });
    const after = new Afterimage(() => ovalRevolution(1, 10, dir), ax, ay, 2, imgs);
    setBlend(this, -1, -1);
    this.task(() => {
      const a = rev.update();
      if (a) { fx.x = ax + rev.x; fx.y = ay + rev.y; }
      const b = after.update();
      this.drawMgr(-1);
      if (a || b) return true;
      fx.x = ax; fx.y = ay - 8;
      return false;
    });
  },
  // 9 Drill Peck: pull back, tilt forward, lunge, hold, tilt back
  9() {
    const side = this.attacker, fx = this.fx[side], ax = fx.x, ay = fx.y, dir = dirX(side);
    let pos = new PosLerp(0, -32 * dir, 0, 0, 3), angle = new ValueLerp(0, DEG(20) * dir, 8), state = 0, delay = 0;
    fx.pivotX = 40 * dirX(this.defender); fx.pivotY = 40;
    this.task(() => {
      switch (state) {
        case 0: if (pos.update()) { fx.x = ax + pos.x; fx.y = ay + pos.y; } else { pos = new PosLerp(pos.x, 0, 0, 0, 2); state++; } break;
        case 1: if (angle.update()) fx.rot = angle.value & 0xffff; else { angle = new ValueLerp(angle.value, 0, 4); state++; delay = 2; } break;
        case 2: if (--delay < 0) state++; break;
        case 3: if (pos.update()) { fx.x = ax + pos.x; fx.y = ay + pos.y; } else { state++; delay = 32; } break;
        case 4: if (--delay < 0) state++; break;
        case 5: if (angle.update()) fx.rot = angle.value & 0xffff; else state++; break;
        default: fx.x = ax; fx.y = ay; fx.rot = 0; return false;
      }
      return true;
    });
  },
  // 11 Confusion: a translucent copy of the defender stretches to 120%x150% and back while it jitters
  11() {
    const d = this.defender, fx = this.fx[d], dx = fx.x, dy = fx.y;
    const shake = new Shake(2, 0, 1, 6);
    const c = copy(this, 0);
    if (c) { c.xlu = true; c.order = 100; c.prio = 1; }
    const s = new ScaleLerp().initXY(10, 12, 10, 15, 10, 7);
    let state = 0, jitter = 1;
    setBlend(this, 28, 15);
    const apply = () => {
      fx.x = dx + shake.x; fx.y = dy + shake.y;
      if (c) { c.x = fx.x; c.y = fx.y; c.scaleX = s.fx + jitter * 0.1; c.scaleY = s.fy; }
      jitter = -jitter;
    };
    this.task(() => {
      if (state === 2) return false;
      shake.update();
      const on = s.update();
      apply();
      if (!on) { if (state === 0) s.initXY(12, 10, 15, 10, 10, 4); else { fx.x = dx; fx.y = dy; } state++; }
      this.drawMgr(-1);
      return true;
    });
  },
  // 12 Acid Armor: the attacker (as a BG copy) melts down into a puddle and fades, then fades back in
  12() {
    const side = this.attacker, fx = this.fx[side], dir = dirX(side);
    const ax = fx.x - 40, ay = fx.y - 40;
    fx.hide = true;
    const startY = Math.max(0, ay - 8), endY = Math.min(192, ay + 80 + 8);
    const scroll = new ScreenScrollX(startY, endY, DEG(5), 8 * dir, 80);
    const pos = new PosLerp(0, 80 * dir, 0, 40, 24);
    const layer = { side, ox: new Array<number>(192).fill(-ax), oy: new Array<number>(192).fill(-ay), mix: 1, dark: 0 };
    this.bg.monBg = layer;
    let state = 0, delay = 0, fade = { done: false };
    const update = () => {
      layer.ox.fill(-ax); layer.oy.fill(-ay);
      const on = pos.update();
      for (let y = startY; y <= endY; y++) {
        const prev = y - 1 < 0 ? y - 1 + 192 : y - 1;
        layer.oy[prev] = -ay - Math.trunc(((endY - y) * pos.y) / 100);
        layer.ox[prev] = -ax - Math.trunc(((startY + 40 - y) * pos.x) / 100);
      }
      const add = scroll.update();
      for (let y = 0; y < 192; y++) layer.ox[y] += add[y];
      return on;
    };
    const mix = () => { layer.mix = this.blendA + this.blendB ? Math.min(16, this.blendA) / (Math.min(16, this.blendA) + Math.min(16, this.blendB)) : 0; };
    this.task(() => {
      switch (state) {
        case 0:
          if (!update()) { state++; this.blendA = 31; this.blendB = 0; fade = alphaFade(this, 31, 0, 0, 31, 16); }
          break;
        case 1: update(); if (fade.done) { state++; delay = 0; } break;
        case 2:
          layer.ox.fill(-ax); layer.oy.fill(-ay);
          if (++delay > 8) { fade = alphaFade(this, 0, 31, 31, 0, 16); state++; }
          break;
        case 3: if (fade.done) { fx.hide = false; state++; } break;
        default: this.bg.monBg = null; return false;
      }
      mix();
      return true;
    }, true);
  },
  // 17 Night Shade (attacker): a translucent copy fades in, then shrinks from 140% to 100% and vanishes
  17() {
    const c = copy(this, 0);
    if (!c) return;
    const s = new ScaleLerp().init(14, 10, 10, 8), alpha = new ValueLerpFx(0, 16, 8);
    c.xlu = true; c.scaleX = 1.4; c.scaleY = 1.4; c.order = 100; c.prio = 1;
    this.blendA = 0; this.blendB = 31;
    let state = 0, delay = 0;
    this.task(() => {
      switch (state) {
        case 0: { const on = alpha.update(); this.blendA = alpha.value; this.blendB = 31 - alpha.value; if (!on) { state++; delay = 0; } break; }
        case 1: if (++delay > 32) state++; break;
        case 2: { const on = s.update(); c.scaleX = s.fx; c.scaleY = s.fy; if (!on) { c.visible = false; state++; } break; }
        default: return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 18 Night Shade (defender): fades to black and back while shaking
  18() {
    const side = this.defender, fx = this.fx[side], dx = fx.x, dy = fx.y;
    const shake = new Shake(4, 0, 1, 4);
    shake.x += dirX(side);
    monFade(this, side, 0, 16, 0, COLOR_BLACK);
    let state = 0;
    this.task(() => {
      if (state === 2) return false;
      const on = shake.update();
      fx.x = dx + shake.x; fx.y = dy + shake.y;
      if (state === 0 && !fx.fading) { monFade(this, side, 16, 0, 0, COLOR_BLACK); state++; }
      else if (state === 1 && !fx.fading) { fx.x = dx; fx.y = dy; state++; }
      void on;
      return true;
    });
  },
  // 20 Spite: a darkened, wobbling translucent copy of the defender appears over it and fades away
  20() {
    const side = this.defender, fx = this.fx[side];
    const dx = fx.x - 40, dy = fx.y - 40;
    const scroll = new ScreenScrollX(Math.max(0, dy), dy + 80, DEG(5), 5, 100);
    const layer = { side, ox: new Array<number>(192).fill(-dx), oy: new Array<number>(192).fill(-dy), mix: 0, dark: 0.5 };
    this.bg.monBg = layer;
    let fade = alphaFade(this, 0, 8, 16, 8, 24), sub = 0, delay = 0;
    this.blendA = 0; this.blendB = 16;
    this.task(() => {
      const add = scroll.update();
      for (let y = 0; y < 192; y++) layer.ox[y] = -dx + add[y];
      layer.mix = Math.min(16, this.blendA) / Math.max(1, Math.min(16, this.blendA) + Math.min(16, this.blendB));
      if (sub === 0) { if (fade.done) { sub++; delay = 32; } }
      else if (sub === 1) { if (--delay < 0) { sub++; fade = alphaFade(this, 8, 0, 8, 16, 24); } }
      else if (sub === 2) { if (fade.done) sub++; }
      else { this.bg.monBg = null; return false; }
      return true;
    });
  },
  // 23 Faint Attack: the attacker turns into a fading translucent copy that loops twice, then fades back in
  23() {
    const side = this.attacker, fx = this.fx[side], ax = fx.x, ay = fx.y + 8;
    const c = copy(this, 0);
    if (c) c.xlu = true;
    fx.hide = true;
    const rev = ovalRevolution(2, 16, dirX(side));
    setBlend(this, 16, 0);
    let fade = alphaFade(this, 16, 0, 0, 16, 32), state = 0, delay = 0;
    this.drawMgr(-1);
    this.task(() => {
      switch (state) {
        case 0: if (rev.update()) { if (c) { c.x = ax + rev.x; c.y = ay + rev.y; } } else { state++; delay = 16; } break;
        case 1: if (--delay < 0) { state++; fade = alphaFade(this, 0, 16, 16, 0, 32); } break;
        case 2: if (fade.done) { if (c) c.visible = true; fx.hide = false; state++; } break;
        default: return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 25 Playful Hops(target): four little tilting hops
  25(v) {
    const side = v[0] === 0 ? this.attacker : this.defender, fx = this.fx[side], bx = fx.x, by = fx.y;
    fx.pivotY = 50;
    let flip = dirX(this.attacker) !== 1, angle = new ValueLerpFx(0, 0, 0), pos = new PosLerp(), hop = 0, hops = 0, delay = 0;
    const initTilt = () => {
      angle = new ValueLerpFx(0, flip ? -DEG(15) : DEG(15), 3);
      fx.pivotX = flip ? 16 : -16;
      hop = 0; delay = 0;
    };
    const updateHop = (): boolean => {
      switch (hop) {
        case 0: angle.update(); fx.rot = angle.value & 0xffff; if (--delay < 0) { hop++; pos.init(bx, bx, by, by + 2, 2); } return false;
        case 1:
          if (angle.update()) fx.rot = angle.value & 0xffff;
          if (pos.update()) { fx.x = pos.x; fx.y = pos.y; } else { hop++; angle = new ValueLerpFx(angle.value, 0, 3); pos.init(bx, bx, by + 2, by, 2); }
          return false;
        case 2:
          if (pos.update()) { fx.x = pos.x; fx.y = pos.y; }
          if (angle.update()) fx.rot = angle.value & 0xffff; else { fx.x = bx; fx.y = by; fx.rot = 0; hop++; }
          return false;
        default: return true;
      }
    };
    initTilt();
    this.task(() => {
      if (hops >= 4) return false;
      if (updateHop()) {
        if (++hops < 4) { flip = !flip; initTilt(); updateHop(); }
      }
      return true;
    });
  },
  // 31 Swagger: the attacker puffs up to 150%, holds, and settles
  31() {
    const side = this.attacker, fx = this.fx[side], baseY = fx.y, h = this.ground(side);
    const s = new ScaleLerp().init(10, 10, 15, 8);
    let sub = 0, scaleDelay = 4, state = 0, delay = 0;
    this.task(() => {
      if (state === 0) {
        if (sub === 0) { if (s.update()) scaleMon(this, side, s, baseY, h); else sub++; }
        else if (sub === 1) { if (--scaleDelay < 0) { sub++; s.init(15, 10, 10, 8); } }
        else if (sub === 2) { if (s.update()) scaleMon(this, side, s, baseY, h); else sub++; }
        else { fx.scaleX = 256; fx.scaleY = 256; state++; delay = 16; }
      } else if (state === 1) { if (--delay < 0) state++; }
      else return false;
      return true;
    });
  },
  // 29 Return: the attacker bounces down and up twice
  29() {
    const fx = this.fx[this.attacker], ax = fx.x, ay = fx.y;
    const pos = new PosLerp();
    let count = 0, init = true;
    this.task(() => {
      if (init) { if (count % 2 === 0) pos.init(0, 0, 0, 32, 6); else pos.init(0, 0, 32, 0, 6); init = false; return true; }
      if (pos.update()) { fx.x = ax + pos.x; fx.y = ay + pos.y; return true; }
      if (++count < 4) { init = true; return true; }
      return false;
    });
  },
  // 30 Vital Throw: the attacker loops once, lunges, the defender is knocked back, both return
  30() {
    const atk = this.attacker, a = this.fx[atk], d = this.fx[this.defender], dir = dirX(atk);
    const ax = a.x, ay = a.y, dx = d.x;
    const rev = ovalRevolution(1, 64, dir);
    let pos = new PosLerp(), dpos = new PosLerp(), state = 0;
    this.task(() => {
      switch (state) {
        case 0:
          if (rev.update()) { a.x = ax + rev.x; a.y = ay + 8 + rev.y; }
          else { a.x = ax; a.y = ay; pos = new PosLerp(ax * dir, (ax + 32) * dir, 0, 0, 2); pos.update(); a.x = pos.x; state++; }
          break;
        case 1: if (pos.update()) a.x = pos.x; else { dpos = new PosLerp(dx, dx + 32 * dir, 0, 0, 2); state++; } break;
        case 2: if (dpos.update()) d.x = dpos.x; else { pos = new PosLerp(pos.x, ax, 0, 0, 8); state++; } break;
        case 3: if (pos.update()) a.x = pos.x; else { a.x = ax; dpos = new PosLerp(dpos.x, dx, 0, 0, 8); state++; } break;
        case 4: if (dpos.update()) d.x = dpos.x; else { d.x = dx; state++; } break;
        default: return false;
      }
      return true;
    });
  },
  // 32 Memento: a dark translucent copy of the attacker stretches up and thins away, then one drops onto the foe
  32() {
    const atk = this.attacker, def = this.defender, ay = this.fx[atk].y, h = this.ground(atk);
    const ac = copy(this, 0), dc = copy(this, 1);
    const anchorTop = 40; // defender copy: affine translation (0, 40) anchors its scaling at the bottom edge
    for (const c of [ac, dc]) if (c) { c.visible = false; c.xlu = true; c.order = 100; c.prio = 1; c.fadeColor = COLOR_BLACK; }
    if (ac) { ac.x = this.fx[atk].x; ac.y = ay; }
    const dy0 = this.fx[def].y;
    if (dc) { dc.x = this.fx[def].x; dc.y = dy0; }
    let state = 0, delay = 0, sub = 0, subDelay = 0, fade = { done: false };
    const scale = new ScaleLerp(), scaleX = new ScaleLerp(), dpos = new PosLerp();
    const placeDef = () => { if (dc) { dc.scaleX = scale.fx; dc.scaleY = scale.fy; dc.y = dpos.y + anchorTop - anchorTop * scale.fy; } };
    this.task(() => {
      switch (state) {
        case 0: setBlend(this, 0, 16); fade = alphaFade(this, 0, 8, 16, 8, 8); state++; break;
        case 1:
          if (fade.done) {
            state++;
            scale.initXY(10, 10, 10, 20, 10, 8); scaleX.init(10, 10, 1, 4); sub = 0; subDelay = 6;
            if (ac) { ac.visible = true; ac.fadeAmt = 8; ac.scaleX = scale.fx; ac.scaleY = scale.fy; }
          }
          break;
        case 2:
          if (sub === 0) {
            scale.update();
            if (ac) { ac.scaleX = scale.fx; ac.scaleY = scale.fy; ac.y = ay + groundOffset(h, scale.curY); }
            if (--subDelay < 0) { sub++; scale.initXY(10, 1, 20, 20, 10, 4); }
          } else {
            scale.update();
            if (scaleX.update()) { if (ac) { ac.scaleX = scaleX.fx; ac.scaleY = scale.fy; ac.y = ay + groundOffset(h, scale.curY); } }
            else { if (ac) ac.visible = false; state++; delay = 2; }
          }
          break;
        case 3:
          if (--delay < 0) {
            dpos.init(dc?.x ?? 0, dc?.x ?? 0, dy0 - 64, dy0, 8);
            scale.initXY(2, 10, 20, 10, 10, 8);
            if (dc) { dc.visible = true; dc.fadeAmt = 8; }
            dpos.update(); placeDef();
            sub = 0; subDelay = 6; state++;
          }
          break;
        case 4:
          if (sub === 0) { subDelay--; dpos.update(); placeDef(); if (subDelay < 0) sub++; }
          else { dpos.update(); const on = scale.update(); placeDef(); if (!on) { state++; fade = alphaFade(this, 8, 0, 8, 16, 8); } }
          break;
        case 5: if (fade.done) state++; break;
        default: return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 41 Fake Out curtain: the move background closes in from both sides while the scene fades to white
  41() {
    const pos = new PosLerp(127, 0, 0, 0, 8), fade = bgPaletteFade(this, COLOR_WHITE);
    let state = 0, delay = 7;
    const clip = (c: [number, number] | null) => { if (this.bg.effect) this.bg.effect.clip = c; };
    this.task(() => {
      switch (state) {
        case 0: clip([0, 255]); state++; break;
        case 1: if (--delay < 0) { fade.start(0, 0, 16); state++; } break;
        case 2: if (pos.update()) clip([127 - pos.x, 128 + pos.x]); else state++; break;
        case 3: if (!fade.active) { clip(null); fade.start(0, 16, 0); state++; } break;
        case 4: if (!fade.active) state++; break;
        default: return false;
      }
      return true;
    });
  },
  // 43 Fake Out: the defender squashes to 70% x 300% and back while shaking
  43() {
    const side = this.defender, fx = this.fx[side], dx = fx.x, dy = fx.y, h = this.ground(side);
    const shake = new Shake(2, 0, 1, 2), s = new ScaleLerp();
    const frames = (4 << 16) | 3;
    let state = 0, cycles = 1;
    const apply = () => {
      if (shake.update()) { fx.x = dx + shake.x; fx.y = dy + shake.y; }
      const on = s.update();
      if (on) { fx.scaleX = s.x; fx.scaleY = s.y; }
      fx.y = dy + groundOffset(h, s.curY);
      return on;
    };
    this.task(() => {
      switch (state) {
        case 0: s.initXY(10, 7, 10, 30, 10, frames >>> 16); apply(); state++; break;
        case 1: if (!apply()) state++; break;
        case 2: s.initXY(7, 10, 30, 10, 10, frames & 0xffff); apply(); state++; break;
        case 3: if (!apply()) { if (--cycles <= 0) state++; else state = 0; } break;
        default: fx.x = dx; fx.y = dy; fx.scaleX = 256; fx.scaleY = 256; return false;
      }
      return true;
    });
  },
  // 46 Megahorn (horn sprite): the horn juts out from the attacker
  46() {
    const atk = this.attacker, keep = this.sprites.get(atk === 'p1' ? 0 : 1);
    this.sprites.delete(atk === 'p1' ? 1 : 0);
    if (!keep) return;
    const [x, y] = DEFAULT_POS[atk], hx = x + 64 * dirX(atk), hy = y - 16 * dirY(atk);
    keep.x = hx; keep.y = hy; keep.visible = true;
    const p = new PosLerp(hx, hx + 48 * dirX(atk), hy, hy - 16 * dirY(atk), 6);
    this.task(() => {
      if (!p.update()) { this.sprites.delete(atk === 'p1' ? 0 : 1); return false; }
      keep.x = p.x; keep.y = p.y;
      this.drawMgr(keep.mgr);
      return true;
    });
  },
  // 47 Megahorn (attacker): shakes, charges forward, holds, returns
  47() {
    const side = this.attacker, fx = this.fx[side], x = fx.x, y = fx.y, dX = dirX(side), dY = dirY(side);
    let shake = new Shake(4, 0, 1, 4), pos = new PosLerp(), state = 0, delay = 0;
    this.task(() => {
      switch (state) {
        case 0: if (shake.update()) { fx.x = x + shake.x; fx.y = y + shake.y; } else { state++; pos = new PosLerp(x, x + 40 * dX, y, y - 7 * dY, 4); } break;
        case 1: if (pos.update()) { fx.x = pos.x; fx.y = pos.y; } else { state++; delay = 8; } break;
        case 2: if (--delay < 0) { state++; pos = new PosLerp(x + 40 * dX, x, y - 7 * dY, y, 4); } break;
        case 3: if (pos.update()) { fx.x = pos.x; fx.y = pos.y; } else state++; break;
        default: fx.x = x; fx.y = y; return false;
      }
      void shake;
      return true;
    });
  },
  // 48 Megahorn (defender): knocked back, shakes, returns
  48() {
    const side = this.defender, fx = this.fx[side], x = fx.x, y = fx.y, dX = dirX(side), dY = dirY(side);
    let pos = new PosLerp(x, x - 40 * dX, y, y + 16 * dY, 4), shake = new Shake(4, 0, 1, 4), bx = 0, by = 0, state = 0;
    this.task(() => {
      switch (state) {
        case 0: if (pos.update()) { fx.x = pos.x; fx.y = pos.y; } else { state++; shake = new Shake(4, 0, 1, 4); bx = fx.x; by = fx.y; } break;
        case 1: if (shake.update()) { fx.x = bx + shake.x; fx.y = by + shake.y; } else { state++; pos = new PosLerp(x - 40 * dX, x, y + 16 * dY, y, 4); } break;
        case 2: if (pos.update()) { fx.x = pos.x; fx.y = pos.y; } else state++; break;
        default: fx.x = x; fx.y = y; return false;
      }
      return true;
    });
  },
  // 10 Submission(revs, framesPerRev, target): the battler loops ovals
  10(v) {
    const side = v[2] & (1 << 1) ? this.attacker : this.defender, fx = this.fx[side];
    const rev = ovalRevolution(v[0], v[1], side === this.attacker ? -1 : 1);
    const bx = fx.x, by = fx.y + 8;
    this.task(() => {
      if (rev.update()) { fx.x = bx + rev.x; fx.y = by + rev.y; return true; }
      fx.x = bx; fx.y = by - 8; fx.rot = 0;
      return false;
    });
  },
  // 53 ShakeAndScaleAttacker(scale1, scale2, frames1, frames2, hold)
  53(v) {
    const side = this.attacker, fx = this.fx[side], baseY = fx.y, h = this.ground(side);
    const s = new ScaleLerp().init(100, 100, v[0], v[2]), shake = new Shake(2, 0, 0, 10);
    let state = 0, timer = 0;
    this.task(() => {
      switch (state) {
        case 0: if (s.update()) { shake.update(); fx.scaleX = s.x; fx.scaleY = s.y; fx.x += shake.x; fx.y = baseY + groundOffset(h, s.curY); } else state++; break;
        case 1: if (++timer > v[4]) { s.init(v[0], 100, v[1], v[3]); state++; } break;
        case 2: case 3:
          if (s.update()) scaleMon(this, side, s, baseY, h);
          else if (state === 2) state++;
          else { fx.scaleX = 256; fx.scaleY = 256; fx.y = baseY; state++; }
          break;
        default: return false;
      }
      return true;
    });
  },
  // 54 ShakeAndScaleAttacker2(x1, y1, frames1, x2, y2, frames2, hold): start<<16|end packed scales
  54(v) {
    const side = this.attacker, fx = this.fx[side], h = this.ground(side), baseY = DEFAULT_POS[side][1] + h;
    const st = (n: number) => n >> 16, en = (n: number) => n & 0xff;
    const s = new ScaleLerp().initXY(st(v[0]), en(v[0]), st(v[1]), en(v[1]), 100, v[2]), shake = new Shake(2, 0, 0, 10);
    let state = 0, timer = 0;
    this.task(() => {
      switch (state) {
        case 0: if (s.update()) { shake.update(); fx.scaleX = s.x; fx.scaleY = s.y; fx.x += shake.x; fx.y = baseY + groundOffset(h, s.curY); } else state++; break;
        case 1: if (++timer > v[6]) { s.initXY(st(v[3]), en(v[3]), st(v[4]), en(v[4]), 100, v[5]); state++; } break;
        case 2: case 3:
          if (s.update()) scaleMon(this, side, s, baseY, h);
          else if (state === 2) state++;
          else { fx.scaleX = 256; fx.scaleY = 256; fx.y = baseY; state++; }
          break;
        default: return false;
      }
      return true;
    });
  },
  // 56 Superpower: an OBJ-window halo for a single frame (no visible effect at 30 Hz)
  56() { let once = true; this.task(() => { const r = once; once = false; return r; }); },
  // 60 RevolveBattler(target, revs, framesPerRev): half-size oval loops
  60(v) {
    const side = this.sides(v[0])[0];
    if (!side) return;
    const fx = this.fx[side], bx = fx.x, by = fx.y + 8;
    const rev = new Revolution(0, DEG(360), 0, DEG(360), 16, -4, v[2]);
    rev.steps *= v[1];
    this.task(() => {
      if (rev.update()) { fx.x = bx + rev.x; fx.y = by + rev.y; return true; }
      fx.x = bx; fx.y = by - 8;
      return false;
    });
  },
  // 61 MoveBattlerOffScreen(target, frames) / 77 MoveBattlerOnOrOffScreen(mode, target, frames)
  61(v) { moveOffScreen.call(this, 0, v[0], v[1]); },
  77(v) { moveOffScreen.call(this, v[0], v[1], v[2]); },
  // 63 FadePokemonSprite(target, stepFrames, step, start, end, color): palette fade on a pokemon sprite copy
  63(v) {
    let c: MonCopy | null = null;
    for (let i = 0; i < 4 && !c; i++) if (v[0] & (1 << (i + 1))) c = copy(this, i);
    let frac = v[3], timer = 0, active = true;
    this.task(() => {
      if (!active) return false;
      if (++timer >= v[1]) {
        timer = 0;
        if (c) { c.fadeColor = v[5]; c.fadeAmt = frac; }
        if (frac === v[4]) active = false;
        else frac = v[2] > 0 ? Math.min(v[4], frac + v[2]) : Math.max(v[4], frac + v[2]);
      }
      return true;
    }, true);
  },
  // 67 BattlerPartialDraw(target, .., .., step, interval, sketch): Dig — sink into / rise out of the ground
  67(v) {
    const side = this.sides(v[0])[0];
    if (!side) return;
    const fx = this.fx[side], step = v[3], interval = v[4];
    let timer = 0, done = false;
    let yOff = 80 - this.ground(side), height = yOff, y = fx.y;
    const baseY = y;
    if (v[5]) {
      height = 0;
      fx.partial = { x: 0, y: yOff, w: 80, h: 0 };
      this.task(() => {
        if (done) { fx.partial = null; return false; }
        if (++timer < interval) return true;
        timer = 0; yOff -= step; height += step;
        if (yOff < 0) { yOff = 0; done = true; }
        fx.partial = { x: 0, y: yOff, w: 80, h: height };
        return true;
      });
      return;
    }
    const appear = step <= 0;
    if (!appear) fx.partial = { x: 0, y: 0, w: 80, h: yOff };
    else { yOff = 0; y += height; fx.y = y; fx.partial = { x: 0, y: 0, w: 80, h: 0 }; }
    this.task(() => {
      if (done) { fx.partial = null; fx.y = baseY; return false; }
      if (++timer < interval) return true;
      timer = 0; y += step; fx.y = y; yOff -= step;
      if (appear ? yOff > height : yOff < 0) { yOff = appear ? height : 0; done = true; }
      fx.partial = { x: 0, y: 0, w: 80, h: yOff };
      return true;
    });
  },
  // 69 PixelatePokemonSprite(spriteID, step, startX, startY): OBJ mosaic on a copy (Transform)
  69(v) {
    const c = copy(this, v[0]);
    if (!c) return;
    c.visible = true;
    let sx = v[2], sy = v[3];
    const step = v[1], target = step < 0 ? 0 : 15;
    const run = () => {
      if (sx === target || sy === target) return false;
      if (step < 0) { if (sx + step > 0) { sx += step; sy += step; } else { sx = target; sy = target; } }
      else if (sx + step < 15) { sx += step; sy += step; } else { sx = target; sy = target; }
      c.mosaic = sx + 1;
      this.drawMgr(-1);
      return true;
    };
    this.task(run, true);
  },
  // 73 MoveEmitterViewportTop(emitter, mode, type, frames, delay, params): an emitter drops from / rises to the top
  73(v) {
    const e = this.emitters[v[0]], sys = this.ps();
    if (!e || !sys) return;
    const side = v[1] === 0 ? this.attacker : this.defender, w = this.world(side);
    const px = (u: number) => Math.trunc((u * FX) / 172);
    const topY = (16512 + 60 * 172) / FX;
    const [sx, sy, ex, ey] = v[2] === 0 ? [w[0], topY, w[0], w[1]] : [w[0], w[1], w[0], topY];
    const lin = new PosLerp(px(sx), px(ex), px(sy), px(ey), v[3]);
    for (let i = 0; i < v[5] >>> 16; i++) lin.update();
    const place = () => e.setPos({ 0: (lin.x * 172) / FX, 1: (lin.y * 172) / FX });
    place();
    let timer = 0;
    this.task(() => {
      if (timer < v[4]) { timer++; return true; }
      if (!lin.update() && !e.active) { sys.mgr.remove(e); return false; }
      place();
      return true;
    });
  },
  // 58 Mimic: a copy of the defender shrinks into the ground
  58() {
    const side = this.defender, dy = this.fx[side].y, h = this.ground(side);
    const c0 = copy(this, 0), c1 = copy(this, 1), c2 = copy(this, 2);
    const s = new ScaleLerp().initXY(100, 20, 100, 20, 100, 10);
    if (c0) c0.order = 60;
    this.task(() => {
      if (!s.update()) { for (const c of [c0, c1, c2]) if (c) c.visible = false; this.drawMgr(-1); return false; }
      if (c0) { c0.scaleX = s.fx; c0.scaleY = s.fy; c0.y = dy + groundOffset(h, s.curY); }
      this.drawMgr(-1);
      return true;
    });
  },
  // 55 Camouflage: the attacker blends into the background (hidden behind a fading copy) for 120 frames
  55() {
    const side = this.attacker, fx = this.fx[side];
    const mask = copy(this, 0), c = copy(this, 1);
    if (mask) mask.visible = false; // OBJ window: shows the (wavy) battle background through the silhouette
    if (c) c.xlu = true;
    this.blendA = 16; this.blendB = 2;
    let fade = alphaFade(this, 16, 2, 2, 16, 16), state = 0, timer = 0;
    this.task(() => {
      switch (state) {
        case 0: fx.hide = true; state++; break;
        case 1: if (fade.done) { timer = 0; state++; } break;
        case 2: if (++timer >= 120) { fade = alphaFade(this, 2, 16, 16, 2, 16); state++; } break;
        case 3: if (fade.done) { fx.hide = false; state++; } break;
        default: return false;
      }
      this.drawMgr(-1);
      return true;
    });
  },
  // 80..83 StatChangeUp/Down/Heal/Metal(pattern, mode): a scrolling pattern over the battler's silhouette
  80(v) { statChange.call(this, v, 3); },
  81(v) { statChange.call(this, v, -3); },
  82(v) { statChange.call(this, v, 3); },
  83(v) { statChange.call(this, v, -6); },
};

function moveOffScreen(this: MoveAnimation, mode: number, target: number, frames: number) {
  const side = this.sides(target)[0];
  if (!side) return;
  const fx = this.fx[side], dest = side === 'p1' ? -80 : 256 + 80;
  const p = mode === 0 ? new PosLerp(fx.x, dest, fx.y, fx.y, frames) : new PosLerp(dest, DEFAULT_POS[side][0], fx.y, fx.y, frames);
  this.task(() => { const on = p.update(); fx.x = p.x; fx.y = p.y; return on; });
}

function statChange(this: MoveAnimation, v: number[], stepY: number) {
  const side = v[1] === 0 ? this.attacker : this.defender, fx = this.fx[side];
  // Copy 0 sits below the pattern BG (priority 2) and copy 1 is the OBJ window: both show through the battler's overlay.
  for (const id of [0, 1]) { const c = copy(this, id); if (c) c.visible = false; }
  let a = 12, b = 4, state = 0, timer = 0, oy = 0;
  this.task(() => {
    switch (state) {
      case 0: state++; break; // load BG
      case 1: fx.stat = { img: v[0], x: 0, y: 0, mix: 0 }; state++; break; // set blending
      case 2: if (timer > 20) state++; else timer++; break;
      case 3:
        if (a > 0) a--;
        if (b < 16) b++;
        if (a === 0 && b === 16) { fx.stat = null; state++; }
        break;
      default: fx.stat = null; return false;
    }
    oy += stepY;
    if (fx.stat) { fx.stat.y = oy; fx.stat.mix = a / 16; }
    this.drawMgr(-1);
    return true;
  });
}

/** PaletteData_StartFade on the base BG palettes (step 2 every `wait` frames; negative wait = step 2+|wait|). */
function bgPaletteFade(a: MoveAnimation, color: number) {
  const st = { active: false, start(wait: number, from: number, to: number) {
    st.active = true;
    a.bg.fadeColor = color;
    const w = wait < 0 ? 0 : wait, step = wait < 0 ? 2 - wait : 2;
    let cur = from, ws = w;
    a.sysTask(() => {
      if (ws < w) { ws++; return true; }
      ws = 0;
      a.bg.fadeAmt = cur;
      if (cur === to) { st.active = false; return false; }
      cur = cur < to ? Math.min(to, cur + step) : Math.max(to, cur - step);
      return true;
    });
  } };
  return st;
}

export const SPRITE_FUNCS: Record<number, SpriteFn> = {
  // 1 String Shot(count): threads blink in at the defender, flatten, then fade
  1(sp, v) {
    const n = v[0], [bx, by] = DEFAULT_POS[this.defender];
    setBlend(this, -1, -1);
    let sa = 15, ba = 0;
    this.blendA = sa; this.blendB = ba;
    const sprites = [sp];
    for (let i = 1; i < n; i++) sprites.push(this.newSprite(sp.mgr));
    sprites.forEach((s, i) => { s.x = bx; s.y = by + 32 - i * 4; s.xlu = true; });
    const timing = [[8, 2], [13, 1], [18, 3]], counters = [0, 0, 0];
    const s = new ScaleLerp();
    let state = 0, delay = 0;
    this.task(() => {
      switch (state) {
        case 0:
          delay++;
          sprites.forEach((spr, i) => {
            if (delay >= timing[i][0]) { if (++counters[i] >= timing[i][1]) { counters[i] = 0; spr.visible = !spr.visible; } }
            else spr.visible = false;
          });
          if (delay >= 45) { sprites.forEach(spr => (spr.visible = true)); delay = 0; state++; }
          break;
        case 1: s.initXY(100, 60, 100, 100, 100, 10); state++; break;
        case 2:
          if (s.update()) sprites.forEach(spr => { spr.scaleX = s.fx; spr.scaleY = s.fy; });
          else if (++delay >= 45) state++;
          break;
        case 3:
          if (sa > 0) sa--;
          if (ba < 15) ba++;
          if (sa === 0 && ba === 15) state++;
          this.blendA = sa; this.blendB = ba;
          break;
        default: sprites.forEach(spr => this.extra.delete(spr)); return false;
      }
      sprites.forEach(tick);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 3 Trick(cupCount): attacker bobs, two cups rise, swap places five times along arcs, then fade
  3(sp, v) {
    const side = this.attacker, fx = this.fx[side], ay = fx.y, h = this.ground(side);
    const cups = [sp];
    for (let i = 1; i < v[0]; i++) cups.push(this.newSprite(sp.mgr));
    const alpha = { n: 0 }, bgA = { n: 16 };
    setBlend(this, -1, -1); this.blendA = 0; this.blendB = 16;
    cups.forEach(c => { c.xlu = true; c.prio = 2; });
    cups[0].x = 100; cups[0].y = 54;
    if (cups[1]) { cups[1].x = 180; cups[1].y = 39; }
    const scales = [[100, 100, 100, 70, 8], [100, 100, 70, 120, 3], [100, 100, 120, 100, 3]];
    const dirs = [[1, -1], [-1, 1], [1, -1], [1, -1], [1, -1]];
    const s = new ScaleLerp();
    let state = 0, it = 0, delay = 0, arcs: Parabolic[] = [];
    this.task(() => {
      const c0 = cups[0], c1 = cups[1] ?? cups[0];
      switch (state) {
        case 0: { const [sx, ex, sy, ey, f] = scales[it++]; s.initXY(sx, ex, sy, ey, 100, f); state++; break; }
        case 1: if (s.update()) scaleMon(this, side, s, ay, h); else state = it >= 3 ? 2 : 0; break;
        case 2: if (++delay >= 1) { delay = 0; it = 0; state++; } break;
        case 3: if (c0.y <= 104) { c0.y += 2; if (c1 !== c0) c1.y += 2; } else state++; break;
        case 4:
          if (c0.y <= 104) { c0.y += 2; if (c1 !== c0) c1.y += 2; } else { this.blendA = 16; this.blendB = 0; state++; }
          delay++;
          stepValue(alpha, 16, 16); stepValue(bgA, 0, -16);
          this.blendA = alpha.n; this.blendB = bgA.n;
          if (delay === 10) c0.y += 16;
          if (delay === 12 && c1 !== c0) c1.y += 16;
          break;
        case 5: if (++delay >= 1) { delay = 0; state++; } break;
        case 6:
          arcs = [new Parabolic(c0.x, c1.x, c0.y, c1.y, 10, 40 * dirs[it][0]), new Parabolic(c1.x, c0.x, c1.y, c0.y, 10, 40 * dirs[it][1])];
          it++; state++;
          break;
        case 7: {
          let done = 0;
          arcs.forEach((p, i) => { if (!p.update()) done++; else { const c = cups[i]; if (c) { c.x = p.x; c.y = p.y; } } });
          if (done === 2) state = it === 5 ? 8 : 6;
          break;
        }
        case 8: {
          let done = 0;
          if (stepValue(alpha, 0, -2)) done++;
          if (stepValue(bgA, 16, 2)) done++;
          this.blendA = alpha.n; this.blendB = bgA.n;
          if (done === 2) state++;
          break;
        }
        default: cups.forEach(c => this.extra.delete(c)); fx.scaleX = 256; fx.scaleY = 256; fx.y = ay; return false;
      }
      for (const c of cups) c.prio = c.y < 80 || c.x > 128 ? 1 : 2;
      if (state < 4) return true;
      cups.forEach(tick);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 2 Kinesis: a spoon fades in beside the attacker, it and two copies swing in arcs, then it bends and fades
  2(sp) {
    const atk = this.attacker, [px, py] = DEFAULT_POS[atk], rx = dirX(atk) * -32;
    type Spoon = { s: OamSprite; rev: Revolution; cos: Sinusoid; step: number; state: number; active: boolean };
    const mk = (s: OamSprite): Spoon => {
      const rev = Revolution.withStepSize(DEG(90), DEG(270), DEG(90), DEG(270), rx, -8, DEG(10));
      return { s, rev, cos: new Sinusoid(0, DEG(360), -1, rev.steps), step: rev.stepX, state: 0, active: false };
    };
    const spoon = mk(sp);
    spoon.active = true;
    sp.x = px; sp.y = py; sp.xlu = true;
    const extras = [0, 1].map(() => { const e = mk(this.newSprite(sp.mgr)); e.s.x = px; e.s.y = py; e.s.visible = false; e.s.xlu = true; return e; });
    const upd = (k: Spoon): boolean => {
      if (!k.active) return true;
      if (k.state === 2) return false;
      if (k.rev.update()) { k.cos.update(); k.rev.stepX = k.step + k.cos.value; k.s.x = px + k.rev.x; k.s.y = py + k.rev.y; }
      else {
        if (k.state === 0) { k.rev = Revolution.withStepSize(k.rev.curX, DEG(180), k.rev.curX, DEG(180), rx, -8, DEG(10)); k.cos = new Sinusoid(0, DEG(360), -1, k.rev.steps); }
        k.state++;
      }
      return true;
    };
    let state = 0, delay = 8, activeIdx = 0, alpha = 0;
    this.blendA = 0; this.blendB = 31;
    const len = this.host.animLength?.(sp.key, sp.anim) ?? 8;
    this.task(() => {
      switch (state) {
        case 0: upd(spoon); state++; break;
        case 1:
          alpha += 10; this.blendA = Math.trunc(alpha / 10); this.blendB = 31 - Math.trunc(alpha / 10);
          if (alpha >= 310) { sp.xlu = false; state++; }
          break;
        case 2: setBlend(this, -1, -1); state++; break;
        case 3: {
          if (delay <= 0 && activeIdx < 2) { extras[activeIdx].active = true; extras[activeIdx].s.visible = true; activeIdx++; delay = 8; }
          if (activeIdx < 2) delay--;
          let any = upd(spoon);
          for (const e of extras) { const on = upd(e); if (!on) e.s.visible = false; any = any || on; }
          if (!any) state++;
          break;
        }
        case 4: sp.t++; if (sp.t >= len) { sp.xlu = true; state++; } break;
        case 5: alpha -= 10; this.blendA = Math.trunc(alpha / 10); this.blendB = 31 - Math.trunc(alpha / 10); if (alpha <= 0) state++; break;
        default: this.extra.delete(sp); extras.forEach(e => this.extra.delete(e.s)); return false;
      }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 4 Metronome: a wagging finger grows beside the attacker, waggles five times, and shrinks
  4(sp) {
    const atk = this.attacker, dir = dirX(atk), [x, y] = DEFAULT_POS[atk];
    sp.x = x + 40 * dir; sp.y = y;
    sp.anim = atk === 'p2' ? 1 : 0;
    const pivot = { x: -12 * dir, y: 12 }; // affine translation: rotate about the finger's base
    const s = new ScaleLerp().init(1, 10, 10, 8);
    let angle = dir >= 0 ? new ValueLerp(DEG(359), DEG(320), 4) : new ValueLerp(DEG(0), DEG(40), 4);
    let next = dir >= 0 ? DEG(359) : DEG(0), counter = 0, state = 0;
    const place = () => {
      const r = (sp.rot / 65536) * Math.PI * 2, c = Math.cos(r), si = Math.sin(r);
      sp.x = x + 40 * dir + pivot.x - (pivot.x * c - pivot.y * si) * sp.scaleX;
      sp.y = y + pivot.y - (pivot.x * si + pivot.y * c) * sp.scaleY;
    };
    this.task(() => {
      switch (state) {
        case 0: if (s.update()) { sp.scaleX = s.fx; sp.scaleY = s.fy; } else { state++; counter = 5; s.init(10, 10, 1, 8); } break;
        case 1: {
          const on = angle.update(); sp.rot = angle.value & 0xffff;
          if (!on) { if (counter > 0) { counter--; const st = angle.value, en = next; next = angle.value; angle = new ValueLerp(st, en, 4); } else state++; }
          break;
        }
        case 2: if (s.update()) { sp.scaleX = s.fx; sp.scaleY = s.fy; } else state++; break;
        default: this.extra.delete(sp); return false;
      }
      place();
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 5 Constrict: four vines appear around the defender one by one, it shakes, the vines squeeze
  5(sp) {
    const def = this.defender, fx = this.fx[def], dx = fx.x, dy = fx.y;
    const shake = new Shake(4, 0, 1, 1);
    const vines = [0, 1, 2, 3].map(i => {
      const s = i === 0 ? sp : this.newSprite(sp.mgr);
      const flip = i % 2 === 1;
      s.x = dx; s.y = dy + 16 - i * 10; s.visible = false;
      if (flip) s.scaleX = -1;
      return { s, flip, scale: new ScaleLerp().init(10, 10, 8, 8), count: 3, ns: 8, ne: 10, animate: false };
    });
    let state = 0, counter = 0, idx = 0;
    this.task(() => {
      switch (state) {
        case 0:
          if (counter >= 4) { counter = 0; vines[idx].s.visible = true; vines[idx].animate = true; if (++idx >= 4) state++; }
          counter++;
          break;
        case 1: if (shake.update()) { fx.x = dx + shake.x; fx.y = dy + shake.y; } else state++; break;
        case 2: {
          let on = false;
          for (const v of vines) {
            if (v.scale.update()) { v.s.scaleX = v.flip ? -v.scale.fx : v.scale.fx; v.s.scaleY = 1; on = true; }
            else if (v.count > 0) { v.count--; v.scale.init(v.ns, 10, v.ne, 8); [v.ns, v.ne] = [v.ne, v.ns]; on = true; }
            else on = false;
          }
          if (!on) state++;
          break;
        }
        default: fx.x = dx; fx.y = dy; vines.forEach(v => this.extra.delete(v.s)); return false;
      }
      vines.forEach(v => { if (v.animate) v.s.t++; });
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 6 Bonemerang: the attacker throws; the bone arcs to the defender and back, the attacker catches it
  6(sp) {
    const a = this.fx[this.attacker], d = this.fx[this.defender], ax = a.x, ay = a.y, dir = dirX(this.attacker);
    let pos = new PosLerp(0, -16 * dir, 0, 0, 4), arc = new Parabolic(ax, d.x, ay, d.y, 10, 32), state = 0;
    this.task(() => {
      switch (state) {
        case 0: if (pos.update()) { a.x = ax + pos.x; a.y = ay + pos.y; } else { pos = new PosLerp(pos.x, 0, 0, 0, 2); state++; } return true;
        case 1: if (pos.update()) { a.x = ax + pos.x; a.y = ay + pos.y; } else { a.x = ax; a.y = ay; pos = new PosLerp(0, -32 * dir, 0, 0, 4); state++; } return true;
        case 2: if (arc.update()) { sp.x = arc.x; sp.y = arc.y; } else { arc = new Parabolic(d.x, ax, d.y, ay, 10, -32); state++; } break;
        case 3: if (arc.update()) { sp.x = arc.x; sp.y = arc.y; } else { sp.visible = false; state++; } break;
        case 4: if (pos.update()) { a.x = ax + pos.x; a.y = ay + pos.y; } else { pos = new PosLerp(pos.x, 0, 0, 0, 4); state++; } break;
        case 5: if (pos.update()) { a.x = ax + pos.x; a.y = ay + pos.y; } else { a.x = ax; a.y = ay; state++; } break;
        default: this.extra.delete(sp); return false;
      }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 7 Scary Face: the attacker stretches tall while a giant face grows beside it, then fades
  7(sp) {
    const atk = this.attacker, fx = this.fx[atk], dX = dirX(atk), dY = dirY(atk);
    const aScale = new ScaleLerp().init(10, 10, 15, 12);
    let aState = 0, fState = 0, fade = { done: false };
    sp.xlu = true;
    const bx = fx.x + 32 * dX, by = fx.y;
    const fpos = new PosLerp(0, 0, 0, (dY < 0 ? -8 : -24) * dY, 32), fscale = new ScaleLerp().init(5, 10, 12, 32);
    this.blendA = 31; this.blendB = 26;
    this.task(() => {
      if (aState === 0) { if (aScale.update()) fx.scaleY = aScale.y; else { aState++; aScale.init(15, 10, 10, 12); } }
      else if (aState === 1) { if (aScale.update()) fx.scaleY = aScale.y; else { fx.scaleY = 256; aState++; } }
      if (fState === 0) {
        if (fscale.update()) { sp.scaleX = fscale.fx; sp.scaleY = fscale.fy; }
        if (fpos.update()) { sp.x = bx + fpos.x; sp.y = by + fpos.y; } else { fState++; fade = alphaFade(this, 16, 0, 14, 16, 8); }
      } else if (fState === 1) { if (fade.done) { sp.visible = false; fState++; } }
      else { this.extra.delete(sp); return false; }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 8 Foresight: a lens zig-zags over the defender, fades, and the defender flashes white
  8(sp) {
    const side = this.defender, fx = this.fx[side];
    let bx = sp.x, by = sp.y, seg = 0, delay = 0, state = 0, fade = { done: false };
    const E = 80, segs = [[E / 2, E / 2], [0, -E], [-E, E], [0, -E], [E, E], [-E / 2, -E / 2]];
    const pos = new PosLerp();
    this.task(() => {
      switch (state) {
        case 0: if (++delay > 4) { pos.init(0, segs[seg][0], 0, segs[seg][1], 8); state++; delay = 0; } break;
        case 1:
          if (pos.update()) { sp.x = bx + pos.x; sp.y = by + pos.y; }
          else if (++seg < 6) { state = 0; bx += pos.x; by += pos.y; }
          else { state++; sp.xlu = true; fade = alphaFade(this, 16, 0, 0, 16, 16); monFade(this, side, 0, 10, 0, COLOR_WHITE); }
          break;
        case 2:
          if (fade.done) sp.visible = false;
          if (!fx.fading) { state++; monFade(this, side, 10, 0, 0, COLOR_WHITE); }
          break;
        case 3: if (!fx.fading) state++; break;
        default: this.extra.delete(sp); return false;
      }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 9 Lock-On: a reticle traces in to the defender, locks, the screen flashes white, and it blinks out
  9(sp) {
    const E = 80;
    let bx = sp.x - E / 2, by = sp.y - E / 2, seg = 0, delay = -16, state = 0, blink = 0, vis = false;
    sp.x = bx; sp.y = by; sp.xlu = true;
    this.blendA = 31; this.blendB = 26;
    const segs = [[E, E], [0, -E], [-E, E], [E / 2, -E / 2]];
    const pos = new PosLerp(), bgFade = bgPaletteFade(this, COLOR_WHITE);
    const sides: Side[] = ['p1', 'p2'];
    this.task(() => {
      switch (state) {
        case 0: if (++delay > 1) { pos.init(0, segs[seg][0], 0, segs[seg][1], 4); state++; delay = 0; } break;
        case 1:
          if (pos.update()) { sp.x = bx + pos.x; sp.y = by + pos.y; }
          else if (++seg < 4) { state = 0; bx += pos.x; by += pos.y; }
          else { state++; delay = 8; sp.anim = 1; sp.t = 0; }
          break;
        case 2:
          if (--delay < 0) { state++; bgFade.start(-8, 0, 16); sides.forEach(s => monFade(this, s, 14, 16, 0, COLOR_WHITE)); }
          break;
        case 3: if (!bgFade.active) { state++; bgFade.start(-8, 16, 0); sides.forEach(s => monFade(this, s, 2, 0, 0, COLOR_WHITE)); } break;
        case 4: if (!bgFade.active) { state++; delay = 4; blink = 4; vis = false; } break;
        case 5: if (--delay < 0) { delay = 4; if (--blink < 0) state++; else { sp.visible = vis; vis = !vis; } } break;
        default: this.extra.delete(sp); return false;
      }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 11 Mean Look: a pulsing eye shrinks/grows in decaying beats, opens, the screen flashes white, it fades
  11(sp) {
    sp.xlu = true; sp.t = 4;
    let repeat = 3, frames = 400, start = 1500, end = 1000, seq = 0, pulse = 0, count = 0, state = 0, timer = 0;
    let fade = { done: false }, flash = 0, flashT = 0;
    const s = new ScaleLerp();
    const len = this.host.animLength?.(sp.key, 0) ?? 16;
    const initPulse = () => {
      s.init(Math.trunc(start / 100), 10, Math.trunc(end / 100), Math.trunc(frames / 100));
      setBlend(this, 16, 0);
      fade = alphaFade(this, 16, 10, 0, 6, Math.trunc(frames / 100) * 2);
      pulse = 0; count = 0;
    };
    const updPulse = (): boolean => {
      if (pulse === 0) { if (s.update()) { sp.scaleX = s.fx; sp.scaleY = s.fy; } else { s.init(Math.trunc(end / 100), 10, Math.trunc(start / 100), Math.trunc(frames / 100)); pulse++; } }
      else if (pulse === 1) {
        if (s.update()) { sp.scaleX = s.fx; sp.scaleY = s.fy; }
        else if (++count < 2) { pulse = 0; s.init(Math.trunc(start / 100), 10, Math.trunc(end / 100), Math.trunc(frames / 100)); } else pulse++;
      } else if (pulse === 2) { if (fade.done) { pulse++; return true; } }
      else return true;
      return false;
    };
    const sides: Side[] = ['p1', 'p2'];
    const flashTo = (from: number, to: number) => { // BrightnessController on BG0/2/3: the scene (not OBJ) toward white
      flash = 1; flashT = 0;
      this.sysTask(() => {
        flashT++;
        const v = Math.round(from + ((to - from) * flashT) / 8);
        this.bg.fadeColor = COLOR_WHITE; this.bg.fadeAmt = v;
        sides.forEach(sd => { this.fx[sd].fadeColor = COLOR_WHITE; this.fx[sd].fadeAmt = v; });
        if (flashT >= 8) { flash = 0; return false; }
        return true;
      });
    };
    this.task(() => {
      switch (state) {
        case 0:
          if (seq === 0) { initPulse(); updPulse(); seq = 1; }
          else if (updPulse()) {
            if (--repeat >= 0) { frames -= Math.trunc(frames / 3); start -= Math.trunc(start / 3); end -= Math.trunc(end / 3); seq = 0; }
            else { state++; timer = 30; sp.anim = 0; sp.t = 0; sp.scaleX = 1; sp.scaleY = 1; fade = alphaFade(this, 0, 16, 16, 0, 4); }
          }
          break;
        case 1:
          if (timer === 0) { flashTo(0, 16); timer = -1; } else if (timer > 0) timer--;
          if (timer === -1 && !flash) { flashTo(16, 0); timer = -2; }
          sp.t++;
          if (sp.t >= len) state++;
          break;
        case 2: if (!flash) { state++; setBlend(this, 16, 0); fade = alphaFade(this, 16, 0, 0, 16, 8); } break; // brightness transition complete (or never started)
        case 3: if (fade.done) { sp.visible = false; state++; } break;
        default: this.extra.delete(sp); return false;
      }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 12 Torment: speech bubbles pop up around the attacker one after another while it shudders
  12(sp) {
    const atk = this.attacker, fx = this.fx[atk], ax = fx.x, ay = fx.y, h = this.ground(atk);
    const bubbles = [0, 1, 2, 3, 4, 5].map(i => {
      const b = i === 0 ? sp : this.newSprite(sp.mgr);
      b.visible = false;
      const ang = Math.trunc(DEG(90) / 3) * Math.trunc(i / 2);
      const ox = Math.floor(Math.cos((ang / 65536) * Math.PI * 2) * 48), oy = Math.floor(Math.sin((ang / 65536) * Math.PI * 2) * 48);
      if (i % 2 === 0) { b.x = ax + ox; b.hflip = true; } else b.x = ax - ox;
      b.y = ay - oy;
      return { b, done: false, end: i < 2 ? 8 : 0, speed: 2 };
    });
    const len = this.host.animLength?.(sp.key, 0) ?? 60;
    const initBubble = (k: typeof bubbles[0]) => { k.done = false; k.b.visible = true; k.b.anim = 0; k.b.t = 55; k.speed = 2; };
    const updBubble = (k: typeof bubbles[0]) => { if (!k.done && k.b.t >= len) k.done = true; return k.done; };
    const s = new ScaleLerp();
    let scaleState = 0, state = 0, cur = 0;
    const updScale = (): boolean => {
      if (scaleState === 3) return true;
      if (s.update()) { fx.scaleX = s.x; fx.scaleY = s.y; fx.y = ay + groundOffset(h, s.curY); return false; }
      if (scaleState === 0) s.initXY(9, 11, 8, 15, 10, 2);
      else if (scaleState === 1) s.initXY(11, 10, 15, 10, 10, 2);
      else { fx.scaleX = 256; fx.scaleY = 256; }
      scaleState++;
      return scaleState === 3;
    };
    this.task(() => {
      switch (state) {
        case 0: scaleState = 0; s.initXY(10, 9, 10, 8, 10, 2); initBubble(bubbles[cur]); state++; break;
        case 1: { const a = updScale(), b = updBubble(bubbles[cur]); if (a && b) { bubbles[cur].b.anim = 1; state++; } break; }
        case 2: if (--bubbles[cur].end < 0) { if (++cur < 6) state = 0; else state++; } break;
        case 3: bubbles.forEach(initBubble); state++; break;
        case 4: { let d = false; bubbles.forEach(k => (d = updBubble(k))); if (d) state++; break; }
        default: bubbles.forEach(k => this.extra.delete(k.b)); return false;
      }
      bubbles.forEach(k => { if (k.b.visible && !k.done) k.b.t += k.speed; });
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 13 Baton Pass: a Poké Ball opens, the attacker shrinks into it, it closes and flies off the top
  13(sp) {
    const atk = this.attacker, fx = this.fx[atk], [ax, ay] = DEFAULT_POS[atk];
    fx.hide = false;
    sp.x = ax; sp.y = ay;
    const len = (n: number) => this.host.animLength?.(sp.key, n) ?? 8;
    const s = new ScaleLerp(), p = new PosLerp(), bp = new PosLerp();
    let state = 0, animating = false;
    this.task(() => {
      switch (state) {
        case 0: animating = true; state++; break;
        case 1: if (sp.t >= len(0)) { animating = false; state++; s.init(10, 10, 0, 8); p.init(fx.x, ax, fx.y, ay, 8); } break;
        case 2:
          if (p.update()) { fx.x = p.x; fx.y = p.y; }
          if (s.update()) { fx.scaleX = s.x; fx.scaleY = s.y; }
          else { fx.hide = true; fx.scaleX = 256; fx.scaleY = 256; sp.anim = 1; sp.t = 0; animating = true; state++; }
          break;
        case 3: if (sp.t >= len(1)) { animating = false; state++; bp.init(0, 0, ay, 0, 8); } break;
        case 4: if (bp.update()) { sp.x = ax; sp.y = bp.y; } else state++; break;
        default: this.extra.delete(sp); return false;
      }
      if (animating) sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 15 Grudge: six ghostly flames circle the attacker, fading in and out
  15(sp) {
    const atk = this.attacker, fx = this.fx[atk], ax = fx.x, ay = fx.y, dir = dirX(atk);
    const flames = [0, 1, 2, 3, 4, 5].map(i => { const f = i === 0 ? sp : this.newSprite(sp.mgr); f.xlu = true; f.order = 100; return f; });
    const revs = flames.map((_, i) => { const r = new Revolution(0, DEG(180), 0, 0, 50, 0, 48); r.curX = (r.curX + Math.trunc(DEG(360) / 6) * i) & 0xffff; r.stepX *= dir; return r; });
    const upd = () => revs.forEach((r, i) => {
      r.update();
      const ang = (r.curX * 5) & 0xffff;
      const oy = Math.floor(Math.round(Math.sin((ang / 65536) * Math.PI * 2) * FX) * 10 * dir / FX);
      flames[i].x = ax + r.x; flames[i].y = ay + oy;
      flames[i].prio = r.curX >= DEG(90) && r.curX <= DEG(269) ? 1 : 2;
    });
    let state = 0, delay = 0, fade = { done: false };
    this.task(() => {
      switch (state) {
        case 0: setBlend(this, 1, 15); fade = alphaFade(this, 1, 16, 15, 0, 10); upd(); state++; break;
        case 1: upd(); if (fade.done) { state++; delay = 48 - 20; } break;
        case 2: upd(); if (--delay < 0) { state++; fade = alphaFade(this, 16, 1, 0, 15, 10); } break;
        case 3: upd(); if (fade.done) state++; break;
        default: flames.forEach(f => this.extra.delete(f)); return false;
      }
      flames.forEach(tick);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 16 Grass Whistle: notes drift from the attacker across the screen on a wavy path
  16(sp) {
    const atk = this.attacker, fx = this.fx[atk], dX = dirX(atk), dY = dirY(atk);
    const notes = Array.from({ length: 15 }, (_, i) => {
      const n = i === 0 ? sp : this.newSprite(sp.mgr);
      n.visible = false; n.x = fx.x; n.y = fx.y; n.anim = i % 3;
      return { n, p: new PosLerp() };
    });
    let delay = 0, idx = 0;
    this.task(() => {
      if (idx < 15 && ++delay > 6) { delay = 0; const k = notes[idx++]; k.p.init(k.n.x, k.n.x + 256 * dX, k.n.y, k.n.y - 128 * dY, 59); k.n.visible = true; }
      let done = false;
      for (let i = 0; i < idx; i++) {
        const k = notes[i];
        if (k.p.update()) {
          const deg = (k.p.x * DEG(2)) & 0xffff, sn = Math.sin((deg / 65536) * Math.PI * 2);
          k.n.x = k.p.x; k.n.y = k.p.y + Math.floor(sn * 14);
          k.n.scaleX = k.n.scaleY = 1 - sn * 0.17;
          done = false;
        } else done = true;
      }
      if (idx >= 15 && done) { notes.forEach(k => this.extra.delete(k.n)); return false; }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 18 Fake Out: the clapping hands fade in, play their animation, and fade out
  18(sp) {
    sp.xlu = true;
    const len = this.host.animLength?.(sp.key, sp.anim) ?? 16;
    let state = 0, fade = { done: false };
    this.task(() => {
      switch (state) {
        case 0: setBlend(this, 0, 16); fade = alphaFade(this, 0, 16, 16, 0, 8); state++; break;
        case 1: if (fade.done) state++; break;
        case 2: if (sp.t >= len) { state++; fade = alphaFade(this, 16, 0, 0, 16, 8); } break;
        case 3: if (fade.done) state++; break;
        default: this.extra.delete(sp); return false;
      }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 10 Swagger: two anger marks pop on the defender, one after the other
  10(sp) {
    const def = this.fx[this.defender], dir = dirX(this.attacker);
    sp.visible = false;
    const s = new ScaleLerp();
    let pop = 0, step = 0, delay = 4;
    const start = (x: number, y: number) => { sp.visible = true; sp.x = x; sp.y = y; step = 0; s.init(10, 10, 14, 4); };
    const upd = () => {
      if (s.update()) { sp.scaleX = s.fx; sp.scaleY = s.fy; return false; }
      if (step) { sp.visible = false; return true; }
      step = 1; s.init(14, 10, 12, 2);
      return false;
    };
    this.task(() => {
      switch (pop) {
        case 0: start(def.x + 24 * dir, def.y - 16); pop++; break;
        case 1: if (upd()) pop++; break;
        case 2: if (--delay < 0) { pop++; start(def.x - 24 * dir, def.y - 24); } break;
        case 3: if (upd()) pop++; break;
        default: this.extra.delete(sp); return false;
      }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 25 OffsetAndAnimate(dx, dy): plays the sprite's animation once at an offset
  25(sp, v) {
    sp.x += v[0]; sp.y += v[1];
    const len = this.host.animLength?.(sp.key, sp.anim) ?? 16;
    this.task(() => {
      if (sp.t >= len) { this.extra.delete(sp); return false; }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 26 Follow Me: a waving finger sways side to side in front of/behind the defender, then wags
  26(sp) {
    const [dx, dy] = DEFAULT_POS[this.defender];
    sp.x = dx; sp.y = dy + 12; sp.anim = this.attacker === 'p2' ? 1 : 0; sp.prio = 1;
    const offs = [5, 5, 5, 5, 4, 4, 4, 3, 3, 3, 0, -3, -3, -3, -4, -4, -4, -5, -5, -5, -5, -5, -5, -5, -5, -4, -4, -4, -3, -3, -3, 0, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 255];
    const A = DEG(20), tilts = [[A, -A, 4], [-A, A, 4], [A, -A, 4], [-A, A, 4], [A, 0, 2]];
    let i = 0, phase = 0, tilt = new ValueLerp(0, A, 4);
    const base = { x: sp.x, y: sp.y };
    const pivot = { x: -8, y: 16 };
    const place = () => {
      const r = (sp.rot / 65536) * Math.PI * 2, c = Math.cos(r), s = Math.sin(r);
      sp.x = base.x + pivot.x - (pivot.x * c - pivot.y * s); sp.y = base.y + pivot.y - (pivot.x * s + pivot.y * c);
    };
    this.task(() => {
      if (phase === 0) {
        const o = offs[i++];
        if (o !== 255) { if (o === 0) sp.prio = sp.prio === 1 ? 2 : 1; sp.x += o; base.x = sp.x; }
        else { tilt = new ValueLerp(0, A, 4); i = 0; phase = 1; }
      } else if (phase === 1) {
        if (tilt.update()) { sp.rot = tilt.value & 0xffff; place(); }
        else if (i > 5) phase = 2;
        else { i++; const t = tilts[i - 1]; if (t) tilt = new ValueLerp(t[0], t[1], t[2]); }
      } else { this.extra.delete(sp); return false; }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 27 Fissure: the crack opens under the defender (BG priority: behind the battlers)
  27(sp) {
    const def = this.defender;
    sp.x = DEFAULT_POS[def][0];
    sp.y = def === 'p1' ? 126 : 32;
    sp.anim = def === 'p1' ? 1 : 0;
    sp.prio = 2;
    const len = this.host.animLength?.(sp.key, sp.anim) ?? 16;
    this.task(() => {
      if (sp.t >= len) { this.extra.delete(sp); return false; }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 28 Escape item: the item arcs in from the bottom left, plays its animation, and fades
  28(sp) {
    sp.x = -30; sp.y = 160; sp.prio = 2;
    const p = new Parabolic(-30, 112, 160, 112, 21, 64);
    const len = this.host.animLength?.(sp.key, sp.anim) ?? 16;
    let state = 0, a = 16, b = 0;
    this.task(() => {
      switch (state) {
        case 0: if (p.update()) { sp.x = p.x; sp.y = p.y; } else state++; break;
        case 1: if (sp.t >= len) { sp.xlu = true; a = 16; b = 0; setBlend(this, a, b); state++; } break;
        case 2: if (a > 0) a--; if (b < 16) b++; this.blendA = a; this.blendB = b; if (a === 0) state++; break;
        default: this.extra.delete(sp); return false;
      }
      sp.t++;
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 19 Taunt(hands): a beckoning hand fades in mid-screen and back out
  19(sp, v) {
    const hands = [sp];
    for (let i = 1; i < v[0]; i++) hands.push(this.newSprite(sp.mgr));
    const pSide = this.defender === 'p1';
    sp.anim = pSide ? (this.attacker === 'p1' ? 0 : 1) : (this.attacker === 'p2' ? 1 : 0);
    sp.x = 128; sp.y = 80;
    hands.forEach(h => (h.xlu = true));
    let a = 0, b = 15, frames = 0, state = 0;
    this.blendA = a; this.blendB = b;
    this.task(() => {
      if (state === 0) { if (a < 15) a++; if (b > 0) b--; this.blendA = a; this.blendB = b; if (++frames >= 45) state++; }
      else if (state === 1) { if (a > 0) a--; if (b < 15) b++; if (a === 0 && b === 15) state++; this.blendA = a; this.blendB = b; }
      else { hands.forEach(h => this.extra.delete(h)); return false; }
      hands.forEach(tick);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 20 Helping Hand(hands): pairs of hands clap together in the middle of the screen
  20(sp, v) {
    const hands = [sp];
    for (let i = 1; i < v[0]; i++) hands.push(this.newSprite(sp.mgr));
    const pos = [[80, 50], [180, 50], [80, 100], [180, 100], [80, 75], [180, 75]];
    const anims = [0, 0, 1, 1, 2, 3];
    hands.forEach((h, i) => { h.anim = anims[i] ?? 0; h.x = pos[i]?.[0] ?? 128; h.y = pos[i]?.[1] ?? 80; h.xlu = true; h.visible = i === 0 || i === 3; });
    if (hands[0]) hands[0].hflip = true;
    if (hands[3]) hands[3].hflip = true;
    const dests = [[[0x78, 0x50], [0x88, 0x50]], [[0x78, 0x50], [0x88, 0x50]], [[0x78, 0x50], [0x88, 0x50]], [[0x58, 0x50], [0xa8, 0x50]]];
    const frames = [5, 5, 5, 3], pairs = [[0, 3], [1, 2], [4, 5], [4, 5]];
    let a = 0, b = 15, state = 0, pair = 0, h1 = sp, h2 = sp;
    const p1 = new PosLerp(), p2 = new PosLerp();
    this.blendA = a; this.blendB = b;
    this.task(() => {
      let animsDone = false;
      switch (state) {
        case 0: if (a < 15) a++; if (b > 0) b--; if (a === 15 && b === 0) state++; this.blendA = a; this.blendB = b; break;
        case 1:
          h1 = hands[pairs[pair][0]] ?? sp; h2 = hands[pairs[pair][1]] ?? sp; h1.visible = true; h2.visible = true;
          p1.init(h1.x, dests[pair][0][0], h1.y, dests[pair][0][1], frames[pair]);
          p2.init(h2.x, dests[pair][1][0], h2.y, dests[pair][1][1], frames[pair]);
          pair++; state++;
          break;
        case 2: {
          let done = 0;
          if (p1.update()) { h1.x = p1.x; h1.y = p1.y; } else done++;
          if (p2.update()) { h2.x = p2.x; h2.y = p2.y; } else done++;
          if (done >= 2) { if (pair <= 3) { h1.visible = false; h2.visible = false; state--; } else state++; }
          break;
        }
        case 3:
          if (a > 0) a--; if (b < 15) b++;
          if (b >= 7) animsDone = true;
          if (a === 0 && b === 15) state++;
          this.blendA = a; this.blendB = b;
          break;
        default: hands.forEach(h => this.extra.delete(h)); return false;
      }
      if (state < 3 && !animsDone) hands.forEach(tick);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 21 Assist: twelve paw prints pop up around the screen, then scatter off to the edges
  21(sp) {
    const offs = [[40, 30], [93, 30], [146, 30], [40, 80], [93, 80], [146, 80]];
    const dests = [[0, 0], [128, 0], [256, 0], [0, 170], [128, 170], [256, 170]];
    setBlend(this, -1, -1);
    type Paw = { s: OamSprite; state: number; step: number; delay: number; dest: number; scale: number; pos: PosLerp; outer: number };
    const paws: Paw[] = Array.from({ length: 12 }, (_, i) => {
      const s = i === 0 ? sp : this.newSprite(sp.mgr);
      const o = offs[i % 6];
      s.x = o[0] + (lcrng() % 53); s.y = o[1] + (lcrng() % 50); s.visible = false;
      return { s, state: 0, step: 0, delay: 10 + (lcrng() % 10) + i, dest: lcrng() % 6, scale: 1, pos: new PosLerp(), outer: 0 };
    });
    const updPaw = (p: Paw) => {
      switch (p.state) {
        case 0: if (--p.delay <= 10) p.state++; break;
        case 1: if (++p.step >= 3) { p.s.visible = true; p.step = 0; p.state++; } break;
        case 2: if (++p.step <= 3) { p.scale += 0.1; p.s.scaleX = p.s.scaleY = p.scale; } else { p.step = 0; p.state++; } break;
        case 3: if (++p.step <= 3) { p.scale -= 0.1; p.s.scaleX = p.s.scaleY = p.scale; } else { p.step = 0; p.state++; } break;
        case 4: if (--p.delay <= 10) { p.outer = 1; p.step = 0; p.state++; } break;
        case 5: if (++p.step > 30) { p.step = 0; p.state++; } else if (p.outer === 2) p.state++; break;
        case 6: p.pos.init(p.s.x, dests[p.dest][0], p.s.y, dests[p.dest][1], 10 + (lcrng() % 10)); p.state++; break;
        case 7: if (p.pos.update()) { p.s.x = p.pos.x; p.s.y = p.pos.y; } else { p.s.visible = false; p.state++; p.outer = 3; } break;
        default: p.outer = 3;
      }
      p.s.t++;
    };
    let state = 0;
    this.task(() => {
      paws.forEach(updPaw);
      if (state === 0) { if (paws.every(p => p.outer === 1)) state++; }
      else if (state === 1) { paws.forEach(p => (p.outer = 2)); state++; }
      else if (state === 2) { if (paws.every(p => p.outer === 3)) state++; }
      else { paws.forEach(p => this.extra.delete(p.s)); return false; }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 22 Metal Claw: two pairs of claws slash; the right pair starts 10 frames later
  22(sp) {
    const claws = [sp, this.newSprite(sp.mgr), this.newSprite(sp.mgr), this.newSprite(sp.mgr)];
    const offs = [[-32, 0], [-32, 32], [32, 0], [32, 32]];
    claws.forEach((c, i) => { c.x = sp.x + offs[i][0]; c.y = sp.y + offs[i][1]; });
    claws[0].hflip = true; claws[1].hflip = true;
    const counters = [0, 0, 0, 0];
    let rightDelay = 10;
    this.task(() => {
      if (rightDelay <= 0) { for (const c of [claws[2], claws[3]]) if (c.visible) c.t++; } else rightDelay--;
      for (const c of [claws[0], claws[1]]) if (c.visible) c.t++;
      let done = 0;
      claws.forEach((c, i) => { if (++counters[i] >= 40) { c.visible = false; done++; } });
      if (done === 4) { claws.forEach(c => this.extra.delete(c)); return false; }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 23 Ingrain: four vines sprout around the attacker's feet, flash white three times and fade
  23(sp) {
    const atk = this.attacker, fx = this.fx[atk];
    const vines = [sp, this.newSprite(sp.mgr), this.newSprite(sp.mgr), this.newSprite(sp.mgr)];
    const delays = [0, ...[1, 2, 3].map(i => (lcrng() % 4) + i * 5)];
    vines[1].hflip = true; vines[2].hflip = true;
    const vy = atk === 'p1' ? 140 : 84;
    const offs = [[-32, 0], [40, 4], [32, 0], [-40, 4]]; // LL, UR, LR, UL
    vines.forEach((v, i) => { v.x = fx.x + offs[i][0]; v.y = vy + offs[i][1]; });
    const front = atk === 'p1' ? [1, 3] : [0, 2];
    vines.forEach((v, i) => { v.order = front.includes(i) ? 18 : 10; });
    let bgA = 15, spA = 0;
    const flash = (from: number, to: number) => {
      let f = from;
      this.sysTask(() => { vines.forEach(v => { v.fadeColor = COLOR_WHITE; v.fadeAmt = f; }); if (f === to) return false; f = from < to ? Math.min(to, f + 2) : Math.max(to, f - 2); return true; });
    };
    this.task(() => {
      vines.forEach((v, i) => { if (++delays[i] >= 20 && v.visible) v.t++; });
      const d = delays[0];
      if (d === 50 || d === 70 || d === 90) flash(0, 14);
      if (d === 60 || d === 80 || d === 100) flash(14, 0);
      if (d === 110) { setBlend(this, -1, -1); vines.forEach(v => (v.xlu = true)); bgA = 15; spA = 0; }
      if (d >= 110) {
        if (bgA > 0) bgA--;
        if (spA < 15) spA++;
        this.blendA = bgA; this.blendB = spA;
        if (bgA === 0 && spA === 15) { vines.forEach(v => this.extra.delete(v)); return false; }
      }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 24 Frenzy Plant: eight roots spread from attacker to defender, sprouting in turn, gone after 160 frames
  24(sp) {
    const roots = [sp];
    for (let i = 1; i < 8; i++) { const r = this.newSprite(sp.mgr); if (i % 2) r.hflip = true; roots.push(r); }
    const a = this.fx[this.attacker], d = this.fx[this.defender];
    const p = new PosLerp(a.x, d.x, a.y, d.y, 20);
    let frame = 0, idx = 0, skip = this.attacker === 'p2', on = true;
    do {
      on = p.update();
      if (frame % 2) { if (!skip) { if (idx < 8) { roots[idx].x = p.x; roots[idx].y = p.y; idx++; } } else skip = false; }
      frame++;
    } while (on);
    const life = roots.map((r, i) => { r.prio = 2; r.order = 8 - i; return (8 - i) * 4; });
    this.task(() => {
      let gone = 0;
      roots.forEach((r, i) => {
        life[i]++;
        if (life[i] < 32) return;
        if (r.visible) r.t++;
        if (life[i] >= 160) { r.visible = false; gone++; }
      });
      if (gone === 8) { roots.forEach(r => this.extra.delete(r)); return false; }
      this.drawMgr(sp.mgr);
      return true;
    });
  },
  // 17 Icicle Spear(offX, offY, frames, arc): an icicle flies in an arc from attacker to defender, rotating
  17(sp, v) {
    const a = this.fx[this.attacker], d = this.fx[this.defender];
    let dir = dirX(this.attacker);
    const path = new Parabolic(a.x, d.x + v[0] * dir, a.y, d.y + v[1] * dir, v[2], v[3]);
    const angle = dir > 0 ? new ValueLerp(DEG(20) * dir, DEG(130) * dir, 10) : new ValueLerp(DEG(90) * dir, DEG(130) * dir, 10);
    sp.rot = angle.value & 0xffff;
    path.update(); sp.x = path.x; sp.y = path.y;
    tick(sp);
    this.task(() => {
      if (!path.update()) { this.extra.delete(sp); return false; }
      sp.x = path.x; sp.y = path.y;
      if (angle.update()) sp.rot = angle.value & 0xffff;
      tick(sp);
      this.drawMgr(sp.mgr);
      return true;
    });
  },
};
