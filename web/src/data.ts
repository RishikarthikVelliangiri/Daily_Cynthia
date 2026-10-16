// ROM-derived game data (written by `python -m tools.extract` into extracted/). Never bundled.

export interface Species {
  id: number; name: string;
  baseStats: { hp: number; atk: number; def: number; spe: number; spa: number; spd: number };
  types: string[]; catchRate: number; genderRatio: number; growth: string; eggGroups: number[];
  abilities: string[];
}
export interface Move {
  id: number; name: string; effect: number; category: 'Physical' | 'Special' | 'Status';
  power: number; type: string; accuracy: number; pp: number; effectChance: number;
  target: number; priority: number; flags: number;
}
export interface Learnset { levelUp: [number, number][]; tm: number[]; egg: number[] }
export interface Evolution { method: number; param: number; target: number }
export interface Item { id: number; name: string; price: number; holdEffect: number; holdParam: number; healAmount: number }
export interface TrainerMon {
  species: number; form: number; level: number; difficulty: number; item: number; moves: number[];
  nature?: string; abilitySlot?: number; iv?: number; pid?: number;
}
export interface Trainer {
  id: number; name: string; class: string; classId: number; items: number[]; aiFlags: number;
  battleType: number; party: TrainerMon[];
}
export interface GameText {
  battle: string[]; champion_room: string[]; trainer_classes: string[]; types: string[];
  move_descriptions: string[]; battle_ui: string[]; move_use: string[]; stats: string[];
  cynthia: Record<string, string>;
}
export interface GameData {
  species: Species[]; moves: Move[]; learnsets: Learnset[]; evolutions: Evolution[][];
  items: Item[]; trainers: Trainer[]; text: GameText;
  typechart: { atk: string; def: string; mult: number; foresightOnly: boolean }[];
  aiSeq: Uint8Array;
}

export const CYNTHIA_ID = 267;

export class MissingDataError extends Error {
  constructor(what: string) {
    super(`Missing extracted ROM data (${what}). Run: python -m tools.extract path/to/diamond.nds`);
  }
}

const JSON_FILES = ['species', 'moves', 'learnsets', 'evolutions', 'items', 'trainers', 'text', 'typechart'] as const;

/** Loads extracted data. `read(path)` returns file bytes (fetch in the browser, fs in node) or null. */
export async function loadGameData(read: (path: string) => Promise<Uint8Array | null>): Promise<GameData> {
  const out: Record<string, unknown> = {};
  const dec = new TextDecoder();
  for (const f of JSON_FILES) {
    const b = await read(`data/${f}.json`);
    if (!b) throw new MissingDataError(`data/${f}.json`);
    out[f] = JSON.parse(dec.decode(b));
  }
  const ai = await read('data/tr_ai_seq.bin');
  if (!ai) throw new MissingDataError('data/tr_ai_seq.bin');
  out.aiSeq = ai;
  return out as unknown as GameData;
}

/** Node loader (tests, CLI). */
export async function loadGameDataFromDisk(root?: string): Promise<GameData> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const dir = root ?? path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../extracted');
  return loadGameData(async p => {
    try { return new Uint8Array(await fs.readFile(path.join(dir, p))); } catch { return null; }
  });
}

/** Browser loader. */
export function loadGameDataFromServer(base = ''): Promise<GameData> {
  return loadGameData(async p => {
    const r = await fetch(`${base}${p}`);
    if (!r.ok) return null;
    // Vite's dev server returns index.html for unknown paths; treat HTML as missing.
    if ((r.headers.get('content-type') ?? '').includes('text/html')) return null;
    return new Uint8Array(await r.arrayBuffer());
  });
}
