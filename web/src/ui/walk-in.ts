// Walk-in: the player walks up the Champion's room to Cynthia, she speaks (ROM text), then the battle
// transition. The Champion room itself is a 3D NSBMD map in the ROM; it is drawn here as a 2D
// approximation in code (see docs/deviations.md). Characters, music and dialogue are extracted from the ROM.
import type { GameData } from '../data';
import { image, type RomFont, type Sound, STYLE_DARK } from './assets';
import { type DS, H, sleep, W } from './screen';
import { textWindow } from './widgets';

const T = 16;              // tile size
const ROOM_W = 15, ROOM_H = 20;
const CYNTHIA = { x: 7, y: 3 };
const START_Y = 18, STOP_Y = 5;

export interface WalkInOptions { playerSprite: 'lucas' | 'dawn'; textSpeed: 'normal' | 'fast'; onText?: (s: string) => void }

export async function walkIn(ds: DS, font: RomFont, sound: Sound, data: GameData, opts: WalkInOptions) {
  const player = await image(`gfx/overworld/${opts.playerSprite}.png`);
  const cynthia = await image('gfx/overworld/cynthia.png');
  let py = START_Y * T, frame = 0, text: string[] = [], skip = false, alive = true;
  sound.playBgm('champion_room');

  const draw = () => {
    const g = ds.top;
    const camY = Math.max(0, Math.min(ROOM_H * T - H, py - 112));
    const ox = (W - ROOM_W * T) / 2;
    g.fillStyle = '#10142a'; g.fillRect(0, 0, W, H);
    g.save(); g.translate(ox, -camY);
    drawRoom(g);
    g.drawImage(cynthia, 4 * 32, 0, 32, 32, CYNTHIA.x * T - 8, CYNTHIA.y * T - 16, 32, 32); // facing down
    g.drawImage(player, frame * 32, 0, 32, 32, 7 * T - 8, py - 16, 32, 32);                 // facing up
    g.restore();
    if (text.length) {
      textWindow(g, { x: 2, y: 142, w: 252, h: 48 });
      text.forEach((l, i) => font.draw(g, l, 12, 149 + i * 16, STYLE_DARK));
    }
    drawPoketch(ds.bottom, font);
  };
  const loop = () => { if (!alive) return; draw(); requestAnimationFrame(loop); };
  loop();

  // Walk north one tile at a time: 16 px over 16 frames, alternating step frames (stand, left, stand, right).
  for (let ty = START_Y; ty > STOP_Y && !skip; ty--) {
    for (let k = 1; k <= 8; k++) {
      py = ty * T - k * 2;
      frame = k < 5 ? (ty % 2 ? 1 : 3) : 0;
      const i = await ds.nextOrTimeout(16); // B skips the walk
      if (i && 'key' in i && i.key === 'b') skip = true;
    }
  }
  py = STOP_Y * T; frame = 0;
  ds.clearInput();

  // Cynthia's speech (msg archive 180 #0), paged like the overworld: \r / \f wait for A.
  sound.playBgm('encounter_champion');
  const speech = data.text.champion_room[0];
  opts.onText?.(speech.replace(/[\r\f]/g, '\n'));
  for (const page of speech.split(/[\r\f]/).filter(p => p.trim())) {
    const lines = page.split('\n');
    text = lines.map(() => '');
    for (let li = 0; li < lines.length; li++) {
      for (let ci = 1; ci <= lines[li].length; ci++) { text[li] = lines[li].slice(0, ci); if (opts.textSpeed !== 'fast') await sleep(22); }
    }
    for (;;) { const i = await ds.next(); if ('tap' in i || i.key === 'a' || i.key === 'b') break; }
  }
  text = [];
  alive = false;
  await battleTransition(ds);
}

function drawRoom(g: CanvasRenderingContext2D) {
  // Floor: dark League stone with bevelled tiles.
  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    g.fillStyle = (x + y) % 2 ? '#2b3163' : '#283058';
    g.fillRect(x * T, y * T, T, T);
    g.fillStyle = '#353d75'; g.fillRect(x * T, y * T, T, 1);
    g.fillStyle = '#1d2245'; g.fillRect(x * T, y * T + T - 1, T, 1);
  }
  // Back wall.
  const wall = g.createLinearGradient(0, 0, 0, 2 * T);
  wall.addColorStop(0, '#0d1024'); wall.addColorStop(1, '#3a4282');
  g.fillStyle = wall; g.fillRect(0, 0, ROOM_W * T, 2 * T);
  g.fillStyle = '#c8a850'; g.fillRect(0, 2 * T - 2, ROOM_W * T, 2);
  // Carpet from the door to the dais.
  g.fillStyle = '#c8a850'; g.fillRect(5 * T - 2, 4 * T, 5 * T + 4, (ROOM_H - 4) * T);
  g.fillStyle = '#287878'; g.fillRect(5 * T, 4 * T, 5 * T, (ROOM_H - 4) * T);
  g.fillStyle = '#309090';
  for (let y = 5; y < ROOM_H; y += 2) g.fillRect(7 * T + 2, y * T + 4, T - 4, T - 8);
  // Dais under Cynthia.
  g.fillStyle = '#c8a850';
  g.beginPath(); g.ellipse(CYNTHIA.x * T + 8, CYNTHIA.y * T + 10, 34, 18, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4a3a7a';
  g.beginPath(); g.ellipse(CYNTHIA.x * T + 8, CYNTHIA.y * T + 10, 30, 15, 0, 0, Math.PI * 2); g.fill();
  // Pillars down both sides.
  for (let y = 4; y < ROOM_H; y += 4) for (const x of [1, ROOM_W - 2]) {
    g.fillStyle = '#151933'; g.fillRect(x * T + 2, y * T + 10, T, 10);
    g.fillStyle = '#9aa6d6'; g.fillRect(x * T, y * T - 14, T, 26);
    g.fillStyle = '#d6dcf4'; g.fillRect(x * T + 2, y * T - 14, 4, 26);
    g.fillStyle = '#c8a850'; g.fillRect(x * T - 1, y * T - 16, T + 2, 3);
  }
}

/** Pokétch digital watch on the bottom screen (the DS's idle lower screen in the overworld). */
function drawPoketch(g: CanvasRenderingContext2D, font: RomFont) {
  g.fillStyle = '#e04848'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#c03030'; g.fillRect(0, H - 24, W, 24);
  g.fillStyle = '#70b070'; g.fillRect(16, 16, W - 32, H - 56);
  g.fillStyle = '#90d090'; g.fillRect(20, 20, W - 40, H - 64);
  const now = new Date();
  const s = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  font.draw(c.getContext('2d')!, s, 0, 0, { color: '#203820', shadow: '#70b070' });
  g.imageSmoothingEnabled = false;
  const w = font.width(s);
  g.drawImage(c, 0, 0, w, 16, (W - w * 5) / 2, 44, w * 5, 80);
}

/** Trainer-battle transition: three flashes, then a spiral wipe to black. */
export async function battleTransition(ds: DS) {
  const g = ds.top;
  const snap = document.createElement('canvas');
  snap.width = W; snap.height = H;
  snap.getContext('2d')!.drawImage(g.canvas, 0, 0);
  for (let i = 0; i < 3; i++) {
    g.fillStyle = '#f8f8f8'; g.fillRect(0, 0, W, H); await sleep(60);
    g.drawImage(snap, 0, 0); await sleep(60);
  }
  for (let t = 0; t <= 1.0001; t += 1 / 36) {
    g.drawImage(snap, 0, 0);
    g.fillStyle = '#000';
    for (let arm = 0; arm < 4; arm++) {
      g.beginPath(); g.moveTo(W / 2, H / 2);
      const a0 = arm * (Math.PI / 2) - Math.PI / 2;
      g.arc(W / 2, H / 2, 200, a0, a0 + t * (Math.PI / 2));
      g.closePath(); g.fill();
    }
    await sleep(16);
  }
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  await sleep(200);
}
