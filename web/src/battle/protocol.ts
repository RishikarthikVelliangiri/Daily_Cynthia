// Showdown protocol lines -> UI events, with messages built from the ROM's own battle text templates.
import type { GameData } from '../data';
import { dex } from './showdown';

export type Side = 'p1' | 'p2';
export type UIEvent =
  | { t: 'msg'; text: string }
  | { t: 'switch'; side: Side; species: number; name: string; level: number; gender: string; hp: number; maxhp: number; status: string; text: string }
  | { t: 'move'; side: Side; move: string; num: number; anim: boolean; text: string }
  | { t: 'hp'; side: Side; hp: number; maxhp: number; hit?: 'normal' | 'super' | 'weak' }
  | { t: 'status'; side: Side; status: string }
  | { t: 'faint'; side: Side; text: string }
  | { t: 'item'; side: Side; text: string }
  | { t: 'turn'; n: number }
  /** Common animation (wazaeffect/we_sub.narc): status, stat change, weather, trap damage...; side = affected battler. */
  | { t: 'anim'; sub: number; side: Side; target?: Side }
  | { t: 'win'; winner: Side; text: string };

// Message archive 324 indices (each is a player/wild/foe triplet; foe = +2 unless noted).
const T = {
  fainted: 30, missed: 12, protected: 15, noEffect: 27, asleep: 47, poisoned: 63, badlyPoisoned: 79, burned: 85,
  frozen: 101, thawed: 114, paralyzed: 120, cantMoveParalyzed: 130, confused: 150, becameConfused: 156,
  flinched: 181, hurtPoison: 73, hurtBurn: 95, fastAsleep: 299, wokeUp: 302, mustRecharge: 360,
  statRose: 750, statSharplyRose: 753, statFell: 762, statHarshlyFell: 765, statWontRise: 142, statWontFall: 145,
  crit: 774, notVeryEffective: 779, superEffective: 780, playerDefeated: 785, playerLost: 787,
  rain: 799, rainStop: 803, sandStart: 804, sandRage: 805, sandStop: 806, sunStart: 807, sunStop: 809,
  hailStart: 810, hailStop: 812, trainerSentOut: 974, go: 979, comeBack: 985, trainerUsedItem: 858,
  sandBuffet: 285, recoil: 279, drained: 82, littleHp: 908, moveRestored: 1030, abilityRestored: 635,
  exerting: 1238, abilityRaised: 622, noItems: 1135, aquaRing: 1027, foresaw: 472,
  absorbedLight: 214, burrowed: 226, flew: 223, tightening: 497, hurtConfusion: 797, snappedOut: 153,
  hitCount: 46, noTarget: 1234, hurtBy: 262, itemRestoredHp: 1030, restoredUsingItem: 899,
} as const;
const STAT_INDEX: Record<string, number> = { atk: 1, def: 2, spe: 3, spa: 4, spd: 5, accuracy: 6, evasion: 7 };
const STATUS_MSG: Record<string, number> = { slp: T.asleep, psn: T.poisoned, tox: T.badlyPoisoned, brn: T.burned, frz: T.frozen, par: T.paralyzed };
// Common animation ids (pret anim_subscripts.order).
const SUB_STATUS: Record<string, number> = { slp: 1, psn: 2, tox: 2, brn: 3, frz: 4, par: 5 };
const SUB_WEATHER: Record<string, number> = { RainDance: 19, Hail: 20, Sandstorm: 21, SunnyDay: 22 };
const SUB_DAMAGE: [string, number][] = [['Curse', 30], ['Nightmare', 31], ['Leech Seed', 32], ['Bind', 33], ['Wrap', 34], ['Fire Spin', 35],
  ['Magma Storm', 36], ['Clamp', 37], ['Whirlpool', 38], ['Sand Tomb', 39]];

/** Fill a ROM text template: {01xx:n} are variables (names, moves, …); other commands (02xx waits/yes-no,
 * FFxx colors) are control codes and render as nothing. */
export function fillTemplate(tpl: string, vars: (string | number)[]): string {
  return tpl.replace(/\{([0-9A-F]{4}):(\d+)\}/g, (_, cmd: string, i: string) => (cmd.startsWith('01') ? String(vars[+i] ?? '') : ''));
}

export class Translator {
  private names: Record<Side, string> = { p1: '', p2: '' };
  private intimidator: Side | null = null;
  constructor(private data: GameData, private playerName = 'Player', private trainer = 'Cynthia') {}

  private fill(tpl: string, vars: (string | number)[]): string {
    return fillTemplate(tpl, vars);
  }
  /** Triplet template: player side uses base, Cynthia's side uses the "The foe's" variant (+2). */
  private side(idx: number, side: Side, ...vars: (string | number)[]) {
    return this.fill(this.data.text.battle[idx + (side === 'p2' ? 2 : 0)], vars);
  }
  private plain(idx: number, ...vars: (string | number)[]) { return this.fill(this.data.text.battle[idx], vars); }

  displayName(speciesName: string) { return speciesName.toUpperCase(); } // DP shows species names in caps

  private who(id: string): Side { return id.slice(0, 2) as Side; }
  private hp(s: string) {
    const [cur, rest = ''] = s.split(' ');
    const [hp, max] = cur.split('/').map(Number);
    return { hp: hp || 0, maxhp: max || 100, status: rest.trim() };
  }

  /** Translate a batch of protocol lines. `|split|` pairs keep the first (exact HP) line. */
  translate(lines: string[]): UIEvent[] {
    const out: UIEvent[] = [];
    let pendingHit: 'normal' | 'super' | 'weak' = 'normal';
    for (let i = 0; i < lines.length; i++) {
      let parts = lines[i].split('|');
      if (parts[1] === 'split') { parts = lines[i + 1].split('|'); i += 2; } // keep the exact-HP (secret) line
      const cmd = parts[1];
      if (cmd === '-supereffective' || cmd === '-resisted') {
        // Showdown prints effectiveness before damage; the DS shows the hit, then the message.
        pendingHit = cmd === '-supereffective' ? 'super' : 'weak';
        out.push({ t: 'msg', text: this.plain(cmd === '-supereffective' ? T.superEffective : T.notVeryEffective) });
        continue;
      }
      const before = out.length;
      this.handle(parts, out);
      if (cmd === 'move' && immuneAfter(lines, i)) { const e = out[out.length - 1]; if (e?.t === 'move') e.anim = false; }
      for (let k = before; k < out.length; k++) {
        const e = out[k];
        if (e.t === 'hp' && e.hit) { e.hit = pendingHit; pendingHit = 'normal'; }
      }
    }
    return reorderEffectiveness(out);
  }

  private handle(p: string[], out: UIEvent[]) {
    const cmd = p[1];
    const t = this.data.text;
    switch (cmd) {
      case 'switch': case 'drag': {
        const side = this.who(p[2]);
        const det = p[3].split(', ');
        const sp = dex.species.get(det[0]);
        const level = Number((det.find(d => /^L\d+$/.test(d)) ?? 'L100').slice(1));
        const gender = det.find(d => d === 'M' || d === 'F') ?? '';
        const name = this.displayName(this.data.species[sp.num].name);
        const prev = this.names[side];
        this.names[side] = name;
        const { hp, maxhp, status } = this.hp(p[4]);
        let text = side === 'p1' ? this.plain(T.go, name) : this.plain(T.trainerSentOut, this.trainer, name);
        if (side === 'p1' && prev && cmd === 'switch') text = this.plain(T.comeBack, prev) + '\f' + text;
        out.push({ t: 'switch', side, species: sp.num, name, level, gender, hp, maxhp, status, text });
        break;
      }
      case 'move': {
        const side = this.who(p[2]);
        const mv = dex.moves.get(p[3]);
        // [still]/[miss]/[notarget]: Showdown's "no animation" flags (charging turn, miss, no target).
        const anim = !p.slice(4).some(x => x === '[still]' || x.startsWith('[miss]') || x === '[notarget]');
        out.push({ t: 'move', side, move: mv.id, num: mv.num, anim, text: this.fill(t.move_use[mv.num * 3 + (side === 'p2' ? 2 : 0)], [this.names[side]]) });
        break;
      }
      case '-damage': case '-heal': case '-sethp': {
        const side = this.who(p[2]);
        const { hp, maxhp } = this.hp(p[3]);
        const from = p.find(x => x.startsWith('[from]')) ?? '';
        if (from.includes('confusion')) out.push({ t: 'msg', text: this.plain(T.hurtConfusion) });
        const other: Side = side === 'p1' ? 'p2' : 'p1';
        if (cmd === '-damage' && (from === '[from] psn' || from === '[from] tox' || from === '[from] brn')) out.push({ t: 'anim', sub: SUB_STATUS[from.slice(7)], side });
        else if (cmd === '-damage') { const d = SUB_DAMAGE.find(([n]) => from.includes(n)); if (d) out.push({ t: 'anim', sub: d[1], side, target: other }); }
        else if (cmd === '-heal' && from.includes('item: ')) out.push({ t: 'anim', sub: 10, side });
        else if (cmd === '-heal' && from.includes('Ingrain')) out.push({ t: 'anim', sub: 40, side });
        out.push({ t: 'hp', side, hp, maxhp, hit: cmd === '-damage' && !from ? 'normal' : undefined });
        const name = this.names[side];
        if (from.includes('psn')) out.push({ t: 'msg', text: this.side(T.hurtPoison, side, this.names[side]) });
        else if (from.includes('brn')) out.push({ t: 'msg', text: this.side(T.hurtBurn, side, this.names[side]) });
        else if (from.includes('Sandstorm') || from.includes('Hail')) out.push({ t: 'msg', text: this.side(T.sandBuffet, side, from.includes('Hail') ? 'Hail' : 'Sandstorm', this.names[side]) });
        else if (from.includes('item: ')) {
          const item = from.split('item: ')[1];
          if (cmd === '-heal') out.push({ t: 'msg', text: this.side(item === 'Leftovers' ? T.littleHp : T.restoredUsingItem, side, name, item) });
          else out.push({ t: 'msg', text: `${side === 'p2' ? 'The foe’s ' : ''}${this.names[side]} was hurt\nby its ${item}!` });
        } else if (from.includes('Recoil')) out.push({ t: 'msg', text: this.side(T.recoil, side, this.names[side]) });
        else if (from.includes('Aqua Ring') || from.includes('Ingrain')) out.push({ t: 'msg', text: this.side(T.moveRestored, side, name, from.includes('Ingrain') ? 'Ingrain' : 'Aqua Ring') });
        else if (from.includes('ability: ') && cmd === '-heal') out.push({ t: 'msg', text: this.side(T.abilityRestored, side, name, from.split('ability: ')[1]) });
        else if (from.includes('move: ')) out.push({ t: 'msg', text: this.side(T.hurtBy, side, name, from.split('move: ')[1]) });
        else if (from.includes('drain')) out.push({ t: 'msg', text: this.side(T.drained, side === 'p1' ? 'p2' : 'p1', this.names[side === 'p1' ? 'p2' : 'p1']) });
        break;
      }
      case '-crit': out.push({ t: 'msg', text: this.plain(T.crit) }); break;
      case '-miss': out.push({ t: 'msg', text: this.side(T.missed, this.who(p[2]), this.names[this.who(p[2])]) }); break;
      case '-immune': out.push({ t: 'msg', text: this.side(T.noEffect, this.who(p[2]), this.names[this.who(p[2])]) }); break;
      case '-fail': out.push({ t: 'msg', text: 'But it failed!' }); break;
      case '-activate':
        if (p[3]?.includes('Protect')) out.push({ t: 'msg', text: this.side(T.protected, this.who(p[2]), this.names[this.who(p[2])]) });
        else if (p[3] === 'confusion') {
          out.push({ t: 'msg', text: this.side(T.confused, this.who(p[2]), this.names[this.who(p[2])]) });
          out.push({ t: 'anim', sub: 6, side: this.who(p[2]) });
        }
        break;
      case '-status': {
        const side = this.who(p[2]);
        if (SUB_STATUS[p[3]]) out.push({ t: 'anim', sub: SUB_STATUS[p[3]], side });
        out.push({ t: 'status', side, status: p[3] });
        if (STATUS_MSG[p[3]] !== undefined) out.push({ t: 'msg', text: this.side(STATUS_MSG[p[3]], side, this.names[side]) });
        break;
      }
      case '-curestatus': {
        const side = this.who(p[2]);
        out.push({ t: 'status', side, status: '' });
        if (p[3] === 'slp') out.push({ t: 'msg', text: this.side(T.wokeUp, side, this.names[side]) });
        if (p[3] === 'frz') out.push({ t: 'msg', text: this.side(T.thawed, side, this.names[side]) });
        break;
      }
      case 'cant': {
        const side = this.who(p[2]);
        const why = p[3];
        const idx = why === 'par' ? T.cantMoveParalyzed : why === 'slp' ? T.fastAsleep : why === 'frz' ? 111
          : why === 'flinch' ? T.flinched : why === 'recharge' ? T.mustRecharge : -1;
        if (SUB_STATUS[why]) out.push({ t: 'anim', sub: SUB_STATUS[why], side });
        if (idx >= 0) out.push({ t: 'msg', text: this.side(idx, side, this.names[side]) });
        break;
      }
      case '-start': {
        const side = this.who(p[2]);
        const idx = p[3] === 'confusion' ? T.becameConfused : p[3] === 'Embargo' ? T.noItems : p[3] === 'Aqua Ring' ? T.aquaRing
          : p[3]?.includes('Future Sight') ? T.foresaw : -1;
        if (p[3] === 'confusion') out.push({ t: 'anim', sub: 6, side });
        if (idx >= 0) out.push({ t: 'msg', text: this.side(idx, side, this.names[side]) });
        break;
      }
      case '-boost': case '-unboost': {
        const side = this.who(p[2]);
        const n = Number(p[4]);
        const stat = t.stats[STAT_INDEX[p[3]] ?? 0];
        if (n !== 0) out.push({ t: 'anim', sub: cmd === '-boost' ? 12 : 13, side });
        if (cmd === '-unboost' && this.intimidator && this.intimidator !== side) {
          const by = this.intimidator;
          this.intimidator = null;
          // 664: yours cuts the foe's; 667: the foe's cuts yours
          out.push({ t: 'msg', text: this.plain(by === 'p1' ? 664 : 667, this.names[by], 'Intimidate', this.names[side], stat) });
          break;
        }
        const fromAbility = p.find(x => x.startsWith('[from] ability: '));
        if (cmd === '-boost' && fromAbility) {
          out.push({ t: 'msg', text: this.side(T.abilityRaised, side, this.names[side], fromAbility.slice(16), stat) });
          break;
        }
        const idx = n === 0 ? (cmd === '-boost' ? T.statWontRise : T.statWontFall)
          : cmd === '-boost' ? (n >= 2 ? T.statSharplyRose : T.statRose) : (n >= 2 ? T.statHarshlyFell : T.statFell);
        out.push({ t: 'msg', text: this.side(idx, side, this.names[side], stat) });
        break;
      }
      case '-weather': {
        const upkeep = p.includes('[upkeep]');
        const w = p[2];
        // Each turn's weather (and ability-started weather) plays its animation; a move's own animation covers Rain Dance etc.
        if (SUB_WEATHER[w] && (upkeep || p.some(x => x.startsWith('[from] ability:')))) out.push({ t: 'anim', sub: SUB_WEATHER[w], side: 'p1' });
        const idx = w === 'RainDance' ? (upkeep ? 872 : T.rain) : w === 'Sandstorm' ? (upkeep ? T.sandRage : T.sandStart)
          : w === 'SunnyDay' ? (upkeep ? 808 : T.sunStart) : w === 'Hail' ? (upkeep ? 811 : T.hailStart) : -1;
        if (idx >= 0) out.push({ t: 'msg', text: this.plain(idx) });
        break;
      }
      case '-enditem':
        if (p.includes('[eat]')) { /* the following -heal carries the message */ }
        break;
      case '-message': out.push({ t: 'msg', text: p[2] }); break;
      case '-ability': {
        const side = this.who(p[2]);
        if (p[3] === 'Pressure') out.push({ t: 'msg', text: this.side(T.exerting, side, this.names[side], 'Pressure') });
        else if (p[3] === 'Intimidate') this.intimidator = side;
        else if (p[3] === 'Mold Breaker') out.push({ t: 'msg', text: `${side === 'p2' ? 'The foe’s ' : ''}${this.names[side]}
breaks the mold!` });
        break;
      }
      case '-prepare': {
        const side = this.who(p[2]);
        const idx = p[3] === 'Solar Beam' ? T.absorbedLight : p[3] === 'Dig' ? T.burrowed : p[3] === 'Fly' ? T.flew : -1;
        if (idx >= 0) out.push({ t: 'msg', text: this.side(idx, side, this.names[side]) });
        break;
      }
      case '-singleturn':
        if (p[3]?.includes('Focus Punch')) out.push({ t: 'msg', text: this.side(T.tightening, this.who(p[2]), this.names[this.who(p[2])]) });
        break;
      case '-end':
        if (p[3] === 'confusion') out.push({ t: 'msg', text: this.side(T.snappedOut, this.who(p[2]), this.names[this.who(p[2])]) });
        break;
      case '-hitcount': out.push({ t: 'msg', text: this.plain(T.hitCount, p[3]) }); break;
      case '-notarget': out.push({ t: 'msg', text: this.plain(T.noTarget) }); break;
      case 'faint': {
        const side = this.who(p[2]);
        out.push({ t: 'faint', side, text: this.side(T.fainted, side, this.names[side]) });
        break;
      }
      case 'turn': out.push({ t: 'turn', n: Number(p[2]) }); break;
      case 'win': {
        const winner: Side = p[2] === this.playerName ? 'p1' : 'p2';
        const text = winner === 'p1' ? this.plain(T.playerDefeated, `Champion ${this.trainer}`) : this.plain(T.playerLost, `Champion ${this.trainer}`);
        out.push({ t: 'win', winner, text: text.replace('Player', this.playerName === 'Player' ? 'You' : this.playerName) });
        break;
      }
    }
  }
}

/** A move whose target turns out immune ("It doesn't affect…") plays no animation in Gen 4. */
function immuneAfter(lines: string[], i: number) {
  for (let k = i + 1; k < lines.length; k++) {
    const c = lines[k].split('|')[1];
    if (c === '-immune') return true;
    if (c === 'move' || c === 'turn' || c === 'switch' || c === 'drag' || c === '' || c === 'upkeep') return false;
  }
  return false;
}

/** Showdown emits -supereffective/-crit lines before the damage line; the DS shows them after the hit. */
function reorderEffectiveness(ev: UIEvent[]): UIEvent[] {
  const out: UIEvent[] = [];
  let held: UIEvent[] = [];
  for (const e of ev) {
    const isEff = e.t === 'msg' && (e.text.startsWith('It’s super') || e.text.startsWith('It’s not very') || e.text === 'A critical hit!');
    if (isEff) { held.push(e); continue; }
    out.push(e);
    if (e.t === 'hp' && held.length) {
      held.sort((a, b) => Number((b as { text: string }).text === 'A critical hit!') - Number((a as { text: string }).text === 'A critical hit!'));
      out.push(...held); held = [];
    }
  }
  return out.concat(held);
}
