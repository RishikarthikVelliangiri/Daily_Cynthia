import { describe, expect, it } from 'vitest';
import { dayNumber, finishAttempt, loadDay, shareText, startAttempt } from './storage';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }
const outcome = (result: 'win' | 'loss') => ({ result, turns: 23, playerLeft: [true, false, true, false, false, true], cynthiaLeft: [false, false, false, false, false, result === 'loss'] });

describe('daily record', () => {
  it('first attempt is scored, replays are practice', () => {
    const s = new Mem();
    const a = startAttempt(s, '2026-10-16');
    expect(a.scored).toBe(true);
    finishAttempt(s, '2026-10-16', a.attempt, outcome('loss'));
    const b = startAttempt(s, '2026-10-16');
    expect(b.scored).toBe(false);
    finishAttempt(s, '2026-10-16', b.attempt, outcome('win'));
    const rec = loadDay(s, '2026-10-16');
    expect(rec.attempts).toBe(2);
    expect(rec.scored?.result).toBe('loss'); // practice win does not change the score
    expect(rec.practiceWins).toBe(1);
  });

  it('leaving mid-way through the scored attempt counts it as a loss', () => {
    const s = new Mem();
    startAttempt(s, '2026-10-16');
    const rec = loadDay(s, '2026-10-16'); // page reloaded, battle never finished
    expect(rec.scored).toMatchObject({ result: 'loss', abandoned: true });
    expect(startAttempt(s, '2026-10-16').scored).toBe(false);
  });

  it('days are independent', () => {
    const s = new Mem();
    finishAttempt(s, '2026-10-16', startAttempt(s, '2026-10-16').attempt, outcome('win'));
    expect(startAttempt(s, '2026-10-17').scored).toBe(true);
  });

  it('share text is spoiler-free', () => {
    const s = new Mem();
    finishAttempt(s, '2026-10-16', startAttempt(s, '2026-10-16').attempt, outcome('win'));
    const t = shareText(loadDay(s, '2026-10-16'));
    expect(t).toContain(`Daily Champion #${dayNumber('2026-10-16')}`);
    expect(t).toContain('🟩⬛🟩⬛⬛🟩');
    expect(t).toContain('23 turns');
    expect(t).not.toMatch(/Garchomp|Spiritomb/i);
  });
});
