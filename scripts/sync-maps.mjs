// Build browser-sized map assets from m59-harness's compiled world model.
// The harness remains the source of truth; this project keeps no hand-authored map.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const harnessRoot = path.resolve(
  process.env.M59_HARNESS_ROOT || path.join(projectRoot, "..", "m59-harness"),
);
const mapSource = path.join(harnessRoot, "substrate", "m59-map.json");
const zoneSource = path.join(harnessRoot, "compendium", "data", "zones.json");
const outputRoot = path.join(projectRoot, "public", "maps");
const roomOutput = path.join(outputRoot, "rooms");

for (const source of [mapSource, zoneSource]) {
  if (!fs.existsSync(source)) {
    throw new Error(`m59-harness map source is missing: ${source}`);
  }
}

// THE HARNESS'S OWN GEOMETRY, IMPORTED RATHER THAN REIMPLEMENTED.
//
// The disconnection overlay is only worth drawing if it shows what the FLEET's router
// believes — a second copy of "walkable" and "which neighbours" here would eventually
// disagree with the harness by a square or a rule, and then the picture would be of a
// world nothing actually navigates. This project already treats the harness as the source
// of truth for map DATA; for this it needs the same rules too.
const { sharedRoomGeometry, protocolToClient } = await import(
  path.join(harnessRoot, "tools", "m59-roo.mjs")
);
// The region labelling is the harness's own, from the offline route bake, for the same
// reason: `components()` is what decides whether walking can join two exits at all, and a
// second copy of it here would eventually answer differently from the fleet's router.
const { components } = await import(
  path.join(harnessRoot, "tools", "m59-routebake.mjs")
);
// The baked step masks, and the harness's own list of rooms worth a human looking at.
const { attachStepMasks } = await import(
  path.join(harnessRoot, "tools", "m59-routes.mjs")
);
const { review } = await import(
  path.join(harnessRoot, "tools", "m59-mapreview.mjs")
);

const mapData = JSON.parse(fs.readFileSync(mapSource, "utf8"));
const zoneData = JSON.parse(fs.readFileSync(zoneSource, "utf8"));
fs.mkdirSync(roomOutput, { recursive: true });

// ATTACH THE MASKS BEFORE ANYTHING ASKS `components()` A QUESTION. This is the difference
// between a sync that takes seconds and one that takes a quarter of an hour — on `predev`,
// `prebuild` AND `prestart`.
//
// `components()` labels the squares the FLEET's router can actually join, which means
// asking the mover's own collision trace. Measured, that trace is 28 SECONDS for one big
// room (576) and there are 264 of them. The harness bakes the whole answer offline into
// substrate/m59-routes.json — one byte a square, one bit a direction — and this hands it
// over, after which the same question is an array index.
//
// No table, or one baked from different geometry, is not an error: the harness falls back
// to the coarse grid exactly as it did before any of this existed. But it IS worth saying
// out loud, because the overlay then draws the coarse grid's opinion rather than the
// router's, and a picture of the wrong map is the one thing this file exists to avoid.
const masks = attachStepMasks(mapData);
console.log(masks.attached
  ? `Attached ${masks.attached} baked step mask(s) — overlays show the router's own view.`
  : `No step masks (${masks.why}); overlays fall back to the coarse grid and this sync will be slow.`);

function writeJson(file, value) {
  const contents = JSON.stringify(value);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(file, contents);
      return;
    } catch (error) {
      if (error?.code !== "EPERM" || attempt >= 40) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const DIRS = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  w: [-1, 0],
};
const CELL_W = 146;
const CELL_H = 74;
const NODE_HALF_W = 66;
const NODE_HALF_H = 30;
const COMPONENT_GAP = 74;

function layoutWorld(rooms) {
  const positions = {};
  const components = {};
  let component = 0;
  const order = Object.keys(rooms)
    .filter((key) => rooms[key].exits.some((exit) => exit.kind === "edge" && exit.to))
    .sort(
      (a, b) =>
        rooms[b].exits.filter((exit) => exit.kind === "edge" && exit.to).length -
        rooms[a].exits.filter((exit) => exit.kind === "edge" && exit.to).length,
    );

  for (const seed of order) {
    if (positions[seed]) continue;
    component += 1;
    const taken = new Map();
    const place = (key, x, y) => {
      positions[key] = { x, y, component };
      components[key] = component;
      taken.set(`${x},${y}`, key);
    };
    place(seed, 0, 0);
    const queue = [seed];

    while (queue.length) {
      const at = queue.shift();
      for (const exit of rooms[at].exits) {
        if (exit.kind !== "edge" || !exit.to || !rooms[exit.to]) continue;
        const direction = DIRS[exit.dir];
        if (!direction) continue;
        const wantedX = positions[at].x + direction[0];
        const wantedY = positions[at].y + direction[1];
        if (positions[exit.to]) continue;

        let x = wantedX;
        let y = wantedY;
        if (taken.has(`${x},${y}`)) {
          let found = false;
          for (let ring = 1; ring <= 6 && !found; ring += 1) {
            for (let dx = -ring; dx <= ring && !found; dx += 1) {
              for (let dy = -ring; dy <= ring && !found; dy += 1) {
                if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                if (!taken.has(`${wantedX + dx},${wantedY + dy}`)) {
                  x = wantedX + dx;
                  y = wantedY + dy;
                  found = true;
                }
              }
            }
          }
          if (!found) continue;
        }
        place(exit.to, x, y);
        queue.push(exit.to);
      }
    }
  }
  return { positions, components };
}

function buildWorldAsset(rooms) {
  const layout = layoutWorld(rooms);
  const groups = new Map();
  for (const [key, position] of Object.entries(layout.positions)) {
    groups.set(position.component, [...(groups.get(position.component) || []), key]);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const packed = new Map();
  let belowX = 0;
  let belowY = 0;
  let belowRowHeight = 0;
  let primaryWidth = 0;

  sortedGroups.forEach(([component, keys], index) => {
    const xs = keys.map((key) => layout.positions[key].x);
    const ys = keys.map((key) => layout.positions[key].y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = (maxX - minX + 1) * CELL_W + 14;
    const height = (maxY - minY + 1) * CELL_H + 14;
    let offsetX = 0;
    let offsetY = 0;

    if (index === 0) {
      primaryWidth = width;
      belowY = height + COMPONENT_GAP;
    } else {
      if (belowX && belowX + width > Math.max(primaryWidth, 1500)) {
        belowX = 0;
        belowY += belowRowHeight + COMPONENT_GAP;
        belowRowHeight = 0;
      }
      offsetX = belowX;
      offsetY = belowY;
      belowX += width + COMPONENT_GAP;
      belowRowHeight = Math.max(belowRowHeight, height);
    }
    packed.set(component, { offsetX, offsetY, minX, minY, width, height, keys });
  });

  const nodes = [];
  const nodeByKey = new Map();
  for (const [key, position] of Object.entries(layout.positions)) {
    const room = rooms[key];
    const pack = packed.get(position.component);
    const node = {
      key,
      roomNum: room.ridValue,
      name: room.disp || room.name,
      region: room.region,
      slug: room.slug,
      component: position.component,
      x: pack.offsetX + (position.x - pack.minX) * CELL_W + 80,
      y: pack.offsetY + (position.y - pack.minY) * CELL_H + 44,
    };
    nodes.push(node);
    nodeByKey.set(key, node);
  }

  const edges = [];
  const drawn = new Set();
  for (const node of nodes) {
    for (const exit of rooms[node.key].exits) {
      if (exit.kind !== "edge" || !nodeByKey.has(exit.to)) continue;
      const target = nodeByKey.get(exit.to);
      const edgeKey = [node.roomNum, target.roomNum].sort((a, b) => a - b).join(":");
      if (drawn.has(edgeKey)) continue;
      drawn.add(edgeKey);
      edges.push({ from: node.roomNum, to: target.roomNum, x1: node.x, y1: node.y, x2: target.x, y2: target.y });
    }
  }

  const adjacency = new Map();
  const connect = (a, b) => {
    if (!a || !b) return;
    adjacency.set(a, new Set([...(adjacency.get(a) || []), b]));
    adjacency.set(b, new Set([...(adjacency.get(b) || []), a]));
  };
  for (const [key, room] of Object.entries(rooms)) {
    for (const exit of room.exits) if (exit.to && rooms[exit.to]) connect(key, exit.to);
  }

  const laidKeys = new Set(nodes.map((node) => node.key));
  const anchors = {};
  for (const [start, room] of Object.entries(rooms)) {
    if (room.ridValue == null) continue;
    if (laidKeys.has(start)) {
      anchors[room.ridValue] = room.ridValue;
      continue;
    }
    const queue = [start];
    const seen = new Set(queue);
    let anchor = null;
    while (queue.length && !anchor) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (seen.has(next)) continue;
        if (laidKeys.has(next)) {
          anchor = rooms[next].ridValue;
          break;
        }
        seen.add(next);
        queue.push(next);
      }
    }
    anchors[room.ridValue] = anchor;
  }

  const componentAssets = [...packed.entries()].map(([id, pack], index) => {
    const regions = [...new Set(pack.keys.map((key) => rooms[key].region))];
    return {
      id,
      primary: index === 0,
      x: pack.offsetX,
      y: pack.offsetY,
      width: pack.width,
      height: pack.height,
      label: index === 0 ? "The main landmass" : `Landmass ${index + 1}`,
      regions,
    };
  });

  // Some real rooms intentionally have no graph exit at all (most importantly the
  // Underworld). Keep them visibly separate instead of inventing a connection or
  // silently dropping fleet members who are standing there.
  const isolated = Object.entries(rooms).filter(([, room]) => room.ridValue != null && anchors[room.ridValue] == null);
  if (isolated.length) {
    const primary = componentAssets.find((component) => component.primary);
    const componentId = Math.max(...componentAssets.map((component) => component.id)) + 1;
    const columns = 3;
    const offsetX = primary.width + COMPONENT_GAP;
    const offsetY = 0;
    isolated.forEach(([key, room], index) => {
      const node = {
        key,
        roomNum: room.ridValue,
        name: room.disp || room.name,
        region: room.region,
        slug: room.slug,
        component: componentId,
        x: offsetX + (index % columns) * CELL_W + 80,
        y: offsetY + Math.floor(index / columns) * CELL_H + 44,
      };
      nodes.push(node);
      anchors[room.ridValue] = room.ridValue;
    });
    componentAssets.push({
      id: componentId,
      primary: false,
      x: offsetX,
      y: offsetY,
      width: columns * CELL_W + 14,
      height: Math.ceil(isolated.length / columns) * CELL_H + 14,
      label: "Portal & isolated realms",
      regions: [...new Set(isolated.map(([, room]) => room.region))],
    });
  }
  const width = Math.max(...componentAssets.map((component) => component.x + component.width));
  const height = Math.max(...componentAssets.map((component) => component.y + component.height));

  return {
    source: path.relative(projectRoot, zoneSource).replaceAll("\\", "/"),
    generatedAt: new Date().toISOString(),
    width,
    height,
    nodeWidth: NODE_HALF_W * 2,
    nodeHeight: NODE_HALF_H * 2,
    components: componentAssets,
    nodes,
    edges,
    anchors,
  };
}

// SQUARE CENTRES ARE (n - 0.5), NOT (n + 0.5), AND GETTING THAT WRONG DREW THE WHOLE
// FLEET ONE SQUARE DOWN-RIGHT OF WHERE IT WAS STANDING.
//
// Room grids are 1-BASED — the wire carries a +64 bias and the client subtracts it, so
// square col 1 spans client x [0, 1024) and its centre is at 512. `(col + 0.5) * 1024`
// puts col 1 at 1536, which is the middle of square TWO.
//
// Forward and inverse were both wrong the same way, so clicking a marker still selected
// the square under it and the round trip looked fine. What did not look fine was the
// picture: every character, monster, safe spot and exit sat one square off from the walls
// they were supposed to be standing against, which is exactly how it was noticed.
//
// Checked against the geometry: room 52 is 11x11 and its walls span client x 0..10704.
// With (n - 0.5) the last square centre is 10752, inside the room; with (n + 0.5) it is
// 11776, a full square past the end of it.
//
// One helper, used everywhere, because six copies of a magic expression is how all six
// came to be wrong at once.
const SQUARE = 1024;
const squareCentre = (n) => (n - 0.5) * SQUARE;

function roomAsset(room) {
  const walls = room.roo?.walls || [];
  if (!walls.length) return null;
  let geometry = null;
  try { geometry = sharedRoomGeometry(room); } catch { geometry = null; }
  if (!geometry?.rows) geometry = null;
  // One labelling per room, shared by the disconnection overlay and by every exit's
  // "which side of the room is this on" — they are the same question.
  const regions = geometry ? components(geometry) : null;
  const regionOfSquare = (row, col) => {
    if (!regions) return null;
    const r = Math.round(row);
    const c = Math.round(col);
    if (!(r >= 1 && c >= 1 && r <= geometry.rows && c <= geometry.cols)) return null;
    const id = regions.label[regions.at(r, c)];
    return id < 0 ? null : id;
  };
  // WHICH SQUARES THE BODY OF THE ROOM CANNOT WALK TO — the "unpathable" overlay.
  //
  // A DIFFERENT QUESTION FROM THE DISCONNECTION LINES BESIDE IT, and the difference is
  // direction. `disconnects` draws the boundary between two regions, which is symmetric
  // and says nothing about which side you can get to. This is one flood outward from the
  // largest region, so a square is marked when the room's main floor cannot REACH it.
  //
  // That matters because the mover's step graph is directed and heavily so: the stock
  // client only blocks a move that gets CLOSER to a wall, so a square whose centre already
  // lies inside a wall's radius can be left and not entered. A pocket you can step out of
  // is a safe spot; one you cannot step into is scenery. Drawn the same, they would read
  // the same, and only one of them is somewhere to send a character.
  const unpathable = unpathableSquares(geometry, regions);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x0, y0, x1, y1] of walls) {
    minX = Math.min(minX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxX = Math.max(maxX, x0, x1);
    maxY = Math.max(maxY, y0, y1);
  }
  if (!Number.isFinite(minX)) return null;
  const max = 720;
  const pad = 8;
  const scale = Math.min(max / Math.max(1, maxX - minX), max / Math.max(1, maxY - minY));
  const width = Math.round((maxX - minX) * scale) + pad * 2;
  const height = Math.round((maxY - minY) * scale) + pad * 2;
  const X = (x) => (x - minX) * scale + pad;
  const Y = (y) => (y - minY) * scale + pad;
  const pathFor = (segments) =>
    segments
      .map(
        ([x0, y0, x1, y1]) =>
          `M${X(x0).toFixed(1)} ${Y(y0).toFixed(1)}L${X(x1).toFixed(1)} ${Y(y1).toFixed(1)}`,
      )
      .join("");
  const solid = walls.filter((wall) => !(wall[4] & 1));
  const passage = walls.filter((wall) => wall[4] & 1);
  const roomByNumber = mapData.rooms;
  const exitName = (to) =>
    to > 0 ? roomByNumber[String(to)]?.name || `Room ${to}` : "Locked passage";
  const exits = (room.goExits || [])
    .filter((exit) => exit.row != null && exit.col != null)
    .map((exit) => ({
      row: exit.row,
      col: exit.col,
      x: X(squareCentre(exit.col)),
      y: Y(squareCentre(exit.row)),
      locked: Boolean(exit.locked || exit.to < 0),
      toRoom: exit.to > 0 ? exit.to : null,
      to: exitName(exit.to),
      kind: "door",
      direction: null,
      // A `go` exit names its own square, so there is nothing to model and nothing to guess.
      approach: "named",
      openings: null,
      region: regionOfSquare(exit.row, exit.col),
    }))
    .filter((exit) => exit.x >= 0 && exit.y >= 0 && exit.x <= width && exit.y <= height);

  const conditionedMidpoint = (edgeExit, axisLength, axis) => {
    const condition = edgeExit.condition;
    if (!condition || !condition.name?.startsWith(axis)) return (axisLength + 1) / 2;
    if (condition.name.endsWith(">")) return (condition.threshold + 1 + axisLength) / 2;
    if (condition.name.endsWith("<")) return Math.max(1, condition.threshold) / 2;
    return (axisLength + 1) / 2;
  };

  // An edge exit's condition is a range along the wall, and each modelled opening either
  // falls inside it or belongs to the OTHER exit on that same wall. 84 of 280 edge exits
  // share a direction with another one — Cor Noth 108 west is room 562 above row 46 and
  // room 111 below it — so an opening has to be tested against the condition before it can
  // be called this exit's doorway.
  const conditionAllows = (condition, crossing) => {
    if (!condition?.name) return true;
    const value = condition.name.startsWith("row") ? crossing.row : crossing.col;
    if (condition.name.endsWith(">")) return value > condition.threshold;
    if (condition.name.endsWith("<")) return value < condition.threshold;
    return true;
  };

  // WHERE THE WALL IS ACTUALLY CROSSED, ASKED OF THE MODEL RATHER THAN GUESSED.
  //
  // This used to put an edge exit at the MIDDLE of the room's edge, which is a guess about
  // where a doorway is, and measured against the harness's own baked approaches it is wrong
  // for every single one of the 275 edge exits the model can place: 175 of them by more
  // than eight squares, the worst by 121. A door drawn half a room away from the door is
  // not a small error on a map whose whole job is to say where things are.
  //
  // `edgeApproachCandidates` is the same call the harness's own exit anchoring makes
  // (tools/m59-routebake.mjs, exitAnchors). It is cheap here because every one of the 264
  // rooms carries its approaches baked into m59-map.json — no collision trace is run.
  //
  // A candidate is only published when the model found somewhere to stand that can reach
  // it, so an empty list is the harness's exit-gap case rather than a room without doors:
  // Cor Noth 150 west publishes six boundary crossings and no grounded approach, which is
  // what kept ten characters away from a bank. Prefer one the room graph can reach.
  const chooseOpening = (exit) => {
    const direction = exit.leaveName;
    let candidates = [];
    try { candidates = geometry?.edgeApproachCandidates(direction) || []; } catch { candidates = []; }
    const qualifying = candidates.filter((candidate) => conditionAllows(exit.condition, candidate));
    const chosen = qualifying.find((candidate) => candidate.graph_routable) || qualifying[0] || null;
    return { chosen, openings: qualifying.length };
  };

  const edgeExits = (room.edgeExits || []).map((exit) => {
    const direction = exit.leaveName;
    const { chosen, openings } = chooseOpening(exit);
    if (chosen) {
      // Drawn at the crossing point itself — sub-square, on the boundary, where the doorway
      // is — while row/col stay the square a character actually stands on to use it, which
      // is what the router walks to and what a reader wants read back.
      const stand = chosen.stages?.[0] || { row: chosen.row, col: chosen.col };
      return {
        row: stand.row,
        col: stand.col,
        x: X(protocolToClient(chosen.fine_stand_on.x)),
        y: Y(protocolToClient(chosen.fine_stand_on.y)),
        locked: false,
        toRoom: exit.to > 0 ? exit.to : null,
        to: exitName(exit.to),
        kind: "edge",
        direction,
        approach: "modelled",
        openings,
        region: regionOfSquare(stand.row, stand.col),
      };
    }
    // No modelled opening at all: fall back to the old midpoint of the wall, and mark it a
    // guess rather than presenting it as the model's answer. This is the shape of a gap in
    // the model, not of a room without doors — players use these — and
    // m59-harness/tools/m59-exitgap.mjs is what records where one actually worked.
    let row = conditionedMidpoint(exit, room.rows || room.roo.rows, "row");
    let col = conditionedMidpoint(exit, room.cols || room.roo.cols, "col");
    if (direction === "north") row = 1;
    if (direction === "south") row = room.rows || room.roo.rows;
    if (direction === "west") col = 1;
    if (direction === "east") col = room.cols || room.roo.cols;
    return {
      row,
      col,
      x: X(squareCentre(col)),
      y: Y(squareCentre(row)),
      locked: false,
      toRoom: exit.to > 0 ? exit.to : null,
      to: exitName(exit.to),
      kind: "edge",
      direction,
      approach: "guessed",
      openings: 0,
      region: regionOfSquare(row, col),
    };
  }).filter((exit) => exit.x >= 0 && exit.y >= 0 && exit.x <= width && exit.y <= height);

  return {
    roomNum: room.num,
    name: room.name,
    file: room.rooFile || room.roo.file,
    rows: room.rows || room.roo.rows,
    cols: room.cols || room.roo.cols,
    wallCount: walls.length,
    viewBox: { width, height },
    transform: { minX, minY, scale, pad, fineness: 1024 },
    solidPath: pathFor(solid),
    passagePath: pathFor(passage),
    exits: [...exits, ...edgeExits],
    geometry: {
      grid: room.roo.grid,
      monsterGrid: room.roo.monsterGrid,
      flags: room.roo.flags,
    },
    // WHERE WALKING CANNOT GET FROM ONE SIDE TO THE OTHER, drawn as the boundary it is.
    //
    // Every pair of grid-adjacent walkable squares that the router puts in DIFFERENT
    // connected regions gets one segment on the line between them. Those segments are the
    // walls of disconnection: not walls in the world — players walk these rooms — but the
    // places our pathing believes a wall is. Seeing them is the point, because that is
    // where the model is wrong and nothing else shows it.
    //
    // Regions are labelled so a reader can tell a genuine division (a cliff, water) from
    // a hairline crack through open floor, which is the shape of a modelling bug.
    disconnects: disconnectSegments(geometry, regions, X, Y),
    // Squares the main body of the room cannot walk to, as rectangles in the same space as
    // the walls. See unpathableSquares — this is the one-way half of the same measurement.
    unpathable: unpathable && {
      main_body: unpathable.mainSize,
      walkable: unpathable.walkable,
      // Split, because "I can get out but not back in" and "I can get in but not out" are
      // opposite facts and only one of them strands a character.
      unreachable: unpathable.unreachable.map(([r, c]) => squareRect(r, c, X, Y)),
      noReturn: unpathable.noReturn.map(([r, c]) => squareRect(r, c, X, Y)),
    },
  };
}

// A square as a rectangle in wall space, so an overlay can paint it directly.
function squareRect(row, col, X, Y) {
  const x0 = X(squareCentre(col) - SQUARE / 2);
  const y0 = Y(squareCentre(row) - SQUARE / 2);
  const x1 = X(squareCentre(col) + SQUARE / 2);
  const y1 = Y(squareCentre(row) + SQUARE / 2);
  return [
    Number(Math.min(x0, x1).toFixed(1)), Number(Math.min(y0, y1).toFixed(1)),
    Number(Math.abs(x1 - x0).toFixed(1)), Number(Math.abs(y1 - y0).toFixed(1)),
  ];
}

// The squares the largest region cannot reach, and the ones it can reach but not come back
// from. Two floods, one forward over the mover's own edges and one backward over them.
function unpathableSquares(geometry, regions) {
  if (!geometry || !regions) return null;
  const { rows, cols } = geometry;
  const { label, at, sizes } = regions;
  let main = -1;
  let mainSize = 0;
  for (let id = 0; id < sizes.length; id += 1)
    if (sizes[id] > mainSize) { mainSize = sizes[id]; main = id; }
  let seed = null;
  for (let r = 1; r <= rows && !seed; r += 1)
    for (let c = 1; c <= cols && !seed; c += 1)
      if (geometry.walkable(r, c) && label[at(r, c)] === main) seed = [r, c];
  if (!seed) return null;

  const flood = (forward) => {
    const seen = new Set([`${seed[0]},${seed[1]}`]);
    const stack = [seed];
    while (stack.length) {
      const [r, c] = stack.pop();
      if (forward) {
        for (const n of geometry.neighbors(r, c, { collision: true })) {
          const key = `${n.row},${n.col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          stack.push([n.row, n.col]);
        }
      } else {
        // Backward: every square that can step ONTO this one. There is no reverse
        // adjacency list, so ask each of the eight candidates whether it can reach here.
        for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
          if (!dr && !dc) continue;
          const pr = r + dr;
          const pc = c + dc;
          if (!geometry.inBounds(pr, pc) || !geometry.walkable(pr, pc)) continue;
          const key = `${pr},${pc}`;
          if (seen.has(key)) continue;
          if (!geometry.neighbors(pr, pc, { collision: true })
            .some((n) => n.row === r && n.col === c)) continue;
          seen.add(key);
          stack.push([pr, pc]);
        }
      }
    }
    return seen;
  };

  const out = flood(true);
  const back = flood(false);
  const unreachable = [];
  const noReturn = [];
  let walkable = 0;
  for (let r = 1; r <= rows; r += 1) for (let c = 1; c <= cols; c += 1) {
    if (!geometry.walkable(r, c)) continue;
    walkable += 1;
    const key = `${r},${c}`;
    if (!out.has(key)) unreachable.push([r, c]);
    else if (!back.has(key)) noReturn.push([r, c]);
  }
  return { mainSize, walkable, unreachable, noReturn };
}

// The segments between adjacent walkable squares that the router cannot join.
//
// The labelling itself is `components()` out of the harness's route bake — the same
// function, on the same geometry, with the same default view of "can I step there", so
// what is drawn here is what the fleet's own router would conclude. That default moved
// TWICE in one day (collision-aware planning shipped on, then off again after it cost
// twelve characters), which is exactly why this asks rather than keeps a copy.
function disconnectSegments(geometry, regions, X, Y) {
  if (!geometry || !regions) return null;
  const { rows, cols } = geometry;
  const { label, at } = regions;
  // Only the four orthogonal pairs: a diagonal disagreement has no single edge to draw,
  // and every real division shows up on an orthogonal pair somewhere along it.
  const segments = [];
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      if (!geometry.walkable(r, c)) continue;
      const mine = label[at(r, c)];
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr > rows || nc > cols || !geometry.walkable(nr, nc)) continue;
        if (label[at(nr, nc)] === mine) continue;
        // The shared edge between the two squares, in the same space the walls use.
        const midX = squareCentre(c) + (dc ? SQUARE / 2 : 0);
        const midY = squareCentre(r) + (dr ? SQUARE / 2 : 0);
        const halfX = dc ? 0 : SQUARE / 2;
        const halfY = dr ? 0 : SQUARE / 2;
        segments.push([
          Number(X(midX - halfX).toFixed(1)), Number(Y(midY - halfY).toFixed(1)),
          Number(X(midX + halfX).toFixed(1)), Number(Y(midY + halfY).toFixed(1)),
        ]);
      }
    }
  }
  // The count is what says whether a division is a cliff or a hairline crack through open
  // floor. Which region each EXIT falls in now travels on the exit itself, because that is
  // the question worth asking of a room: 111 of them have exits the router cannot join by
  // walking at all, and in those the answer is `blink`, not a longer path.
  return { regions: regions.count, segments };
}

const world = buildWorldAsset(zoneData.rooms);
writeJson(path.join(outputRoot, "world.json"), world);

let written = 0;
// EVERY ROOM THAT HAS A MAP, WHETHER OR NOT ANYBODY IS STANDING IN IT.
//
// The board reaches a room by selecting a unit or a location, which means the only rooms
// you can look at are the ones the fleet happens to be in. That is right for commanding a
// fleet and useless for reviewing a world: the rooms most worth opening are the ones
// nothing has walked into, because nothing has found out yet what is wrong with them.
// This index is what lets map review offer all of them.
const index = [];
for (const room of Object.values(mapData.rooms)) {
  const asset = roomAsset(room);
  if (!asset) continue;
  writeJson(path.join(roomOutput, `${room.num}.json`), asset);
  index.push({
    roomNum: room.num,
    name: room.name ?? `room ${room.num}`,
    rows: asset.rows,
    cols: asset.cols,
    exits: asset.exits.length,
    regions: asset.disconnects?.regions ?? null,
    // The two numbers a reviewer sorts on, carried here so the dropdown can show them
    // without fetching 264 room files.
    mainBody: asset.unpathable?.main_body ?? null,
    walkable: asset.unpathable?.walkable ?? null,
    unreachable: asset.unpathable?.unreachable.length ?? 0,
    noReturn: asset.unpathable?.noReturn.length ?? 0,
  });
  written += 1;
}
index.sort((a, b) => a.roomNum - b.roomNum);

// THE HARNESS'S OWN TAGS, NOT A SECOND OPINION FORMED HERE. `review()` reads the same
// baked table the router plans on and says which rooms are worth a human look and why. It
// deliberately draws no conclusion — a tag is a measurement of our MODEL of somebody
// else's server, which is stricter than the world, so `pocket-dense` in particular marks
// where the SAFE SPOTS are rather than a defect. Absent is fine; the page just has no tags.
let reviewData = { ok: false, why: "not attempted", rooms: [] };
try { reviewData = review(); } catch (error) { reviewData = { ok: false, why: error.message, rooms: [] }; }
writeJson(path.join(outputRoot, "review.json"), {
  ok: reviewData.ok,
  why: reviewData.why ?? null,
  builtAt: reviewData.built_at ?? null,
  view: reviewData.view ?? null,
  masksAttached: masks.attached,
  rooms: index,
  exceptional: reviewData.rooms ?? [],
});

console.log(`Synced ${world.nodes.length} world nodes and ${written} .roo room maps from m59-harness.`);
console.log(reviewData.ok
  ? `Map review: ${index.length} rooms selectable, ${reviewData.rooms.length} tagged exceptional.`
  : `Map review: ${index.length} rooms selectable, no tags (${reviewData.why}).`);
