// Winnability report: `npm run passrate -- [N=1000] [--attempts 4]`.
// For N consecutive date seeds: how often the raw generated team can beat Cynthia with the greedy bot.
import { loadGameDataFromDisk } from '../src/data';
import { DEFAULT_WINNABILITY, isWinnable } from '../src/generator/daily';
import { generateTeam } from '../src/generator/generate';

const args = process.argv.slice(2);
const n = Number(args.find(a => /^\d+$/.test(a)) ?? 1000);
const attempts = args.includes('--attempts') ? Number(args[args.indexOf('--attempts') + 1]) : DEFAULT_WINNABILITY.attempts;
const data = await loadGameDataFromDisk();
let pass = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const d = new Date(Date.UTC(2026, 9, 16) + i * 86400000);
  const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  if (isWinnable(data, generateTeam(data, seed), seed, { ...DEFAULT_WINNABILITY, attempts })) pass++;
  if ((i + 1) % 100 === 0) console.log(`${i + 1}/${n}  pass ${(100 * pass / (i + 1)).toFixed(1)}%  (${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/seed)`);
}
console.log(`\nRaw pass rate over ${n} seeds (bot wins at least 1 of ${attempts}): ${(100 * pass / n).toFixed(1)}%`);
console.log(`Days needing a reroll: ${(100 * (n - pass) / n).toFixed(1)}%`);
