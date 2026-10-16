import { beforeAll, describe, expect, it } from 'vitest';
import { type GameData, loadGameDataFromDisk } from '../data';
import { Translator } from './protocol';

let data: GameData;
beforeAll(async () => { data = await loadGameDataFromDisk(); });

describe('protocol translator (ROM text)', () => {
  it('builds DP messages for a typical exchange', () => {
    const tr = new Translator(data);
    const ev = tr.translate([
      '|switch|p1a: Gengar|Gengar, L76, M|224/224',
      '|switch|p2a: Spiritomb|Spiritomb, L76, F|100/100',
      '|turn|1',
      '|move|p2a: Spiritomb|Dark Pulse|p1a: Gengar',
      '|-supereffective|p1a: Gengar',
      '|split|p1', '|-damage|p1a: Gengar|50/224', '|-damage|p1a: Gengar|23/100',
      '|move|p1a: Gengar|Earthquake|p2a: Spiritomb',
      '|-crit|p2a: Spiritomb',
      '|split|p2', '|-damage|p2a: Spiritomb|0 fnt', '|-damage|p2a: Spiritomb|0 fnt',
      '|faint|p2a: Spiritomb',
      '|-unboost|p1a: Gengar|spa|2',
    ]);
    const texts = ev.filter(e => 'text' in e).map(e => (e as any).text);
    expect(texts).toEqual([
      'Go! GENGAR!',
      'Cynthia sent out\nSPIRITOMB!',
      'The foe’s SPIRITOMB used\nDark Pulse!',
      'It’s super effective!',
      'GENGAR used\nEarthquake!',
      'A critical hit!',
      'The foe’s SPIRITOMB fainted!\r',
      'GENGAR’s Sp. Atk\nharshly fell!',
    ]);
    const hp = ev.filter(e => e.t === 'hp') as any[];
    expect(hp[0]).toMatchObject({ side: 'p1', hp: 50, maxhp: 224, hit: 'super' }); // exact HP from the split line
    // effectiveness message comes after its HP drain
    const iHp = ev.indexOf(hp[0]);
    expect((ev[iHp + 1] as any).text).toBe('It’s super effective!');
  });

  it('item and status messages use the right templates', () => {
    const tr = new Translator(data);
    tr.translate(['|switch|p2a: Garchomp|Garchomp, L76, M|100/100', '|switch|p1a: Lapras|Lapras, L76, F|300/300']);
    const ev = tr.translate([
      '|-heal|p2a: Garchomp|60/100|[from] item: Sitrus Berry',
      '|-status|p1a: Lapras|par',
      '|cant|p1a: Lapras|par',
      '|-weather|Sandstorm|[upkeep]',
      '|-damage|p1a: Lapras|280/300|[from] Sandstorm',
    ]);
    const texts = ev.filter(e => 'text' in e).map(e => (e as any).text);
    expect(texts).toEqual([
      'The foe’s GARCHOMP restored its\nhealth using its Sitrus Berry!',
      'LAPRAS is paralyzed!\nIt may be unable to move!',
      'LAPRAS is paralyzed!\nIt can’t move!',
      'The sandstorm rages.',
      'LAPRAS is buffeted\nby the Sandstorm!',
    ]);
  });
});

describe('protocol translator: abilities, field effects, ordering', () => {
  it('uses the combined ROM lines for Intimidate, Aqua Ring, Pressure and crit-first ordering', () => {
    const tr = new Translator(data);
    tr.translate(['|switch|p1a: Gyarados|Gyarados, L76, M|300/300', '|switch|p2a: Milotic|Milotic, L76, F|100/100']);
    const ev = tr.translate([
      '|-ability|p1a: Gyarados|Intimidate|boost',
      '|-unboost|p2a: Milotic|atk|1',
      '|-ability|p2a: Milotic|Pressure',
      '|move|p2a: Milotic|Ice Beam|p1a: Gyarados',
      '|-resisted|p1a: Gyarados',
      '|-crit|p1a: Gyarados',
      '|-damage|p1a: Gyarados|250/300',
      '|-heal|p2a: Milotic|90/100|[from] Aqua Ring',
    ]);
    const texts = ev.filter(e => 'text' in e).map(e => (e as any).text.replace(/[\n\f]/g, ' '));
    expect(texts).toEqual([
      'GYARADOS’s Intimidate cuts the foe’s MILOTIC’s Attack!',
      'The foe’s MILOTIC is exerting its Pressure!',
      'The foe’s MILOTIC used Ice Beam!',
      'A critical hit!',
      'It’s not very effective...',
      'Aqua Ring restored the foe’s MILOTIC’s HP!',
    ]);
  });
});
