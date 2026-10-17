// Battle animation script interpreter: runs Diamond's move animation bytecode (wazaeffect/we.arc) frame by frame.
// Command semantics follow pret pokeplatinum src/battle_anim/battle_anim_system.c; Diamond's scripts use the same
// command set (all 501 scripts disassemble with it). Single battles only.
import { type Emitter, seedSpl, SplManager, type SplFile, type Quad, type Vec3, sinIdx, cosIdx } from './spl';
import { blendAlpha, DEFAULT_POS, type Side } from './helpers';
import { MORE_FUNCS, SPRITE_FUNCS } from './funcs';

export { DEFAULT_POS, type Side };
export const other = (s: Side): Side => (s === 'p1' ? 'p2' : 'p1');
const TYPE: Record<Side, number> = { p1: 0, p2: 1 }; // BATTLER_TYPE_SOLO_PLAYER / SOLO_ENEMY

/** Per-battler sprite state the scene applies while drawing (PokemonSprite attributes). */
export interface MonFx {
  x: number; y: number; scaleX: number; scaleY: number; // scale 256 = 100%
  rot: number; pivotX: number; pivotY: number; hide: boolean;
  fadeColor: number; fadeAmt: number; // GX RGB555 color, 0..16 blend toward it
  /** Per-screen-row x offsets (Extrasensory's scanline distortion), keyed by screen y. */
  rowShift?: Map<number, number> | null;
  /** PokemonSprite_StartFade running (PokemonSprite_IsFadeActive). */
  fading?: boolean;
  /** MON_SPRITE_PARTIAL_DRAW: only this part of the 80x80 frame is drawn (null = all). */
  partial?: { x: number; y: number; w: number; h: number } | null;
  /** MON_SPRITE_MOSAIC (Transform): pixel block size, 0 = off. */
  mosaic?: number;
  /** Stat-change overlay: bg/stat{img}.png scrolled over the silhouette, blended at `mix` (0..1). */
  stat?: { img: number; x: number; y: number; mix: number } | null;
  /** MON_SPRITE_ALPHA 0..31 (undefined = opaque). */
  alpha?: number;
}
export interface BgFx {
  x: number; y: number; fadeColor: number; fadeAmt: number; grayscale: boolean;
  /** Move-animation background (SwitchBg) drawn over the battle background, under platforms and sprites. */
  effect?: EffectBg | null;
  /** ScrollCustomBg / MuddyWater: a translucent move BG scrolled over the Pokémon and particles. */
  overlay?: EffectBg | null;
  /** LoadPokemonSpriteIntoBg copy on the base BG (Acid Armor, Spite): per-scanline BG offsets in DS screen space
   * (row r shows copy row r + oy[r], drawn at x = -ox[r]), blended at `mix`, darkened toward black by `dark`. */
  monBg?: { side: Side; ox: number[]; oy: number[]; mix: number; dark: number } | null;
}
export interface EffectBg {
  bg: number; reversed: boolean;
  mix: number; // 0..1 weight of the effect BG against the battle BG (DS alpha blend, clamped to 16)
  fadeColor: number; fadeAmt: number; // effect palette fade 0..16
  x: number; y: number; // scroll offset
  /** Per-scanline x scroll (HDMA: wave / ScrollSwitchedBg), replacing x for those rows (y scroll is 0 there). */
  rowX?: number[] | null;
  /** Window 0 (Fake Out): the effect BG shows only between these screen x (inclusive). */
  clip?: [number, number] | null;
}
/** Attributes shared by OAM sprites (ManagedSprite): center position, affine scale (1 = 100%) and rotation,
 * draw flag, XLU = blended by the global alpha registers, prio = BG priority (2+ draws behind the battlers),
 * order = sprite priority (lower is in front), palette fade toward a GX color. */
export interface ObjAttrs {
  x: number; y: number; scaleX: number; scaleY: number; rot: number; visible: boolean;
  xlu: boolean; alpha: number; prio: number; order: number; fadeColor: number; fadeAmt: number; hflip?: boolean;
}
/** OAM copies of battlers (pokemon sprite manager); tint = TintPalette gray tone (r, g, b out of 256). */
export interface MonCopy extends ObjAttrs { side: Side; tint: [number, number, number] | null; mosaic?: number }
/** A hardware sprite from wazaeffect/effectclact; key = "char_pltt_cell_anim" in anim/oam.json, t = anim frame timer. */
export interface OamSprite extends ObjAttrs { key: string; anim: number; t: number; mgr: number }
/** Sprite manager id of the pokemon sprite (copy) manager in `shown`. */
export const MON_MGR = -1;
const obj = (x: number, y: number): ObjAttrs => ({ x, y, scaleX: 1, scaleY: 1, rot: 0, visible: true, xlu: false, alpha: 1, prio: 1, order: 100, fadeColor: 0, fadeAmt: 0 });

export interface AnimData { scripts: number[][]; sub?: number[][]; world: Vec3[][]; axis: { playerToEnemy: Vec3; enemyToPlayer: Vec3 }[] }
/** Common animations (wazaeffect/we_sub.narc, order of pret anim_subscripts.order). */
export const SUB = {
  sleep: 1, poison: 2, burn: 3, freeze: 4, paralysis: 5, confusion: 6, infatuation: 7, heldItem: 10, statUp: 12, statDown: 13,
  heal: 14, rain: 19, hail: 20, sandstorm: 21, sun: 22, curse: 30, nightmare: 31, leechSeed: 32, bind: 33, wrap: 34,
  fireSpin: 35, magmaStorm: 36, clamp: 37, whirlpool: 38, sandTomb: 39, ingrain: 40,
} as const;
export interface ParticleAsset { file: SplFile; sheet: HTMLImageElement }

export interface AnimHost {
  loadParticles(id: number): Promise<ParticleAsset>;
  playSe(seq: number, pan: number): void;
  playCry(side: Side): void;
  seActive(): boolean;
  /** MON_SPRITE_SHADOW_HEIGHT-like offset used to anchor scaling to the ground. */
  groundHeight(side: Side): number;
  /** Frames one pass of an effect sprite's cell animation takes (Sprite_IsAnimated for one-shot anims). */
  animLength?(key: string, anim: number): number;
}

export interface ActiveSystem { mgr: SplManager; asset: ParticleAsset }

type Task = () => boolean; // returns false when done
const FX = 4096;
const BEHAVIOR_TYPES: Record<number, string> = { 1: 'gravity', 4: 'magnet', 5: 'magnet', 6: 'spin', 7: 'spin', 12: 'convergence', 13: 'convergence' };

export function freshFx(side: Side): MonFx {
  const [x, y] = DEFAULT_POS[side];
  return { x, y, scaleX: 256, scaleY: 256, rot: 0, pivotX: 0, pivotY: 0, hide: false, fadeColor: 0, fadeAmt: 0 };
}

export class MoveAnimation {
  private w: number[] = [];
  private pc = 0;
  private delay = 0;
  private waiting = false; // BattleAnimScript_WaitForDelay is the active executor
  private endFrames = 0;
  private seWait = 0;
  private vars = new Array<number>(10).fill(0);
  private loops: { start: number; cur: number; max: number }[] = [];
  private calls: number[] = [];
  private tasks: Task[] = [];
  private soundTasks: Task[] = [];
  private bgTasks: Task[] = [];
  private bgState: 0 | 1 | 2 = 0; // BATTLE_BG_SWITCH_STATE_NONE / RUNNING / PARTIAL
  private bgMove: { stepX: number; stepY: number; on: boolean } | null = null;
  readonly systems: (ActiveSystem | null)[] = [null, null, null, null];
  emitters: (Emitter | null)[] = new Array(10).fill(null);
  private currentPs = 0;
  private projections = [1, 1, 1, 1];
  private flips = [0, 0, 0, 0];
  private pending: Promise<void> | null = null;
  readonly copies = new Map<number, MonCopy>();
  readonly sprites = new Map<number, OamSprite>();
  /** Sprites made by sprite functions (AddSpriteWithFunc) and their extra copies. */
  readonly extra = new Set<OamSprite>();
  /** Global alpha blend registers (G2_SetBlendAlpha EVA/EVB) used by XLU sprites. */
  blendA = 16; blendB = 0;
  /** Sprite managers drawn (SpriteSystem_DrawSprites) during the last finished frame; MON_MGR = pokemon sprites. */
  shown = new Set<number>();
  private drawing = new Set<number>();
  private monDrawTask = false;
  lastTemplate: number[] = [];
  /** Move power (Magnitude's shake strength). */
  power = 0;
  done = false;
  frame = 0;
  get loading() { return this.pending !== null; }
  /** Why the script stopped early (unknown opcode / timeout); empty when it reached End. */
  aborted = '';

  /** move: a move id, or { sub } for a common animation (status, stat change, weather...). */
  constructor(private data: AnimData, readonly host: AnimHost, readonly move: number | { sub: number }, readonly attacker: Side,
    readonly fx: Record<Side, MonFx>, readonly bg: BgFx, private effectChance = 0, target?: Side) {
    this.w = (typeof move === 'number' ? data.scripts[move] : data.sub?.[move.sub]) ?? [];
    this.target = target ?? other(attacker);
    seedSpl(((typeof move === 'number' ? move : 1000 + move.sub) * 2654435761) >>> 0);
    if (!this.w.length) this.done = true;
  }

  private target: Side;
  get defender(): Side { return this.target; }
  alpha(o: ObjAttrs) { return o.xlu ? blendAlpha(this.blendA, this.blendB) : o.alpha; }
  /** SpriteSystem_DrawSprites(manager) for this frame. */
  drawMgr(mgr: number) { this.drawing.add(mgr); }
  /** A new effect sprite from a template (char, pltt, cell, anim members), at the defender like AddSprite. */
  newSprite(mgr: number, t = this.lastTemplate): OamSprite {
    const [x, y] = DEFAULT_POS[this.defender];
    const sp: OamSprite = { ...obj(x, y), key: `${t[0]}_${t[1]}_${t[2]}_${t[3]}`, anim: 0, t: 0, mgr };
    this.extra.add(sp);
    return sp;
  }
  /** A pokemon sprite copy of a battler (AddPokemonSprite) at its position; hidden if the battler is. */
  newCopy(side: Side): MonCopy {
    const f = this.fx[side];
    return { ...obj(f.x, f.y), side, tint: null, visible: !f.hide };
  }
  /** Script variables of the current CallFunc / AddSpriteWithFunc. */
  get scriptVars() { return this.vars; }
  private side(role: number): Side | null {
    // BATTLER_ROLE_*: attacker, defender, (partners), player 1, enemy 1, (player 2, enemy 2)
    return role === 0 ? this.attacker : role === 1 ? this.defender : role === 4 ? 'p1' : role === 5 ? 'p2' : null;
  }
  private dirX(side: Side) { return side === 'p2' ? -1 : 1; } // BattleAnimUtil_GetTransformDirectionX
  ps() { return this.systems[this.currentPs]; }
  ground(side: Side) { return this.host.groundHeight(side); }
  world(side: Side, kind = 0): Vec3 {
    const proj = this.ps()?.mgr.camera.projection ?? 1;
    return [...this.data.world[TYPE[side]][kind * 2 + proj]] as Vec3;
  }

  /** Advance one game frame (30 Hz on DP). */
  step(): void {
    if (this.done || this.pending) return; // particle resource still loading (the DS waits 2 frames for VRAM upload)
    this.frame++;
    this.drawing = new Set();
    if (this.waiting) {
      if (this.delay === 0) this.waiting = false; else this.delay--;
    } else {
      let guard = 0;
      do { this.exec(); } while (this.delay === 0 && !this.done && !this.waiting && !this.pending && ++guard < 2000);
    }
    this.sysTasks = this.sysTasks.filter(t => t());
    this.tasks = this.tasks.filter(t => t());
    this.soundTasks = this.soundTasks.filter(t => t());
    this.bgTasks = this.bgTasks.filter(t => t());
    if (this.monDrawTask) this.drawing.add(MON_MGR);
    this.shown = this.drawing;
    const eff = this.bg.effect;
    if (eff && this.bgMove?.on) { eff.x += this.bgMove.stepX; eff.y += this.bgMove.stepY; }
    for (const s of this.systems) s?.mgr.update();
    if (this.frame > 30 * 40) { this.aborted = 'timeout'; this.finish(); } // safety net: never hang the battle
  }

  /** Screen-space particle quads for the current frame, one batch per particle system. */
  quads(): { quads: Quad[]; sys: ActiveSystem }[] {
    const out: { quads: Quad[]; sys: ActiveSystem }[] = [];
    for (const s of this.systems) if (s) { const q: Quad[] = []; s.mgr.draw(q); out.push({ quads: q, sys: s }); }
    return out;
  }

  private finish() {
    this.bg.effect = null; this.bg.overlay = null; this.bg.monBg = null; this.bgTasks = []; this.sprites.clear(); this.extra.clear(); this.copies.clear();
    this.shown = new Set();
    this.done = true;
    for (let i = 0; i < 4; i++) this.systems[i] = null;
    this.tasks = []; this.soundTasks = []; this.sysTasks = [];
  }

  private rd() { return this.w[this.pc++] ?? 4; }

  private extraParams(count: number): number[] {
    // BattleAnimSystem_GetExtraParams: skips the SetExtraParams opcode, checks the count.
    this.pc++;
    const n = this.rd();
    const p = this.w.slice(this.pc, this.pc + n);
    this.pc += n;
    if (n !== count) return new Array(count).fill(0);
    return p;
  }

  private exec() {
    const op = this.rd();
    switch (op) {
      case 0: this.delay = this.rd(); this.waiting = true; break; // Delay
      case 1: // WaitForAnimTasks
        if (this.tasks.length) { this.pc--; this.delay = 1; } else this.delay = 0;
        break;
      case 2: this.loops.push({ max: this.rd() & 0xff, cur: 0, start: 0 }); this.loops[this.loops.length - 1].start = this.pc; break;
      case 3: { // EndLoop
        const l = this.loops[this.loops.length - 1];
        if (l) { if (++l.cur === l.max) this.loops.pop(); else this.pc = l.start; }
        break;
      }
      case 4: this.end(); break;
      case 5: this.host.playSe(this.rd(), 0); break;
      case 8: this.pc += 2; break; // SetBg0Bg1AlphaBlending (no BG1 effects here)
      case 12: { const id = this.rd(), val = this.rd(); if (id < 10) this.vars[id] = val; break; }
      case 9: case 56: case 59: case 67: case 84: break;
      case 19: // WaitForPartialBgSwitch
        if (this.bgState === 2) this.delay = 0; else { this.pc--; this.delay = 1; }
        break;
      case 20: // WaitForBgSwitch
        if (this.bgState === 0) this.delay = 0; else { this.pc--; this.delay = 1; }
        break;
      case 16: case 18: { // SwitchBg / RestoreBg bgID, mode | flags << 16
        const bgId = this.rd(), param = this.rd();
        this.bgSwitch(bgId, (param & 0xffff) + (op === 18 ? 3 : 0), param >>> 16);
        break;
      }
      case 17: { // SetBgSwitchVar
        const v = this.rd(), val = (this.rd() << 16) >> 16;
        if (this.bgMove) { if (v === 0) this.bgMove.stepX = val; else if (v === 1) this.bgMove.stepY = val; }
        if (this.bg.effect && (v === 2 || v === 3)) this.bg.effect.x = val; // pret: START_Y writes offsetX too
        break;
      }
      case 34: { // SwitchBgEx playerAttackBg, enemyAttackBg, contestBg
        const a = this.rd(), b = this.rd(); this.rd();
        this.bgSwitch(this.defender === 'p1' ? b : a, 0, 0);
        break;
      }
      case 10: { const at = this.pc; this.calls.push(at + 1); this.pc = at + this.w[at]; break; }
      case 11: this.pc = this.calls.pop() ?? this.pc; break;
      case 13: { // JumpIfEffectChanceOdd
        const at = this.pc + (this.effectChance & 1 ? 1 : 0);
        this.pc = at + this.w[at];
        break;
      }
      case 14: { const chance = this.rd(); if (chance === this.effectChance) this.pc += this.w[this.pc]; else this.pc++; break; }
      case 15: { const at = this.pc; this.pc = at + this.w[at]; break; }
      case 31: this.pc += 2; break; // LoadPokemonSpriteIntoBg
      case 21: case 23: case 32: case 33: case 44: case 53: case 57: case 60: case 61: case 66: case 68: case 69: case 71: case 72: case 80: case 83: {
        const a = this.rd();
        if (op === 53) this.systems[a] = null; // UnloadParticleSystem
        if (op === 60) this.copies.delete(a); // RemovePokemonSprite
        if (op === 80) { // FreeSpriteManager
          for (const [k, sp] of this.sprites) if (sp.mgr === a) this.sprites.delete(k);
          for (const sp of this.extra) if (sp.mgr === a) this.extra.delete(sp);
        }
        if (op === 83) this.monDrawTask = false; // StopPokemonSpriteDrawTask
        break;
      }
      case 22: { const seq = this.rd(), pan = this.rd(); this.host.playSe(seq, this.pan(pan)); break; }
      case 24: case 35: case 36: { // moving sound: play now, pan from start to end
        const seq = this.rd(), start = this.pan(this.rd()); this.pc += 3;
        this.host.playSe(seq, start);
        break;
      }
      case 25: { // PlayLoopedSoundEffect
        const seq = this.rd(), pan = this.pan(this.rd()), interval = this.rd() & 0xff;
        let repeat = this.rd() & 0xff, tick = interval;
        this.soundTasks.push(() => {
          if (tick++ < interval) return true;
          tick = 0; repeat--;
          this.host.playSe(seq, pan);
          return repeat > 0;
        });
        break;
      }
      case 26: { // PlayDelayedSoundEffect
        const seq = this.rd(), pan = this.pan(this.rd());
        let wait = this.rd() & 0xff;
        this.soundTasks.push(() => {
          if (wait-- === 0) { this.host.playSe(seq, pan); return false; }
          return true;
        });
        break;
      }
      case 29: // WaitForSoundEffects
        if (this.soundTasks.length || (this.host.seActive() && this.seWait++ < 90)) { this.pc--; this.delay = 1; } else { this.seWait = 0; this.delay = 0; }
        break;
      case 30: this.pc += 3; break; // JumpIfEqual (unused by Diamond's move scripts)
      case 45: this.callFunc(); break;
      case 46: case 47: case 48: case 49: this.createEmitter(op); break;
      case 50: { // WaitForAllEmitters
        const n = this.systems.reduce((a, s) => a + (s ? s.mgr.emitters.length : 0), 0);
        if (n) { this.pc--; this.delay = 1; } else this.delay = 0;
        break;
      }
      case 51: { // LoadParticleSystem
        const idx = this.rd(), member = this.rd();
        this.pending = this.host.loadParticles(member).then(asset => {
          const file: SplFile = structuredClone(asset.file); // emitter callbacks may rewrite behaviors
          this.systems[idx] = { mgr: new SplManager(file), asset };
          this.pending = null;
        }, () => { this.pending = null; });
        this.delay = 2; this.waiting = true;
        break;
      }
      case 52: this.pc += 3; break;
      case 54: break;
      case 55: { const n = this.rd(); this.pc += n; break; } // stray SetExtraParams
      case 58: { // AddPokemonSprite role, track, spriteID, resID
        const role = this.rd(); this.rd(); const id = this.rd(); this.rd();
        const s = this.side(role);
        if (s) this.copies.set(id, this.newCopy(s));
        break;
      }
      case 62: { const ps = this.rd(), proj = this.rd(); this.projections[ps] = proj; break; } // SetCameraProjection
      case 63: { const ps = this.rd(), flip = this.rd(); this.flips[ps] = flip; break; } // SetCameraFlip
      case 64: { // JumpIfBattlerSide battler, enemy, player
        const who = this.rd();
        const side = who === 0 ? this.attacker : this.defender;
        if (side === 'p2') this.pc++;
        const at = this.pc;
        this.pc = at + this.w[at];
        break;
      }
      case 65: this.pc += 3; this.host.playCry(this.attacker); break;
      case 70: { // JumpIfWeather: no weather animation state is tracked -> "no weather" branch
        const at = this.pc; this.pc = at + this.w[at];
        break;
      }
      case 73: this.pc += 8; break; // InitSpriteManager
      case 74: case 76: case 77: this.pc += 2; break; // Load{Char,Cell,Anim}ResObj (resources are keyed by the sprite template)
      case 75: this.pc += 3; break; // LoadPlttRes
      case 82: { // StartPokemonSpriteDrawTask role, slot, spriteID: singles hide that copy and keep drawing the manager
        this.rd(); this.rd(); const c = this.copies.get(this.rd());
        if (c) c.visible = false;
        this.monDrawTask = true;
        break;
      }
      case 78: { // AddSpriteWithFunc manager, funcID, template[6], argc, args...
        const m = this.rd(), fn = this.rd();
        this.lastTemplate = this.w.slice(this.pc, this.pc + 6); this.pc += 6;
        const n = this.rd();
        const v = new Array<number>(10).fill(0);
        for (let i = 0; i < n; i++) v[i] = this.w[this.pc + i] | 0;
        this.pc += n;
        this.vars = v;
        const sp = this.newSprite(m);
        const f = SPRITE_FUNCS[fn];
        if (f) f.call(this, sp, v); else this.extra.delete(sp);
        break;
      }
      case 79: { // AddSprite manager, spriteID, template[6]: placed on the defender, drawn when its manager is
        const m = this.rd(), id = this.rd();
        this.lastTemplate = this.w.slice(this.pc, this.pc + 6); this.pc += 6;
        const sp = this.newSprite(m);
        this.extra.delete(sp);
        this.sprites.set(id, sp);
        break;
      }
      case 81: { const id = this.rd(), vis = this.rd(); const c = this.copies.get(id); if (c) c.visible = !!vis; break; }
      default: this.aborted = `opcode ${op} at ${this.pc - 1}`; this.finish();
    }
  }

  private pan(p: number) { return this.attacker === 'p2' ? -(p << 24 >> 24) : (p << 24 >> 24); } // CorrectPanDirection

  private end() {
    if (this.endFrames < 1) { this.endFrames++; this.pc--; this.delay = 1; return; }
    const emitters = this.systems.reduce((a, s) => a + (s ? s.mgr.emitters.length : 0), 0);
    if (emitters || this.tasks.length || this.soundTasks.length) { this.pc--; this.delay = 1; return; }
    if (this.host.seActive() && this.seWait++ < 90) { this.pc--; this.delay = 1; return; } // BATTLE_ANIM_SCRIPT_MAX_SFX_WAIT_FRAMES
    this.finish();
  }

  // ---------------------------------------------------------------- background switching

  /** BattleAnimSystem's ShouldBeReversed for vars[6] (anim mode) / vars[7] (screen mode). */
  private bgReversed(mode: number) {
    if (mode === 2) return this.attacker === this.defender ? this.defender === 'p2' : this.defender === 'p1';
    return mode !== 0 && this.defender === 'p1';
  }

  /** mode: 0 blend, 1 fade, 2 flags only; +3 = restore. flags: 0x02 move, 0x04 stop, 0x08 cancel. */
  private bgSwitch(bgId: number, mode: number, flags: number) {
    const vars = [...this.vars];
    const fadeColor = vars[4] === 1 ? 0x7fff : 0;
    const blendType = vars[5];
    let a = blendType === 2 ? 7 : 0, b = blendType === 2 ? 15 : 31;
    const ta = blendType === 1 ? 15 : 29, tb = blendType === 1 ? 7 : 2;
    const applyFlags = () => {
      if (flags & 0x02) {
        const rev = this.bgReversed(vars[6]) ? -1 : 1;
        this.bgMove = { stepX: vars[0] * rev, stepY: vars[1] * rev, on: true };
        if (this.bg.effect) { this.bg.effect.x = vars[2] * rev; this.bg.effect.y = vars[3] * rev; }
      }
      if (flags & 0x08 && this.bgMove) this.bgMove.on = false;
      if (flags & 0x20 && this.bg.effect) { // AnimStartWave: 16 strips of 8 rows slide at 32,28..4,4..32 px/frame
        const eff = this.bg.effect, rev = this.bgReversed(vars[6]) ? -1 : 1;
        const speeds = [32, 28, 24, 20, 16, 12, 8, 4, 4, 8, 12, 16, 20, 24, 28, 32].map(s => s * rev), acc = new Array(16).fill(0);
        this.sysTask(() => {
          if (this.bg.effect !== eff) return false; // restored (CancelBgAnim)
          const rows = new Array<number>(192).fill(0);
          for (let i = 0; i < 16; i++) { acc[i] = (((acc[i] + speeds[i]) << 16) >> 16); for (let r = i * 8; r < i * 8 + 8; r++) rows[r] = acc[i]; }
          eff.rowX = rows;
          return true;
        });
      }
    };
    const mixOf = (eff: number, base: number) => { const e = Math.min(16, eff), bb = Math.min(16, base); return e + bb ? e / (e + bb) : 0; };
    const newEffect = (): EffectBg => ({ bg: bgId, reversed: this.bgReversed(vars[7]), mix: 0, fadeColor, fadeAmt: 0, x: 0, y: 0 });
    const fader = (from: number, to: number, set: (v: number) => void) => {
      let cur = from;
      return () => { set(cur); if (cur === to) return false; cur = cur < to ? Math.min(to, cur + 2) : Math.max(to, cur - 2); return true; };
    };
    this.bgState = 1;
    let state = 0, f: (() => boolean) | null = null;
    const done = () => { this.bgState = 0; return false; };
    let task: Task;
    switch (mode) {
      case 0: task = () => { // blend in
        if (state === 0) { this.bg.effect = newEffect(); applyFlags(); state = 1; }
        let fin = 0;
        if (a < ta) a += 2; else fin++;
        if (b > tb) b -= 2; else fin++;
        if (fin === 2) { a = ta; b = tb; }
        this.bg.effect!.mix = mixOf(a, b);
        return fin === 2 ? done() : true;
      }; break;
      case 1: task = () => { // fade to black/white, swap, fade the effect in
        if (state === 0) { this.bg.fadeColor = fadeColor; f = fader(0, 16, v => (this.bg.fadeAmt = v)); state = 1; }
        if (state === 1) {
          if (f!()) return true;
          this.bg.effect = { ...newEffect(), mix: 1, fadeAmt: 16 };
          this.bg.fadeAmt = 0;
          f = fader(16, 0, v => (this.bg.effect!.fadeAmt = v));
          applyFlags(); this.bgState = 2; state = 2;
          return true;
        }
        return f!() ? true : done();
      }; break;
      case 3: task = () => { // blend back to the battle BG
        if (!this.bg.effect) return done();
        if (state === 0) { applyFlags(); state = 1; }
        let fin = 0;
        if (a < ta) a += 2; else fin++;
        if (b > tb) b -= 2; else fin++;
        this.bg.effect.mix = mixOf(b, a);
        if (fin === 2) { this.bg.effect = null; if (this.bgMove) this.bgMove.on = false; return done(); }
        return true;
      }; break;
      case 4: task = () => { // fade the effect out, swap back, fade the battle BG in
        if (state === 0) { applyFlags(); f = fader(0, 16, v => { if (this.bg.effect) this.bg.effect.fadeAmt = v; }); state = 1; }
        if (state === 1) {
          if (f!()) return true;
          this.bg.effect = null; if (this.bgMove) this.bgMove.on = false;
          this.bg.fadeColor = fadeColor;
          f = fader(16, 0, v => (this.bg.fadeAmt = v)); state = 2;
          return true;
        }
        if (f!()) return true;
        this.bgState = 2;
        return done();
      }; break;
      default: task = () => { applyFlags(); if (mode === 5 && this.bgMove) this.bgMove.on = false; return done(); };
    }
    this.bgTasks.push(task);
  }

  // ---------------------------------------------------------------- particles

  private createEmitter(op: number) {
    const psIdx = this.rd();
    let slot = 0, res: number;
    if (op === 46) res = this.rd();
    else if (op === 47) { slot = this.rd(); res = this.rd(); }
    else if (op === 48) { const t = this.w.slice(this.pc, this.pc + 6); this.pc += 6; res = t[this.attacker === 'p1' ? 0 : 3]; }
    else { const t = this.w.slice(this.pc, this.pc + 4); this.pc += 4; res = t[this.attacker === 'p1' ? 0 : 1]; }
    const cb = this.rd();
    this.currentPs = psIdx;
    const sys = this.systems[psIdx];
    if (!sys) { if (cb === 17) this.skipGenericParams(); return; }
    const cam = sys.mgr.camera;
    if (this.flips[psIdx]) cam.up = [cam.up[0], -cam.up[1], cam.up[2]];
    cam.projection = this.projections[psIdx] as 0 | 1;
    if (!sys.mgr.file.resources[res]) { if (cb === 17) this.skipGenericParams(); return; }
    const e = sys.mgr.create(res, [0, 0, 0], em => this.emitterCallback(cb, em));
    this.emitters[slot] = e;
  }

  private skipGenericParams() {
    // Generic callback params must still be consumed when the emitter can't be created.
    const p = this.extraParams(6);
    if ([3, 4, 5, 12, 13].includes(p[2])) this.extraParams(4);
    if (p[2] === 100 || p[2] === 101) for (let i = 0; i < 6; i++) this.extraParams(4);
    for (let v = 1; v <= 13; v++) if (BEHAVIOR_TYPES[v] && (p[4] & (1 << v))) this.extraParams(5);
    if (p[5] === 2) this.extraParams(4);
  }

  private emitterCallback(cb: number, e: Emitter) {
    const set = (v: Vec3) => e.setPos({ 0: v[0], 1: v[1], 2: v[2] });
    switch (cb) {
      case 1: set(this.world('p2', 0)); break;
      case 2: set(this.world('p1', 0)); break;
      case 3: case 21: case 19: set(this.world(this.attacker, 0)); break;
      case 4: case 20: set(this.world(this.defender, 0)); break;
      case 18: set([0, 0, 0]); break;
      case 17: this.generic(e); break;
    }
  }

  /** BattleAnimEmitterCb_Generic: params = priority, target mode, position, axis, behavior flags, camera. */
  private generic(e: Emitter) {
    const p = this.extraParams(6);
    const [prio, targetMode, posMode, axisMode, bhv, camMode] = p;
    const start = targetMode === 1 || targetMode === 3 ? this.defender : this.attacker;
    const end = other(start);
    const dirOf = () => (start === 'p2' ? -1 : 1);
    let dir = dirOf();
    let pos: Vec3 = [0, 0, 0];
    const offset = () => {
      const q = this.extraParams(4);
      dir = q[0] === 1 ? 1 : dirOf();
      pos = [pos[0] + (q[1] / FX) * dir, pos[1] + (q[2] / FX) * dir, pos[2] + (q[3] / FX) * dir];
    };
    const KIND: Record<number, [number, 'start' | 'end']> = {
      1: [0, 'start'], 2: [0, 'end'], 6: [1, 'start'], 7: [1, 'end'], 8: [11, 'start'], 9: [11, 'end'], 10: [2, 'start'],
      11: [2, 'end'], 14: [3, 'start'], 15: [3, 'end'], 16: [4, 'start'], 17: [4, 'end'], 18: [5, 'start'], 19: [5, 'end'],
      20: [6, 'start'], 21: [6, 'end'], 22: [7, 'start'], 23: [7, 'end'], 24: [8, 'start'], 25: [8, 'end'],
      26: [9, 'start'], 27: [9, 'end'], 34: [0, 'start'],
    };
    if (KIND[posMode]) { const [k, w] = KIND[posMode]; pos = this.world(w === 'start' ? start : end, k); }
    else if (posMode === 3) {
      const q = this.extraParams(4);
      dir = q[0] === 1 ? 1 : dirOf();
      pos = [(q[1] / FX) * dir, (q[2] / FX) * dir, q[3] / FX];
    } else if (posMode === 4 || posMode === 5) { pos = this.world(posMode === 4 ? start : end, 0); offset(); }
    else if (posMode === 12 || posMode === 13) { pos = this.world(posMode === 12 ? this.attacker : this.defender, 0); offset(); }
    else if (posMode === 100 || posMode === 101) {
      const who = posMode === 100 ? start : end;
      pos = this.world(who, 0);
      for (let t = 0; t < 6; t++) {
        const q = this.extraParams(4);
        if (t === TYPE[who]) { dir = q[0] === 1 ? 1 : dirOf(); pos = [pos[0] + (q[1] / FX) * dir, pos[1] + (q[2] / FX) * dir, pos[2] + (q[3] / FX) * dir]; }
      }
    } else if (posMode === 28) pos = [2.8047, 0, 0];
    else if (posMode === 33) pos = [-1.2207, -1.4648, 0];
    else if (posMode === 30) pos = start === 'p1' ? [-2.6904, -0.8516, 0] : [2.6562, 1.8691, 0];
    else if (posMode === 31) pos = start === 'p1' ? [-1.4063, -1.0625, 0] : [2.3164, -0.4844, 0];
    else if (posMode === 32) pos = start === 'p1' ? [-1.125, -1.0938, 0] : [1.8613, 0.5488, 0];
    if (posMode !== 0) e.setPos({ 0: pos[0], 1: pos[1], 2: pos[2] });

    if (axisMode) e.axis = this.axis(axisMode, start, end);

    const behaviors = e.res.behaviors;
    const find = (type: string) => behaviors.find(b => b.type === type);
    for (let v = 1; v <= 13; v++) {
      if (!BEHAVIOR_TYPES[v] || !(bhv & (1 << v))) continue;
      const q = this.extraParams(5);
      const [mode, flip] = q;
      const d = flip === 1 ? 1 : dirOf();
      const b = find(BEHAVIOR_TYPES[v]);
      const at = (who: Side) => this.world(who, 0);
      if (v === 1 && b) { // gravity magnitude
        let mag: Vec3 = [0, 0, 0];
        if (mode === 1) { b.mag = [(q[2] / FX) * d, (q[3] / FX) * d, (q[4] / FX) * d]; continue; }
        mag = [mag[0] - pos[0], mag[1] - pos[1], mag[2] - pos[2]];
        b.mag = mag;
      } else if (v === 4 && b) { // magnet target
        let t: Vec3 = [...b.target!] as Vec3;
        if (mode === 0) t = [t[0] * d, t[1] * d, t[2] * d];
        else if (mode === 1) t = [(q[2] / FX) * d, (q[3] / FX) * d, (q[4] / FX) * d];
        else if (mode === 2) t = at(start); else if (mode === 3) t = at(end); else t = [0, 0, 0];
        b.target = [t[0] - pos[0], t[1] - pos[1], t[2]];
      } else if (v === 5 && b) b.force = mode === 0 ? b.force! * d : mode === 1 ? (q[2] / FX) * d : 0;
      else if (v === 6 && b) b.angle = ((mode === 0 ? b.angle! * d : mode === 1 ? q[2] * d : 0) & 0xffff);
      else if (v === 7 && b) b.axis = mode === 1 ? q[2] : mode === 0 ? b.axis : 0;
      else if (v === 12 && b) {
        let t: Vec3 = [...b.target!] as Vec3;
        if (mode === 0) t = [t[0] * d, t[1] * d, t[2] * d];
        else if (mode === 1) t = [(q[2] / FX) * d, (q[3] / FX) * d, (q[4] / FX) * d];
        else if (mode === 4) { const e2 = at(end); t = [(e2[0] * q[2]) / q[3], (e2[1] * q[2]) / q[3], (e2[2] * q[2]) / q[3]]; }
        else if (mode === 2) t = at(start); else if (mode === 3) t = at(end); else t = [0, 0, 0];
        b.target = [t[0] - pos[0], t[1] - pos[1], t[2] - pos[2]];
      } else if (v === 13 && b) b.force = mode === 0 ? b.force! * d : mode === 1 ? (q[2] / FX) * d : 0;
    }

    const cam = this.ps()!.mgr.camera;
    const ang = (deg: number) => Math.round((deg * 65536) / 360) & 0xffff;
    switch (camMode) {
      case 0: cam.setAngle([0, 0, 0]); break;
      case 1: cam.projection = 1; cam.setAngle([ang(45) + 1, ang(45) + 1, 0]); break;
      case 2: { const q = this.extraParams(4); cam.setAngle([q[1], q[2], q[3]]); break; }
      case 3: cam.projection = 1; cam.setAngle([-ang(67.502), ang(45) + 1, ang(22.5) + 1]); break;
      case 4: cam.projection = 1; cam.setAngle([ang(50.8) + 1, ang(20.567), 0]); break;
      case 5: cam.projection = 1; cam.setAngle([ang(272.817), ang(32.696), ang(22.5) + 1]); break;
      case 6: cam.projection = 1; cam.setAngle([0, 0, -ang(32.96)]); break;
      case 7: cam.target = this.world(start, 10); break;
      case 8: cam.target = this.world(end, 10); break;
    }

    if (prio === 1) e.setPos({ 2: end === 'p1' ? 0.0625 : -1.25 });
    else if (prio === 2) e.setPos({ 2: end === 'p1' ? 0 : -1.3125 });
  }

  private axis(mode: number, start: Side, end: Side): Vec3 {
    const tbl = (i: number) => { const t = this.data.axis[i]; return start === 'p1' ? t.playerToEnemy : t.enemyToPlayer; };
    const half = (v: Vec3): Vec3 => [v[0], v[1], v[2] / 2];
    switch (mode) {
      case 1: case 2: case 4: case 5: return half(tbl(0));
      case 6: case 7: return start === 'p1' ? [0.7754, 0.4785, -0.0723] : [-0.7754, -0.4785, 0.0723];
      case 8: case 9: return half(tbl(1));
      case 10: case 11: { const a = tbl(2), b = tbl(1); return [a[0], b[1], b[2] / 2]; }
      case 12: case 13: return [...tbl(3)] as Vec3;
      case 14: case 15: return [...tbl(4)] as Vec3;
      case 16: case 17: return [...tbl(5)] as Vec3;
      case 18: case 19: return [...tbl(6)] as Vec3;
      case 20: case 21: return [...tbl(7)] as Vec3;
      case 3: return [-0.1953, 0.293, 0.122];
      case 22: return [-0.8325, -0.6455, 0];
      case 25: return [-0.8398, 0.4766, 0];
      case 26: return start === 'p1' ? [0.9219, 0.5156, 0] : [-1.4648, -0.537, 0];
      case 24: return start === 'p1' ? [0.6992, 0.916, 0] : [-0.7188, 0.3555, 0];
    }
    return [0, 0, 0];
  }

  // ---------------------------------------------------------------- script functions (CallFunc)

  sides(mask: number): Side[] {
    if (mask & (1 << 6)) return [this.attacker, this.defender];
    const out: Side[] = [];
    if (mask & (1 << 1)) out.push(this.attacker);
    if (mask & ((1 << 3) | (1 << 5))) out.push(this.defender);
    return out;
  }
  task(t: Task, runNow = false) { if (!runNow || t()) this.tasks.push(t); }
  /** A task the script doesn't wait for (SysTask_Start outside the anim task list: fades, alpha lerps). */
  sysTask(t: Task) { this.sysTasks.push(t); }
  private sysTasks: Task[] = [];

  private callFunc() {
    const id = this.rd(), n = this.rd();
    const v = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) v[i] = this.w[this.pc + i] | 0;
    this.pc += n;
    this.vars = v;
    const fn = FUNCS[id] ?? MORE_FUNCS[id];
    if (fn) fn.call(this, v);
  }

  /** ShakeContext (+e, 0, -e, 0 ...; 4 cycles per "amount"). */
  static shaker(ex: number, ey: number, interval: number, amount: number) {
    const s = { x: 0, y: 0, counter: interval, cycle: 0, remaining: amount, prevX: -ex, prevY: -ey };
    const flip = (cur: number, prev: number): [number, number] => [prev === 0 ? 0 : -prev, cur];
    return {
      s,
      update(): boolean {
        if (!s.remaining) return false;
        if (++s.counter >= interval) {
          s.counter = 0;
          [s.x, s.prevX] = flip(s.x, s.prevX);
          [s.y, s.prevY] = flip(s.y, s.prevY);
          if (++s.cycle >= 4) { s.cycle = 0; s.remaining--; }
        }
        return true;
      },
    };
  }

  /** PosLerpContext */
  static lerp(sx: number, ex: number, sy: number, ey: number, steps: number) {
    const st = Math.max(steps, 0);
    const dx = st ? ((ex - sx) * FX) / st : 0, dy = st ? ((ey - sy) * FX) / st : 0;
    const s = { x: sx, y: sy, cx: sx * FX, cy: sy * FX, steps: st };
    return {
      s,
      update(): boolean {
        if (!s.steps) return false;
        s.cx += Math.trunc(dx); s.cy += Math.trunc(dy);
        s.x = Math.floor(s.cx / FX); s.y = Math.floor(s.cy / FX);
        s.steps--;
        return true;
      },
    };
  }

  /** RevolutionContext */
  static revolve(sx: number, ex: number, sy: number, ey: number, rx: number, ry: number, steps: number) {
    const s = { x: 0, y: 0, cx: sx & 0xffff, cy: sy & 0xffff, steps, stepX: Math.trunc((ex - sx) / steps), stepY: Math.trunc((ey - sy) / steps) };
    return {
      s,
      update(): boolean {
        if (!s.steps) return false;
        s.cx = (s.cx + s.stepX) & 0xffff; s.cy = (s.cy + s.stepY) & 0xffff;
        s.steps--;
        s.x = Math.floor(sinIdx(s.cx) * rx); s.y = Math.floor(cosIdx(s.cy) * ry);
        return true;
      },
    };
  }

  // helpers used by FUNCS
  monFade(side: Side, from: number, to: number, delay: number, color: number, done?: () => void) {
    const fx = this.fx[side];
    let cur = from, counter = 0;
    return () => {
      if (counter === 0) {
        counter = delay;
        fx.fadeColor = color; fx.fadeAmt = cur;
        if (cur === to) { done?.(); return false; }
        cur += cur > to ? -1 : 1;
      } else counter--;
      return true;
    };
  }
}

// Battle anim script functions by id (btlanimfunc.inc / script_func_tables.c). Missing ids do nothing.
type Fn = (this: MoveAnimation, v: number[]) => void;
const DEG = (d: number) => Math.round((d * 65536) / 360);
const FUNCS: Record<number, Fn> = {
  // 4 RotateMon(start, end, frames, mode, pivotX, pivotY)
  4(v) {
    const side = v[3] === 0 || v[3] === 2 ? this.defender : this.attacker;
    const fx = this.fx[side];
    let dir = side === 'p2' ? -1 : 1;
    const steps = v[2];
    let value = v[0], stepSize = Math.trunc(((v[1] - v[0]) * FX) / Math.max(1, steps) / FX) * dir, left = steps, phase = 0;
    if (v[3] === 2) dir *= -1;
    fx.pivotX = v[3] === 1 ? v[4] : 40 * dir; fx.pivotY = v[3] === 1 ? v[5] : 40;
    this.task(() => {
      if (phase < 2) {
        if (left) { value += stepSize; left--; fx.rot = value & 0xffff; }
        else { stepSize = Math.trunc(((v[0] - value) * FX) / Math.max(1, steps) / FX); left = steps; phase++; }
        return true;
      }
      fx.pivotX = 0; fx.pivotY = 0; fx.rot = 0;
      return false;
    });
  },
  // 33 FadeBg(type, delay, start, end, color) — base background palettes
  33(v) {
    if (v[0] !== 0) return;
    const bg = this.bg;
    bg.fadeColor = v[4];
    // PaletteData_StartFade: steps of 2 every `wait` frames; a negative wait means steps of 2+|wait| every frame.
    const wait = v[1] < 0 ? 0 : v[1], step = v[1] < 0 ? 2 - v[1] : 2, to = v[3];
    let cur = v[2], waitStep = wait;
    this.task(() => {
      if (waitStep < wait) { waitStep++; return true; }
      waitStep = 0;
      bg.fadeAmt = cur;
      if (cur === to) return false;
      cur = cur < to ? Math.min(to, cur + step) : Math.max(to, cur - step);
      return true;
    });
  },
  // 34 FadeBattlerSprite(target, stepFrames, cycles, color, alpha, hold)
  34(v) {
    const side = v[0] & (1 << 1) ? this.attacker : v[0] & (1 << 3) ? this.defender : null;
    if (!side) return;
    let state = 0, cycles = v[2], hold = v[5], sub: (() => boolean) | null = null;
    this.task(() => {
      switch (state) {
        case 0: sub = this.monFade(side, 0, v[4], v[1], v[3]); state++; return true;
        case 1: if (!sub!()) state++; return true;
        case 2: if (hold-- > 0) return true; state++; // fallthrough
        case 3: sub = this.monFade(side, v[4], 0, v[1], v[3]); state++; return true;
        case 4:
          if (!sub!()) { if (--cycles <= 0) state++; else { state = 0; hold = v[5]; } }
          return true;
        default: this.fx[side].fadeAmt = 0; return false;
      }
    });
  },
  // 36 Shake(extentX, extentY, interval, amount, targets)
  36(v) {
    const targets = v[4];
    const sides = this.sides(targets);
    const base = sides.map(s => [this.fx[s].x, this.fx[s].y]);
    const sh = MoveAnimation.shaker(v[0], v[1], v[2], v[3]);
    let init = true;
    this.task(() => {
      if (init) { init = false; return true; }
      if (!sh.update()) return false;
      if (targets & (1 << 8)) sides.forEach((s, i) => { this.fx[s].x = base[i][0] + sh.s.x; this.fx[s].y = base[i][1] + sh.s.y; });
      if (targets & (1 << 10)) this.bg.x = sh.s.x;
      return true;
    });
  },
  // 40 HideBattler(targets, hide)
  40(v) { for (const s of this.sides(v[0])) this.fx[s].hide = !!v[1]; },
  // 42 ScaleBattlerSprite(target, startX, endX, startY, endY, reference, hold<<16|cycles, frames<<16|restore)
  42(v) {
    const side = v[0] & (1 << 1) ? this.attacker : v[0] & (1 << 3) ? this.defender : null;
    if (!side) return;
    const fx = this.fx[side], baseY = fx.y, H = this.ground(side) + 16;
    const rel = (s: number) => Math.trunc((s * 256) / (v[5] || 1));
    let cycles = v[6] & 0xffff, hold = v[6] >>> 16, state = 0;
    let lx = MoveAnimation.lerp(rel(v[1]), rel(v[2]), rel(v[3]), rel(v[4]), v[7] >>> 16);
    const apply = () => {
      fx.scaleX = lx.s.x; fx.scaleY = lx.s.y;
      const avail = 80 - H * 2;
      fx.y = baseY + Math.floor((avail - (avail * lx.s.y) / 256) / 2);
    };
    const t = () => {
      switch (state) {
        case 0: apply(); state++; return true;
        case 1: if (lx.update()) apply(); else state++; return true;
        case 2: if (hold > 0) { hold--; return true; } state++; // fallthrough
        case 3: lx = MoveAnimation.lerp(rel(v[2]), rel(v[1]), rel(v[4]), rel(v[3]), v[7] & 0xffff); lx.update(); apply(); state++; return true;
        case 4: if (lx.update()) apply(); else if (--cycles <= 0) state++; else { state = 0; lx = MoveAnimation.lerp(rel(v[1]), rel(v[2]), rel(v[3]), rel(v[4]), v[7] >>> 16); } return true;
        default: fx.scaleX = 256; fx.scaleY = 256; fx.y = baseY; return false;
      }
    };
    this.task(t, true);
  },
  // 50 BlinkAttacker(count, interval)
  50(v) {
    const fx = this.fx[this.attacker];
    let count = v[0] * 2, timer = 0;
    this.task(() => {
      if (timer >= v[1]) {
        if (count === 0) { fx.hide = false; return false; }
        fx.hide = !fx.hide; count--; timer = 0;
      } else timer++;
      return true;
    });
  },
  // 51/52 MoveBattlerX(frames, offset, target)
  51(v) { moveBattler.call(this, v[2], v[1], 0, v[0], false); },
  52(v) { moveBattler.call(this, v[2], v[1], 0, v[0], true); },
  // 57 MoveBattler(frames, dx, dy, target)
  57(v) { moveBattler.call(this, v[3], v[1], v[2], v[0], true); },
  // 62 MoveBattlerToDefaultPos(target)
  62(v) { for (const s of this.sides(v[0])) { this.fx[s].x = DEFAULT_POS_X(s); this.fx[s].y = DEFAULT_POS_Y(s); } },
  // 65 MoveEmitterA2BLinear / 66 Parabolic (emitterID, offX, offY, startDelay, frames, radius, mode, params, curve)
  65(v) { moveEmitter.call(this, v, false); },
  66(v) { moveEmitter.call(this, v, true); },
  // 68 ShakeBg(extentX, extentY, interval, amount, cycles, target)
  68(v) {
    let sh = MoveAnimation.shaker(v[0], v[1], v[2], v[3]), it = 0;
    this.task(() => {
      if (!sh.update()) {
        this.bg.x = 0; this.bg.y = 0;
        if (it++ >= v[4]) return false;
        sh = MoveAnimation.shaker(v[0], v[1], v[2], v[3]);
        return true;
      }
      this.bg.x = sh.s.x; this.bg.y = sh.s.y;
      return true;
    });
  },
  // 72 RevolveEmitter(emitterID, sx, ex, sy, ey, rx, ry, frames, mode, particleSystem)
  72(v) {
    const e = this.emitters[v[0]];
    const sys = this.systems[v[9]];
    if (!e || !sys) return;
    const side = v[8] === 0 ? this.attacker : this.defender;
    const base = this.world(side);
    const r = MoveAnimation.revolve(DEG(v[1]), DEG(v[2]), DEG(v[3]), DEG(v[4]), v[5], v[6], v[7] || 1);
    const place = () => e.setPos({ 0: base[0] + (r.s.x * 172) / FX, 1: base[1] + (r.s.y * 172) / FX });
    r.update(); place();
    this.task(() => {
      if (!r.update() && !e.active) { sys.mgr.remove(e); return false; }
      place();
      return true;
    });
  },
  // 44 ScrollCustomBg / 45 MuddyWater (bgID, startX, startY, stepX, stepY, reverse, targetAlpha, slowDownTime)
  44(v) { scrollBg.call(this, v, v[6], 7); },
  45(v) { scrollBg.call(this, v, 16, 4); },
  // 49 Surf: the wave sprite rises from the attacker's side, crashes forward and fades (sprites 0/1 from AddSprite)
  49() {
    const enemy = this.attacker === 'p2';
    const sp = this.sprites.get(enemy ? 1 : 0);
    this.sprites.delete(enemy ? 0 : 1);
    if (!sp) return;
    sp.anim = enemy ? 1 : 0; sp.visible = true;
    const [px, py] = enemy ? [144, 64] : [76, 120];
    let lx = MoveAnimation.lerp(256, 256, 256, Math.trunc((5 * 256) / 100), 1), state = 0, hold = 0, a = 0, b = 31;
    const apply = () => {
      sp.scaleX = lx.s.x / 256; sp.scaleY = lx.s.y / 256;
      sp.x = px; sp.y = py + Math.floor((48 - 48 * sp.scaleY) / 2);
      const A = Math.min(16, a), B = Math.min(16, b);
      sp.alpha = A + B ? A / (A + B) : 0;
    };
    lx.update(); apply();
    this.task(() => {
      this.drawMgr(sp.mgr);
      switch (state) {
        case 0: lx = MoveAnimation.lerp(256, 153, 12, 384, 12); state = 1; break;
        case 1:
          if (!lx.update()) { lx = MoveAnimation.lerp(153, 384, 384, 25, 12); state = 2; }
          else { if (a < 31) a++; if (b > 4) b--; apply(); }
          break;
        case 2: if (++hold >= 4) state = 3; break;
        case 3:
          if (!lx.update()) { this.sprites.delete(enemy ? 1 : 0); return false; }
          if (a > 0) a--; if (b < 31) b++; apply();
          break;
      }
      return true;
    });
  },
  // 74 SetBgGrayscale(on)
  74(v) { this.bg.grayscale = !!v[0]; },
  // 24 Earthquake: base BG fades to black 10/16, then 8 shakes of decreasing extent (12..0) with black/white flashes
  24() {
    const sides = [this.attacker, this.defender];
    const base = sides.map(s => this.fx[s].x);
    const extents = [12, 10, 8, 6, 4, 2, 1, 0];
    let state = 0, count = 0, flash = 0, flashFor = 0, sh = MoveAnimation.shaker(0, 0, 0, 0), waitStep = 1, cur = 0;
    this.bg.fadeColor = 0;
    this.task(() => {
      if (state === 0) { // PaletteData_StartFade(delay 1, 0 -> 10, black)
        if (waitStep < 1) { waitStep++; return true; }
        waitStep = 0; this.bg.fadeAmt = cur;
        if (cur < 10) { cur = Math.min(10, cur + 2); return true; }
        state = 1;
      }
      if (state === 1) {
        sh = MoveAnimation.shaker(extents[count], 0, 0, 5);
        this.bg.fadeColor = flash ? 0x7fff : 0; this.bg.fadeAmt = 10;
        flashFor = 3; flash ^= 1; count++; state = 2;
      }
      if (!sh.update()) {
        if (count >= extents.length) { sides.forEach((s, i) => (this.fx[s].x = base[i])); this.bg.x = 0; return false; }
        state = 1;
      }
      if (flashFor > 0 && --flashFor === 0) this.bg.fadeAmt = 0;
      sides.forEach((s, i) => (this.fx[s].x = base[i] + sh.s.x));
      this.bg.x = sh.s.x;
      return true;
    });
  },
  // 37 Extrasensory: the defender is redrawn with a per-scanline horizontal wave (3 phases of 16 frames)
  37() {
    const d = this.defender, fx = this.fx[d];
    const centerY = fx.y, top = fx.y - 40;
    const phases = [[0x8000, 5, 16], [0x8000, -5, -16], [0x8000, 10, 20]];
    let phase = 0, delay = -1, dir = 1;
    this.task(() => {
      if (delay < 0) { if (phase >= 3) { fx.rowShift = null; return false; } delay = 16; }
      const [angle, step, amp] = phases[phase];
      dir = -dir;
      const rows = new Map<number, number>();
      const startY = Math.max(0, top - 8), endY = Math.min(192, top + 80 + 8);
      for (let y = startY; y < endY; y++) {
        const a = y & 2 ? amp + dir : amp - dir;
        const ang = (angle + 409 * (y - startY)) & 0xffff;
        rows.set(y, Math.floor(sinIdx(ang) * a) + Math.trunc(((y - centerY) * step) / 10));
      }
      fx.rowShift = rows;
      if (--delay < 0) phase++;
      return true;
    });
  },
};
const DEFAULT_POS_X = (s: Side) => DEFAULT_POS[s][0];
const DEFAULT_POS_Y = (s: Side) => DEFAULT_POS[s][1];

function scrollBg(this: MoveAnimation, v: number[], targetBg: number, targetOther: number) {
  let [, x, y, stepX, stepY] = v;
  const enemy = this.attacker === 'p2';
  if (v[5] && enemy) { x = -x; y = -y; stepX = -stepX; stepY = -stepY; y -= 84; } else y += 84;
  const ov: EffectBg = { bg: v[0], reversed: enemy, mix: 0, fadeColor: 0, fadeAmt: 0, x, y };
  this.bg.overlay = ov;
  let a = 0, o = 31, state = 0, timer = 0, finished = false;
  const mix = () => { const A = Math.min(16, a), O = Math.min(16, o); ov.mix = A + O ? A / (A + O) : 0; };
  this.task(() => {
    if (state === 0) { // fade in
      let c = 0;
      if (a < targetBg - 2) a += 2; else c++;
      if (o > targetOther + 2) o -= 2; else c++;
      if (c === 2) { a = targetBg; o = targetOther; state = 1; }
    } else if (state === 1) { if (finished) state = 2; }
    else if (state === 2) { // fade out
      let c = 0;
      if (a > 2) a -= 2; else c++;
      if (o < 29) o += 2; else c++;
      if (c === 2) { this.bg.overlay = null; return false; }
    }
    mix();
    if ((stepY > 0 && y >= 512) || (stepY < 0 && y <= -412)) finished = true;
    x += stepX; y += stepY;
    if (v[7] < timer) { stepY = stepY < 0 ? stepY + 1 : 0; stepX = stepX < 0 ? stepX + 1 : 0; timer = 0; } else timer++;
    ov.x = x; ov.y = y;
    return true;
  });
}

function moveBattler(this: MoveAnimation, target: number, dx: number, dy: number, frames: number, immediate: boolean) {
  const side = target & (1 << 1) ? this.attacker : target & (1 << 3) ? this.defender : null;
  if (!side) return;
  const fx = this.fx[side], dir = side === 'p2' ? -1 : 1;
  const l = MoveAnimation.lerp(fx.x, fx.x + dx * dir, fx.y, fx.y + dy * dir, frames);
  let init = !immediate;
  this.task(() => {
    if (init) { init = false; return true; }
    const more = l.update();
    fx.x = l.s.x; fx.y = l.s.y;
    return more;
  }, immediate);
}

function moveEmitter(this: MoveAnimation, v: number[], parabolic: boolean) {
  const e = this.emitters[v[0]];
  const sys = this.ps();
  if (!e || !sys) return;
  const start: Side = v[6] === 1 ? this.defender : this.attacker, end = start === 'p1' ? 'p2' : 'p1';
  const dir = this.attacker === 'p2' ? -1 : 1;
  const a = this.world(start), b = this.world(end);
  const px = (w: number) => Math.trunc((w * FX) / 172);
  const lin = MoveAnimation.lerp(px(a[0]), px(b[0]) + v[1] * dir, px(a[1]), px(b[1]) + v[2] * dir, v[4]);
  const rev = parabolic ? MoveAnimation.revolve(0, 0, DEG(90), DEG(270), 0, -v[5], v[4] || 1) : null;
  const skip = v[7] >>> 16;
  let timer = 0, angle = 0;
  const pos = () => [lin.s.x + (rev ? rev.s.x : 0), lin.s.y + (rev ? rev.s.y : 0)];
  const upd = () => { const a1 = lin.update(); const a2 = rev ? rev.update() : false; return a1 || a2; };
  for (let i = 0; i < skip; i++) upd();
  const place = () => { const [x, y] = pos(); e.setPos({ 0: (x * 172) / FX, 1: (y * 172) / FX }); };
  place();
  this.task(() => {
    if (!parabolic && timer < v[3]) { timer++; return true; }
    if (!upd() && !e.active) { sys.mgr.remove(e); return false; }
    place();
    if (!parabolic && v[8]) {
      angle += Math.trunc(360 / (v[4] || 1));
      e.setPos({ 1: (pos()[1] * 172) / FX + Math.sin((angle * Math.PI) / 180) });
    }
    return true;
  });
}

/** Function ids with a port (coverage checks). */
export const implementedFuncs = () => ({
  funcs: new Set([...Object.keys(FUNCS), ...Object.keys(MORE_FUNCS)].map(Number)),
  sprites: new Set(Object.keys(SPRITE_FUNCS).map(Number)),
});
