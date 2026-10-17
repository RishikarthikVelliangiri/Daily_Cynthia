import './style.css';
import { type GameData, loadGameDataFromServer, MissingDataError } from './data';
import { DailyBattle, DEFAULT_CONFIG } from './battle/engine';
import { type DailyPuzzle, dailyPuzzle } from './generator/daily';
import { dateKey } from './generator/generate';
import { finishAttempt, loadDay, type Outcome, shareText, startAttempt } from './storage';
import { type AudioManifest, type GfxMeta, image, RomFont, Sound } from './ui/assets';
import { BattleScene } from './ui/battle-scene';
import { AnimPlayer } from './anim/player';
import { messageScreen, type MenuCtx, optionsScreen, resultScreen, type Settings, titleScreen } from './ui/menus';
import { DS } from './ui/screen';
import { walkIn } from './ui/walk-in';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SETTINGS_KEY = 'daily-champion:settings';

function loadSettings(): Settings {
  const def: Settings = { textSpeed: 'normal', muted: false, readable: false, trainer: 'lucas' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return def; }
}
function saveSettings(s: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  applySettings(s);
}
function applySettings(s: Settings) {
  document.body.classList.toggle('readable', s.readable);
  const mute = $<HTMLButtonElement>('mute');
  mute.setAttribute('aria-pressed', String(s.muted));
  mute.textContent = s.muted ? 'Sound off' : 'Sound on';
}

function transcript(line: string) {
  const log = $('transcript-log');
  const p = document.createElement('p');
  p.textContent = line;
  log.appendChild(p);
  while (log.children.length > 60) log.firstChild!.remove();
  log.scrollTop = log.scrollHeight;
}

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

async function boot() {
  const ds = new DS($('ds'));
  const settings = loadSettings();
  let data: GameData, meta: GfxMeta, font: RomFont, manifest: AudioManifest | null;
  try {
    const metaRes = await fetch('gfx/meta.json');
    if (!metaRes.ok || !(metaRes.headers.get('content-type') ?? '').includes('json')) throw new MissingDataError('gfx/meta.json');
    meta = await metaRes.json();
    data = await loadGameDataFromServer('');
    font = new RomFont(await image('gfx/font.png'), meta.font);
    manifest = await fetch('audio/manifest.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  } catch (e) {
    document.body.classList.add('no-data');
    $('setup').hidden = false;
    if (!(e instanceof MissingDataError)) console.error(e);
    return;
  }

  const sound = new Sound(manifest);
  sound.setMuted(settings.muted);
  ds.onGesture(() => sound.unlock());
  applySettings(settings);
  $('mute').addEventListener('click', () => { settings.muted = !settings.muted; sound.unlock(); sound.setMuted(settings.muted); saveSettings(settings); });
  $('readable').addEventListener('click', () => { settings.readable = !settings.readable; saveSettings(settings); });
  document.body.classList.add('powered');

  const anim = await AnimPlayer.load(sound);
  const ctx: MenuCtx = { ds, font, sound, meta };
  const previewMove = Number(new URLSearchParams(location.search).get('anim'));
  if (previewMove) {
    (window as any).__anim = anim; // dev inspection
    const p = dailyPuzzle(data, new Date());
    const engine = new DailyBattle(data, p.team, p.battleSeed, DEFAULT_CONFIG);
    await new BattleScene(ds, font, meta, sound, data, engine, { textSpeed: 'fast', playerName: 'Player', playerSprite: settings.trainer, anim }).preview(previewMove);
    return;
  }
  // The date is fixed when the page loads, so a battle that crosses UTC midnight still counts for its own day.
  const today = new Date();
  const date = dateKey(today);
  $('date').textContent = date;

  await messageScreen(ctx, 'PREPARING', ['Generating today’s team and', 'checking it can beat Cynthia…']);
  await new Promise(r => setTimeout(r, 30));
  const puzzle: DailyPuzzle = dailyPuzzle(data, today);

  for (;;) {
    const rec = loadDay(localStorage, date);
    const choice = await titleScreen(ctx, date, rec);
    if (choice === 'options') { await optionsScreen(ctx, settings, s => { sound.setMuted(s.muted); saveSettings(s); }); continue; }
    if (choice === 'result' && rec.scored) {
      const act = await resultScreen(ctx, { date, outcome: rec.scored, scored: true, rec, team: puzzle.team });
      if (act === 'share') await share(rec);
      if (act !== 'replay') continue;
    }
    // Battle loop (first = scored, then practice replays from the result screen).
    for (;;) {
      const { attempt, scored } = startAttempt(localStorage, date);
      transcript(scored ? '— Today’s scored battle —' : `— Practice battle (attempt ${attempt}) —`);
      await walkIn(ds, font, sound, data, { playerSprite: settings.trainer, textSpeed: settings.textSpeed, onText: transcript });
      const engine = new DailyBattle(data, puzzle.team, puzzle.battleSeed, DEFAULT_CONFIG);
      const scene = new BattleScene(ds, font, meta, sound, data, engine, {
        textSpeed: settings.textSpeed, playerName: 'Player', playerSprite: settings.trainer, onText: transcript, anim,
      });
      const winner = await scene.run();
      sound.stopBgm();
      const outcome = summarize(engine, puzzle, winner);
      const after = finishAttempt(localStorage, date, attempt, outcome);
      let act = await resultScreen(ctx, { date, outcome, scored, rec: after, team: puzzle.team });
      while (act === 'share') { await share(after); act = await resultScreen(ctx, { date, outcome, scored, rec: after, team: puzzle.team }); }
      if (act === 'title') break;
    }
  }
}

function summarize(engine: DailyBattle, puzzle: DailyPuzzle, winner: 'player' | 'cynthia'): Outcome {
  const b = engine.battle;
  const alive = (side: typeof b.p1, nums: number[]) => nums.map(n => side.pokemon.some(p => p.species.num === n && !p.fainted));
  return {
    result: winner === 'player' ? 'win' : 'loss',
    turns: b.turn,
    playerLeft: alive(b.p1, puzzle.team.map(m => m.species)),
    cynthiaLeft: alive(b.p2, engine.data.trainers[267].party.map(m => m.species)),
  };
}

async function share(rec: ReturnType<typeof loadDay>) {
  const text = shareText(rec);
  try { await navigator.clipboard.writeText(text); toast('Result copied to clipboard'); }
  catch { toast('Copy failed: select the text in the transcript'); transcript(text); }
}

void boot();
