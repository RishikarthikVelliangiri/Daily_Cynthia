import type { Pokemon } from '@pkmn/sim';
import type { GameData } from '../data';
import type { DailyBattle } from '../battle/engine';
import { fillTemplate, Translator, type Side, type UIEvent } from '../battle/protocol';
import { dex } from '../battle/showdown';
import type { AnimPlayer } from '../anim/player';
import { type BgFx, DEFAULT_POS, freshFx, MON_MGR, type MonFx } from '../anim/system';
import { type GfxMeta, image, pokemonSprite, type RomFont, type Sound, STYLE_DARK, STYLE_LIGHT } from './assets';
import { type DS, H, sleep, W } from './screen';
import { button, hit } from './widgets';
import { MENU_GUARD_MS } from './menus';

// Layout (DS pixels, top screen). Platform centers follow pret's battle_display.c (enemy 192,88; player 64,136).
const ENEMY = { x: 192, y: 88, foot: 92 };
const PLAYER = { x: 64, y: 136, foot: 150 };
const HPBOX = { enemy: { x: 0, y: 6 }, player: { x: 128, y: 88 } };
const MSG_Y = 144;

export const TYPE_COLORS: Record<string, string> = {
  Normal: '#a8a878', Fire: '#f08030', Water: '#6890f0', Grass: '#78c850', Electric: '#e0b820', Ice: '#68b8c8',
  Fighting: '#c03028', Poison: '#a040a0', Ground: '#c8a048', Flying: '#a890f0', Psychic: '#f85888', Bug: '#98a820',
  Rock: '#b8a038', Ghost: '#705898', Dragon: '#7038f8', Dark: '#705848', Steel: '#a0a0c0', '???': '#68a090',
};
const STATUS_COLORS: Record<string, string> = { par: '#c8a800', psn: '#a040a0', tox: '#a040a0', brn: '#e05030', frz: '#58a8d0', slp: '#888888' };

interface MonView {
  species: number; name: string; level: number; gender: string; hp: number; maxhp: number; shownHp: number;
  status: string; img: HTMLImageElement | null; scale: number; dy: number; dx: number; visible: boolean; flash: boolean;
  boxVisible: boolean; boxDx: number;
}

type Bottom =
  | { mode: 'idle' }
  | { mode: 'command'; cursor: number }
  | { mode: 'fight'; cursor: number }
  | { mode: 'party'; cursor: number; forced: boolean };

export interface SceneOptions {
  textSpeed: 'normal' | 'fast'; playerName: string; playerSprite: 'lucas' | 'dawn'; onText?: (s: string) => void;
  /** ROM move animations; null = simple nudge/blink fallback. */
  anim?: AnimPlayer | null;
}

export class BattleScene {
  private tr: Translator;
  private views: Record<Side, MonView | null> = { p1: null, p2: null };
  private text: string[] = [];
  private bottom: Bottom = { mode: 'idle' };
  private trainer = { cynthia: { visible: true, dx: 0 }, player: { visible: true, dx: 0, frame: 0 } };
  private intro = 0; // 0..1 slide-in progress
  private imgs: Record<string, HTMLImageElement> = {};
  private raf = 0;
  private hpBeep: ReturnType<typeof setInterval> | null = null;
  private fx: Record<Side, MonFx> = { p1: freshFx('p1'), p2: freshFx('p2') };
  private bgFx: BgFx = { x: 0, y: 0, fadeColor: 0, fadeAmt: 0, grayscale: false };

  constructor(private ds: DS, private font: RomFont, private meta: GfxMeta, private sound: Sound,
    private data: GameData, private engine: DailyBattle, private opts: SceneOptions) {
    this.tr = new Translator(data, 'Player', 'Cynthia');
  }

  async run(): Promise<'player' | 'cynthia'> {
    const names = ['msgwin', 'hpbox_enemy', 'hpbox_player', 'platform_enemy', 'platform_player', 'touch_idle'];
    for (const n of names) this.imgs[n] = await image(`gfx/battle/${n}.png`);
    this.imgs.bg = await image(`gfx/battle/${this.meta.championBg}`);
    this.imgs.cynthia = await image('gfx/trainers/cynthia.png');
    this.imgs.player = await image(`gfx/trainers/${this.opts.playerSprite}_back.png`);
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
    try {
      await this.introSequence();
      // Showdown logs the lead switch-ins p1 first; in DP the trainer sends out first, then "Go! …".
      const opening = this.tr.translate(this.engine.takeLog());
      await this.play([...opening.filter(e => e.t === 'switch' && e.side === 'p2'), ...opening.filter(e => !(e.t === 'switch' && e.side === 'p2'))]);
      while (!this.engine.ended) {
        const choice = await this.askPlayer();
        if (!this.engine.choose(choice)) continue;
        this.bottom = { mode: 'idle' };
        await this.play(this.tr.translate(this.engine.takeLog()));
      }
      return this.engine.winner!;
    } finally {
      this.stopBeep();
      cancelAnimationFrame(this.raf);
      this.draw();
    }
  }

  /** Dev tool (?anim=N): both leads on screen; arrows pick a move (±1/±10), A = player uses it, B = foe uses it. */
  async preview(start: number) {
    const names = ['msgwin', 'hpbox_enemy', 'hpbox_player', 'platform_enemy', 'platform_player', 'touch_idle'];
    for (const n of names) this.imgs[n] = await image(`gfx/battle/${n}.png`);
    this.imgs.bg = await image(`gfx/battle/${this.meta.championBg}`);
    this.imgs.cynthia = await image('gfx/trainers/cynthia.png');
    this.imgs.player = await image(`gfx/trainers/${this.opts.playerSprite}_back.png`);
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    loop();
    this.intro = 1;
    this.trainer.cynthia.visible = false; this.trainer.player.visible = false;
    for (const e of this.tr.translate(this.engine.takeLog())) if (e.t === 'switch') await this.showSwitch({ ...e, text: '' });
    (window as any).__scene = this; // dev inspection
    let move = start; // past 467: the common animations (status, stat change, weather...) 1..40
    for (;;) {
      const name = move > 467 ? `common ${move - 467}` : this.data.moves[move]?.name ?? '?';
      this.text = [`#${move} ${name}`, 'A: you use it  B: foe uses it'];
      this.ds.block(150);
      const i = await this.ds.next();
      if ('tap' in i) continue;
      const d = { left: -1, right: 1, up: 10, down: -10 }[i.key as string];
      if (d) { move = Math.min(507, Math.max(1, move + d)); continue; }
      await this.playMoveAnim(move > 467 ? { sub: move - 467 } : move, i.key === 'a' ? 'p1' : 'p2');
    }
  }

  /** Dev tool: steps a move animation frame by frame and returns a film strip (every Nth frame) of the top screen. */
  async filmstrip(move: number | { sub: number }, side: Side, every = 6, count = 24): Promise<HTMLCanvasElement> {
    const strip = document.createElement('canvas');
    strip.width = 256 * 4; strip.height = 192 * Math.ceil(count / 4);
    const sg = strip.getContext('2d')!;
    this.fx = { p1: freshFx('p1'), p2: freshFx('p2') };
    const height = (s: Side) => { const v = this.views[s]; return v ? this.monBox(s, v).h : 0; };
    const anim = this.opts.anim!.start(move, side, this.fx, this.bgFx, height)!;
    for (let f = 0, shot = 0; shot < count && !anim.done; f++) {
      anim.step();
      for (let k = 0; k < 4; k++) await Promise.resolve(); // particle loads
      if (anim.loading) { f--; await sleep(20); continue; }
      if (f % every === 0) { this.draw(); sg.drawImage(this.ds.top.canvas, (shot % 4) * 256, Math.floor(shot / 4) * 192); shot++; }
    }
    this.opts.anim!.current = null;
    this.fx = { p1: freshFx('p1'), p2: freshFx('p2') };
    Object.assign(this.bgFx, { x: 0, y: 0, fadeAmt: 0, grayscale: false, effect: null, overlay: null, monBg: null });
    return strip;
  }

  // ------------------------------------------------------------- sequences

  private async introSequence() {
    this.sound.playBgm('battle_champion');
    for (let t = 0; t <= 1; t += 1 / 40) { this.intro = t; await sleep(16); }
    this.intro = 1;
    await this.say(this.fillBattle(969, 'Champion', 'Cynthia'), 'auto');
  }

  /** Plays translated events; returns when the next player decision is needed. */
  private async play(events: UIEvent[]) {
    for (const e of events) {
      switch (e.t) {
        case 'switch': await this.showSwitch(e); break;
        case 'move': {
          if (e.anim && this.opts.anim) {
            await this.say(e.text, 'none');
            await this.playMoveAnim(e.num, e.side);
            await sleep(this.opts.textSpeed === 'fast' ? 120 : 250);
          } else {
            await this.say(e.text, 'auto');
            const v = this.views[e.side];
            if (v && e.anim) { for (const d of [4, 0]) { v.dx = e.side === 'p1' ? d : -d; await sleep(60); } }
          }
          break;
        }
        case 'hp': await this.showHp(e.side, e.hp, e.maxhp, e.hit); break;
        case 'status': if (this.views[e.side]) this.views[e.side]!.status = e.status; break;
        case 'faint': await this.showFaint(e.side, e.text); break;
        case 'msg': await this.say(e.text, 'auto'); break;
        case 'item': await this.say(e.text, 'auto'); break;
        case 'turn': break;
        case 'anim': if (this.opts.anim?.hasCommon && this.views[e.side]?.visible) await this.playMoveAnim({ sub: e.sub }, e.side, e.target); break;
        case 'win': await this.showEnd(e.winner, e.text); break;
      }
    }
  }

  /** Plays the move's ROM animation script; sprite/background effects are reset afterwards. */
  private async playMoveAnim(move: number | { sub: number }, side: Side, target?: Side) {
    const reset = () => { this.fx = { p1: freshFx('p1'), p2: freshFx('p2') }; Object.assign(this.bgFx, { x: 0, y: 0, fadeAmt: 0, grayscale: false, effect: null, overlay: null, monBg: null }); };
    reset();
    const height = (s: Side) => { const v = this.views[s]; return v ? this.monBox(s, v).h : 0; }; // empty rows under the sprite
    await this.opts.anim!.play(move, side, this.fx, this.bgFx, height, target);
    reset();
  }

  private async showSwitch(e: Extract<UIEvent, { t: 'switch' }>) {
    const old = this.views[e.side];
    if (old?.visible) { // withdraw
      for (let s = 1; s >= 0; s -= 0.15) { old.scale = Math.max(0, s); await sleep(16); }
      old.visible = false; old.boxVisible = false;
    }
    if (e.side === 'p2' && this.trainer.cynthia.visible) {
      for (let d = 0; d <= 100; d += 6) { this.trainer.cynthia.dx = d; await sleep(16); }
      this.trainer.cynthia.visible = false;
    }
    if (e.side === 'p1' && this.trainer.player.visible) {
      this.trainer.player.frame = 1;
      for (let d = 0; d <= 120; d += 6) { this.trainer.player.dx = -d; await sleep(16); }
      this.trainer.player.visible = false;
    }
    const female = e.gender === 'F' && (await this.hasFemaleSprite(e.species, e.side === 'p1'));
    const img = await image(pokemonSprite(e.species, e.side === 'p1', female)).catch(() => null);
    const v: MonView = {
      species: e.species, name: e.name, level: e.level, gender: e.gender, hp: e.hp, maxhp: e.maxhp, shownHp: e.hp,
      status: e.status, img, scale: 0, dy: 0, dx: 0, visible: true, flash: true, boxVisible: false, boxDx: e.side === 'p1' ? 128 : -128,
    };
    this.views[e.side] = v;
    const said = this.say(e.text, 'auto');
    for (let s = 0; s <= 1.0001; s += 0.1) { v.scale = Math.min(1, s); await sleep(16); }
    v.flash = false;
    void this.sound.playCry(e.species);
    v.boxVisible = true;
    for (let d = Math.abs(v.boxDx); d >= 0; d -= 16) { v.boxDx = e.side === 'p1' ? d : -d; await sleep(16); }
    v.boxDx = 0;
    await said;
  }

  private async hasFemaleSprite(species: number, back: boolean) {
    try { await image(pokemonSprite(species, back, true)); return true; } catch { return false; }
  }

  private async showHp(side: Side, hp: number, maxhp: number, hit?: 'normal' | 'super' | 'weak') {
    const v = this.views[side];
    if (!v) return;
    if (hit) {
      void this.sound.playSe(hit === 'super' ? 'se_hit_super' : hit === 'weak' ? 'se_hit_weak' : 'se_hit');
      for (let i = 0; i < 4; i++) { v.visible = !v.visible; await sleep(70); }
      v.visible = true;
    }
    // Gen 4 HP bars move one pixel (of 48) per frame.
    const target = side === 'p1' ? hp : Math.round((hp / maxhp) * v.maxhp);
    const step = Math.max(1, v.maxhp / 48);
    v.hp = target;
    while (Math.abs(v.shownHp - target) > 0.01) {
      v.shownHp = v.shownHp > target ? Math.max(target, v.shownHp - step) : Math.min(target, v.shownHp + step);
      await sleep(16);
    }
  }

  private async showFaint(side: Side, text: string) {
    const v = this.views[side];
    if (v) {
      void this.sound.playCry(v.species);
      await sleep(250);
      for (let dy = 0; dy <= 80; dy += 8) { v.dy = dy; await sleep(16); }
      v.visible = false; v.boxVisible = false;
    }
    if (side === 'p1') this.stopBeep();
    await this.say(text, 'auto');
  }

  private async showEnd(winner: Side, text: string) {
    this.stopBeep();
    if (winner === 'p1') {
      this.sound.playBgm('victory_champion');
      this.trainer.cynthia.visible = true;
      for (let d = 100; d >= 0; d -= 6) { this.trainer.cynthia.dx = d; await sleep(16); }
      this.trainer.cynthia.dx = 0;
      await this.say(text, 'press');
      const speech = this.data.text.cynthia.defeat;
      if (speech) await this.say(speech, 'press');
    } else {
      this.sound.stopBgm();
      await this.say(text, 'press');
      await this.say('Player blacked out!'.replace('Player', 'You'), 'press');
    }
  }

  // ------------------------------------------------------------- text

  private fillBattle(idx: number, ...vars: string[]) {
    return fillTemplate(this.data.text.battle[idx], vars);
  }

  /** Typewriter text in the message window. Pages split on \r and \f; 'press' waits for A, 'auto' for a beat. */
  async say(text: string, wait: 'auto' | 'press' | 'none') {
    const pages = text.split(/[\r\f]/).map(p => p.replace(/\{[0-9A-F]{4}:\d+\}/g, '')).filter(p => p.trim());
    this.opts.onText?.(pages.join(' ').replace(/\n/g, ' '));
    for (const page of pages) {
      const lines = page.split('\n');
      this.text = lines.map(() => '');
      const fast = this.opts.textSpeed === 'fast';
      const t0 = performance.now(); // A/B/tap while printing finishes the page; it doesn't also turn it
      for (let li = 0; li < lines.length; li++) {
        for (let ci = 1; ci <= lines[li].length; ci++) {
          this.text[li] = lines[li].slice(0, ci);
          if (!fast && this.ds.lastPress <= t0) await sleep(22);
        }
      }
      this.ds.block(100);
      if (wait === 'press') await this.waitA();
      else if (wait === 'auto') { // a beat, or A/B/tap to hurry it; arrows never advance text
        const until = performance.now() + (fast ? 450 : 900);
        for (let left = until - performance.now(); left > 0; left = until - performance.now()) {
          const i = await this.ds.nextOrTimeout(left);
          if (!i || 'tap' in i || i.key === 'a' || i.key === 'b') break;
        }
      }
    }
  }

  private async waitA() {
    for (;;) {
      const i = await this.ds.next();
      if ('tap' in i || i.key === 'a' || i.key === 'b') return;
    }
  }

  // ------------------------------------------------------------- player input

  private async askPlayer(): Promise<string> {
    const b = this.engine.battle;
    const me = b.p1.active[0];
    if (this.engine.needs === 'switch') {
      this.bottom = { mode: 'party', cursor: this.firstAlive(), forced: true };
      await this.say('Choose a POKéMON.', 'none');
      return (await this.partyMenu(true))!;
    }
    const name = this.views.p1?.name ?? me.name.toUpperCase();
    await this.say(this.fillBattle(921, name), 'none');
    this.startBeepIfLow();
    for (;;) {
      this.bottom = { mode: 'command', cursor: 0 };
      const cmd = await this.commandMenu();
      if (cmd === 'fight') {
        const c = await this.fightMenu(me);
        if (c) return c;
      } else if (cmd === 'party') {
        const c = await this.partyMenu(false);
        if (c) return c;
      } else if (cmd === 'bag') {
        await this.say(this.data.text.battle[593], 'press'); // "Items can't be used here."
        await this.say(this.fillBattle(921, name), 'none');
      } else {
        await this.say(this.data.text.battle[793], 'press'); // "No! There's no running from a Trainer battle!"
        await this.say(this.fillBattle(921, name), 'none');
      }
    }
  }

  private firstAlive() { return Math.max(0, this.engine.battle.p1.pokemon.findIndex(p => !p.fainted && !p.isActive)); }

  private static CMD_RECTS = [
    { x: 16, y: 20, w: 224, h: 104 }, // FIGHT
    { x: 0, y: 140, w: 84, h: 48 },   // BAG
    { x: 92, y: 148, w: 72, h: 40 },  // RUN
    { x: 172, y: 140, w: 84, h: 48 }, // POKéMON
  ];

  private async commandMenu(): Promise<'fight' | 'bag' | 'run' | 'party'> {
    const ids = ['fight', 'bag', 'run', 'party'] as const;
    this.ds.block(MENU_GUARD_MS);
    for (;;) {
      const i = await this.ds.next();
      const st = this.bottom as { mode: 'command'; cursor: number };
      if ('tap' in i) {
        const k = BattleScene.CMD_RECTS.findIndex(r => hit(r, i.tap));
        if (k >= 0) { st.cursor = k; void this.sound.playSe('se_select'); return ids[k]; }
        continue;
      }
      const nav: Record<string, number[]> = { up: [0, 0, 0, 0], down: [2, 1, 2, 3], left: [0, 1, 1, 2], right: [0, 2, 3, 3] };
      if (i.key === 'a') { void this.sound.playSe('se_select'); return ids[st.cursor]; }
      if (nav[i.key]) { st.cursor = nav[i.key][st.cursor]; void this.sound.playSe('se_cursor'); }
    }
  }

  private static MOVE_RECTS = [
    { x: 4, y: 8, w: 122, h: 64 }, { x: 130, y: 8, w: 122, h: 64 },
    { x: 4, y: 78, w: 122, h: 64 }, { x: 130, y: 78, w: 122, h: 64 },
  ];
  private static CANCEL = { x: 40, y: 152, w: 176, h: 36 };

  private async fightMenu(me: Pokemon): Promise<string | null> {
    this.bottom = { mode: 'fight', cursor: 0 };
    const req = (this.engine.battle.p1.activeRequest as any)?.active?.[0];
    const usable = (k: number) => {
      const r = req?.moves?.[k];
      return r ? !r.disabled && (r.pp ?? 1) > 0 : false;
    };
    this.ds.block(MENU_GUARD_MS);
    for (;;) {
      const i = await this.ds.next();
      const st = this.bottom as { mode: 'fight'; cursor: number };
      let pick = -1;
      if ('tap' in i) {
        if (hit(BattleScene.CANCEL, i.tap)) return null;
        pick = BattleScene.MOVE_RECTS.findIndex((r, k) => k < me.moveSlots.length && hit(r, i.tap));
        if (pick < 0) continue;
      } else if (i.key === 'b') return null;
      else if (i.key === 'a') pick = st.cursor;
      else {
        const c = st.cursor, n = me.moveSlots.length;
        const nx = i.key === 'left' ? c & ~1 : i.key === 'right' ? c | 1 : i.key === 'up' ? c & 1 : (c & 1) + 2;
        if (nx < n) { st.cursor = nx; void this.sound.playSe('se_cursor'); }
        continue;
      }
      if (req?.moves?.length === 1 && req.moves[0].id === 'struggle') return 'move 1';
      if (!usable(pick)) {
        await this.say(this.data.text.battle[823], 'auto'); // "There's no PP left for this move!"
        continue;
      }
      void this.sound.playSe('se_select');
      return `move ${pick + 1}`;
    }
  }

  private static PARTY_RECTS = [0, 1, 2, 3, 4, 5].map(k => ({ x: k % 2 ? 130 : 4, y: 4 + Math.floor(k / 2) * 48, w: 122, h: 44 }));

  private async partyMenu(forced: boolean): Promise<string | null> {
    const party = this.engine.battle.p1.pokemon;
    this.bottom = { mode: 'party', cursor: forced ? this.firstAlive() : 0, forced };
    this.ds.block(MENU_GUARD_MS);
    for (;;) {
      const i = await this.ds.next();
      const st = this.bottom as { mode: 'party'; cursor: number; forced: boolean };
      let pick = -1;
      if ('tap' in i) {
        if (!forced && hit(BattleScene.CANCEL, i.tap)) return null;
        pick = BattleScene.PARTY_RECTS.findIndex((r, k) => k < party.length && hit(r, i.tap));
        if (pick < 0) continue;
      } else if (i.key === 'b') { if (!forced) return null; continue; }
      else if (i.key === 'a') pick = st.cursor;
      else {
        const d = { left: -1, right: 1, up: -2, down: 2 }[i.key];
        const nx = st.cursor + d;
        if (nx >= 0 && nx < party.length) { st.cursor = nx; void this.sound.playSe('se_cursor'); }
        continue;
      }
      const mon = party[pick];
      if (mon.fainted) { await this.say(`${this.dispName(mon)} has no energy\nleft to battle!`, 'auto'); continue; }
      if (mon.isActive) { await this.say(`${this.dispName(mon)} is already\nin battle!`, 'auto'); continue; }
      void this.sound.playSe('se_select');
      return `switch ${pick + 1}`;
    }
  }

  private dispName(p: Pokemon) { return this.data.species[p.species.num].name.toUpperCase(); }

  private startBeepIfLow() {
    const v = this.views.p1;
    this.stopBeep();
    if (v && v.hp > 0 && v.hp <= v.maxhp / 5) this.hpBeep = setInterval(() => void this.sound.playSe('se_hp_low'), 700);
  }
  private stopBeep() { if (this.hpBeep) clearInterval(this.hpBeep); this.hpBeep = null; }

  // ------------------------------------------------------------- drawing

  private draw() {
    this.drawTop(this.ds.top);
    this.drawBottom(this.ds.bottom);
  }

  private drawTop(g: CanvasRenderingContext2D) {
    const I = this.imgs;
    g.clearRect(0, 0, W, H);
    const bg = this.bgFx;
    g.save();
    if (bg.grayscale) g.filter = 'grayscale(1)';
    g.translate(-bg.x, -bg.y); // DS BG scroll offset moves the layer the other way
    g.drawImage(I.bg, 0, 0);
    if (bg.x) { g.drawImage(I.bg, W, 0); g.drawImage(I.bg, -W, 0); }
    g.restore();
    if (bg.fadeAmt > 0) { g.fillStyle = gxColor(bg.fadeColor, bg.fadeAmt / 16); g.fillRect(0, 0, W, MSG_Y); }
    this.drawEffectBg(g);
    g.save();
    g.translate(-bg.x, -bg.y);
    const slide = (1 - this.intro) * 256;
    const pe = this.meta.platform_enemy, pp = this.meta.platform_player;
    g.drawImage(I.platform_enemy, ENEMY.x + pe.originX - slide, ENEMY.y + pe.originY);
    g.drawImage(I.platform_player, PLAYER.x + pp.originX + slide, PLAYER.y + pp.originY);
    g.restore();

    if (this.trainer.cynthia.visible) g.drawImage(I.cynthia, 0, 0, 80, 80, ENEMY.x - 40 + this.trainer.cynthia.dx - slide, ENEMY.foot - 80, 80, 80);
    if (this.trainer.player.visible) {
      const f = this.trainer.player.frame;
      g.drawImage(I.player, f * 80, 0, 80, 80, PLAYER.x - 40 + this.trainer.player.dx + slide, MSG_Y - 80, 80, 80);
    }
    this.opts.anim?.drawSprites(g, true); // effect sprites with BG priority below the battlers
    this.drawMon(g, 'p2');
    this.drawMon(g, 'p1');
    this.drawMonBg(g);
    this.opts.anim?.draw(g);
    this.opts.anim?.drawSprites(g, false);
    if (this.bgFx.overlay) this.drawEffectBg(g, this.bgFx.overlay);
    this.drawHpBox(g, 'p2');
    this.drawHpBox(g, 'p1');

    g.drawImage(I.msgwin, 0, MSG_Y);
    this.text.forEach((l, i) => this.font.draw(g, l, 12, MSG_Y + 8 + i * 16, STYLE_LIGHT));
  }

  private flashCanvas = document.createElement('canvas');
  private copyCanvas = document.createElement('canvas');
  private copyLayer = document.createElement('canvas');
  private mosaicCanvas = document.createElement('canvas');
  private effectCanvas = document.createElement('canvas');

  /** SwitchBg layer: the move's ROM background, scrolled (wrapping like a DS text BG) and blended over the battle BG. */
  private drawEffectBg(g: CanvasRenderingContext2D, e = this.bgFx.effect) {
    const img = e && this.opts.anim?.effectImage(e.bg, e.reversed);
    if (!e || !img || e.mix <= 0) return;
    const c = this.effectCanvas, eg = c.getContext('2d')!;
    c.width = W; c.height = MSG_Y;
    const wrap = (v: number, n: number) => ((Math.round(v) % n) + n) % n;
    const ox = wrap(e.x, img.width), oy = wrap(e.y, img.height);
    const rows = e.rowX;
    if (rows) { // per-scanline x scroll (HDMA); those rows have y scroll 0
      for (let r = 0; r < MSG_Y; r++) {
        const rx = rows[r] ? wrap(rows[r], img.width) : ox, sy = rows[r] ? r % img.height : (r + oy) % img.height;
        for (let x = -rx; x < W; x += img.width) eg.drawImage(img, 0, sy, img.width, 1, x, r, img.width, 1);
      }
    } else for (let y = -oy; y < MSG_Y; y += img.height) for (let x = -ox; x < W; x += img.width) eg.drawImage(img, x, y);
    if (e.fadeAmt > 0) { eg.globalCompositeOperation = 'source-atop'; eg.fillStyle = gxColor(e.fadeColor, e.fadeAmt / 16); eg.fillRect(0, 0, W, MSG_Y); }
    g.globalAlpha = Math.min(1, e.mix);
    if (e.clip) g.drawImage(c, e.clip[0], 0, e.clip[1] - e.clip[0] + 1, MSG_Y, e.clip[0], 0, e.clip[1] - e.clip[0] + 1, MSG_Y);
    else g.drawImage(c, 0, 0);
    g.globalAlpha = 1;
  }

  private monBgCanvas = document.createElement('canvas');
  /** LoadPokemonSpriteIntoBg copy (Acid Armor, Spite): the battler drawn as a BG with per-scanline offsets. */
  private drawMonBg(g: CanvasRenderingContext2D) {
    const m = this.bgFx.monBg, v = m && this.views[m.side];
    if (!m || !v?.img || m.mix <= 0) return;
    const box = this.monBox(m.side, v), [bx, by] = DEFAULT_POS[m.side];
    const ddx = box.x - (bx - 40), ddy = box.y - (by - 40);
    const c = this.monBgCanvas, cg = c.getContext('2d')!;
    c.width = W; c.height = MSG_Y;
    for (let r = 0; r < 192; r++) {
      const sy = r + m.oy[r], row = r + ddy;
      if (sy < 0 || sy >= 80 || row < 0 || row >= MSG_Y) continue;
      cg.drawImage(v.img, 0, sy, 80, 1, -m.ox[r] + ddx, row, 80, 1);
    }
    if (m.dark > 0) { cg.globalCompositeOperation = 'source-atop'; cg.fillStyle = `rgba(0,0,0,${m.dark})`; cg.fillRect(0, 0, W, MSG_Y); }
    g.globalAlpha = Math.min(1, m.mix);
    g.drawImage(c, 0, 0);
    g.globalAlpha = 1;
  }

  /** Screen box of a battler's 80x80 frame at rest (feet on the platform, ROM height table). */
  private monBox(side: Side, v: MonView) {
    const back = side === 'p1';
    const pos = back ? PLAYER : ENEMY;
    // ROM height table = empty rows under the sprite, so feet land on the platform: (F back, M back, F front, M front)
    const info = this.meta.species[v.species];
    const h = info ? info.height[(back ? 0 : 2) + (v.gender === 'F' ? 0 : 1)] : 0;
    const foot = back ? MSG_Y + 2 : pos.foot;
    const s = v.scale, size = 80 * s;
    return { x: Math.round(pos.x - size / 2 + v.dx), y: Math.round(foot - (80 - h) * s + v.dy), size, foot, h };
  }

  /** The battler's frame with palette effects applied: send-out flash, fades, gray tint, stat-change overlay. */
  private monFrame(img: HTMLImageElement, o: { flash?: boolean; fadeAmt: number; fadeColor: number; tint?: [number, number, number] | null; stat?: MonFx['stat'] }, at: { x: number; y: number }, c = this.flashCanvas): CanvasImageSource {
    const tint = o.flash ? { color: '#f8f8f8', a: 1 } : o.fadeAmt > 0 ? { color: gxColor(o.fadeColor, 1), a: o.fadeAmt / 16 } : null;
    if (!tint && !o.tint && !o.stat) return img;
    const fg = c.getContext('2d', { willReadFrequently: !!o.tint })!;
    c.width = 80; c.height = 80;
    fg.drawImage(img, 0, 0, 80, 80, 0, 0, 80, 80);
    if (o.tint) { // TintPalette: gray = (76r + 151g + 29b) >> 8, channel = tone * gray >> 8
      const d = fg.getImageData(0, 0, 80, 80), p = d.data, [tr, tg, tb] = o.tint;
      for (let i = 0; i < p.length; i += 4) {
        const gray = (76 * (p[i] >> 3) + 151 * (p[i + 1] >> 3) + 29 * (p[i + 2] >> 3)) >> 8;
        p[i] = Math.min(31, (tr * gray) >> 8) * 8.23; p[i + 1] = Math.min(31, (tg * gray) >> 8) * 8.23; p[i + 2] = Math.min(31, (tb * gray) >> 8) * 8.23;
      }
      fg.putImageData(d, 0, 0);
    }
    fg.globalCompositeOperation = 'source-atop';
    if (tint) { fg.globalAlpha = tint.a; fg.fillStyle = tint.color; fg.fillRect(0, 0, 80, 80); }
    const pat = o.stat && this.opts.anim?.statImage(o.stat.img);
    if (o.stat && pat) { // the pattern scrolls in screen space, seen through the silhouette (OBJ window)
      fg.globalAlpha = o.stat.mix;
      const ox = (((Math.round(at.x) + o.stat.x) % 512) + 512) % 512, oy = (((Math.round(at.y) + o.stat.y) % 512) + 512) % 512;
      for (const dx of [0, 512]) for (const dy of [0, 512]) fg.drawImage(pat, dx - ox, dy - oy);
    }
    return c;
  }

  private drawMon(g: CanvasRenderingContext2D, side: Side) {
    const v = this.views[side];
    const fx = this.fx[side];
    const anim = this.opts.anim?.current;
    if (!v || !v.visible || !v.img || v.scale <= 0) return;
    const { x, y, size, foot } = this.monBox(side, v);
    const [bx, by] = DEFAULT_POS[side];
    const cx = x + size / 2 + (fx.x - bx), cy = y + size / 2 + (fx.y - by);
    if (!fx.hide) {
      let src = this.monFrame(v.img, { flash: v.flash, fadeAmt: fx.fadeAmt, fadeColor: fx.fadeColor, stat: fx.stat }, { x: cx - 40, y: cy - 40 });
      if (fx.mosaic && fx.mosaic > 1) src = mosaic(src, fx.mosaic, this.mosaicCanvas);
      g.save();
      if (v.dy > 0) { g.beginPath(); g.rect(0, 0, W, foot); g.clip(); } // faint: sink below the platform line
      if (fx.alpha !== undefined) g.globalAlpha = Math.max(0, Math.min(1, fx.alpha / 31));
      // Move-animation transforms (PokemonSprite center/scale/rotation), relative to the DS default position.
      g.translate(cx + fx.pivotX, cy + fx.pivotY);
      if (fx.rot) g.rotate((fx.rot / 65536) * Math.PI * 2); // y-down sprite space: RotZ is clockwise
      g.translate(-fx.pivotX, -fx.pivotY);
      g.scale(fx.scaleX / 256, fx.scaleY / 256);
      const k = size / 80, p = fx.partial;
      if (p) { if (p.w > 0 && p.h > 0) g.drawImage(src, p.x, p.y, p.w, p.h, -size / 2 + p.x * k, -size / 2 + p.y * k, p.w * k, p.h * k); }
      else if (fx.rowShift) { // scanline distortion: one 1-px row at a time
        const top = cy - size / 2;
        for (let r = 0; r < 80; r++) g.drawImage(src, 0, r, 80, 1, -size / 2 + (fx.rowShift.get(Math.round(top + r * v.scale)) ?? 0), -size / 2 + r * v.scale, size, v.scale);
      } else g.drawImage(src, 0, 0, 80, 80, -size / 2, -size / 2, size, size);
      g.restore();
    }
    // Pokémon sprite copies (OAM) the animation made of this battler; drawn only while their manager is drawn.
    if (!anim?.shown.has(MON_MGR)) return;
    const copies = [...anim.copies.values()].filter(c => c.side === side && c.visible).sort((a, b) => b.order - a.order);
    // XLU copies blend once with what's below them (OBJs never blend with each other): flatten them into one layer first.
    const xlu = copies.filter(c => c.xlu), layer = this.copyLayer, lg = layer.getContext('2d')!;
    if (xlu.length) { layer.width = W; layer.height = H; lg.imageSmoothingEnabled = false; }
    const gMain = g;
    for (const c of copies) {
      const a = c.xlu ? 1 : anim.alpha(c);
      if (a <= 0) continue;
      const g = c.xlu ? lg : gMain;
      g.save();
      g.globalAlpha = Math.min(1, a);
      const px = x + size / 2 + (c.x - bx), py = y + size / 2 + (c.y - by);
      g.translate(px, py);
      if (c.rot) g.rotate((c.rot / 65536) * Math.PI * 2);
      g.scale(c.scaleX, c.scaleY);
      let frame = this.monFrame(v.img, c, { x: px - 40, y: py - 40 }, this.copyCanvas);
      if (c.mosaic && c.mosaic > 1) frame = mosaic(frame, c.mosaic, this.mosaicCanvas);
      g.drawImage(frame, 0, 0, 80, 80, -size / 2, -size / 2, size, size);
      g.restore();
    }
    if (xlu.length) { gMain.globalAlpha = Math.min(1, anim.alpha(xlu[0])); gMain.drawImage(layer, 0, 0); gMain.globalAlpha = 1; }
  }

  private drawHpBox(g: CanvasRenderingContext2D, side: Side) {
    const v = this.views[side];
    if (!v || !v.boxVisible) return;
    const enemy = side === 'p2';
    const pos = enemy ? HPBOX.enemy : HPBOX.player;
    const x = pos.x + v.boxDx, y = pos.y;
    g.drawImage(enemy ? this.imgs.hpbox_enemy : this.imgs.hpbox_player, x, y);
    const nx = x + (enemy ? 10 : 20), ny = y + 14;
    const end = this.font.draw(g, v.name, nx, ny, STYLE_DARK);
    if (v.gender === 'M' || v.gender === 'F') {
      this.font.draw(g, v.gender === 'M' ? '♂' : '♀', end, ny, v.gender === 'M' ? { color: '#4070e0', shadow: '#a8c0f0' } : { color: '#e05050', shadow: '#f0b0a8' });
    }
    this.font.draw(g, `Lv${v.level}`, x + (enemy ? 84 : 94), ny, STYLE_DARK);
    // HP bar: 48px inside the box's bar slot; Gen 4 colors switch at 1/2 and 1/5.
    const bx = x + (enemy ? 57 : 65), by = y + 33;
    const frac = Math.max(0, v.shownHp / v.maxhp);
    const px = v.shownHp > 0 ? Math.max(1, Math.ceil(frac * 48)) : 0;
    const [hi, lo] = frac > 0.5 ? ['#70f8a8', '#58d080'] : frac > 0.2 ? ['#f8e038', '#c8a808'] : ['#f85838', '#a84048'];
    g.fillStyle = '#505050'; g.fillRect(bx, by, 48, 3);
    g.fillStyle = lo; g.fillRect(bx, by, px, 3);
    g.fillStyle = hi; g.fillRect(bx, by, px, 1);
    if (v.status) {
      g.fillStyle = STATUS_COLORS[v.status] ?? '#888';
      g.fillRect(x + (enemy ? 12 : 22), y + 31, 26, 8);
      this.font.draw(g, v.status.toUpperCase().slice(0, 3), x + (enemy ? 13 : 23), y + 27, STYLE_LIGHT);
    }
    if (!enemy) {
      const cur = String(Math.ceil(v.shownHp)), max = String(v.maxhp);
      this.font.draw(g, cur, x + 88 - this.font.width(cur), y + 37, STYLE_DARK);
      this.font.draw(g, max, x + 95, y + 37, STYLE_DARK);
    }
  }

  private drawBottom(g: CanvasRenderingContext2D) {
    g.clearRect(0, 0, W, H);
    g.drawImage(this.imgs.touch_idle, 0, 0);
    const b = this.bottom;
    if (b.mode === 'idle') return;
    g.fillStyle = 'rgba(16,24,32,0.55)';
    g.fillRect(0, 0, W, H);
    const labels = this.data.text.battle;
    if (b.mode === 'command') {
      const colors = ['#d84838', '#e0a020', '#3878d8', '#48a848'];
      const text = [labels[924], labels[925], labels[927], labels[926]];
      BattleScene.CMD_RECTS.forEach((r, k) => {
        button(g, r, colors[k], b.cursor === k);
        const s = text[k];
        this.font.draw(g, s, r.x + (r.w - this.font.width(s)) / 2, r.y + r.h / 2 - 8, STYLE_LIGHT);
      });
    } else if (b.mode === 'fight') {
      const me = this.engine.battle.p1.active[0];
      BattleScene.MOVE_RECTS.forEach((r, k) => {
        const slot = me.moveSlots[k];
        if (!slot) { button(g, r, '#404850', false); return; }
        const mv = dex.moves.get(slot.id);
        button(g, r, TYPE_COLORS[mv.type] ?? '#888', b.cursor === k);
        const name = this.data.moves[mv.num]?.name ?? mv.name;
        this.font.draw(g, name, r.x + (r.w - this.font.width(name)) / 2, r.y + 10, STYLE_LIGHT);
        const pp = `PP ${slot.pp}/${slot.maxpp}`;
        this.font.draw(g, pp, r.x + r.w - 8 - this.font.width(pp), r.y + 36, slot.pp === 0 ? { color: '#f8a0a0', shadow: '#683838' } : STYLE_LIGHT);
        this.font.draw(g, this.typeName(mv.type), r.x + 8, r.y + 36, STYLE_LIGHT);
      });
      button(g, BattleScene.CANCEL, '#606870', false);
      this.font.draw(g, 'CANCEL', 128 - this.font.width('CANCEL') / 2, 162, STYLE_LIGHT);
    } else if (b.mode === 'party') {
      const party = this.engine.battle.p1.pokemon;
      BattleScene.PARTY_RECTS.forEach((r, k) => {
        const p = party[k];
        if (!p) return;
        button(g, r, p.fainted ? '#784848' : p.isActive ? '#3878a8' : '#4c8c58', b.cursor === k);
        this.font.draw(g, this.dispName(p), r.x + 8, r.y + 4, STYLE_LIGHT);
        this.font.draw(g, `Lv${p.level}`, r.x + r.w - 8 - this.font.width(`Lv${p.level}`), r.y + 4, STYLE_LIGHT);
        const frac = p.hp / p.maxhp;
        g.fillStyle = '#303030'; g.fillRect(r.x + 8, r.y + 24, 64, 4);
        g.fillStyle = frac > 0.5 ? '#58d080' : frac > 0.2 ? '#e0c020' : '#e05040';
        g.fillRect(r.x + 8, r.y + 24, Math.ceil(64 * frac), 4);
        const hp = `${p.hp}/${p.maxhp}`;
        this.font.draw(g, hp, r.x + r.w - 8 - this.font.width(hp), r.y + 24, STYLE_LIGHT);
      });
      if (!b.forced) {
        button(g, BattleScene.CANCEL, '#606870', false);
        this.font.draw(g, 'CANCEL', 128 - this.font.width('CANCEL') / 2, 162, STYLE_LIGHT);
      }
    }
  }

  private typeName(t: string) {
    const order = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
    return this.data.text.types[order.indexOf(t)] ?? t.toUpperCase();
  }
}

/** OBJ mosaic: blocks of n x n pixels (sampled from each block's top-left like the DS). */
function mosaic(src: CanvasImageSource, n: number, c: HTMLCanvasElement): HTMLCanvasElement {
  const small = document.createElement('canvas');
  const w = Math.ceil(80 / n);
  small.width = w; small.height = w;
  const sg = small.getContext('2d')!;
  sg.imageSmoothingEnabled = false;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) sg.drawImage(src, x * n, y * n, 1, 1, x, y, 1, 1);
  c.width = 80; c.height = 80;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, 80, 80);
  g.drawImage(small, 0, 0, w * n, w * n);
  return c;
}

/** GX RGB555 -> css color with alpha. */
function gxColor(c: number, a: number) {
  const ch = (k: number) => Math.round((((c >> k) & 31) * 255) / 31);
  return `rgba(${ch(0)},${ch(5)},${ch(10)},${a})`;
}
