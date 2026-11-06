// OCTO: the bundled default pet, an original small octopus.
//
// Frames are composed from text pixel parts (head, face, tentacles) stamped
// onto a 24x24 grid, so the face and tentacles can change independently.
// In every part '.' means "leave what is underneath". Frames face the viewer;
// walk frames look to the right and the renderer mirrors them for walking left.
//
// Palette: o outline, b body, d shade / cheeks / tongue, h highlight, w eye shine.

import type { Anchor, CharacterPack, PackFrame } from '../pack';

const W = 24;
const H = 24;

type Part = string[];

function canvas(): string[][] {
  return Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
}

function stamp(grid: string[][], part: Part, top: number, left = 0): void {
  part.forEach((row, r) => {
    const y = top + r;
    if (y < 0 || y >= H) return;
    for (let c = 0; c < row.length; c++) {
      const x = left + c;
      if (row[c] !== '.' && x >= 0 && x < W) grid[y][x] = row[c];
    }
  });
}

// Shift the lower tentacle rows sideways by dx (from row `from` down).
function swayTips(legs: Part, dx: number, from = 4): Part {
  return legs.map((row, r) => {
    if (r < from) return row;
    return dx > 0 ? '.'.repeat(dx) + row.slice(0, row.length - dx) : row.slice(-dx) + '.'.repeat(-dx);
  });
}

// ---------------------------------------------------------------- head (12 rows)

const HEAD: Part = [
  '........oooooooo........',
  '......oohhhbbbbboo......',
  '.....ohhbbbbbbbbbbo.....',
  '....ohbbbbbbbbbbbbbo....',
  '....ohbbbbbbbbbbbbbo....',
  '...ohbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...odbbbbbbbbbbbbbbdo...',
];

// Wider, shorter head for sitting / landing squash (11 rows).
const HEAD_SQUASH: Part = [
  '.......oooooooooo.......',
  '.....oohhhbbbbbbboo.....',
  '....ohhbbbbbbbbbbbbo....',
  '...ohbbbbbbbbbbbbbbbo...',
  '..ohbbbbbbbbbbbbbbbbbo..',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..odbbbbbbbbbbbbbbbbdo..',
];

// ---------------------------------------------------------------- faces
// Stamped at head row 6 (HEAD) / head row 5 (HEAD_SQUASH).

const FACE_OPEN: Part = [
  '........wo....wo........',
  '........oo....oo........',
  '........oo....oo........',
  '......dd..o..o..dd......',
  '...........oo...........',
];

const FACE_BLINK: Part = [
  '........................',
  '........................',
  '........oo....oo........',
  '......dd..o..o..dd......',
  '...........oo...........',
];

// Looking right (walk); the renderer mirrors it for the left.
const FACE_LOOK: Part = [
  '.........wo....wo.......',
  '.........oo....oo.......',
  '.........oo....oo.......',
  '.......dd..o..o..dd.....',
  '............oo..........',
];

const FACE_SLEEP: Part = [
  '........................',
  '........................',
  '.......ooo....ooo.......',
  '......dd........dd......',
  '...........oo...........',
];

const FACE_SLEEP_DEEP: Part = [
  '........................',
  '........................',
  '.......ooo....ooo.......',
  '......dd...oo...dd......',
  '...........oo...........',
];

// Squeezed > < with a small open mouth (picked up).
const FACE_SQUISH: Part = [
  '........o......o........',
  '.........o....o.........',
  '........o......o........',
  '......dd...oo...dd......',
  '...........oo...........',
];

// Wide round eyes (surprised: picked up / falling).
const FACE_SURPRISED: Part = [
  '.......www....www.......',
  '.......wow....wow.......',
  '.......www....www.......',
  '......d....oo....d......',
  '...........oo...........',
];

// ^ ^ with a wide open smile.
const FACE_HAPPY: Part = [
  '........oo....oo........',
  '.......o..o..o..o.......',
  '........................',
  '......dd.oooooo.dd......',
  '..........oddo..........',
];

// Heavy lids, flat mouth, tongue poking out: concentrating.
const FACE_FOCUS: Part = [
  '.......ooo....ooo.......',
  '........wo....wo........',
  '........................',
  '......dd..oooo..dd......',
  '...........odo..........',
];

// Chewing: happy eyes, mouth open / closed.
const FACE_CHEW_OPEN: Part = [
  '........oo....oo........',
  '.......o..o..o..o.......',
  '........................',
  '......dd...oo...dd......',
  '..........oddo..........',
];

const FACE_CHEW_SHUT: Part = [
  '........oo....oo........',
  '.......o..o..o..o.......',
  '........................',
  '......dd..oooo..dd......',
  '........................',
];

// ---------------------------------------------------------------- tentacles (7 rows, rows 17..23)

const LEGS_STAND: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbobbbobbbbobbbobbo..',
  '.obbo.obbo.oo.obbo.obbo.',
  '.obo..obbo....obbo..obo.',
  'obbo..obo......obo..obbo',
  '.oo....o........o....oo.',
];

// Breathing: outer tips curl up a little.
const LEGS_STAND_CURL: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbobbbobbbbobbbobbo..',
  '.obbo.obbo.oo.obbo.obbo.',
  'obbo..obbo....obbo..obbo',
  'oo....obo......obo....oo',
  '.......o........o.......',
];

// Walking right: tentacle tips sway back (left) then forward (right).
const LEGS_WALK_BACK: Part = swayTips(LEGS_STAND, -1);
const LEGS_WALK_FWD: Part = swayTips(LEGS_STAND, 1);

// Dangling while held: tentacles hang straight and sway.
const LEGS_DANGLE_L: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbobbbobbobbbobbo...',
  '...obo.obo.oo.obo.obo...',
  '..obo.obo.....obo.obo...',
  '..obo.obo.....obo.obo...',
  '...o...o.......o...o....',
];

const LEGS_DANGLE_R: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '...obbbbbbbbbbbbbbbbo...',
  '...obbobbbobbobbbobbo...',
  '...obo.obo.oo.obo.obo...',
  '....obo.obo...obo.obo...',
  '....obo.obo...obo.obo...',
  '.....o...o.....o...o....',
];

// Falling: tentacles flare up and out like a little parachute.
const LEGS_FLARE_A: Part = [
  'oo.obbbbbbbbbbbbbbbbo.oo',
  'obbobbbbbbbbbbbbbbbbobbo',
  '.obbbobbbobbobbbobbbbbo.',
  '..oo.obbo.oo.obbo..oo...',
  '......oo......oo........',
];

const LEGS_FLARE_B: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  'oo.obbbbbbbbbbbbbbbbo.oo',
  'obbobbbobbbbbbobbbobbbbo',
  '.oo.obbo.oooo.obbo..oo..',
  '.....oo........oo.......',
];

// Sitting: tentacles spread flat on the ground (5 rows, rows 19..23).
const LEGS_SIT: Part = [
  '..obbbbbbbbbbbbbbbbbbo..',
  '.obbbbbbbbbbbbbbbbbbbbo.',
  'obbbobbbbobbbbobbbbobbbo',
  'obbo.obbbo.oo.obbbo.obbo',
  '.oo...ooo......ooo...oo.',
];

// Busy: two front tentacles tap like typing.
const LEGS_TAP_A: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbobbbobbbbobbbobbo..',
  '.obbo.obbo.oo.obbo.obbo.',
  '.obo..obbo....obo...obo.',
  'obbo..obo.....oo...obbo.',
  '.oo....o............oo..',
];

const LEGS_TAP_B: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbobbbobbbbobbbobbo..',
  '.obbo.obbo.oo.obbo.obbo.',
  '.obo...obo....obbo..obo.',
  'obbo....oo.....obo..obbo',
  '.oo.............o....oo.',
];

// Wave: right outer tentacle raised beside the head (drawn as an overlay).
const ARM_UP_A: Part = [
  '....................oo..',
  '...................obbo.',
  '...................obbo.',
  '..................obbo..',
  '..................obo...',
  '..................obo...',
];

const ARM_UP_B: Part = [
  '......................oo',
  '.....................obo',
  '....................obbo',
  '...................obbo.',
  '..................obbo..',
  '..................obo...',
];

// Leg set used under a raised arm: right outer tentacle is missing.
const LEGS_ONE_UP: Part = [
  '...obbbbbbbbbbbbbbbbo...',
  '..obbbbbbbbbbbbbbbbbbo..',
  '..obbobbbobbbbobbbobo...',
  '.obbo.obbo.oo.obbo.o....',
  '.obo..obbo....obbo......',
  'obbo..obo......obo......',
  '.oo....o........o.......',
];

// Eat: a tentacle lifts a snack to the mouth (snack itself is an accessory later).
const ARM_TO_MOUTH: Part = [
  '..............oo........',
  '.............oddo.......',
  '..............oddo......',
  '...............oddo.....',
];

// ---------------------------------------------------------------- composition

type Pose = {
  head?: Part;
  headTop?: number;
  face: Part;
  legs: Part;
  legsTop?: number;
  extras?: Array<{ part: Part; top: number }>;
};

function frameRows(p: Pose): string[] {
  const head = p.head ?? HEAD;
  const headTop = p.headTop ?? 5;
  const g = canvas();
  stamp(g, head, headTop);
  stamp(g, p.face, headTop + (head === HEAD_SQUASH ? 5 : 6));
  const legsTop = p.legsTop ?? H - p.legs.length;
  // Bridge any gap between the head's last row and the tentacles.
  for (let y = headTop + head.length; y < legsTop; y++) stamp(g, [head[head.length - 2]], y);
  stamp(g, p.legs, legsTop);
  for (const e of p.extras ?? []) stamp(g, e.part, e.top);
  return g.map((row) => row.join(''));
}

function anchorsFor(headTop: number): PackFrame['anchors'] {
  const head: Anchor = { x: 12, y: headTop };
  const body: Anchor = { x: 12, y: headTop + 8 };
  const hand: Anchor = { x: 19, y: headTop + 12 };
  return { head, body, hand };
}

function frame(p: Pose, ms: number): PackFrame {
  return { rows: frameRows(p), ms, anchors: anchorsFor(p.headTop ?? 5) };
}

export const OCTO_PACK: CharacterPack = {
  id: 'octo',
  name: 'OCTO',
  size: { w: W, h: H },
  scale: 4,
  palette: {
    o: '#3b1f47',
    b: '#ff8fab',
    d: '#e5607f',
    h: '#ffd3df',
    w: '#ffffff',
  },
  animations: {
    idle: [
      frame({ face: FACE_OPEN, legs: LEGS_STAND }, 700),
      frame({ face: FACE_OPEN, legs: LEGS_STAND_CURL, headTop: 6 }, 600),
      frame({ face: FACE_OPEN, legs: LEGS_STAND }, 900),
      frame({ face: FACE_BLINK, legs: LEGS_STAND }, 140),
      frame({ face: FACE_OPEN, legs: LEGS_STAND_CURL, headTop: 6 }, 600),
    ],
    walk: [
      frame({ face: FACE_LOOK, legs: LEGS_WALK_BACK }, 160),
      frame({ face: FACE_LOOK, legs: LEGS_STAND, headTop: 4, legsTop: 16 }, 160),
      frame({ face: FACE_LOOK, legs: LEGS_WALK_FWD }, 160),
      frame({ face: FACE_LOOK, legs: LEGS_STAND_CURL, headTop: 6 }, 160),
    ],
    sit: [
      frame({ head: HEAD_SQUASH, headTop: 8, face: FACE_OPEN, legs: LEGS_SIT }, 1600),
      frame({ head: HEAD_SQUASH, headTop: 8, face: FACE_BLINK, legs: LEGS_SIT }, 150),
    ],
    sleep: [
      frame({ head: HEAD_SQUASH, headTop: 8, face: FACE_SLEEP, legs: LEGS_SIT }, 1400),
      frame({ head: HEAD_SQUASH, headTop: 9, face: FACE_SLEEP_DEEP, legs: LEGS_SIT }, 1400),
    ],
    held: [
      frame({ headTop: 2, face: FACE_SURPRISED, legs: LEGS_DANGLE_L, legsTop: 14 }, 220),
      frame({ headTop: 2, face: FACE_SQUISH, legs: LEGS_DANGLE_R, legsTop: 14 }, 220),
    ],
    fall: [
      frame({ headTop: 3, face: FACE_SURPRISED, legs: LEGS_FLARE_A, legsTop: 15 }, 120),
      frame({ headTop: 3, face: FACE_SURPRISED, legs: LEGS_FLARE_B, legsTop: 15 }, 120),
    ],
    happy: [
      frame({ face: FACE_HAPPY, legs: LEGS_STAND_CURL, headTop: 6 }, 160),
      frame({ face: FACE_HAPPY, legs: LEGS_FLARE_A, headTop: 2, legsTop: 14 }, 220),
      frame({ face: FACE_HAPPY, legs: LEGS_STAND, headTop: 4 }, 160),
      frame({ face: FACE_HAPPY, legs: LEGS_STAND_CURL, headTop: 6 }, 260),
    ],
    busy: [
      frame({ face: FACE_FOCUS, legs: LEGS_TAP_A }, 140),
      frame({ face: FACE_FOCUS, legs: LEGS_TAP_B, headTop: 6 }, 140),
    ],
    wave: [
      frame({ face: FACE_HAPPY, legs: LEGS_ONE_UP, extras: [{ part: ARM_UP_A, top: 11 }] }, 260),
      frame({ face: FACE_HAPPY, legs: LEGS_ONE_UP, extras: [{ part: ARM_UP_B, top: 11 }] }, 260),
    ],
    eat: [
      frame({ face: FACE_CHEW_OPEN, legs: LEGS_ONE_UP, extras: [{ part: ARM_TO_MOUTH, top: 15 }] }, 260),
      frame({ face: FACE_CHEW_SHUT, legs: LEGS_ONE_UP, extras: [{ part: ARM_TO_MOUTH, top: 15 }] }, 260),
    ],
  },
};
