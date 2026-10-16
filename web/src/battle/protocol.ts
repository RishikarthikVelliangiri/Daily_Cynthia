// Showdown protocol lines -> UI events, with messages built from the ROM's own battle text templates.
import type { GameData } from '../data';
import { dex } from './showdown';

export type Side = 'p1' | 'p2';
export type UIEvent =
  | { t: 'msg'; text: string }
  | { t: 'switch'; side: Side; species: number; name: string; level: number; gender: string; hp: number; maxhp: number; status: string; text: string }
  | { t: 'move'; side: Side; move: string; text: string }
  | { t: 'hp'; side: Side; hp: number; maxhp: number; hit?: 'normal' | 'super' | 'weak' }
  | { t: 'status'; side: Side; status: string }
  | { t: 'faint'; side: Side; text: string }
  | { t: 'item'; side: Side; text: string }
  | { t: 'turn'; n: number }
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
  sandBuffet: 285, recoil: 279, drained: 82, itemRestoredHp: 1030, restoredUsingItem: 899,
} as const;
const STAT_INDEX: Record<string, number> = { atk: 1, def: 2, spe: 3, spa: 4, spd: 5, accuracy: 6, evasion: 7 };
const STATUS_MSG: Record<string, number> = { slp: T.asleep, psn: T.poisoned, tox: T.badlyPoisoned, brn: T.burned, frz: T.frozen, par: T.paralyzed };

export class Translator {
  private names: Record<Side, string> = { p1: '', p2: '' };
  constructor(private data: GameData, private playerName = 'Player', private trainer = 'Cynthia') {}

  private fill(tpl: string, vars: (string | number)[]): string {
    return tpl.replace(/\{([0-9A-F]{4}):(\d+)\}/g, (_, cmd: string, i: string) => (cmd === '0200' ? '' : String(vars[+i] ?? '')));
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
        const level = Number((det.find(d => d.startsWith('L')) ?? 'L100').slice(1));
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
        out.push({ t: 'move', side, move: mv.id, text: this.fill(t.move_use[mv.num * 3 + (side === 'p2' ? 2 : 0)], [this.names[side]]) });
        if (p.slice(4).some(x => x === '[still]' || x.startsWith('[miss]'))) { /* animation-only flags */ }
        break;
      }
      case '-damage': case '-heal': case '-sethp': {
        const side = this.who(p[2]);
        const { hp, maxhp } = this.hp(p[3]);
        const from = p.find(x => x.startsWith('[from]')) ?? '';
        out.push({ t: 'hp', side, hp, maxhp, hit: cmd === '-damage' && !from ? 'normal' : undefined });
        if (from.includes('psn')) out.push({ t: 'msg', text: this.side(T.hurtPoison, side, this.names[side]) });
        else if (from.includes('brn')) out.push({ t: 'msg', text: this.side(T.hurtBurn, side, this.names[side]) });
        else if (from.includes('Sandstorm') || from.includes('Hail')) out.push({ t: 'msg', text: this.side(T.sandBuffet, side, from.includes('Hail') ? 'Hail' : 'Sandstorm', this.names[side]) });
        else if (from.includes('item: ')) {
          const item = from.split('item: ')[1];
          if (cmd === '-heal') out.push({ t: 'msg', text: this.side(item.endsWith('Berry') ? T.restoredUsingItem : T.itemRestoredHp, side, this.names[side], item) });
          else out.push({ t: 'msg', text: `${side === 'p2' ? 'The foe’s ' : ''}${this.names[side]} was hurt\nby its ${item}!` });
        } else if (from.includes('Recoil')) out.push({ t: 'msg', text: this.side(T.recoil, side, this.names[side]) });
        else if (from.includes('drain')) out.push({ t: 'msg', text: this.side(T.drained, side === 'p1' ? 'p2' : 'p1', this.names[side === 'p1' ? 'p2' : 'p1']) });
        break;
      }
      case '-crit': out.push({ t: 'msg', text: this.plain(T.crit) }); break;
      case '-miss': out.push({ t: 'msg', text: this.side(T.missed, this.who(p[2]), this.names[this.who(p[2])]) }); break;
      case '-immune': out.push({ t: 'msg', text: this.side(T.noEffect, this.who(p[2]), this.names[this.who(p[2])]) }); break;
      case '-fail': out.push({ t: 'msg', text: 'But it failed!' }); break;
      case '-activate':
        if (p[3]?.includes('Protect')) out.push({ t: 'msg', text: this.side(T.protected, this.who(p[2]), this.names[this.who(p[2])]) });
        else if (p[3] === 'confusion') out.push({ t: 'msg', text: this.side(T.confused, this.who(p[2]), this.names[this.who(p[2])]) });
        break;
      case '-status': {
        const side = this.who(p[2]);
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
        if (idx >= 0) out.push({ t: 'msg', text: this.side(idx, side, this.names[side]) });
        break;
      }
      case '-start':
        if (p[3] === 'confusion') out.push({ t: 'msg', text: this.side(T.becameConfused, this.who(p[2]), this.names[this.who(p[2])]) });
        break;
      case '-boost': case '-unboost': {
        const side = this.who(p[2]);
        const n = Number(p[4]);
        const stat = t.stats[STAT_INDEX[p[3]] ?? 0];
        const idx = n === 0 ? (cmd === '-boost' ? T.statWontRise : T.statWontFall)
          : cmd === '-boost' ? (n >= 2 ? T.statSharplyRose : T.statRose) : (n >= 2 ? T.statHarshlyFell : T.statFell);
        out.push({ t: 'msg', text: this.side(idx, side, this.names[side], stat) });
        break;
      }
      case '-weather': {
        const upkeep = p.includes('[upkeep]');
        const w = p[2];
        const idx = w === 'RainDance' ? (upkeep ? 872 : T.rain) : w === 'Sandstorm' ? (upkeep ? T.sandRage : T.sandStart)
          : w === 'SunnyDay' ? (upkeep ? 808 : T.sunStart) : w === 'Hail' ? (upkeep ? 811 : T.hailStart) : -1;
        if (idx >= 0) out.push({ t: 'msg', text: this.plain(idx) });
        break;
      }
      case '-enditem':
        if (p.includes('[eat]')) { /* the following -heal carries the message */ }
        break;
      case '-message': out.push({ t: 'msg', text: p[2] }); break;
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

/** Showdown emits -supereffective/-crit lines before the damage line; the DS shows them after the hit. */
function reorderEffectiveness(ev: UIEvent[]): UIEvent[] {
  const out: UIEvent[] = [];
  let held: UIEvent[] = [];
  for (const e of ev) {
    const isEff = e.t === 'msg' && (e.text.startsWith('It’s super') || e.text.startsWith('It’s not very') || e.text === 'A critical hit!');
    if (isEff) { held.push(e); continue; }
    out.push(e);
    if (e.t === 'hp' && held.length) { out.push(...held); held = []; }
  }
  return out.concat(held);
}
