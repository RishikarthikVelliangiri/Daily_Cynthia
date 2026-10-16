// Dev aid for fairness tuning: KO distribution + win rate per generator setting. `npx tsx scripts/tune.ts [N]`
import { loadGameDataFromDisk } from '../src/data';
import { botBattle } from '../src/generator/daily';
import { DEFAULT_OPTIONS, type GenOptions, generateTeam } from '../src/generator/generate';

const data = await loadGameDataFromDisk();
const n = Number(process.argv[2] ?? 40);
const variants: [string, Partial<GenOptions>, number | null][] = [
  ['default', {}, 76],
  ['evs 85', { evs: 85 }, 76],
  ['3 dmg moves + evs 85', { evs: 85, minDamagingMoves: 3 }, 76],
  ['cynthia rom levels', {}, null],
];
for (const [name, o, lvl] of variants) {
  let wins = 0, kos = 0;
  const hist = new Array(7).fill(0);
  for (let i = 0; i < n; i++) {
    const team = generateTeam(data, 20261016 + i, { ...DEFAULT_OPTIONS, ...o });
    const b = botBattle(data, team, i, { cynthiaLevel: lvl });
    const ko = b.battle.p2.pokemon.filter(p => p.fainted).length;
    hist[ko]++; kos += ko; if (b.winner === 'player') wins++;
  }
  console.log(`${name.padEnd(26)} win ${(100 * wins / n).toFixed(0)}%  avg KOs ${(kos / n).toFixed(2)}  hist ${hist.join(' ')}`);
}
