# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the owner's written brief (2026-10-16); the owner asked for a single uninterrupted build, so no interview round was held. Every line below is an inference from that brief unless marked otherwise.

## Platform

web

## Stack

Delegated in the brief: TypeScript + Vite, plain DOM + Canvas 2D, `@pkmn/sim` for Gen 4 mechanics; Python extractor for ROM data. Static site, no backend.

## Users

Pokémon fans who played Diamond/Pearl and enjoy a short daily ritual like Wordle: open the page once a day, play one fair battle, share a spoiler-free result with friends.

## Product Purpose

One puzzle per UTC day: six random, legal level-76 Pokémon vs. Champion Cynthia with her real team and real ROM AI. The first attempt of the day is the scored attempt; replays are practice. Success = the battle feels like the real game and the daily result is worth sharing.

## Positioning

Everything on the battle screen comes from the player's own Diamond ROM, extracted locally: the real sprites, font, music, text and Cynthia's actual trainer-AI bytecode. Nothing Nintendo-owned ships with the site.

## Operating Context

Desktop and phone browsers. Played in short sessions (5–15 min). Keyboard (Z/X/arrows), mouse, or touch on the bottom screen like a DS stylus.

## Capabilities and Constraints

- Same team for everyone on a date (seeded from `YYYYMMDD`); deterministic reroll keeps puzzles winnable.
- Player picks moves and switches; Bag and Run behave like a real trainer battle (no items, no running).
- Results stored only in the browser (localStorage). No accounts, leaderboards, or monetization.
- The ROM data must be extracted locally before play; the site must explain this when data is missing.

## Brand Commitments

- The battle scene must look like Pokémon Diamond; design opinions never override it (owner, explicit).
- Menus, result screens and surrounding site stay tied to the Gen 4 / DS identity rather than generic modern UI (owner, explicit).

## Evidence on Hand

ROM-extracted assets under `extracted/` (git-ignored, user-supplied). No testimonials, press, or user data exist; none may be fabricated.

## Product Principles

1. Authentic first: when the real game has an answer (text, timing, layout), use it.
2. One fair puzzle a day; practice never changes the score.
3. Ship only our code; the ROM stays with its owner.
4. Spoiler-free sharing.

## Accessibility & Inclusion

Keyboard play, a readable-text mode (plain-HTML battle transcript, larger type), mute toggle, responsive integer scaling (owner, explicit).
