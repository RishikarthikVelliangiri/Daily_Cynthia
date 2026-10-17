// Headless battle for a date: `npm run sim -- 2026-10-16 [--level 76|rom] [--seed N]`. Prints the team and the log.
import { loadGameDataFromDisk } from '../src/data';
import { botChoice } from '../src/battle/bot';
import { DailyBattle } from '../src/battle/engine';
import { Translator } from '../src/battle/protocol';
import { dailyPuzzle } from '../src/generator/daily';

const args = process.argv.slice(2);
const date = new Date(`${args.find(a => /^\d{4}-\d\d-\d\d$/.test(a)) ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const lvArg = args[args.indexOf('--level') + 1];
const cynthiaLevel = args.includes('--level') ? (lvArg === 'rom' ? null : Number(lvArg)) : 76;
const data = await loadGameDataFromDisk();
const puzzle = dailyPuzzle(data, date);
console.log(`Daily Cynthia ${puzzle.date}  seed ${puzzle.seed}  rerolls ${puzzle.rerolls}`);
for (const m of puzzle.team) {
  console.log(`  Lv${m.level} ${data.species[m.species].name.padEnd(11)} [${m.ability}] ${m.moves.map(id => data.moves[id].name).join(' / ')}`);
}
const seed = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : puzzle.battleSeed;
const b = new DailyBattle(data, puzzle.team, seed, { cynthiaLevel });
const tr = new Translator(data);
const print = () => {
  for (const e of tr.translate(b.takeLog())) {
    if ('text' in e) console.log('  ' + e.text.replace(/[\r\f\n]+/g, ' ').trim());
    else if (e.t === 'turn') console.log(`\n== Turn ${e.n} ==`);
    else if (e.t === 'hp') console.log(`    [${e.side} HP ${e.hp}/${e.maxhp}]`);
  }
};
print();
while (!b.ended && b.battle.turn < 300) {
  if (!b.choose(botChoice(b.battle)) && !b.choose('default')) break;
  print();
}
console.log(`\nWinner: ${b.winner} after ${b.battle.turn} turns`);
