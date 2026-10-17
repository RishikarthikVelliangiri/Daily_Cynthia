import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AnimData, freshFx, implementedFuncs, MoveAnimation, type Side } from './system';

const root = resolve(__dirname, '../../../extracted/anim');
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

/** Opcode argument counts (tools/extract/anim.py ARGC); 45/55/78 carry their own counts. */
const ARGC: Record<number, number> = { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 1, 8: 2, 9: 0, 10: 1, 11: 0, 12: 2, 13: 2, 14: 2, 15: 1, 16: 2, 17: 2,
  18: 2, 19: 0, 20: 0, 21: 1, 22: 2, 23: 1, 24: 5, 25: 4, 26: 3, 29: 0, 30: 3, 31: 2, 32: 1, 33: 1, 34: 3, 35: 5, 36: 5, 44: 1, 46: 3,
  47: 4, 48: 8, 49: 6, 50: 0, 51: 2, 52: 3, 53: 1, 56: 0, 57: 1, 58: 4, 59: 0, 60: 1, 61: 1, 62: 2, 63: 2, 64: 3, 65: 3, 66: 1, 67: 0,
  68: 1, 69: 1, 70: 5, 71: 1, 72: 1, 73: 8, 74: 2, 75: 3, 76: 2, 77: 2, 79: 8, 80: 1, 81: 2, 82: 3, 83: 1, 84: 0 };
function funcsUsed(w: number[]) {
  const funcs: number[] = [], sprites: number[] = [];
  for (let i = 0; i < w.length;) {
    const op = w[i];
    if (op === 45) { funcs.push(w[i + 1]); i += 3 + w[i + 2]; } else if (op === 55) i += 2 + w[i + 1];
    else if (op === 78) { sprites.push(w[i + 2]); i += 10 + w[i + 9]; } else i += 1 + (ARGC[op] ?? 0);
  }
  return { funcs, sprites };
}

describe('move animation scripts', () => {
  const pos = json('positions.json');
  const data: AnimData = { scripts: json('scripts.json'), sub: json('sub.json'), world: pos.world, axis: pos.axis };
  const host = {
    loadParticles: async (id: number) => ({ file: json(`particles/${String(id).padStart(3, '0')}.json`), sheet: null as any }),
    playSe: () => {}, playCry: () => {}, seActive: () => false, groundHeight: () => 0, animLength: () => 12,
  };

  it('every move and common animation has all its script functions ported', () => {
    const have = implementedFuncs();
    const missing: string[] = [];
    const scripts = [...data.scripts.slice(1, 468).map((w, i) => [`move ${i + 1}`, w] as const), ...data.sub!.map((w, i) => [`sub ${i}`, w] as const)];
    for (const [name, w] of scripts) {
      const u = funcsUsed(w);
      for (const f of u.funcs) if (!have.funcs.has(f)) missing.push(`${name}: func ${f}`);
      for (const f of u.sprites) if (!have.sprites.has(f)) missing.push(`${name}: sprite func ${f}`);
    }
    expect(missing).toEqual([]);
  });

  async function runAll(ids: (number | { sub: number })[]) {
    const problems: string[] = [];
    let particles = 0;
    for (const id of ids) {
      for (const side of ['p1', 'p2'] as Side[]) {
        const fx = { p1: freshFx('p1'), p2: freshFx('p2') };
        const a = new MoveAnimation(data, host, id, side, fx, { x: 0, y: 0, fadeColor: 0, fadeAmt: 0, grayscale: false });
        for (let f = 0; f < 30 * 40 + 5 && !a.done; f++) {
          a.step();
          await Promise.resolve(); await Promise.resolve(); // let particle loads resolve
          for (const s of a.systems) if (s) for (const e of s.mgr.emitters) particles += e.particles.length;
        }
        if (!a.done || a.aborted) problems.push(`${JSON.stringify(id)}/${side}: ${a.aborted || 'not done'}`);
      }
    }
    return { problems, particles };
  }

  it('every move script runs to End for both sides with particles alive', async () => {
    const { problems, particles } = await runAll(Array.from({ length: 467 }, (_, i) => i + 1));
    expect(problems).toEqual([]);
    expect(particles).toBeGreaterThan(100000);
  }, 180000);

  it('every common animation (status, stat change, weather) runs to End', async () => {
    const { problems } = await runAll(Array.from({ length: 41 }, (_, i) => ({ sub: i })));
    expect(problems).toEqual([]);
  }, 60000);
});
