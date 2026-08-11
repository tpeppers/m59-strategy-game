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

const mapData = JSON.parse(fs.readFileSync(mapSource, "utf8"));
const zoneData = JSON.parse(fs.readFileSync(zoneSource, "utf8"));
fs.mkdirSync(roomOutput, { recursive: true });

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

function roomAsset(room) {
  const walls = room.roo?.walls || [];
  if (!walls.length) return null;
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
      x: X((exit.col + 0.5) * 1024),
      y: Y((exit.row + 0.5) * 1024),
      locked: Boolean(exit.locked || exit.to < 0),
      toRoom: exit.to > 0 ? exit.to : null,
      to: exitName(exit.to),
      kind: "door",
      direction: null,
    }))
    .filter((exit) => exit.x >= 0 && exit.y >= 0 && exit.x <= width && exit.y <= height);

  const conditionedMidpoint = (edgeExit, axisLength, axis) => {
    const condition = edgeExit.condition;
    if (!condition || !condition.name?.startsWith(axis)) return (axisLength + 1) / 2;
    if (condition.name.endsWith(">")) return (condition.threshold + 1 + axisLength) / 2;
    if (condition.name.endsWith("<")) return Math.max(1, condition.threshold) / 2;
    return (axisLength + 1) / 2;
  };
  const edgeExits = (room.edgeExits || []).map((exit) => {
    const direction = exit.leaveName;
    let row = conditionedMidpoint(exit, room.rows || room.roo.rows, "row");
    let col = conditionedMidpoint(exit, room.cols || room.roo.cols, "col");
    if (direction === "north") row = 1;
    if (direction === "south") row = room.rows || room.roo.rows;
    if (direction === "west") col = 1;
    if (direction === "east") col = room.cols || room.roo.cols;
    return {
      row,
      col,
      x: X((col + 0.5) * 1024),
      y: Y((row + 0.5) * 1024),
      locked: false,
      toRoom: exit.to > 0 ? exit.to : null,
      to: exitName(exit.to),
      kind: "edge",
      direction,
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
  };
}

const world = buildWorldAsset(zoneData.rooms);
writeJson(path.join(outputRoot, "world.json"), world);

let written = 0;
for (const room of Object.values(mapData.rooms)) {
  const asset = roomAsset(room);
  if (!asset) continue;
  writeJson(path.join(roomOutput, `${room.num}.json`), asset);
  written += 1;
}

console.log(`Synced ${world.nodes.length} world nodes and ${written} .roo room maps from m59-harness.`);
