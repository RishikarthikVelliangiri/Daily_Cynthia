// Port of Nintendo's SPL particle library as used by Gen 4 battle animations (pret pokeplatinum lib/spl).
// Resources come from the ROM's SPA files, parsed by tools/extract/anim.py (fixed-point already converted
// to floats: 1.0 = FX32_ONE). Angles stay in u16 "index" units (0x10000 = full turn).

export type Vec3 = [number, number, number];

export interface Behavior {
  type: 'gravity' | 'random' | 'magnet' | 'spin' | 'collision' | 'convergence';
  mag?: Vec3; interval?: number; target?: Vec3; force?: number; angle?: number; axis?: number;
  y?: number; elasticity?: number; kind?: number;
}
export interface SplResource {
  emissionType: number; drawType: number; circleAxis: number; hasRotation: number; randomInitAngle: number;
  selfMaintaining: number; followEmitter: number; polygonRotAxis: number; polygonReferencePlane: number;
  randomizeLoopedAnim: number; drawChildrenFirst: number; hideParent: number; useViewSpace: number;
  basePos: Vec3; emissionCount: number; radius: number; length: number; axis: Vec3; color: Vec3;
  initVelPos: number; initVelAxis: number; baseScale: number; aspect: number; startDelay: number;
  minRotation: number; maxRotation: number; initAngle: number; emitterLifeTime: number; particleLifeTime: number;
  attenScale: number; attenLife: number; attenVel: number; emissionInterval: number; baseAlpha: number;
  airResistance: number; texture: number; loopFrames: number; dbbScale: number; tileS: number; tileT: number;
  scaleAnimDir: number; dpolFaceEmitter: number; flipS: number; flipT: number; polygonX: number; polygonY: number;
  behaviors: Behavior[];
  scaleAnim?: { start: number; mid: number; end: number; in: number; out: number; loop: number };
  colorAnim?: { start: Vec3; end: Vec3; in: number; peak: number; out: number; randomStart: number; loop: number; interpolate: number };
  alphaAnim?: { start: number; mid: number; end: number; randomRange: number; loop: number; in: number; out: number };
  texAnim?: { textures: number[]; frameCount: number; step: number; randomizeInit: number; loop: number };
  child?: {
    usesBehaviors: number; hasScaleAnim: number; hasAlphaAnim: number; rotationType: number; followEmitter: number;
    useChildColor: number; drawType: number; randomInitVelMag: number; endScale: number; lifeTime: number;
    velocityRatio: number; scaleRatio: number; color: Vec3; emissionCount: number; emissionDelay: number;
    emissionInterval: number; texture: number; tileS: number; tileT: number; flipS: number; flipT: number;
  };
}
export interface TexMeta { x: number; w: number; h: number; repeat: number; flip: number }
export interface SplFile { resources: SplResource[]; textures: TexMeta[] }

// ------------------------------------------------------------------ random (SPLRandom_*)
let rngState = 0;
const next = () => (rngState = (Math.imul(rngState, 0x5eedf715) + 0x1b0cb173) >>> 0);
const u = (bits: number) => next() >>> (32 - bits);
const sfx = (bits: number) => (next() | 0) >> (32 - bits); // SPLRandom_FX32: signed
const rangeFx = (num: number) => (num * (u(9) - 256)) / 256; // [-num, num)
const scaledRange = (num: number, range: number) => (num * (255 - ((range * u(8)) >> 8))) / 256;
const doubleScaledRange = (num: number, range: number) => (num * (255 + range - ((range * u(8)) >> 7))) / 256;
function norm(v: Vec3): Vec3 {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 0];
}
const randVec = (): Vec3 => norm([sfx(24), sfx(24), sfx(24)]);
const randVecXY = (): Vec3 => norm([sfx(24), sfx(24), 0]);
export const seedSpl = (s: number) => { rngState = s >>> 0; };

export const sinIdx = (i: number) => Math.sin((i * Math.PI * 2) / 65536);
export const cosIdx = (i: number) => Math.cos((i * Math.PI * 2) / 65536);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const s16 = (v: number) => ((v & 0xffff) << 16) >> 16;

// ------------------------------------------------------------------ particles & emitters
export interface Particle {
  pos: Vec3; vel: Vec3; rotation: number; angVel: number; lifeTime: number; age: number;
  loopTimeFactor: number; lifeTimeFactor: number; texture: number; lifeRateOffset: number;
  baseAlpha: number; animAlpha: number; baseScale: number; animScale: number; color: Vec3; emitterPos: Vec3;
}

export class Emitter {
  particles: Particle[] = []; // index 0 = newest (SPL pushes to the front)
  children: Particle[] = [];
  terminate = false; emissionPaused = false; paused = false; renderingDisabled = false; started = false;
  pos: Vec3; vel: Vec3 = [0, 0, 0]; particleInitVel: Vec3 = [0, 0, 0];
  age = 0; axis: Vec3; initAngle: number; emissionCount: number; radius: number; length: number;
  initVelPos: number; initVelAxis: number; baseScale: number; particleLifeTime: number;
  color: Vec3 = [31, 31, 31]; collisionPlaneHeight: number | null = null;
  texS: number; texT: number; childTexS = 1; childTexT = 1;
  emissionInterval: number; baseAlpha: number; emissionFrac = 0;
  crossAxis1: Vec3 = [0, 0, 0]; crossAxis2: Vec3 = [0, 0, 0];

  constructor(readonly res: SplResource, pos: Vec3) {
    const h = res;
    this.pos = [pos[0] + h.basePos[0], pos[1] + h.basePos[1], pos[2] + h.basePos[2]];
    this.axis = [...h.axis];
    this.initAngle = h.initAngle; this.emissionCount = h.emissionCount; this.radius = h.radius; this.length = h.length;
    this.initVelPos = h.initVelPos; this.initVelAxis = h.initVelAxis; this.baseScale = h.baseScale;
    this.particleLifeTime = h.particleLifeTime; this.emissionInterval = h.emissionInterval; this.baseAlpha = h.baseAlpha;
    this.texS = (1 << h.tileS) * (h.flipS ? -1 : 1);
    this.texT = (1 << h.tileT) * (h.flipT ? -1 : 1);
    if (h.child) {
      this.childTexS = (1 << h.child.tileS) * (h.child.flipS ? -1 : 1);
      this.childTexT = (1 << h.child.tileT) * (h.child.flipT ? -1 : 1);
    }
  }

  /** SPLEmitter_SetPos* (positions are relative to the resource's base position). */
  setPos(p: Partial<Record<0 | 1 | 2, number>>) {
    for (const k of [0, 1, 2] as const) if (p[k] !== undefined) this.pos[k] = p[k]! + this.res.basePos[k];
  }

  private computeAxes() {
    let up: Vec3 = [0, 1, 0];
    let axis: Vec3;
    switch (this.res.circleAxis) {
      case 2: axis = [1, 0, 0]; break; // X
      case 1: axis = [0, 1, 0]; break; // Y
      case 0: axis = [0, 0, 1]; break; // Z
      default: axis = norm(this.axis);
    }
    const d = dot(up, axis);
    if (d === 1 || d === -1) up = [1, 0, 0];
    this.crossAxis1 = norm(cross(axis, up));
    this.crossAxis2 = norm(cross(axis, this.crossAxis1));
  }

  private tilt(p: Vec3): Vec3 {
    const n = norm(cross(this.crossAxis1, this.crossAxis2)), a = this.crossAxis1, b = this.crossAxis2;
    return [p[0] * a[0] + p[1] * b[0] + p[2] * n[0], p[0] * a[1] + p[1] * b[1] + p[2] * n[1], p[0] * a[2] + p[1] * b[2] + p[2] * n[2]];
  }

  emit() {
    const h = this.res;
    const count = this.emissionCount + this.emissionFrac;
    const total = Math.floor(count);
    this.emissionFrac = count - total;
    if ([2, 3, 5, 6, 7, 8, 9].includes(h.emissionType)) this.computeAxes();
    for (let i = 0; i < total; i++) {
      let pos: Vec3 = [0, 0, 0], vel: Vec3 = [0, 0, 0];
      const r = this.radius;
      switch (h.emissionType) {
        case 0: break;
        case 1: { const v = randVec(); pos = [v[0] * r, v[1] * r, v[2] * r]; break; }
        case 2: { const v = randVecXY(); pos = this.tilt([v[0] * r, v[1] * r, 0]); break; }
        case 3: { const idx = Math.floor((i * 16 * 4096) / total); pos = this.tilt([sinIdx(idx) * r, cosIdx(idx) * r, 0]); break; }
        case 4: { const v = randVec(); pos = [v[0] * r * rangeFx(1), v[1] * r * rangeFx(1), v[2] * r * rangeFx(1)]; break; }
        case 5: { const v = randVecXY(); pos = this.tilt([v[0] * r * rangeFx(1), v[1] * r * rangeFx(1), 0]); break; }
        case 8: case 9: {
          const v = randVec(), upv = cross(this.crossAxis1, this.crossAxis2);
          const d = dot(upv, v);
          const flip = h.emissionType === 8 ? d <= 0 : d < 0;
          const w: Vec3 = flip ? [-v[0], -v[1], -v[2]] : v;
          pos = h.emissionType === 8 ? [w[0] * r, w[1] * r, w[2] * r]
            : [w[0] * r * (rangeFx(1) / 2 + 0.5), w[1] * r * (rangeFx(1) / 2 + 0.5), w[2] * r * (rangeFx(1) / 2 + 0.5)];
          break;
        }
        case 6: { vel = randVecXY(); pos = this.tilt([vel[0] * r, vel[1] * r, rangeFx(this.length)]); break; }
        case 7: { vel = randVecXY(); pos = this.tilt([vel[0] * r * rangeFx(1), vel[1] * r * rangeFx(1), rangeFx(this.length)]); break; }
      }
      const magPos = doubleScaledRange(this.initVelPos, h.attenVel);
      const magAxis = doubleScaledRange(this.initVelAxis, h.attenVel);
      let pn: Vec3;
      if (h.emissionType === 6) {
        const a = this.crossAxis1, b = this.crossAxis2;
        pn = norm([vel[0] * a[0] + vel[1] * b[0], vel[0] * a[1] + vel[1] * b[1], vel[0] * a[2] + vel[1] * b[2]]);
      } else if (pos[0] === 0 && pos[1] === 0 && pos[2] === 0) pn = randVec();
      else pn = norm(pos);
      const v: Vec3 = [0, 1, 2].map(k => pn[k] * magPos + this.axis[k] * magAxis + this.particleInitVel[k]) as Vec3;
      let color: Vec3 = [...h.color];
      if (h.colorAnim?.randomStart) color = [[...h.colorAnim.start], [...h.color], [...h.colorAnim.end]][u(12) % 3] as Vec3;
      const p: Particle = {
        pos, vel: v, emitterPos: [...this.pos], baseScale: doubleScaledRange(this.baseScale, h.attenScale), animScale: 1,
        color, baseAlpha: this.baseAlpha, animAlpha: 31,
        rotation: h.randomInitAngle ? u(32) & 0xffff : this.initAngle,
        angVel: h.hasRotation ? s16(Math.floor(h.minRotation + ((h.maxRotation - h.minRotation) * u(12)) / 4096)) : 0,
        lifeTime: Math.floor(scaledRange(this.particleLifeTime, h.attenLife)) + 1, age: 0,
        texture: h.texAnim ? (h.texAnim.randomizeInit ? h.texAnim.textures[u(12) % h.texAnim.frameCount] : h.texAnim.textures[0]) : h.texture,
        loopTimeFactor: 0, lifeTimeFactor: 0, lifeRateOffset: h.randomizeLoopedAnim ? u(8) : 0,
      };
      p.loopTimeFactor = Math.floor(0xffff / (h.loopFrames || 1));
      p.lifeTimeFactor = Math.floor(0xffff / p.lifeTime);
      this.particles.unshift(p);
    }
  }

  private emitChildren(p: Particle) {
    const c = this.res.child!;
    const velRatio = c.velocityRatio / 256;
    for (let i = 0; i < c.emissionCount; i++) {
      const parentScale = p.baseScale * p.animScale;
      this.children.unshift({
        pos: [...p.pos],
        vel: [0, 1, 2].map(k => p.vel[k] * velRatio + rangeFx(c.randomInitVelMag)) as Vec3,
        emitterPos: [...p.emitterPos], baseScale: (parentScale * (c.scaleRatio + 1)) / 64, animScale: 1,
        color: c.useChildColor ? [...c.color] : [...p.color],
        baseAlpha: (p.baseAlpha * (p.animAlpha + 1)) >> 5, animAlpha: 31,
        rotation: c.rotationType === 0 ? 0 : p.rotation, angVel: c.rotationType === 2 ? p.angVel : 0,
        lifeTime: c.lifeTime, age: 0, texture: c.texture,
        loopTimeFactor: Math.floor(0xffff / Math.max(1, p.lifeTime >> 1)), lifeTimeFactor: Math.floor(0xffff / p.lifeTime),
        lifeRateOffset: 0,
      });
    }
  }

  private applyBehaviors(p: Particle, acc: Vec3) {
    for (const b of this.res.behaviors) {
      switch (b.type) {
        case 'gravity': acc[0] += b.mag![0]; acc[1] += b.mag![1]; acc[2] += b.mag![2]; break;
        case 'random':
          if (p.age % (b.interval || 1) === 0) for (let k = 0; k < 3; k++) acc[k] += rangeFx(b.mag![k]);
          break;
        case 'magnet':
          for (let k = 0; k < 3; k++) acc[k] += b.force! * (b.target![k] - p.pos[k] - p.vel[k]);
          break;
        case 'spin': {
          const s = sinIdx(b.angle!), c = cosIdx(b.angle!), [x, y, z] = p.pos;
          if (b.axis === 0) p.pos = [x, y * c - z * s, y * s + z * c];
          else if (b.axis === 1) p.pos = [x * c + z * s, y, -x * s + z * c];
          else p.pos = [x * c - y * s, x * s + y * c, z];
          break;
        }
        case 'collision': {
          const y = this.collisionPlaneHeight ?? b.y!, ey = p.emitterPos[1];
          const crossed = (ey < y && ey + p.pos[1] > y) || (ey >= y && ey + p.pos[1] < y);
          if (crossed) {
            p.pos[1] = y - ey;
            if (b.kind === 0) p.age = p.lifeTime; else p.vel[1] = -p.vel[1] * b.elasticity!;
          }
          break;
        }
        case 'convergence':
          for (let k = 0; k < 3; k++) p.pos[k] += b.force! * (b.target![k] - p.pos[k]);
          break;
      }
    }
  }

  update() {
    const h = this.res, air = (h.airResistance + 384) / 512; // (air + FX32_CONST(0.09375)) >> 9
    if (h.emitterLifeTime === 0 || this.age < h.emitterLifeTime) {
      if (this.age % (this.emissionInterval || 1) === 0 && !this.terminate && !this.emissionPaused && this.started) this.emit();
    }
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const rateNoLoop = (p.lifeTimeFactor * p.age) >> 8 & 0xff;
      const rateLoop = (p.lifeRateOffset + ((p.loopTimeFactor * p.age) >> 8)) & 0xff;
      if (h.scaleAnim) animScale(p, h, h.scaleAnim.loop ? rateLoop : rateNoLoop);
      if (h.colorAnim && !h.colorAnim.randomStart) animColor(p, h, h.colorAnim.loop ? rateLoop : rateNoLoop);
      if (h.alphaAnim) animAlpha(p, h, h.alphaAnim.loop ? rateLoop : rateNoLoop);
      if (h.texAnim && !h.texAnim.randomizeInit) animTex(p, h, h.texAnim.loop ? rateLoop : rateNoLoop);
      const acc: Vec3 = [0, 0, 0];
      if (h.followEmitter) p.emitterPos = [...this.pos];
      this.applyBehaviors(p, acc);
      p.rotation = (p.rotation + p.angVel) & 0xffff;
      for (let k = 0; k < 3; k++) {
        p.vel[k] = p.vel[k] * air + acc[k];
        p.pos[k] += p.vel[k] + this.vel[k];
      }
      if (h.child) {
        const delay = (p.lifeTime * h.child.emissionDelay) / 256;
        const diff = p.age - delay;
        if (diff >= 0 && Math.floor(diff) % (h.child.emissionInterval || 1) === 0) this.emitChildren(p);
      }
      p.age++;
    }
    this.particles = this.particles.filter(p => p.age <= p.lifeTime);
    if (h.child) {
      const c = h.child;
      for (const p of this.children) {
        const rate = Math.floor((p.age << 8) / p.lifeTime) & 0xff;
        if (c.hasScaleAnim) p.animScale = c.endScale + ((c.endScale - 1) * (rate - 255)) / 255;
        if (c.hasAlphaAnim) p.animAlpha = Math.floor(((255 - rate) * 31) / 255);
        const acc: Vec3 = [0, 0, 0];
        if (c.followEmitter) p.emitterPos = [...this.pos];
        if (c.usesBehaviors) this.applyBehaviors(p, acc);
        p.rotation = (p.rotation + p.angVel) & 0xffff;
        for (let k = 0; k < 3; k++) {
          p.vel[k] = p.vel[k] * air + acc[k];
          p.pos[k] += p.vel[k] + this.vel[k];
        }
        p.age++;
      }
      this.children = this.children.filter(p => p.age <= p.lifeTime);
    }
    this.age++;
  }

  /** EMITTER_SHOULD_TERMINATE */
  get done() {
    const h = this.res;
    return ((h.selfMaintaining && h.emitterLifeTime !== 0 && this.started && this.age > h.emitterLifeTime) || this.terminate)
      && this.particles.length === 0 && this.children.length === 0;
  }

  /** IsEmitterActive (battle anim tasks): the oldest particle is still alive. */
  get active() {
    const last = this.particles[this.particles.length - 1];
    if (!last) return this.res.emitterLifeTime === 0 || this.age <= this.res.emitterLifeTime;
    return last.age !== last.lifeTime;
  }
}

function animScale(p: Particle, h: SplResource, rate: number) {
  const a = h.scaleAnim!;
  if (rate < a.in) p.animScale = a.start + (rate * (a.mid - a.start)) / a.in;
  else if (rate < a.out) p.animScale = a.mid;
  else p.animScale = a.end + ((rate - 255) * (a.end - a.mid)) / (255 - a.out || 1);
}
function animColor(p: Particle, h: SplResource, rate: number) {
  const a = h.colorAnim!;
  const lerp = (from: Vec3, to: Vec3, t: number, n: number): Vec3 => [0, 1, 2].map(k => from[k] + Math.trunc((t * (to[k] - from[k])) / n)) as Vec3;
  if (rate < a.in) p.color = [...a.start];
  else if (rate < a.peak) p.color = a.interpolate ? lerp(a.start, h.color, rate - a.in, a.peak - a.in) : [...h.color];
  else if (rate < a.out) p.color = a.interpolate ? lerp(h.color, a.end, rate - a.peak, a.out - a.peak) : [...a.end];
  else p.color = [...a.end];
}
function animAlpha(p: Particle, h: SplResource, rate: number) {
  const a = h.alphaAnim!;
  let v: number;
  if (rate < a.in) v = Math.trunc((rate * (a.mid - a.start)) / a.in) + a.start;
  else if (rate < a.out) v = a.mid;
  else v = Math.trunc(((rate - 255) * (a.end - a.mid)) / (255 - a.out || 1)) + a.end;
  p.animAlpha = Math.max(0, Math.min(31, Math.floor(scaledRange(v, a.randomRange))));
}
function animTex(p: Particle, h: SplResource, rate: number) {
  const a = h.texAnim!;
  for (let i = 0; i < a.frameCount; i++) if (rate < a.step * (i + 1)) { p.texture = a.textures[i]; return; }
}

// ------------------------------------------------------------------ camera + manager
export class Camera {
  pos: Vec3 = [0, 0, 4]; target: Vec3 = [0, 0, 0]; up: Vec3 = [0, 1, 0];
  distance = 4; angle: Vec3 = [0, 0, 0]; projection: 0 | 1 = 1; // 0 perspective, 1 orthographic (battle default)
  /** Camera_SetAngleAroundTarget */
  setAngle(a: Vec3) {
    this.angle = a;
    const ax = a[0] & 0xffff, ay = a[1] & 0xffff;
    this.pos = [
      sinIdx(ay) * this.distance * cosIdx(ax) + this.target[0],
      sinIdx((-ax) & 0xffff) * this.distance + this.target[1],
      cosIdx(ay) * this.distance * cosIdx(ax) + this.target[2],
    ];
  }
  /** World -> view basis (right, up, back), NNS lookAt. */
  basis(): [Vec3, Vec3, Vec3] {
    const z = norm([this.pos[0] - this.target[0], this.pos[1] - this.target[1], this.pos[2] - this.target[2]]);
    const x = norm(cross(this.up, z));
    return [x, cross(z, x), z];
  }
}

export interface Quad { tex: number; x: number[]; y: number[]; u: number[]; v: number[]; rgb: Vec3; alpha: number }

export class SplManager {
  emitters: Emitter[] = []; // index 0 = newest
  camera = new Camera();
  constructor(readonly file: SplFile) {}

  create(resourceId: number, pos: Vec3 = [0, 0, 0], init?: (e: Emitter) => void): Emitter {
    const e = new Emitter(this.file.resources[resourceId], pos);
    init?.(e);
    this.emitters.unshift(e);
    return e;
  }
  remove(e: Emitter) { this.emitters = this.emitters.filter(x => x !== e); }

  update() {
    for (const e of [...this.emitters]) {
      if (!e.started && e.age >= e.res.startDelay) { e.started = true; e.age = 0; }
      if (!e.paused) e.update();
      if (e.done) this.remove(e);
    }
  }

  /** Builds screen-space quads (DS pixels) in SPL draw order. */
  draw(out: Quad[]) {
    const [bx, by, bz] = this.camera.basis(), cam = this.camera;
    const view = (p: Vec3): Vec3 => {
      const d: Vec3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
      return [dot(d, bx), dot(d, by), dot(d, bz)];
    };
    const project = (x: number, y: number, z: number): [number, number] => {
      if (cam.projection === 1) return [128 + (x / (cam.distance * 4 / 3)) * 128, 96 - (y / cam.distance) * 96];
      const w = Math.max(1e-3, -z);
      return [128 + (x / (w * 4 / 3)) * 128, 96 - (y / w) * 96];
    };
    for (const e of this.emitters) {
      if (e.renderingDisabled) continue;
      const h = e.res;
      const parents = () => { if (!h.hideParent) for (const p of e.particles) this.quad(out, e, p, false, view, project, bx, by, bz); };
      const children = () => { if (h.child) for (const p of e.children) this.quad(out, e, p, true, view, project, bx, by, bz); };
      if (h.drawChildrenFirst) { children(); parents(); } else { parents(); children(); }
    }
  }

  private quad(out: Quad[], e: Emitter, p: Particle, child: boolean, view: (p: Vec3) => Vec3,
    project: (x: number, y: number, z: number) => [number, number], bx: Vec3, by: Vec3, bz: Vec3) {
    const h = e.res;
    const alpha = (p.baseAlpha * (p.animAlpha + 1)) >> 5;
    if (alpha <= 0) return;
    let sy = p.baseScale, sx = sy * h.aspect;
    if (h.scaleAnimDir === 0) { sx *= p.animScale; sy *= p.animScale; } else if (h.scaleAnimDir === 1) sx *= p.animScale; else sy *= p.animScale;
    const world: Vec3 = [p.pos[0] + p.emitterPos[0], p.pos[1] + p.emitterPos[1], p.pos[2] + p.emitterPos[2]];
    let t: Vec3;
    if (h.useViewSpace) {
      const v = view([world[0] - h.basePos[0], world[1] - h.basePos[1], world[2] - h.basePos[2]]);
      t = [v[0] + h.basePos[0], v[1] + h.basePos[1], v[2] + h.basePos[2]];
    } else t = view(world);
    const drawType = child ? h.child!.drawType : h.drawType;
    let ax: [number, number], ay: [number, number]; // view-space images of the quad's local x and y axes
    if (drawType === 1 || drawType === 3) { // directional billboard (polygons drawn the same way here)
      let d = cross(p.vel, bz);
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) return;
      d = norm(d);
      const dv: Vec3 = [dot(d, bx), dot(d, by), dot(d, bz)];
      const vd = norm(p.vel);
      const k = Math.abs(dot(vd, [-bz[0], -bz[1], -bz[2]]));
      const dy = sy * ((1 - k) * (h.dbbScale / 4096) + 1);
      ax = [dv[0] * sx, dv[1] * sx]; ay = [-dv[1] * dy, dv[0] * dy];
    } else {
      const s = sinIdx(p.rotation), c = cosIdx(p.rotation);
      ax = [c * sx, s * sx]; ay = [-s * sy, c * sy];
    }
    const px = child ? 0 : h.polygonX, py = child ? 0 : h.polygonY;
    const corners: [number, number][] = [[px - 1, py + 1], [px + 1, py + 1], [px + 1, py - 1], [px - 1, py - 1]];
    const xs: number[] = [], ys: number[] = [];
    for (const [vx, vy] of corners) {
      const [X, Y] = project(t[0] + vx * ax[0] + vy * ay[0], t[1] + vx * ax[1] + vy * ay[1], t[2]);
      xs.push(X); ys.push(Y);
    }
    const S = child ? e.childTexS : e.texS, T = child ? e.childTexT : e.texT;
    out.push({
      tex: child ? h.child!.texture : p.texture, x: xs, y: ys, u: [0, S, S, 0], v: [0, 0, T, T],
      rgb: [0, 1, 2].map(k => (p.color[k] * e.color[k]) / 32 / 31) as Vec3, alpha: alpha / 31,
    });
  }
}
