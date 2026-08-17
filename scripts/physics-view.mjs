// A TEMPORARY LOOK AT THE THREE MAPS A ROOM HAS, DRAWN ON TOP OF EACH OTHER.
//
//   node scripts/physics-view.mjs                 rooms 150 and 578
//   node scripts/physics-view.mjs 150 578 200     any rooms you like
//   node scripts/physics-view.mjs --out foo.html
//
// This is a diagnostic, not a feature. It exists because the route bake reports
//
//   room 150: 33 regions, exits in 3 of them — walking cannot join them
//   room 578: 97 regions, exits in 4 of them — walking cannot join them
//
// about two rooms characters demonstrably walk across, and "33 regions" is a number
// with no picture attached. The point of drawing it is that the three maps involved
// disagree, and only one of them is the one the mover enforces:
//
//   THE SERVER GRID     one byte a square, eight direction bits, LOS off. The map
//                       the server checks a monster's move against.
//   THE MONSTER GRID    the same shape, LOS on, stricter in places and LOOSER in
//                       others. `moveGrid` prefers it, so it is what our router
//                       plans on.
//   THE CLIENT'S BSP    walls, sector floor heights, the player's radius. What the
//                       real client — and, since #18, our own movement validation —
//                       actually collides against.
//
// A route planned on one and walked on another does not come out wrong, it comes out
// as a character walking into a wall for ever, which is the failure this project has
// been chasing. So every layer here is labelled with WHICH map it comes from.
//
// WHAT THE PICTURE SHOWED THE FIRST TIME IT WAS DRAWN, so you know what to look for:
//
// The regions are not areas. Room 150 is 3038 of its 3072 walkable squares in ONE
// region plus 31 SINGLE SQUARES, and the singletons are not enclosed — every one of
// (25,37)'s eight neighbours is floor. They are single because the direction bits are
// DIRECTED and nothing points back: you can step off that square in four directions
// and no square in the room offers a step onto it. Region labelling floods along out
// edges, so a square nothing can enter is its own region for ever.
//
// That is the whole of the "33 regions", and it would be harmless except that the
// exit anchor for room 150's door to 152 sits on one, and all FOUR of the Cragged
// Mountains' anchors sit on theirs. An anchor on an unenterable square is an exit the
// bake believes cannot be reached from anywhere — hence "walking cannot join them",
// about a room whose only genuine barrier is a cliff.
//
// World-wide: 9,261 walkable squares (3.6%) that nothing can step into, and 5.3% of
// all steps are one-way. Neither is a wall. Turn on `unenterable` and `one-way` and
// they are the layers with all the marks in them.
//
// Output goes to outputs/, which is gitignored. Delete it when the anchoring question
// is settled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const harnessRoot = path.resolve(
  process.env.M59_HARNESS_ROOT || path.join(projectRoot, "..", "m59-harness"),
);

// The harness's own geometry and its own bake, imported rather than reimplemented —
// the same rule sync-maps.mjs follows. A second copy of "which neighbours" here would
// eventually disagree with the router, and then the picture would be of a world
// nothing navigates.
const { sharedRoomGeometry } = await import(path.join(harnessRoot, "tools", "m59-roo.mjs"));
const { stepMaskFor, MASK_DIRS, exitAnchors } =
  await import(path.join(harnessRoot, "tools", "m59-routebake.mjs"));
const { loadMap } = await import(path.join(harnessRoot, "tools", "m59-map.mjs"));
const { movementMapFile } = await import(path.join(harnessRoot, "tools", "m59-map-path.mjs"));

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const [value] = argv.splice(i, 2).slice(1);
  return value ?? dflt;
};
const outFile = path.resolve(projectRoot, flag("--out", path.join("outputs", "physics-view.html")));
const rooms = argv.map(Number).filter(Number.isFinite);
const ROOMS = rooms.length ? rooms : [150, 578];

const SQUARE = 1024;                 // client units per grid square — drawdefs.h:42
const b64 = bytes => Buffer.from(bytes).toString("base64");

// The mask the router's own neighbours produce, in MASK_DIRS bit order so that every
// mask on the page can be read with one set of shifts.
function gridMask(geometry, { fine }) {
  const { rows, cols } = geometry;
  const mask = new Uint8Array(rows * cols);
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      if (!geometry.walkable(r, c)) continue;
      let bits = 0;
      for (const n of geometry.neighbors(r, c, { fine })) {
        const i = MASK_DIRS.findIndex(([dr, dc]) => n.row - r === dr && n.col - c === dc);
        if (i >= 0) bits |= 1 << i;
      }
      mask[(r - 1) * cols + (c - 1)] = bits;
    }
  }
  return mask;
}

function roomPayload(room) {
  const geometry = sharedRoomGeometry(room);
  if (!geometry?.rows) throw new Error(`room ${room.num} has no geometry`);
  const { rows, cols } = geometry;

  const walk = new Uint8Array(rows * cols);
  for (let r = 1; r <= rows; r += 1)
    for (let c = 1; c <= cols; c += 1)
      if (geometry.walkable(r, c)) walk[(r - 1) * cols + (c - 1)] = 1;

  // Three maps, one array each. `physics` is the BSP trace alone — walkable plus a
  // move the client would allow — with no direction bits in it at all, which is why
  // it is worth seeing beside them rather than merged into them.
  const monster = gridMask(geometry, { fine: true });
  const server = gridMask(geometry, { fine: false });
  const physics = geometry.collisionReady ? stepMaskFor(geometry) : new Uint8Array(rows * cols);

  const walls = geometry.walls || [];
  const solid = [], passable = [];
  for (const w of walls) {
    if (w.drawable === false) continue;
    (w.passable ? passable : solid).push(Math.round(w.x0), Math.round(w.y0),
                                         Math.round(w.x1), Math.round(w.y1));
  }

  // Every square the approach model would accept for an edge exit, not just the one
  // exitAnchors() takes. When the chosen anchor turns out to be unenterable, the
  // question is immediately "was there a better stage in the same list", and this is
  // the layer that answers it.
  const candidates = [];
  for (const e of room.edgeExits || []) {
    const dir = e.leaveName;
    if (!dir) continue;
    let list = [];
    try { list = geometry.edgeApproachCandidates(dir) || []; } catch { list = []; }
    list.forEach((cand, ci) => {
      (cand.stages || []).forEach((stage, si) => {
        candidates.push({ dir, to: e.to, row: stage.row, col: stage.col,
                          candidate: ci, stage: si, routable: !!cand.graph_routable });
      });
    });
  }

  const anchors = exitAnchors(room, geometry).map(a => ({
    kind: a.kind, dir: a.dir ?? null, to: a.to ?? null, row: a.row, col: a.col,
    locked: !!a.locked,
  }));

  // The grid is 1-based and square (r,c) spans client [(c-1)*1024, c*1024). The wall
  // list is NOT bounded by the grid — room 150's walls run from y = -6144, six squares
  // above row 1 — so the viewport is the union, or the picture silently clips geometry
  // exactly where the interesting disagreements are.
  let minX = 0, minY = 0, maxX = cols * SQUARE, maxY = rows * SQUARE;
  for (let i = 0; i < solid.length; i += 4) {
    minX = Math.min(minX, solid[i], solid[i + 2]); maxX = Math.max(maxX, solid[i], solid[i + 2]);
    minY = Math.min(minY, solid[i + 1], solid[i + 3]); maxY = Math.max(maxY, solid[i + 1], solid[i + 3]);
  }
  for (let i = 0; i < passable.length; i += 4) {
    minX = Math.min(minX, passable[i], passable[i + 2]); maxX = Math.max(maxX, passable[i], passable[i + 2]);
    minY = Math.min(minY, passable[i + 1], passable[i + 3]); maxY = Math.max(maxY, passable[i + 1], passable[i + 3]);
  }

  return {
    num: room.num, name: room.name, file: room.rooFile ?? null,
    rows, cols, square: SQUARE,
    bbox: { minX, minY, maxX, maxY },
    collisionReady: !!geometry.collisionReady,
    walkableCount: geometry.walkableCount,
    wallSummary: geometry.wallSummary,
    walk: b64(walk),
    masks: { monster: b64(monster), server: b64(server), physics: b64(physics) },
    solid, passable,
    anchors, candidates,
    goExits: (room.goExits || []).map(g => ({ row: g.row, col: g.col, to: g.to, locked: !!g.locked })),
    edgeExits: (room.edgeExits || []).map(e => ({ dir: e.leaveName, to: e.to,
      condition: e.condition ? `${e.condition.name}${e.condition.threshold}` : null })),
  };
}

const map = loadMap(movementMapFile());
const payload = [];
for (const num of ROOMS) {
  const room = map.rooms[num] ?? map.rooms[String(num)];
  if (!room?.roo) { console.error(`room ${num}: not in the map, or carries no geometry — skipped`); continue; }
  process.stderr.write(`  room ${num} ${room.name}… `);
  const t = Date.now();
  payload.push(roomPayload(room));
  process.stderr.write(`${Date.now() - t}ms\n`);
}
if (!payload.length) throw new Error("nothing to draw");

// --------------------------------------------------------------------------- page
//
// Self-contained: the masks are in the file, the flood fill runs in the browser. That
// is deliberate — region labelling is the thing under suspicion, so being able to
// switch the map it runs on and watch the count change is the whole exercise.
//
// NOTE for anyone editing PAGE: it is embedded in a template literal, so it must
// contain no backticks and no ${ of its own.
const PAGE = `
const ROOMS = DATA;
const DIRS = [[-1,0,'n'],[1,0,'s'],[0,1,'e'],[0,-1,'w'],[-1,1,'ne'],[1,1,'se'],[1,-1,'sw'],[-1,-1,'nw']];
const un64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

const state = { room: 0, lens: 'monster', undirected: false, zoom: 1, panX: 0, panY: 0, at: null,
                layers: { walls: true, passable: true, floor: true, regions: true, islands: true,
                          unenterable: true, oneway: false, refused: false, anchors: true,
                          candidates: false } };

// A LINK TO A SQUARE, so a finding can be handed to someone else rather than described.
//   #r=1&lens=server&u=1&z=8&at=16,47
// "at" centres on that row,col whatever the zoom, which is the only way to talk about a
// single square in a 70-column room. (No backticks in here — see the note above PAGE.)
function readHash() {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (q.has('r')) state.room = Math.max(0, Math.min(ROOMS.length - 1, Number(q.get('r')) || 0));
  if (q.has('lens')) state.lens = q.get('lens');
  if (q.has('u')) state.undirected = q.get('u') === '1';
  if (q.has('z')) state.zoom = Math.max(0.4, Math.min(24, Number(q.get('z')) || 1));
  if (q.has('at')) {
    const parts = q.get('at').split(',').map(Number);
    if (parts.length === 2 && parts.every(isFinite)) state.at = { row: parts[0], col: parts[1] };
  }
  if (q.has('l')) {
    const on = new Set(q.get('l').split(','));
    for (const k of Object.keys(state.layers)) state.layers[k] = on.has(k);
  }
}
function writeHash() {
  const on = Object.keys(state.layers).filter(k => state.layers[k]).join(',');
  const q = 'r=' + state.room + '&lens=' + state.lens + '&u=' + (state.undirected ? 1 : 0) +
            '&z=' + state.zoom.toFixed(2) + (state.at ? '&at=' + state.at.row + ',' + state.at.col : '') +
            '&l=' + on;
  history.replaceState(null, '', '#' + q);
}

// Everything derived from the masks, per room per lens, worked out once and kept.
const cache = new Map();
function view(roomIndex, lens, undirected) {
  const key = roomIndex + ':' + lens + ':' + (undirected ? 'u' : 'd');
  if (cache.has(key)) return cache.get(key);
  const room = ROOMS[roomIndex];
  const rows = room.rows, cols = room.cols;
  const walk = un64(room.walk);
  const monster = un64(room.masks.monster);
  const server = un64(room.masks.server);
  const physics = un64(room.masks.physics);
  const at = (r, c) => (r - 1) * cols + (c - 1);
  const mask = new Uint8Array(rows * cols);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = lens === 'monster' ? monster[i]
            : lens === 'server' ? server[i]
            : lens === 'physics' ? physics[i]
            : (monster[i] & physics[i]);
  }
  // Directed is what the bake does. Undirected answers the different question "is this
  // a separate PLACE, or only a square nothing points at".
  const canStep = (r, c, i) => {
    if (mask[at(r, c)] & (1 << i)) return true;
    if (!undirected) return false;
    const nr = r + DIRS[i][0], nc = c + DIRS[i][1];
    const back = DIRS.findIndex(d => d[0] === -DIRS[i][0] && d[1] === -DIRS[i][1]);
    return !!(mask[at(nr, nc)] & (1 << back));
  };
  const inside = (r, c) => r >= 1 && c >= 1 && r <= rows && c <= cols;

  const label = new Int32Array(rows * cols).fill(-1);
  const sizes = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) {
    if (!walk[at(r, c)] || label[at(r, c)] !== -1) continue;
    const id = sizes.length; let size = 0; const stack = [[r, c]];
    label[at(r, c)] = id;
    while (stack.length) {
      const cur = stack.pop(); size++;
      for (let i = 0; i < 8; i++) {
        const nr = cur[0] + DIRS[i][0], nc = cur[1] + DIRS[i][1];
        if (!inside(nr, nc) || !walk[at(nr, nc)]) continue;
        if (!canStep(cur[0], cur[1], i)) continue;
        if (label[at(nr, nc)] !== -1) continue;
        label[at(nr, nc)] = id; stack.push([nr, nc]);
      }
    }
    sizes.push(size);
  }

  // In-degree under the LENS, before any undirected softening: a square with none is
  // one the router can never route into, whatever it looks like on the map.
  const indeg = new Uint8Array(rows * cols);
  const oneway = [], refused = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) {
    if (!walk[at(r, c)]) continue;
    for (let i = 0; i < 8; i++) {
      const nr = r + DIRS[i][0], nc = c + DIRS[i][1];
      if (!inside(nr, nc) || !walk[at(nr, nc)]) continue;
      const out = !!(mask[at(r, c)] & (1 << i));
      const back = DIRS.findIndex(d => d[0] === -DIRS[i][0] && d[1] === -DIRS[i][1]);
      const ret = !!(mask[at(nr, nc)] & (1 << back));
      if (out) indeg[at(nr, nc)] = Math.min(255, indeg[at(nr, nc)] + 1);
      if (out && !ret) oneway.push([r, c, nr, nc]);
      // Grid says step, the client's collision says no. Only meaningful against a
      // grid lens; the physics lens IS the collision answer.
      if (lens !== 'physics' && out && !(physics[at(r, c)] & (1 << i))) refused.push([r, c, nr, nc]);
    }
  }
  const unenterable = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++)
    if (walk[at(r, c)] && !indeg[at(r, c)]) unenterable.push([r, c]);

  const out = { walk, mask, monster, server, physics, label, sizes, indeg,
                oneway, refused, unenterable, at, rows, cols };
  cache.set(key, out);
  return out;
}

// ------------------------------------------------------------------------ drawing
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
let fit = { scale: 1, x: 0, y: 0 };

// THE BIGGEST REGION IS THE BORING ONE, AND IT IS ALWAYS MOST OF THE ROOM.
//
// Colouring it like any other region paints 98.9% of Cor Noth in one hue and the eye
// reads that as the finding. It is the opposite: the finding is the handful of squares
// that are NOT in it. So the largest region gets a flat slate and every other region
// gets a colour, well away from the reds the warning marks use.
function palette(id, biggestId) {
  if (id === biggestId) return '#1e2839';
  const h = (60 + id * 137.508) % 300 + 40;
  return 'hsl(' + h.toFixed(0) + ' 60% 48%)';
}

function draw() {
  const room = ROOMS[state.room];
  const v = view(state.room, state.lens, state.undirected);
  const b = room.bbox, S = room.square;
  const W = canvas.width = canvas.clientWidth * devicePixelRatio;
  const H = canvas.height = canvas.clientHeight * devicePixelRatio;
  const base = Math.min(W / (b.maxX - b.minX), H / (b.maxY - b.minY));
  fit.scale = base * state.zoom;
  if (state.at) {
    fit.x = W / 2 - (state.at.col - 0.5) * S * fit.scale;
    fit.y = H / 2 - (state.at.row - 0.5) * S * fit.scale;
  } else {
    fit.x = -b.minX * fit.scale + state.panX * devicePixelRatio;
    fit.y = -b.minY * fit.scale + state.panY * devicePixelRatio;
  }
  const X = x => x * fit.scale + fit.x;
  const Y = y => y * fit.scale + fit.y;
  const cell = S * fit.scale;

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);

  const L = state.layers;
  let biggestId = -1, biggest = -1;
  for (let k = 0; k < v.sizes.length; k++) if (v.sizes[k] > biggest) { biggest = v.sizes[k]; biggestId = k; }
  // Floor and regions share one pass over the squares.
  if (L.floor || L.regions || L.islands || L.unenterable) {
    for (let r = 1; r <= v.rows; r++) for (let c = 1; c <= v.cols; c++) {
      const i = v.at(r, c);
      if (!v.walk[i]) continue;
      const x = X((c - 1) * S), y = Y((r - 1) * S);
      const id = v.label[i], size = id >= 0 ? v.sizes[id] : 0;
      let fill = null;
      if (L.regions && id >= 0) fill = palette(id, biggestId);
      else if (L.floor) fill = '#1b2230';
      if (L.islands && size > 0 && size <= 3 && id !== biggestId) fill = '#b45309';
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, cell + 0.5, cell + 0.5); }
      if (L.unenterable && !v.indeg[i]) {
        ctx.fillStyle = '#ff3355';
        // Capped: a mark is there to be FOUND, and at zoom 9 an uncapped one covers the
        // geometry it is pointing at.
        const d = Math.max(1.5, Math.min(12, cell * 0.34));
        ctx.fillRect(x + cell / 2 - d / 2, y + cell / 2 - d / 2, d, d);
      }
    }
  }

  const line = (r0, c0, r1, c1, colour, width) => {
    ctx.strokeStyle = colour; ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(X((c0 - 0.5) * S), Y((r0 - 0.5) * S));
    ctx.lineTo(X((c1 - 0.5) * S), Y((r1 - 0.5) * S));
    ctx.stroke();
  };
  if (L.oneway) for (const s of v.oneway) line(s[0], s[1], s[2], s[3], 'rgba(255,196,0,0.75)', 1.4);
  if (L.refused) for (const s of v.refused) line(s[0], s[1], s[2], s[3], 'rgba(0,224,255,0.8)', 1.4);

  // Walls last, over everything: they are the one layer that is never in doubt.
  if (L.passable && room.passable.length) {
    ctx.strokeStyle = 'rgba(120,200,255,0.55)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < room.passable.length; i += 4) {
      ctx.moveTo(X(room.passable[i]), Y(room.passable[i + 1]));
      ctx.lineTo(X(room.passable[i + 2]), Y(room.passable[i + 3]));
    }
    ctx.stroke();
  }
  if (L.walls && room.solid.length) {
    ctx.strokeStyle = '#e8eef8'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < room.solid.length; i += 4) {
      ctx.moveTo(X(room.solid[i]), Y(room.solid[i + 1]));
      ctx.lineTo(X(room.solid[i + 2]), Y(room.solid[i + 3]));
    }
    ctx.stroke();
  }

  if (L.candidates) for (const cand of room.candidates) {
    const x = X((cand.col - 0.5) * S), y = Y((cand.row - 0.5) * S);
    ctx.strokeStyle = 'rgba(160,255,180,0.8)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(x - cell * 0.4, y - cell * 0.4, cell * 0.8, cell * 0.8);
  }
  if (L.anchors) for (const a of room.anchors) {
    const i = v.at(a.row, a.col);
    const id = v.label[i], size = id >= 0 ? v.sizes[id] : 0;
    const bad = !v.indeg[i] || size <= 3;
    const x = X((a.col - 0.5) * S), y = Y((a.row - 0.5) * S);
    const rad = Math.max(4, Math.min(15, cell * 0.55));
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = bad ? 'rgba(255,60,90,0.9)' : 'rgba(120,255,160,0.9)';
    ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0e14'; ctx.stroke();
  }
  stats(room, v);
  writeHash();
}

function bits(mask, i) {
  const on = [];
  for (let k = 0; k < 8; k++) if (mask[i] & (1 << k)) on.push(DIRS[k][2]);
  return on.length ? on.join(' ') : '—';
}

function stats(room, v) {
  const singles = v.sizes.filter(s => s === 1).length;
  const biggest = Math.max.apply(null, v.sizes.length ? v.sizes : [0]);
  const anchorTrouble = room.anchors.filter(a => {
    const i = v.at(a.row, a.col);
    return !v.indeg[i] || (v.label[i] >= 0 && v.sizes[v.label[i]] <= 3);
  });
  const rowsOut = [
    ['room', room.num + ' ' + room.name + '  (' + room.rows + 'x' + room.cols + ', ' + room.file + ')'],
    ['walkable squares', room.walkableCount],
    ['regions', v.sizes.length + '   biggest ' + biggest +
      ' (' + (100 * biggest / room.walkableCount).toFixed(1) + '% of the floor), ' +
      singles + ' single squares'],
    ['unenterable squares', v.unenterable.length + '   nothing in the room can step onto these'],
    ['one-way steps', v.oneway.length],
    ['steps the BSP refuses', state.lens === 'physics' ? 'n/a on this lens' : v.refused.length],
    ['exit anchors', room.anchors.length + ' — ' + anchorTrouble.length + ' stranded'],
    ['walls', room.wallSummary ? (room.wallSummary.total + ' total, ' +
      room.wallSummary.passable + ' passable, ' + room.wallSummary.map_never + ' never drawn') : '—'],
  ];
  document.getElementById('stats').innerHTML = rowsOut
    .map(r => '<div><b>' + r[0] + '</b><span>' + r[1] + '</span></div>').join('');

  document.getElementById('stranded').innerHTML = anchorTrouble.length
    ? '<h3>stranded exit anchors</h3>' + anchorTrouble.map(a => {
        const i = v.at(a.row, a.col);
        const id = v.label[i];
        return '<div class="bad">' + a.kind + (a.dir ? ' ' + a.dir : '') + ' &rarr; room ' + a.to +
          ' at row ' + a.row + ', col ' + a.col +
          '<br><small>region ' + id + ' of ' + (id >= 0 ? v.sizes[id] : 0) + ' square(s), in-degree ' +
          v.indeg[i] + ' — out: ' + bits(v.mask, i) + '</small></div>';
      }).join('')
    : '<h3>stranded exit anchors</h3><div class="ok">none on this lens</div>';
}

// ------------------------------------------------------------------------- hover
canvas.addEventListener('mousemove', ev => {
  const room = ROOMS[state.room], v = view(state.room, state.lens, state.undirected);
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) * devicePixelRatio - fit.x) / fit.scale;
  const y = ((ev.clientY - rect.top) * devicePixelRatio - fit.y) / fit.scale;
  const c = Math.floor(x / room.square) + 1, r = Math.floor(y / room.square) + 1;
  const box = document.getElementById('hover');
  if (r < 1 || c < 1 || r > room.rows || c > room.cols) { box.innerHTML = '<i>outside the grid</i>'; return; }
  const i = v.at(r, c);
  const id = v.label[i];
  box.innerHTML = '<b>row ' + r + ', col ' + c + '</b>' +
    '<div>' + (v.walk[i] ? 'floor' : 'no floor') +
    (v.walk[i] ? ', region ' + id + ' (' + (id >= 0 ? v.sizes[id] : 0) + ' sq), in-degree ' + v.indeg[i] : '') + '</div>' +
    '<div>monster grid out: ' + bits(v.monster, i) + '</div>' +
    '<div>server grid out: ' + bits(v.server, i) + '</div>' +
    '<div>BSP physics out: ' + bits(v.physics, i) + '</div>';
});

// -------------------------------------------------------------------- pan / zoom
let drag = null;
canvas.addEventListener('mousedown', ev => {
  // Dragging away from a linked square adopts wherever it currently sits, so the view
  // does not jump back to centre on the first pixel of movement.
  if (state.at) {
    const b = ROOMS[state.room].bbox;
    state.panX = (fit.x + b.minX * fit.scale) / devicePixelRatio;
    state.panY = (fit.y + b.minY * fit.scale) / devicePixelRatio;
    state.at = null;
  }
  drag = { x: ev.clientX, y: ev.clientY, px: state.panX, py: state.panY };
});
addEventListener('mouseup', () => { drag = null; });
addEventListener('mousemove', ev => {
  if (!drag) return;
  state.panX = drag.px + (ev.clientX - drag.x);
  state.panY = drag.py + (ev.clientY - drag.y);
  draw();
});
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  state.zoom = Math.max(0.4, Math.min(24, state.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
  draw();
}, { passive: false });

// ------------------------------------------------------------------------ chrome
function controls() {
  const roomSel = document.getElementById('rooms');
  roomSel.innerHTML = ROOMS.map((r, i) =>
    '<option value="' + i + '">' + r.num + ' — ' + r.name + '</option>').join('');
  roomSel.value = String(state.room);
  roomSel.onchange = () => {
    state.room = Number(roomSel.value);
    state.zoom = 1; state.panX = state.panY = 0; state.at = null; draw();
  };

  document.querySelectorAll('input[name=lens]').forEach(el => {
    el.checked = el.value === state.lens;
    el.onchange = () => { state.lens = el.value; draw(); };
  });
  const und = document.getElementById('undirected');
  und.checked = state.undirected;
  und.onchange = ev => { state.undirected = ev.target.checked; draw(); };
  document.getElementById('reset').onclick = () => {
    state.zoom = 1; state.panX = state.panY = 0; state.at = null; draw();
  };

  const box = document.getElementById('layers');
  box.innerHTML = Object.keys(state.layers).map(k =>
    '<label><input type="checkbox" data-layer="' + k + '"' +
    (state.layers[k] ? ' checked' : '') + '> ' + k + '</label>').join('');
  box.querySelectorAll('input').forEach(el => {
    el.onchange = () => { state.layers[el.dataset.layer] = el.checked; draw(); };
  });
}
readHash();
controls();
addEventListener('resize', draw);
draw();
`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>m59 wall geometry / physics view</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0e14; color: #d7dee9;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 10px 14px; border-bottom: 1px solid #222a38; display: flex;
           gap: 18px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  main { display: grid; grid-template-columns: 1fr 320px; height: calc(100vh - 52px); }
  #map { width: 100%; height: 100%; display: block; cursor: grab; }
  aside { border-left: 1px solid #222a38; padding: 12px 14px; overflow: auto; }
  fieldset { border: 1px solid #222a38; margin: 0 0 12px; padding: 8px 10px; }
  legend { color: #8b98ab; padding: 0 4px; }
  label { display: inline-flex; gap: 5px; align-items: center; margin-right: 10px; white-space: nowrap; }
  #layers label { display: flex; }
  #stats div { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0;
               border-bottom: 1px dotted #1d2532; }
  #stats b { color: #8b98ab; font-weight: 500; }
  #stats span { text-align: right; }
  #hover { min-height: 84px; color: #a8b4c6; }
  h3 { font-size: 12px; color: #8b98ab; margin: 12px 0 6px; font-weight: 500; }
  .bad { border-left: 2px solid #ff3355; padding: 4px 8px; margin-bottom: 6px; background: #16111a; }
  .ok { color: #7fd4a0; }
  small { color: #8b98ab; }
  select, button { background: #121826; color: inherit; border: 1px solid #2a3444;
                   padding: 3px 7px; font: inherit; }
  .key { display: flex; gap: 14px; flex-wrap: wrap; color: #8b98ab; font-size: 12px; }
  .key i { font-style: normal; }
  .sw { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; margin-right: 4px; }
</style>
<header>
  <h1>wall geometry / physics view</h1>
  <select id="rooms"></select>
  <span>
    lens:
    <label><input type="radio" name="lens" value="monster" checked> monster grid (router)</label>
    <label><input type="radio" name="lens" value="server"> server grid</label>
    <label><input type="radio" name="lens" value="physics"> BSP physics</label>
    <label><input type="radio" name="lens" value="both"> monster &and; physics</label>
  </span>
  <label><input type="checkbox" id="undirected"> treat steps as two-way</label>
  <button id="reset">reset view</button>
</header>
<main>
  <canvas id="map"></canvas>
  <aside>
    <fieldset><legend>this room, this lens</legend><div id="stats"></div></fieldset>
    <fieldset><legend>layers</legend><div id="layers"></div></fieldset>
    <fieldset><legend>under the pointer</legend><div id="hover"><i>hover the map</i></div></fieldset>
    <div id="stranded"></div>
    <fieldset><legend>key</legend>
      <div class="key">
        <i><span class="sw" style="background:#e8eef8"></span>solid wall</i>
        <i><span class="sw" style="background:#1e2839;outline:1px solid #2a3444"></span>biggest region</i>
        <i><span class="sw" style="background:#78c8ff"></span>passable wall</i>
        <i><span class="sw" style="background:#b45309"></span>region of &le;3 squares</i>
        <i><span class="sw" style="background:#ff3355"></span>unenterable square</i>
        <i><span class="sw" style="background:#ffc400"></span>one-way step</i>
        <i><span class="sw" style="background:#00e0ff"></span>step the BSP refuses</i>
        <i><span class="sw" style="background:#78ffa0"></span>exit anchor</i>
        <i><span class="sw" style="background:#ff3c5a"></span>stranded anchor</i>
      </div>
      <p style="color:#8b98ab">Region colour is arbitrary — only <b>sameness</b> means anything.
      Drag to pan, wheel to zoom.</p>
    </fieldset>
  </aside>
</main>
<script>
${PAGE.replace("DATA", JSON.stringify(payload))}
</script>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.error(`wrote ${outFile} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB, ` +
              `${payload.length} room(s))`);
