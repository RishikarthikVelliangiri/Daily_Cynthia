import type { RomFont, TextStyle } from './assets';

export type Rect = { x: number; y: number; w: number; h: number };
export const hit = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** DP-style touch button: rounded, dark outline, light top edge, darker base. Focus = white ring. */
export function button(g: CanvasRenderingContext2D, r: Rect, color: string, focused: boolean) {
  const { x, y, w, h } = r;
  g.fillStyle = '#202020';
  g.fillRect(x + 2, y, w - 4, h); g.fillRect(x, y + 2, w, h - 4); g.fillRect(x + 1, y + 1, w - 2, h - 2);
  g.fillStyle = color;
  g.fillRect(x + 2, y + 2, w - 4, h - 4);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(x + 3, y + 3, w - 6, 2);
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.fillRect(x + 3, y + h - 6, w - 6, 3);
  if (focused) {
    g.strokeStyle = '#f8f8f8'; g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/** Overworld-style message window: white body, dark rounded frame, pale blue inner rule. */
export function textWindow(g: CanvasRenderingContext2D, r: Rect) {
  const { x, y, w, h } = r;
  g.fillStyle = '#383848';
  g.fillRect(x + 2, y, w - 4, h); g.fillRect(x, y + 2, w, h - 4); g.fillRect(x + 1, y + 1, w - 2, h - 2);
  g.fillStyle = '#a8b8d8'; g.fillRect(x + 2, y + 2, w - 4, h - 4);
  g.fillStyle = '#f8f8f8'; g.fillRect(x + 4, y + 4, w - 8, h - 8);
}

const scratch = document.createElement('canvas');
/** ROM font at an integer scale (headings). */
export function bigText(g: CanvasRenderingContext2D, font: RomFont, s: string, x: number, y: number, scale: number, style: TextStyle) {
  const w = font.width(s) + 2;
  scratch.width = w; scratch.height = 16;
  const sg = scratch.getContext('2d')!;
  sg.clearRect(0, 0, w, 16);
  font.draw(sg, s, 0, 0, style);
  g.imageSmoothingEnabled = false;
  g.drawImage(scratch, 0, 0, w, 16, x, y, w * scale, 16 * scale);
}

export const centered = (font: RomFont, s: string, scale = 1) => 128 - (font.width(s) * scale) / 2;
