// Transform contexts used by the battle animation script functions, ported from pret pokeplatinum
// src/battle_anim/battle_anim_helpers.c (fx32 = 1/4096 fixed point, angles 0..65535).
import { cosIdx, sinIdx } from './spl';

export type Side = 'p1' | 'p2';
export const FX = 4096;
export const DEFAULT_POS: Record<Side, [number, number]> = { p1: [64, 112], p2: [192, 48] }; // BATTLER_POS_SOLO_*
export const DEG = (d: number) => Math.trunc((0xffff * d) / 360);
const sin = (i: number) => Math.round(sinIdx(i) * FX), cos = (i: number) => Math.round(cosIdx(i) * FX);
const fxMul = (a: number, b: number) => Math.round((a * b) / FX); // FX_Mul rounds
/** BattleAnimMath_GetStepSize for integer start/end: fx32 step. */
export const stepSize = (start: number, end: number, steps: number) => (steps ? Math.trunc(((end - start) * FX) / steps) : 0);

/** XYTransformContext as a position lerp (PosLerpContext). */
export class PosLerp {
  x = 0; y = 0; steps = 0; private cx = 0; private cy = 0; private dx = 0; private dy = 0;
  constructor(sx = 0, ex = 0, sy = 0, ey = 0, steps = 0) { this.init(sx, ex, sy, ey, steps); }
  init(sx: number, ex: number, sy: number, ey: number, steps: number) {
    this.x = sx; this.y = sy; this.steps = Math.max(0, steps);
    this.dx = stepSize(sx, ex, steps); this.dy = stepSize(sy, ey, steps);
    this.cx = sx * FX; this.cy = sy * FX;
    return this;
  }
  update(): boolean {
    if (!this.steps) return false;
    this.cx += this.dx; this.cy += this.dy;
    this.x = this.cx >> 12; this.y = this.cy >> 12;
    this.steps--;
    return true;
  }
}

/** ScaleLerpContext: x/y are MON_AFFINE_SCALE values (256 = 100%); curY is the fx32 scale for anchoring. */
export class ScaleLerp {
  x = 256; y = 256; steps = 0; curX = 256 * FX; curY = 256 * FX; private dx = 0; private dy = 0;
  static rel(scale: number, ref: number) { return Math.trunc((scale * 256) / ref); }
  init(start: number, ref: number, end: number, steps: number) {
    return this.initXY(start, end, start, end, ref, steps);
  }
  initXY(sx: number, ex: number, sy: number, ey: number, ref: number, steps: number) {
    const r = ScaleLerp.rel;
    this.steps = steps;
    this.dx = stepSize(r(sx, ref), r(ex, ref), steps); this.dy = stepSize(r(sy, ref), r(ey, ref), steps);
    this.x = r(sx, ref); this.y = r(sy, ref);
    this.curX = this.x * FX; this.curY = this.y * FX;
    return this;
  }
  update(): boolean {
    if (!this.steps) return false;
    this.steps--;
    this.curX += this.dx; this.curY += this.dy;
    this.x = this.curX >> 12; this.y = this.curY >> 12;
    return true;
  }
  get fx() { return this.x / 256; }
  get fy() { return this.y / 256; }
}

/** ShakeContext: +e, 0, -e, 0 ... switching every `interval` frames; 4 switches per `amount`. */
export class Shake {
  x = 0; y = 0; private counter: number; private cycle = 0; private remaining: number; private px: number; private py: number;
  constructor(ex: number, ey: number, private interval: number, amount: number) {
    this.counter = interval; this.remaining = amount; this.px = -ex; this.py = -ey;
  }
  update(): boolean {
    if (!this.remaining) return false;
    if (++this.counter >= this.interval) {
      this.counter = 0;
      let p = this.px; this.px = this.x; this.x = p === 0 ? 0 : -p;
      p = this.py; this.py = this.y; this.y = p === 0 ? 0 : -p;
      if (++this.cycle >= 4) { this.cycle = 0; this.remaining--; }
    }
    return true;
  }
}

/** RevolutionContext: x = sin(angleX) * rx, y = cos(angleY) * ry (radii in pixels). */
export class Revolution {
  x = 0; y = 0; steps: number; curX: number; private cy: number; stepX: number; private sy: number;
  constructor(sx: number, ex: number, sy: number, ey: number, private rx: number, private ry: number, steps: number) {
    this.steps = steps; this.curX = sx & 0xffff; this.cy = sy & 0xffff;
    this.stepX = steps ? Math.trunc(((ex & 0xffff) - (sx & 0xffff)) / steps) : 0;
    this.sy = steps ? Math.trunc(((ey & 0xffff) - (sy & 0xffff)) / steps) : 0;
  }
  /** RevolutionContext_InitWithStepSize: x advances by a fixed step; the step count follows from the range. */
  static withStepSize(sx: number, ex: number, sy: number, ey: number, rx: number, ry: number, step: number) {
    sx &= 0xffff; ex &= 0xffff;
    const st = sx > ex ? -step : step;
    const q = (ex - sx) / st;
    const steps = Math.abs(Math.trunc(q) + (q % 1 ? 1 : 0));
    const r = new Revolution(sx, ex, sy, ey, rx, ry, 1);
    r.steps = steps; r.stepX = st; r.sy = steps ? Math.trunc(((ey & 0xffff) - (sy & 0xffff)) / steps) : 0;
    return r;
  }
  update(): boolean {
    if (!this.steps) return false;
    this.curX = (this.curX + this.stepX) & 0xffff; this.cy = (this.cy + this.sy) & 0xffff;
    this.steps--;
    this.x = fxMul(sin(this.curX), this.rx * FX) >> 12;
    this.y = fxMul(cos(this.cy), this.ry * FX) >> 12;
    return true;
  }
}

/** XYTransformContext_InitParabolic: a linear move plus a half revolution of radius `arc` on y. */
export class Parabolic {
  readonly lin: PosLerp; private rev: Revolution;
  constructor(sx: number, ex: number, sy: number, ey: number, frames: number, arc: number) {
    this.lin = new PosLerp(sx, ex, sy, ey, frames);
    this.rev = new Revolution(0, 0, DEG(90), DEG(270), 0, arc, frames);
  }
  get x() { return this.lin.x; }
  get y() { return this.lin.y; }
  update(): boolean {
    const a = this.lin.update(), b = this.rev.update();
    this.lin.x += this.rev.x; this.lin.y += this.rev.y;
    return a || b;
  }
}

/** ValueLerpContext (integer step, Init/Update) */
export class ValueLerp {
  value: number; steps: number; private step: number;
  constructor(start: number, end: number, steps: number) { this.value = start; this.steps = steps; this.step = stepSize(start, end, steps) >> 12; }
  update(): boolean { if (!this.steps) return false; this.value += this.step; this.steps--; return true; }
}

/** ValueLerpContext_InitFX32 / UpdateFX32 */
export class ValueLerpFx {
  value: number; steps: number; private cur: number; private step: number;
  constructor(start: number, end: number, steps: number) { this.value = start; this.steps = steps; this.step = stepSize(start, end, steps); this.cur = start * FX; }
  update(): boolean { if (!this.steps) return false; this.cur += this.step; this.value = this.cur >> 12; this.steps--; return true; }
}

/** ValueLerpContext_InitSinusoidal: value = cos(angle) * amplitude (pixels) */
export class Sinusoid {
  value = 0; steps: number; private angle: number; private step: number;
  constructor(start: number, end: number, private amp: number, steps: number) { this.steps = steps; this.angle = start; this.step = Math.trunc((end - start) / steps); }
  update(): boolean {
    if (!this.steps) return false;
    this.angle = (this.angle + this.step) & 0xffff; this.steps--;
    this.value = fxMul(cos(this.angle), this.amp * FX) >> 12;
    return true;
  }
}

/** ScreenScrollManager_ScrollX: rows start..end get x += sine[(pos/100 + row - start) % 192] each frame
 * (the write buffer is refilled with the initial offsets every frame, so nothing accumulates). */
export class ScreenScrollX {
  private sine: number[] = [];
  private pos = 0;
  constructor(private start: number, private end: number, angleStep: number, amplitude: number, private speed: number) {
    for (let i = 0, a = 0; i < 192; i++, a = (a + angleStep) & 0xffff) this.sine.push(fxMul(sin(a), amplitude * FX) >> 12);
  }
  /** Offsets added to rows 0..191 this frame. */
  update(): number[] {
    const out = new Array<number>(192).fill(0);
    let p = Math.trunc(this.pos / 100);
    for (let i = this.start; i <= this.end && i < 192; i++) { out[i] = this.sine[p]; p = (p + 1) % 192; }
    this.pos += this.speed;
    if (this.pos >= 19200) this.pos %= 19200; else if (this.pos < 0) this.pos += 19200;
    return out;
  }
}

/** BattleAnimUtil_GetGroundAnchoredScaleOffset: y offset keeping a scaled 80px sprite on the ground. */
export function groundOffset(height: number, scaleYFx: number): number {
  const avail = (80 - height * 2) * FX;
  const rel = Math.trunc((fxMul(avail, scaleYFx) * FX) / (256 * FX));
  const diff = avail - rel;
  const ip = Math.trunc(diff / FX) * FX;
  let fr = diff - ip;
  if (fr) fr += FX / 2;
  return Math.trunc(((ip + fr) >> 12) / 2);
}

/** BattleAnimUtil_Set*AnchoredPosition: returns the new center y. */
export function anchoredY(y: number, height: number, scaleYFx: number, top = false) {
  let off = groundOffset(height, scaleYFx);
  if (top) { off = -off; y -= height; }
  return y + off;
}

/** BattleAnimUtil_StepValue: moves toward target; true once reached. */
export function stepValue(v: { n: number }, target: number, step: number): boolean {
  if (step < 0 ? v.n + step > target : v.n + step < target) { v.n += step; return false; }
  v.n = target;
  return true;
}

/** DS 2-target alpha blend (EVA, EVB in 0..16+) as a canvas alpha for the first target. */
export function blendAlpha(a: number, b: number) {
  const A = Math.max(0, Math.min(16, a)), B = Math.max(0, Math.min(16, b));
  return A + B ? A / (A + B) : 0;
}
