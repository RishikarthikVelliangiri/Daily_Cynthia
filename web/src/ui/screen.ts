// Two 256x192 canvases stacked like a DS, integer-scaled, with keyboard + pointer input.

export type Key = 'up' | 'down' | 'left' | 'right' | 'a' | 'b';
export type Input = { key: Key } | { tap: { x: number; y: number } };

const KEYMAP: Record<string, Key> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  z: 'a', Z: 'a', Enter: 'a', ' ': 'a', x: 'b', X: 'b', Escape: 'b', Backspace: 'b',
};

export const W = 256, H = 192;

export class DS {
  readonly top: CanvasRenderingContext2D;
  readonly bottom: CanvasRenderingContext2D;
  private waiters: ((i: Input) => void)[] = [];
  private gesture: (() => void)[] = [];
  private blockedUntil = 0;
  /** performance.now() of the last A/B/tap, delivered or not (text printers use it to hurry a page). */
  lastPress = -Infinity;

  constructor(readonly root: HTMLElement) {
    const mk = (id: string, label: string) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H; c.id = id;
      c.setAttribute('aria-label', label);
      c.setAttribute('role', 'img');
      root.appendChild(c);
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      return ctx;
    };
    this.top = mk('top-screen', 'Battle screen');
    this.bottom = mk('bottom-screen', 'Touch screen menu');
    this.bottom.canvas.tabIndex = 0;
    this.fit();
    addEventListener('resize', () => this.fit());
    addEventListener('keydown', e => {
      const k = KEYMAP[e.key];
      if (!k || (e.target as HTMLElement)?.closest?.('button, input, a, dialog')) return;
      e.preventDefault();
      if (e.repeat && (k === 'a' || k === 'b')) return; // like JOY_NEW: holding A doesn't press again; arrows repeat
      this.push({ key: k });
    });
    this.bottom.canvas.addEventListener('pointerdown', e => {
      const r = this.bottom.canvas.getBoundingClientRect();
      this.push({ tap: { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H } });
    });
    this.top.canvas.addEventListener('pointerdown', () => this.push({ key: 'a' })); // tap top screen = advance text
  }

  /** Largest integer scale that fits both screens in the viewport. */
  fit() {
    // Console = two screens + bezel/padding (28 DS px tall, 24 wide incl. speakers); page chrome ~120 CSS px.
    const raw = Math.min((innerWidth - 32) / (W + 40), (innerHeight - 120) / (H * 2 + 28));
    const s = raw >= 2 ? Math.floor(raw) : Math.max(1, raw); // integer when possible, never overflow
    for (const c of [this.top.canvas, this.bottom.canvas]) {
      c.style.width = `${W * s}px`;
      c.style.height = `${H * s}px`;
    }
    this.root.style.setProperty('--scale', String(s));
  }

  onGesture(f: () => void) { this.gesture.push(f); }

  /** Presses are never buffered (the DS samples buttons each frame): one nobody is waiting for is dropped,
   * so spamming A during text can't skip later messages or pick a menu entry ahead of time. */
  private push(i: Input) {
    for (const g of this.gesture) g();
    const now = performance.now();
    if ('tap' in i || i.key === 'a' || i.key === 'b') this.lastPress = now;
    if (now < this.blockedUntil) return;
    this.waiters.shift()?.(i);
  }

  /** Ignore all input for `ms` (screen transitions: a double click must not also hit the next screen). */
  block(ms: number) { this.blockedUntil = Math.max(this.blockedUntil, performance.now() + ms); }

  next(): Promise<Input> {
    return new Promise(r => this.waiters.push(r));
  }

  /** Resolves on the next input or after `ms`, whichever is first. */
  nextOrTimeout(ms: number): Promise<Input | null> {
    return new Promise(res => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; this.waiters = this.waiters.filter(w => w !== f); res(null); } }, ms);
      const f = (i: Input) => { if (!done) { done = true; clearTimeout(t); res(i); } };
      this.waiters.push(f);
    });
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
