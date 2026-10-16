# Design

## World: "the DS on the League floor"

The page is a Nintendo DS Lite in Diamond's palette, set on the dark-indigo floor of the Pokémon League at night. The console carries the game; everything the player does happens on its two screens, drawn with the ROM's own font, window frames, sprites and sounds. HTML outside the console is limited to what must be real HTML: date line, controls legend, share/copy, settings toggles, and the readable battle transcript.

## Screens (canvas, 256×192 each, integer scaled, `image-rendering: pixelated`)

- **Title:** top = Champion room backdrop + Cynthia; ROM-font title and date. Bottom = DS touch buttons (BATTLE / PRACTICE / OPTIONS).
- **Battle:** authentic Gen 4 layout (see `web/src/ui/battle-scene.ts`); no design overrides.
- **Result:** top = outcome headline + six party slots (fainted dimmed) + turns + attempt count; bottom = SHARE / REPLAY buttons.
- **Options:** bottom-screen list (text speed, sound, readable text, trainer).

## Tokens (CSS, chrome only)

- `--league-night: #0e1330` page ground; `--league-dusk: #1c2554` vignette; star dither from a 2px repeating gradient.
- `--shell-diamond: #c9d6ea` → `#8fa6c9` console body (Diamond's ice-blue), `--shell-edge: #5b6f95`, `--hinge: #44557a`.
- `--ink: #f2f5ff` chrome text on night; `--ink-dim: #aab6dd` (≥4.5:1 on night).
- Accent `--dialga: #5a8cff` focus rings, selection, links.
- Type: chrome headings **Pixelify Sans** (Google Fonts; pixel lettering matching the DS); transcript and legend **Atkinson Hyperlegible** (readable-text mode raises to 1.125rem).
- Motion: one authored moment: the console screens power on (brightness/scanline sweep) when data loads. Everything else is the game's own animation.
