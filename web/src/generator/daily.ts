import type { GameData } from '../data';
import { botChoice } from '../battle/bot';
import { type BattleConfig, DailyBattle, DEFAULT_CONFIG } from '../battle/engine';
import { DEFAULT_OPTIONS, type GenMon, type GenOptions, generateTeam, seedFromDate } from './generate';

export interface WinnabilityOptions { attempts: number; maxRerolls: number; maxTurns: number }
export const DEFAULT_WINNABILITY: WinnabilityOptions = { attempts: 4, maxRerolls: 20, maxTurns: 300 };

/** Play one battle with the greedy bot on the player side. */
export function botBattle(data: GameData, team: GenMon[], seed: number, cfg: BattleConfig = DEFAULT_CONFIG, maxTurns = 300) {
  const b = new DailyBattle(data, team, seed, cfg);
  while (!b.ended && b.battle.turn <= maxTurns) {
    if (!b.choose(botChoice(b.battle)) && !b.choose('default')) break;
  }
  return b;
}

/** Can the bot beat Cynthia with this team in any of `attempts` differently-seeded battles? */
export function isWinnable(data: GameData, team: GenMon[], seed: number, w = DEFAULT_WINNABILITY, cfg = DEFAULT_CONFIG) {
  for (let k = 0; k < w.attempts; k++) {
    if (botBattle(data, team, seed * 16 + k, cfg, w.maxTurns).winner === 'player') return true;
  }
  return false;
}

export interface DailyPuzzle { date: string; seed: number; battleSeed: number; rerolls: number; team: GenMon[] }

/** Today's puzzle: team from the date seed, deterministically rerolled (seed*100 + r) until the bot can win. */
export function dailyPuzzle(data: GameData, date: Date, opts: GenOptions = DEFAULT_OPTIONS,
  w = DEFAULT_WINNABILITY, cfg = DEFAULT_CONFIG): DailyPuzzle {
  const base = seedFromDate(date);
  let r = 0, seed = base, team = generateTeam(data, seed, opts);
  while (r < w.maxRerolls && !isWinnable(data, team, seed, w, cfg)) {
    r++;
    seed = base * 100 + r;
    team = generateTeam(data, seed, opts);
  }
  return { date: date.toISOString().slice(0, 10), seed, battleSeed: base, rerolls: r, team };
}
