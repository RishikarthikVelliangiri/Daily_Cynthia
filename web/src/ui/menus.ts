// Title, options and result screens, drawn on the DS screens with the ROM font and DP-style touch buttons.
import type { GenMon } from '../generator/generate';
import type { DayRecord, Outcome } from '../storage';
import { dayNumber } from '../storage';
import { type GfxMeta, image, pokemonSprite, type RomFont, type Sound, STYLE_DARK, STYLE_LIGHT, type TextStyle } from './assets';
import { type DS, H, W } from './screen';
import { bigText, button, centered, hit, type Rect, textWindow } from './widgets';

export interface Settings { textSpeed: 'normal' | 'fast'; muted: boolean; readable: boolean; trainer: 'lucas' | 'dawn' }
export interface MenuCtx { ds: DS; font: RomFont; sound: Sound; meta: GfxMeta }

/** A fresh menu ignores input briefly, so the click that opened it can't also pick an entry. */
export const MENU_GUARD_MS = 300;

const GOLD: TextStyle = { color: '#f8e080', shadow: '#705818' };
interface Btn { rect: Rect; label: string; color: string; id: string; sub?: string }

/** Shows buttons on the bottom screen; resolves with the chosen id. Arrows move focus, A/tap selects, B = `back`. */
async function pick(ctx: MenuCtx, btns: Btn[], back?: string, drawTop?: () => void): Promise<string> {
  const { ds, font, sound } = ctx;
  let focus = 0;
  const bg = await image('gfx/battle/touch_idle.png');
  const render = () => {
    drawTop?.();
    const g = ds.bottom;
    g.clearRect(0, 0, W, H);
    g.drawImage(bg, 0, 0);
    g.fillStyle = 'rgba(16,24,32,0.5)'; g.fillRect(0, 0, W, H);
    btns.forEach((b, i) => {
      button(g, b.rect, b.color, i === focus);
      const y = b.rect.y + b.rect.h / 2 - (b.sub ? 15 : 8);
      font.draw(g, b.label, b.rect.x + (b.rect.w - font.width(b.label)) / 2, y, STYLE_LIGHT);
      if (b.sub) font.draw(g, b.sub, b.rect.x + (b.rect.w - font.width(b.sub)) / 2, y + 15, STYLE_LIGHT);
    });
  };
  render();
  ds.block(MENU_GUARD_MS);
  for (;;) {
    const i = await ds.next();
    if ('tap' in i) {
      const k = btns.findIndex(b => hit(b.rect, i.tap));
      if (k >= 0) { void sound.playSe('se_select'); return btns[k].id; }
      continue;
    }
    if (i.key === 'a') { void sound.playSe('se_select'); return btns[focus].id; }
    if (i.key === 'b' && back) return back;
    if (i.key === 'up' || i.key === 'left') focus = (focus + btns.length - 1) % btns.length;
    if (i.key === 'down' || i.key === 'right') focus = (focus + 1) % btns.length;
    void sound.playSe('se_cursor');
    render();
  }
}

async function drawStage(ctx: MenuCtx) {
  const g = ctx.ds.top;
  g.drawImage(await image(`gfx/battle/${ctx.meta.championBg}`), 0, 0);
  g.fillStyle = 'rgba(10,14,40,0.35)'; g.fillRect(0, 0, W, H);
}

export async function titleScreen(ctx: MenuCtx, date: string, rec: DayRecord): Promise<'battle' | 'result' | 'options'> {
  const { ds, font } = ctx;
  await drawStage(ctx);
  const cyn = await image('gfx/trainers/cynthia.png');
  const plat = await image('gfx/battle/platform_enemy.png');
  const drawTop = () => {
    const g = ds.top;
    g.drawImage(plat, 192 + ctx.meta.platform_enemy.originX, 104 + ctx.meta.platform_enemy.originY);
    g.drawImage(cyn, 0, 0, 80, 80, 152, 28, 80, 80);
    bigText(g, font, 'DAILY', 14, 26, 2, GOLD);
    bigText(g, font, 'CYNTHIA', 14, 54, 2, GOLD);
    font.draw(g, `No. ${dayNumber(date)}  ·  ${date}`, 16, 92, STYLE_LIGHT);
    textWindow(g, { x: 2, y: 142, w: 252, h: 48 });
    const status = rec.scored
      ? rec.scored.result === 'win' ? 'You beat Cynthia today!' : 'Cynthia won today’s battle.'
      : 'Champion Cynthia is waiting.';
    font.draw(g, status, 12, 149, STYLE_DARK);
    font.draw(g, rec.scored ? 'Replays are practice only.' : 'Your first battle is the scored one.', 12, 165, STYLE_DARK);
  };
  const btns: Btn[] = rec.scored
    ? [{ rect: { x: 16, y: 16, w: 224, h: 72 }, label: 'TODAY’S RESULT', color: '#d84838', id: 'result' },
       { rect: { x: 16, y: 96, w: 224, h: 44 }, label: 'PRACTICE BATTLE', color: '#3878d8', id: 'battle' },
       { rect: { x: 64, y: 148, w: 128, h: 36 }, label: 'OPTIONS', color: '#606870', id: 'options' }]
    : [{ rect: { x: 16, y: 16, w: 224, h: 112 }, label: 'BATTLE!', sub: 'Scored attempt', color: '#d84838', id: 'battle' },
       { rect: { x: 64, y: 140, w: 128, h: 40 }, label: 'OPTIONS', color: '#606870', id: 'options' }];
  return (await pick(ctx, btns, undefined, drawTop)) as 'battle' | 'result' | 'options';
}

export async function optionsScreen(ctx: MenuCtx, s: Settings, onChange: (s: Settings) => void) {
  for (;;) {
    await drawStage(ctx);
    const g = ctx.ds.top;
    bigText(g, ctx.font, 'OPTIONS', centered(ctx.font, 'OPTIONS', 2), 24, 2, GOLD);
    const lines = ['Z / Enter: A    X / Esc: B', 'Arrow keys move the cursor.', 'Tap or click the lower screen.'];
    lines.forEach((l, i) => ctx.font.draw(g, l, 24, 80 + i * 18, STYLE_LIGHT));
    const row = (k: number): Rect => ({ x: 8, y: 6 + k * 38, w: 240, h: 34 });
    const id = await pick(ctx, [
      { rect: row(0), label: `TEXT SPEED: ${s.textSpeed === 'fast' ? 'FAST' : 'NORMAL'}`, color: '#4c8c58', id: 'speed' },
      { rect: row(1), label: `SOUND: ${s.muted ? 'OFF' : 'ON'}`, color: '#4c8c58', id: 'sound' },
      { rect: row(2), label: `READABLE TEXT: ${s.readable ? 'ON' : 'OFF'}`, color: '#4c8c58', id: 'readable' },
      { rect: row(3), label: `TRAINER: ${s.trainer === 'lucas' ? 'LUCAS' : 'DAWN'}`, color: '#4c8c58', id: 'trainer' },
      { rect: { x: 64, y: 158, w: 128, h: 30 }, label: 'BACK', color: '#606870', id: 'back' },
    ], 'back');
    if (id === 'back') return;
    if (id === 'speed') s.textSpeed = s.textSpeed === 'fast' ? 'normal' : 'fast';
    if (id === 'sound') s.muted = !s.muted;
    if (id === 'readable') s.readable = !s.readable;
    if (id === 'trainer') s.trainer = s.trainer === 'lucas' ? 'dawn' : 'lucas';
    onChange(s);
  }
}

export interface ResultInfo { date: string; outcome: Outcome; scored: boolean; rec: DayRecord; team: GenMon[] }

export async function resultScreen(ctx: MenuCtx, r: ResultInfo): Promise<'share' | 'replay' | 'title'> {
  const { ds, font } = ctx;
  const sprites = await Promise.all(r.team.map(m => image(pokemonSprite(m.species, false)).catch(() => null)));
  const ball = (g: CanvasRenderingContext2D, x: number, y: number, up: boolean) => {
    g.fillStyle = '#202020'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = up ? '#e04040' : '#585858'; g.beginPath(); g.arc(x, y, 5, Math.PI, 0); g.fill();
    g.fillStyle = up ? '#f8f8f8' : '#909090'; g.beginPath(); g.arc(x, y, 5, 0, Math.PI); g.fill();
    g.fillStyle = '#202020'; g.fillRect(x - 5, y - 1, 10, 2);
    g.fillStyle = '#f8f8f8'; g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.fill();
  };
  const drawTop = () => {
    const g = ds.top;
    const win = r.outcome.result === 'win';
    const head = win ? 'VICTORY!' : 'DEFEATED…';
    bigText(g, font, head, centered(font, head, 2), 8, 2, win ? GOLD : { color: '#f8a8a8', shadow: '#602020' });
    font.draw(g, r.scored ? 'Today’s scored battle' : 'Practice battle (not scored)', centered(font, r.scored ? 'Today’s scored battle' : 'Practice battle (not scored)'), 42, STYLE_LIGHT);
    // Player party: fainted members dimmed.
    r.team.forEach((m, i) => {
      const x = 8 + i * 41, y = 62;
      g.fillStyle = 'rgba(8,12,32,0.55)'; g.fillRect(x, y, 40, 40);
      const s = sprites[i];
      if (s) {
        g.globalAlpha = r.outcome.playerLeft[i] ? 1 : 0.3;
        g.drawImage(s, 0, 0, 80, 80, x, y, 40, 40);
        g.globalAlpha = 1;
      }
    });
    font.draw(g, 'CYNTHIA', 16, 110, STYLE_LIGHT);
    r.outcome.cynthiaLeft.forEach((up, i) => ball(g, 100 + i * 16, 118, up));
    textWindow(g, { x: 2, y: 142, w: 252, h: 48 });
    font.draw(g, `${r.outcome.turns} turns   ·   attempt ${r.rec.attempts}`, 12, 149, STYLE_DARK);
    const sc = r.rec.scored;
    font.draw(g, sc ? `Scored result: ${sc.result === 'win' ? 'WIN' : 'LOSS'}` : 'Scored result pending', 12, 165, STYLE_DARK);
  };
  await drawStage(ctx);
  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  base.getContext('2d')!.drawImage(ds.top.canvas, 0, 0);
  const top = () => { ds.top.drawImage(base, 0, 0); drawTop(); };
  return (await pick(ctx, [
    { rect: { x: 16, y: 16, w: 224, h: 64 }, label: 'SHARE RESULT', sub: 'Copies a spoiler-free summary', color: '#d84838', id: 'share' },
    { rect: { x: 16, y: 88, w: 224, h: 48 }, label: 'BATTLE AGAIN (PRACTICE)', color: '#3878d8', id: 'replay' },
    { rect: { x: 64, y: 146, w: 128, h: 38 }, label: 'TITLE', color: '#606870', id: 'title' },
  ], 'title', top)) as 'share' | 'replay' | 'title';
}

export async function messageScreen(ctx: MenuCtx, title: string, lines: string[]) {
  await drawStage(ctx);
  const g = ctx.ds.top;
  bigText(g, ctx.font, title, centered(ctx.font, title, 2), 20, 2, GOLD);
  lines.forEach((l, i) => ctx.font.draw(g, l, 16, 64 + i * 16, STYLE_LIGHT));
}
