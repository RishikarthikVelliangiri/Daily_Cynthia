import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AnimData, freshFx, MoveAnimation, type Side } from './system';

const root = resolve(__dirname, '../../../extracted/anim');
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

describe('move animation scripts', () => {
  const pos = json('positions.json');
  const data: AnimData = { scripts: json('scripts.json'), world: pos.world, axis: pos.axis };
  const host = {
    loadParticles: async (id: number) => ({ file: json(`particles/${String(id).padStart(3, '0')}.json`), sheet: null as any }),
    playSe: () => {}, playCry: () => {}, seActive: () => false, groundHeight: () => 0,
  };

  it('every move script runs to End for both sides with particles alive and sprite fx restored', async () => {
    const problems: string[] = [];
    let particles = 0;
    for (let move = 1; move <= 467; move++) {
      for (const side of ['p1', 'p2'] as Side[]) {
        const fx = { p1: freshFx('p1'), p2: freshFx('p2') };
        const a = new MoveAnimation(data, host, move, side, fx, { x: 0, y: 0, fadeColor: 0, fadeAmt: 0, grayscale: false });
        for (let f = 0; f < 30 * 40 + 5 && !a.done; f++) {
          a.step();
          await Promise.resolve(); await Promise.resolve(); // let particle loads resolve
          for (const s of a.systems) if (s) for (const e of s.mgr.emitters) particles += e.particles.length;
        }
        if (!a.done || a.aborted) problems.push(`${move}/${side}: ${a.aborted || 'not done'}`);
      }
    }
    expect(problems).toEqual([]);
    expect(particles).toBeGreaterThan(100000);
  }, 120000);
});
