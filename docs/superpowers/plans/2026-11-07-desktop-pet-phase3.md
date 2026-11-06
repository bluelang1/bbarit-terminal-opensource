# Desktop Pet — Phase 3 Implementation Plan (seasons and special days)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** The pet changes with the calendar: seasonal looks and particles, and special-day outfits and treats it eats.

**Spec:** `docs/superpowers/specs/2026-11-06-desktop-pet-design.md` — Goals 5–6, "Rendering and art" (three layers, shared accessories with per-frame anchors), "Behavior engine" item 5.

## Global Constraints

- Local date (the Mac's timezone). Special days are all day:
  11/11 빼빼로데이 (Pepero, eats it), 2/14 발렌타인데이 (chocolate, eats it), 3/14 화이트데이 (candy, eats it),
  10/31 할로윈 (costume + pumpkin, no eating), 12/24–12/25 크리스마스 (Santa hat + outfit, no eating).
- Seasons by month: spring 3–5 (falling cherry petals), summer 6–8 (sunglasses; occasional fan/heat shimmer),
  autumn 9–11 (falling leaves), winter 12–2 (scarf; breath puffs).
- A special day's outfit replaces the season's wearable on that day (e.g. Christmas Santa hat instead of the
  winter scarf only if they collide on the same anchor; scarf + Santa hat may both show if they use different anchors).
  Season particles keep running on special days.
- Accessories are shared across packs: authored once as pixel row strings + palette in `src/pet/accessories.ts`,
  positioned by per-frame anchors (`head`, `hand`, `body`) declared in each pack. A pack frame without the needed
  anchor simply does not draw that accessory (no crash, no guess).
- Particles (petals, leaves, breath puffs, heat shimmer) are drawn in code inside the pet window, pixel-style
  (2 CSS px per art pixel like the bubble), cheap: at most ~12 particles alive, updated on the existing tick.
- Eating: on treat days the engine plays `eat` (in place) every 2–5 min for 3–5 s while idle (`mood: 'none'`),
  with the treat drawn at the `hand` anchor and shrinking bites across the eat frames. Claude moods win over eating.
- Debug override (debug builds only, `import.meta.env.DEV`): `localStorage['bbarit.pet.debugDate'] = 'YYYY-MM-DD'`
  makes the pet use that date, re-read on every visibility change. Release builds ignore it.
- No network, no new permissions. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

1. Year boundary: 12/31 → 1/1 while the pet is visible switches Christmas/winter correctly (calendar re-evaluated at least every minute).
2. A user pack with no anchors still renders the body (accessories skipped) and particles still run.
3. Claude blocked on Pepero day: wave + bubble, no eating, no treat in hand.
4. Pet asleep on a treat day: does not wake up to eat (sleep wins over eating); accessories still drawn on the sleeping frame where anchors exist.
5. Particles never block clicks and stop when the window is hidden (loop already stops).

---

### Task 1: Calendar model (pure)
**Files:** Create `src/pet/calendar.ts`, `src/pet/calendar.test.ts`.
**Produces:** `type Season = 'spring'|'summer'|'autumn'|'winter'`; `type SpecialDay = 'pepero'|'valentine'|'white'|'halloween'|'christmas'`;
`type PetCalendar = { season: Season; special: SpecialDay | null }`; `calendarFor(d: Date): PetCalendar`;
`treatFor(s: SpecialDay | null): 'pepero'|'chocolate'|'candy'|null`; `petDate(now: Date, debugDate: string | null, isDev: boolean): Date`.
- [ ] Tests: every boundary (2/28→3/1 spring, 5/31→6/1 summer, 8/31→9/1 autumn, 11/30→12/1 winter, 12/31, 1/1), each special day and the day before/after, 12/24 and 12/25 both christmas, `petDate` ignores debugDate when `isDev` false and on malformed strings. FAIL → implement → PASS → commit.

### Task 2: Accessories, anchors, particles
**Files:** Create `src/pet/accessories.ts`, `src/pet/accessories.test.ts`, `src/pet/particles.ts`, `src/pet/particles.test.ts`; modify `src/pet/characters/octo.ts` (anchors on every frame), `src/pet/render.ts`.
**Produces:** `type AccessoryId = 'santaHat'|'santaSuit'|'witchHat'|'pumpkin'|'scarf'|'sunglasses'|'pepero'|'chocolate'|'candy'`;
`ACCESSORIES: Record<AccessoryId, { anchor: 'head'|'hand'|'body'; frames: { rows: string[]; ox: number; oy: number }[]; palette: Record<string,string> }>`
(treats have 3 bite frames; others 1); `accessoriesFor(cal: PetCalendar, anim: AnimName): AccessoryId[]` (treat only during `eat`);
`drawAccessory(ctx, id, frameIndex, anchor, scale, flip)`; particles: `type Particle`; `spawnFor(cal, rand, w, h): Particle | null`;
`stepParticles(ps: Particle[], dtMs: number, w: number, h: number): Particle[]` (cap 12); `drawParticles(ctx, ps, scale)`.
Halloween = witch hat + pumpkin carried at `hand`; Christmas = santaHat + santaSuit; winter = scarf; summer = sunglasses.
- [ ] Tests: every accessory row length consistent and only palette chars; every OCTO frame has head/hand/body anchors inside the sprite box;
  `accessoriesFor` table (christmas → santa, winter non-christmas → scarf, pepero non-eat → [] (+ season wearable), pepero eat → pepero);
  pack without anchors → draw skipped (spy on ctx); particle cap and removal when leaving the box. FAIL → implement → PASS.
- [ ] Render previews (throwaway script outside repo) of OCTO in each season and each special day incl. eat frames to
  `/private/tmp/claude-501/-Users-heesungshim-RustroverProjects-bbarit-terminal-opensource/ac5f347d-a98b-4345-b52b-c7bd466152ee/scratchpad/calendar-preview/`, look at them, iterate. Commit.

### Task 3: Engine eating + page wiring
**Files:** Modify `src/pet/engine.ts`, `src/pet/engine.test.ts`, `src/pages/PetPage.tsx`.
**Interfaces:** `PetInput` gains `treat: boolean`. Eating rules per Global Constraints; sleep and Claude moods and dragging win.
PetPage: computes `calendarFor(petDate(...))` on start, on visibility and every 60 s; draws season/special accessories and particles; eat uses treat frames.
- [ ] Tests (engine): treat day idle → eats within the window using stubbed rand; blocked → never eats; asleep → stays asleep. FAIL → implement → PASS.
- [ ] Verify: `npx tsc -p tsconfig.app.json --noEmit`, `npx vitest run src/pet src/config`, `npm run build` (NODE_OPTIONS=--max-old-space-size=5120). Commit.

### Task 4: Dev-app check with the owner
- [ ] Main session sets `bbarit.pet.debugDate` to each special day / season in the dev app and the owner looks.
