import { Battle } from '@pkmn/sim';
import { CYNTHIA_ID, type GameData } from '../data';
import { type GenMon, mulberry32 } from '../generator/generate';
import { type AIState, applyTrainerItem, chooseAction, chooseReplacement, createAIState } from './ai';
import { applyRomOverrides, applyRomTypeOrder, cynthiaSets, playerSet } from './showdown';

export interface BattleConfig {
  /** Cynthia's level; null = her original ROM levels (60-66). Her species/moves/items never change. */
  cynthiaLevel: number | null;
  /** Override her AI flags (the ROM value 0x01 = Basic is used when undefined). */
  aiFlags?: number;
}
export const DEFAULT_CONFIG: BattleConfig = { cynthiaLevel: 76 };

/** One player-vs-Cynthia battle. The player (p1) is driven by `choose()`; Cynthia (p2) by the ROM AI. */
export class DailyBattle {
  readonly battle: Battle;
  readonly ai: AIState;
  private readonly aiFlags: number;
  private pendingItem: number | null = null;
  private cursor = 0;

  constructor(readonly data: GameData, team: GenMon[], seed: number, cfg: BattleConfig = DEFAULT_CONFIG) {
    applyRomOverrides(data);
    const rng = mulberry32(seed ^ 0x5eed);
    const prngSeed = [0, 0, 0, 0].map(() => Math.floor(rng() * 0x10000)).join(',') as `${number},${string}`;
    this.battle = new Battle({ formatid: 'gen4customgame' as any, seed: prngSeed });
    applyRomTypeOrder(this.battle, data);
    this.battle.setPlayer('p1', { name: 'Player', team: team.map(playerSet) });
    this.battle.setPlayer('p2', { name: 'Cynthia', team: cynthiaSets(data, cfg.cynthiaLevel) });
    const trainer = data.trainers[CYNTHIA_ID];
    this.aiFlags = cfg.aiFlags ?? trainer.aiFlags;
    this.ai = createAIState(trainer, seed);
    this.driveCynthia();
  }

  get ended() { return this.battle.ended; }
  get winner(): 'player' | 'cynthia' | null {
    if (!this.battle.ended) return null;
    return this.battle.winner === 'Player' ? 'player' : 'cynthia';
  }
  /** What the player must do now: 'move', 'switch' (forced, after a faint), or '' (nothing). */
  get needs(): 'move' | 'switch' | '' {
    return this.battle.ended ? '' : (this.battle.p1.requestState as 'move' | 'switch' | '');
  }

  /** Player choice in Showdown syntax: 'move 1'..'move 4' or 'switch 2'..'switch 6'. Returns false if illegal. */
  choose(choice: string): boolean {
    const p1 = this.battle.p1;
    if (this.battle.ended || !p1.choose(choice)) { p1.clearChoice(); return false; }
    this.driveCynthia();
    return true;
  }

  /** Protocol lines produced since the last call (for the UI / CLI). */
  takeLog(): string[] {
    const out = this.battle.log.slice(this.cursor);
    this.cursor = this.battle.log.length;
    return out;
  }

  /** Let Cynthia answer any pending request, and run turns while every side has chosen. */
  private driveCynthia() {
    const p2 = this.battle.p2;
    for (let guard = 0; guard < 16 && !this.battle.ended; guard++) {
      if (p2.requestState && !p2.isChoiceDone()) this.cynthiaChoose();
      if (!this.battle.allChoicesDone()) return;
      if (this.pendingItem !== null) { // Gen 4: trainer items are used at the start of the turn, before moves
        applyTrainerItem(this.battle, this.data, this.ai, this.pendingItem);
        this.pendingItem = null;
      }
      this.battle.commitChoices();
    }
  }

  private cynthiaChoose() {
    const p2 = this.battle.p2;
    if (p2.requestState === 'switch') {
      p2.choose(`switch ${chooseReplacement(this.battle, this.data, this.ai) + 1}`);
    } else if (p2.requestState === 'move') {
      const d = chooseAction(this.battle, this.data, this.ai, this.aiFlags);
      if (d.kind === 'move') p2.choose(`move ${d.slot + 1}`);
      else if (d.kind === 'switch') p2.choose(`switch ${d.slot + 1}`);
      else { this.pendingItem = d.item; p2.choice.actions.push({ choice: 'pass' } as any); }
    }
    if (!p2.isChoiceDone()) { p2.clearChoice(); p2.autoChoose(); } // illegal AI choice: never stall
  }
}
