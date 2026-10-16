// Per-day results in localStorage. The first attempt of a UTC day is the scored one.

export interface Outcome { result: 'win' | 'loss'; turns: number; playerLeft: boolean[]; cynthiaLeft: boolean[] }
export interface DayRecord {
  date: string;
  attempts: number;
  /** The scored (first) attempt; null until it finishes. */
  scored: (Outcome & { abandoned?: boolean }) | null;
  /** True while the scored attempt is in progress. */
  pending: boolean;
  practiceWins: number;
}
type Store = Pick<Storage, 'getItem' | 'setItem'>;

const key = (date: string) => `daily-champion:v1:${date}`;
const LAUNCH = Date.UTC(2026, 9, 16); // 2026-10-16 = #1

export function dayNumber(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - LAUNCH) / 86400000) + 1;
}

function read(s: Store, date: string): DayRecord {
  try {
    const raw = s.getItem(key(date));
    if (raw) return JSON.parse(raw) as DayRecord;
  } catch { /* corrupted or blocked storage: start fresh */ }
  return { date, attempts: 0, scored: null, pending: false, practiceWins: 0 };
}
function write(s: Store, rec: DayRecord) {
  try { s.setItem(key(rec.date), JSON.stringify(rec)); } catch { /* storage full/blocked: play still works */ }
}

/** Loads the day. A scored attempt left pending (tab closed mid-battle) is settled as a loss. */
export function loadDay(s: Store, date: string): DayRecord {
  const rec = read(s, date);
  if (rec.pending && !rec.scored) {
    rec.pending = false;
    rec.scored = { result: 'loss', turns: 0, playerLeft: [], cynthiaLeft: [], abandoned: true };
    write(s, rec);
  }
  return rec;
}

/** Call when a battle begins. Recording before the battle makes the scored attempt count even if abandoned. */
export function startAttempt(s: Store, date: string): { attempt: number; scored: boolean } {
  const rec = loadDay(s, date);
  rec.attempts++;
  const scored = rec.attempts === 1;
  if (scored) rec.pending = true;
  write(s, rec);
  return { attempt: rec.attempts, scored };
}

export function finishAttempt(s: Store, date: string, attempt: number, o: Outcome): DayRecord {
  const rec = read(s, date);
  if (attempt === 1 && !rec.scored) { rec.scored = o; rec.pending = false; }
  else if (o.result === 'win') rec.practiceWins++;
  write(s, rec);
  return rec;
}

const mark = (alive: boolean[]) => alive.map(a => (a ? '🟩' : '⬛')).join('');

/** Spoiler-free summary: outcome, which party slots were still standing, turns. */
export function shareText(rec: DayRecord): string {
  const n = dayNumber(rec.date);
  const sc = rec.scored;
  if (!sc) return `Daily Champion #${n} · ${rec.date}\nIn progress…`;
  const head = sc.result === 'win' ? '🏆 Defeated Champion Cynthia' : sc.abandoned ? '🏳️ Left the battle' : '💥 Lost to Champion Cynthia';
  const lines = [`Daily Champion #${n} · ${rec.date}`, head];
  if (sc.playerLeft.length) lines.push(`Me      ${mark(sc.playerLeft)}`, `Cynthia ${mark(sc.cynthiaLeft)}`, `${sc.turns} turns`);
  if (rec.attempts > 1) lines.push(`Attempts today: ${rec.attempts}`);
  return lines.join('\n');
}
