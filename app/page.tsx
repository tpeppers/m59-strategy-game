"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  buildFormationSlots,
  fitFormationSpacing,
  FORMATION_PRESETS,
  formationTarget,
  MAX_FORMATION_OFFSET,
  type FormationKind,
  type UnitGroup,
} from "@/lib/formations";

type FleetUnit = {
  agent: string;
  character: string;
  room: string;
  room_num: number | null;
  health: string;
  mana: string;
  level: number | null;
  vigor: number | null;
  vigor_of: number | null;
  has_weapon: boolean | null;
  has_food: boolean | null;
  carrying: number | null;
  reagents: number | null;
  activity: string | null;
  busy: string | null;
  stalled: string | boolean | null;
  strategy: string | null;
  needs_operator: boolean | string | null;
  autopilot: {
    mode?: string;
    running?: boolean;
    kills?: number;
  } | null;
};

type FleetResponse = {
  broker: { online: boolean; fleet: string | null; pid: number | null };
  fleet: FleetUnit[];
  stalledCount: number;
  needsAttention: number;
  refreshedAt: string;
  error?: string;
};

type OrderAction = "march" | "farm" | "survive" | "hold" | "stop" | "equip";
type Filter = "all" | "working" | "attention";

type DumStrategy = {
  id: string;
  title: string;
  group: string;
  purpose: string;
  requirements: string[];
  description: string;
};

type DumStrategyState = {
  state: "all" | "some" | "none";
  enabled: number;
  total: number;
};

type StrategyResponse = {
  catalogue?: DumStrategy[];
  states?: Record<string, DumStrategyState>;
  selected?: number;
  error?: string;
};

type ActivityEntry = {
  id: string;
  kind: "order" | "success" | "warning";
  title: string;
  detail: string;
  time: string;
};

type WorldMapNode = {
  key: string;
  roomNum: number;
  name: string;
  region: string;
  component: number;
  x: number;
  y: number;
};

type WorldMapData = {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  components: Array<{
    id: number;
    primary: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    regions: string[];
  }>;
  nodes: WorldMapNode[];
  edges: Array<{ from: number; to: number; x1: number; y1: number; x2: number; y2: number }>;
  anchors: Record<string, number | null>;
};

type RoomMapData = {
  roomNum: number;
  name: string;
  file: string;
  rows: number;
  cols: number;
  wallCount: number;
  viewBox: { width: number; height: number };
  transform: { minX: number; minY: number; scale: number; pad: number; fineness: number };
  solidPath: string;
  passagePath: string;
  exits: Array<{
    x: number;
    y: number;
    row: number;
    col: number;
    locked: boolean;
    toRoom: number | null;
    to: string;
    kind: "door" | "edge";
    direction: string | null;
  }>;
};

type RoomPosition = {
  agent: string;
  roomNum: number;
  room: string | null;
  col: number;
  row: number;
  facing: string | null;
  facingDegrees: number | null;
};

type MonsterPosition = {
  id: number;
  name: string;
  col: number;
  row: number;
  seenBy: string[];
};

type SafeSpotPosition = {
  col: number;
  row: number;
  held: number;
  failed: number;
  heldSeconds: number;
  damageTaken: number;
  mostAttackers: number;
  exactX: number | null;
  exactY: number | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedNote: string | null;
  observedAt: number | null;
  verdict: "verified" | "holds" | "failed" | "untested";
};

type SafeSpotLayer = "holds" | "failed" | "untested";

type DragSelection = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
};

type ExitFollow = {
  agents: string[];
  fromRoom: number;
  toRoom: number;
  startedAt: number;
};

type WorldViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WorldPanGesture = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  viewport: WorldViewport;
};

const WORLD_ART_WIDTH = 1456;
const WORLD_ART_HEIGHT = 1090;
const WORLD_MAX_ZOOM = 6;
// Broker positions use KOD's 64 fine units per square. Room geometry uses the
// client's coordinate space (normally 1024 units per square).
const KOD_FINENESS = 64;
const WORLD_FIT_VIEWPORT: WorldViewport = {
  x: 0,
  y: 0,
  width: WORLD_ART_WIDTH,
  height: WORLD_ART_HEIGHT,
};
const DEFAULT_COMPANY_NAME = "The Wayward Company";
const COMPANY_NAME_STORAGE_KEY = "m59-field-command-company-name";
const GROUP_STORAGE_KEY = "m59-field-command-groups-v1";
const FORMATION_GRID_SIZE = 41;
const FORMATION_GRID = Array.from({ length: FORMATION_GRID_SIZE * FORMATION_GRID_SIZE }, (_, index) => ({
  dx: (index % FORMATION_GRID_SIZE) - 20,
  dy: Math.floor(index / FORMATION_GRID_SIZE) - 20,
}));

// The connection graph is laid out for legibility, not geography. These anchors
// place its major destinations on the named landmarks in the illustrated map.
const CARTOGRAPHIC_ANCHORS: Record<number, { x: number; y: number }> = {
  1: { x: 1330, y: 985 }, // Underworld: the parchment margin, not a false land location
  48: { x: 660, y: 895 }, // Temple of Kraanan
  50: { x: 1045, y: 700 },
  61: { x: 1045, y: 700 },
  70: { x: 1015, y: 700 },
  108: { x: 870, y: 270 },
  111: { x: 870, y: 270 },
  112: { x: 870, y: 270 },
  150: { x: 540, y: 515 },
  200: { x: 240, y: 400 },
  350: { x: 390, y: 785 },
  377: { x: 390, y: 785 },
  378: { x: 390, y: 785 },
  379: { x: 390, y: 785 },
  380: { x: 390, y: 785 },
  382: { x: 390, y: 785 },
  535: { x: 350, y: 455 },
  545: { x: 430, y: 505 },
  556: { x: 470, y: 430 },
  568: { x: 690, y: 735 },
  574: { x: 625, y: 475 },
  575: { x: 745, y: 570 },
  576: { x: 820, y: 610 },
  586: { x: 975, y: 650 },
  593: { x: 890, y: 325 },
};

function cartographicPoint(node: WorldMapNode) {
  const anchored = CARTOGRAPHIC_ANCHORS[node.roomNum];
  if (anchored) return anchored;

  const outdoors = /^Outdoors([A-K])(\d)$/.exec(node.key);
  if (outdoors) {
    const column = outdoors[1].charCodeAt(0) - "A".charCodeAt(0);
    const row = Number(outdoors[2]) - 1;
    return {
      x: 210 + column * 96,
      y: 190 + row * 78,
    };
  }

  const regional = {
    Marion: { x: 240, y: 400 },
    Jasper: { x: 390, y: 785 },
    Tos: { x: 1045, y: 700 },
    "Cor Noth": { x: 540, y: 515 },
  }[node.region];
  if (regional) return regional;

  // Detached and portal-only realms have no honest geographic position on the
  // illustrated continent. Keep them on the parchment margin instead.
  if (node.component !== 2) return { x: 1330, y: 985 };

  return {
    x: 90 + (node.x / 1620) * 1276,
    y: 150 + (node.y / 976) * 790,
  };
}

const ACTIONS: Array<{
  id: OrderAction;
  glyph: string;
  label: string;
  hint: string;
}> = [
  { id: "march", glyph: "↠", label: "March", hint: "Travel to a room" },
  { id: "farm", glyph: "⚔", label: "Farm", hint: "Hunt a named creature" },
  { id: "survive", glyph: "◇", label: "Survive", hint: "Recover and evade danger" },
  { id: "hold", glyph: "▣", label: "Hold", hint: "Idle at this position" },
  { id: "equip", glyph: "✦", label: "Equip", hint: "Use the best carried gear" },
  { id: "stop", glyph: "×", label: "Stop", hint: "Stop the current keeper" },
];

function ratio(value: string) {
  const [current, maximum] = value.split("/").map(Number);
  if (!Number.isFinite(current) || !Number.isFinite(maximum) || !maximum) return 0;
  return Math.max(0, Math.min(1, current / maximum));
}

function unitNeedsAttention(unit: FleetUnit) {
  return Boolean(unit.stalled || unit.needs_operator || ratio(unit.health) < 0.45);
}

function unitWorking(unit: FleetUnit) {
  return Boolean(unit.busy || unit.autopilot?.running);
}

function statusLabel(unit: FleetUnit) {
  if (unitNeedsAttention(unit)) return "Needs orders";
  if (unit.busy) return unit.busy;
  if (unit.autopilot?.running) return unit.autopilot.mode || "Working";
  return unit.activity || "Standing by";
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function timeLabel(iso: string | null) {
  if (!iso) return "awaiting report";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
}

function clampWorldViewport(viewport: WorldViewport): WorldViewport {
  let width = Math.min(WORLD_ART_WIDTH, viewport.width);
  let height = Math.min(WORLD_ART_HEIGHT, viewport.height);
  const minimumWidth = WORLD_ART_WIDTH / WORLD_MAX_ZOOM;
  const minimumHeight = WORLD_ART_HEIGHT / WORLD_MAX_ZOOM;
  if (width < minimumWidth || height < minimumHeight) {
    const scale = Math.max(minimumWidth / width, minimumHeight / height);
    width *= scale;
    height *= scale;
  }
  return {
    x: Math.max(0, Math.min(WORLD_ART_WIDTH - width, viewport.x)),
    y: Math.max(0, Math.min(WORLD_ART_HEIGHT - height, viewport.y)),
    width,
    height,
  };
}

function savedGroups(value: unknown): UnitGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Partial<UnitGroup>;
    const agents = Array.isArray(row.agents)
      ? [...new Set(row.agents.filter((agent): agent is string => typeof agent === "string"))].slice(0, 40)
      : [];
    const leader = typeof row.leader === "string" && agents.includes(row.leader)
      ? row.leader
      : agents[0];
    const formationKinds: FormationKind[] = ["conga", "t", "circle", "scattered", "custom"];
    const formation = formationKinds.includes(row.formation as FormationKind)
      ? (row.formation as FormationKind)
      : "conga";
    if (!leader || agents.length < 2 || typeof row.id !== "string") return [];
    const slots = Array.isArray(row.slots)
      ? row.slots.filter(
          (slot) =>
            slot &&
            typeof slot.agent === "string" &&
            agents.includes(slot.agent) &&
            Number.isInteger(slot.dx) &&
            Number.isInteger(slot.dy) &&
            Math.abs(slot.dx) <= MAX_FORMATION_OFFSET &&
            Math.abs(slot.dy) <= MAX_FORMATION_OFFSET,
        )
      : [];
    const completeSlots = agents.every((agent) => slots.some((slot) => slot.agent === agent));
    return [{
      id: row.id,
      revision: typeof row.revision === "number" && Number.isInteger(row.revision) && row.revision >= 0
        ? row.revision
        : row.active === true ? 1 : 0,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 50) : "Unit Group",
      leader,
      agents,
      formation,
      spacing: typeof row.spacing === "number" ? Math.max(1, Math.min(4, Math.round(row.spacing))) : 1,
      slots: completeSlots
        ? slots.map((slot) => ({ agent: slot.agent, dx: slot.dx, dy: slot.dy }))
        : buildFormationSlots("conga", agents, leader, 1),
      // A formation is a live command lease, not a preference. Keep its membership and
      // geometry across reloads, but require a fresh operator click before the page may
      // resume five-second movement ticks. Persisting `active:true` let an old browser
      // tab keep stopping DUM-controlled units hours after the formation was relevant.
      active: false,
    }];
  });
}

export default function Home() {
  const [companyName, setCompanyName] = useState(DEFAULT_COMPANY_NAME);
  const [companyNameDraft, setCompanyNameDraft] = useState(DEFAULT_COMPANY_NAME);
  const [editingCompanyName, setEditingCompanyName] = useState(false);
  const companyNameInputRef = useRef<HTMLInputElement>(null);
  const localMapRef = useRef<SVGSVGElement>(null);
  const worldMapRef = useRef<SVGSVGElement>(null);
  const worldPanGesture = useRef<WorldPanGesture | null>(null);
  const [data, setData] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<OrderAction | null>(null);
  const [destination, setDestination] = useState("");
  const [hunt, setHunt] = useState("spider");
  const [roam, setRoam] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [strategySheetOpen, setStrategySheetOpen] = useState(false);
  const [strategyCatalogue, setStrategyCatalogue] = useState<DumStrategy[]>([]);
  const [strategyStates, setStrategyStates] = useState<Record<string, DumStrategyState>>({});
  const [strategyChanges, setStrategyChanges] = useState<Record<string, boolean>>({});
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [worldMap, setWorldMap] = useState<WorldMapData | null>(null);
  const [worldScope, setWorldScope] = useState<"company" | "all">("all");
  const [worldViewport, setWorldViewport] = useState<WorldViewport | null>(null);
  const [worldPanning, setWorldPanning] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [showSafeSpots, setShowSafeSpots] = useState(false);
  const [showCompanyLayer, setShowCompanyLayer] = useState(true);
  const [showMonsterLayer, setShowMonsterLayer] = useState(true);
  const [showExitLayer, setShowExitLayer] = useState(true);
  const [safeSpotLayers, setSafeSpotLayers] = useState<Record<SafeSpotLayer, boolean>>({
    holds: true,
    failed: true,
    untested: true,
  });
  const [selectedRoomNum, setSelectedRoomNum] = useState<number | null>(null);
  const [roomMap, setRoomMap] = useState<RoomMapData | null>(null);
  const [roomPositions, setRoomPositions] = useState<RoomPosition[]>([]);
  const [roomMonsters, setRoomMonsters] = useState<MonsterPosition[]>([]);
  const [roomSafeSpots, setRoomSafeSpots] = useState<SafeSpotPosition[]>([]);
  const [safeSpotsLoading, setSafeSpotsLoading] = useState(false);
  const [safeSpotsError, setSafeSpotsError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [detailAgent, setDetailAgent] = useState<string | null>(null);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [exitFollow, setExitFollow] = useState<ExitFollow | null>(null);
  const [groups, setGroups] = useState<UnitGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [formationManagerOpen, setFormationManagerOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedSlotAgent, setSelectedSlotAgent] = useState<string | null>(null);
  const formationTickInFlight = useRef(false);
  const formationTickAbort = useRef<AbortController | null>(null);
  const registeredFormations = useRef(new Set<string>());

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(COMPANY_NAME_STORAGE_KEY)?.trim();
      if (saved) {
        setCompanyName(saved.slice(0, 60));
        setCompanyNameDraft(saved.slice(0, 60));
      }
    } catch {
      // The editable title still works for this session when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(GROUP_STORAGE_KEY);
      if (saved) {
        const restored = savedGroups(JSON.parse(saved));
        setGroups(restored);
        setSelectedGroupId(restored[0]?.id || null);
        setSelectedSlotAgent(restored[0]?.leader || null);
      }
    } catch {
      // Groups remain available for this session if local storage is unavailable.
    } finally {
      setGroupsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!groupsLoaded) return;
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups));
    } catch {
      // The in-memory group manager remains usable for this session.
    }
  }, [groups, groupsLoaded]);

  useEffect(() => {
    const synchronizeGroups = (event: StorageEvent) => {
      if (event.key !== GROUP_STORAGE_KEY || !event.newValue) return;
      try {
        setGroups(savedGroups(JSON.parse(event.newValue)));
      } catch {
        // Ignore a partially written value from another local command-post tab.
      }
    };
    window.addEventListener("storage", synchronizeGroups);
    return () => window.removeEventListener("storage", synchronizeGroups);
  }, []);

  useEffect(() => {
    if (editingCompanyName) companyNameInputRef.current?.select();
  }, [editingCompanyName]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/fleet", { cache: "no-store" });
      const snapshot = (await response.json()) as FleetResponse;
      setData(snapshot);
    } catch (error) {
      setData({
        broker: { online: false, fleet: null, pid: null },
        fleet: [],
        stalledCount: 0,
        needsAttention: 0,
        refreshedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Command post unavailable",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const activeGroups = groups.filter((group) => group.active);
    if (!groupsLoaded || !data?.broker.online || !activeGroups.length) return;
    let live = true;
    const tick = async () => {
      if (!live || formationTickInFlight.current) return;
      formationTickInFlight.current = true;
      const controller = new AbortController();
      formationTickAbort.current = controller;
      try {
        await Promise.all(
          activeGroups.map(async (group) => {
            const registrationKey = `${group.id}:${group.revision}`;
            if (!registeredFormations.current.has(registrationKey)) {
              const start = await fetch("/api/formations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                  action: "start",
                  groupId: group.id,
                  revision: group.revision,
                  leader: group.leader,
                  agents: group.agents,
                  slots: group.slots,
                }),
              });
              if (!start.ok) throw new Error("Could not renew formation control");
              registeredFormations.current.add(registrationKey);
            }
            if (!live || controller.signal.aborted) return;
            await fetch("/api/formations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                action: "tick",
                groupId: group.id,
                revision: group.revision,
                leader: group.leader,
                agents: group.agents,
                slots: group.slots,
              }),
            });
          }),
        );
      } catch {
        // A later tick will retry after a transient broker or network interruption.
      } finally {
        if (formationTickAbort.current === controller) formationTickAbort.current = null;
        formationTickInFlight.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      live = false;
      formationTickAbort.current?.abort();
      window.clearInterval(timer);
    };
  }, [data?.broker.online, groups, groupsLoaded]);

  useEffect(() => {
    let active = true;
    fetch("/maps/world.json")
      .then((response) => {
        if (!response.ok) throw new Error("World map is unavailable");
        return response.json() as Promise<WorldMapData>;
      })
      .then((world) => {
        if (active) setWorldMap(world);
      })
      .finally(() => {
        if (active) setMapLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const liveAgents = new Set((data?.fleet || []).map((unit) => unit.agent));
    setSelection((current) => current.filter((agent) => liveAgents.has(agent)));
  }, [data]);

  const visibleUnits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (data?.fleet || []).filter((unit) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "working" && unitWorking(unit)) ||
        (filter === "attention" && unitNeedsAttention(unit));
      const matchesQuery =
        !normalizedQuery ||
        `${unit.character} ${unit.agent} ${unit.room}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [data, filter, query]);

  const worldNodes = useMemo(
    () => new Map((worldMap?.nodes || []).map((node) => [node.roomNum, node])),
    [worldMap],
  );

  const locations = useMemo(() => {
    const grouped = new Map<string, { room: string; roomNum: number | null; units: FleetUnit[] }>();
    for (const unit of data?.fleet || []) {
      const key = `${unit.room_num ?? "unknown"}:${unit.room}`;
      const current = grouped.get(key) || { room: unit.room, roomNum: unit.room_num, units: [] };
      current.units.push(unit);
      grouped.set(key, current);
    }
    const anchorUses = new Map<number, number>();
    return [...grouped.values()]
      .sort((a, b) => b.units.length - a.units.length || a.room.localeCompare(b.room))
      .map((location) => {
        const anchorNum = location.roomNum == null
          ? null
          : worldMap?.anchors[String(location.roomNum)] ?? location.roomNum;
        const anchor = anchorNum == null ? null : worldNodes.get(anchorNum) || null;
        if (!anchor) return { ...location, anchorNum, mapX: null, mapY: null };
        const point = cartographicPoint(anchor);
        const use = anchorUses.get(anchor.roomNum) || 0;
        anchorUses.set(anchor.roomNum, use + 1);
        const angle = use * 1.9;
        const distance = use ? 34 + Math.floor(use / 4) * 12 : 0;
        return {
          ...location,
          anchorNum,
          mapX: point.x + Math.cos(angle) * distance,
          mapY: point.y + Math.sin(angle) * distance,
        };
      });
  }, [data, worldMap, worldNodes]);

  const selectedUnits = useMemo(() => {
    const selected = new Set(selection);
    return (data?.fleet || []).filter((unit) => selected.has(unit.agent));
  }, [data, selection]);

  const strategyGroups = useMemo(() => {
    const groups = new Map<string, DumStrategy[]>();
    for (const strategy of strategyCatalogue)
      groups.set(strategy.group, [...(groups.get(strategy.group) || []), strategy]);
    return [...groups.entries()];
  }, [strategyCatalogue]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || groups[0] || null,
    [groups, selectedGroupId],
  );

  const activeSelectionGroup = useMemo(() => {
    const selected = new Set(selection);
    return groups.find(
      (group) =>
        group.active &&
        group.agents.length === selection.length &&
        group.agents.every((agent) => selected.has(agent)),
    ) || null;
  }, [groups, selection]);

  const groupsByAgent = useMemo(() => {
    const index = new Map<string, UnitGroup[]>();
    for (const group of groups) {
      for (const agent of group.agents) {
        index.set(agent, [...(index.get(agent) || []), group]);
      }
    }
    return index;
  }, [groups]);

  const selectedRoomUnits = useMemo(
    () => (data?.fleet || []).filter((unit) => unit.room_num === selectedRoomNum),
    [data, selectedRoomNum],
  );

  const worldScopeViewport = useMemo<WorldViewport>(() => {
    if (!worldMap || worldScope === "all") return WORLD_FIT_VIEWPORT;
    const scaleX = WORLD_ART_WIDTH / worldMap.width;
    const scaleY = WORLD_ART_HEIGHT / worldMap.height;
    const points = locations
      .filter((location) => location.mapX != null && location.mapY != null)
      .map((location) => ({
        x: (location.mapX as number) * scaleX,
        y: (location.mapY as number) * scaleY,
      }));
    if (!points.length) return WORLD_FIT_VIEWPORT;
    let minX = Math.min(...points.map((point) => point.x)) - 112;
    let maxX = Math.max(...points.map((point) => point.x)) + 112;
    let minY = Math.min(...points.map((point) => point.y)) - 84;
    let maxY = Math.max(...points.map((point) => point.y)) + 84;
    const minimumWidth = 660;
    const minimumHeight = 430;
    if (maxX - minX < minimumWidth) {
      const extra = (minimumWidth - (maxX - minX)) / 2;
      minX -= extra;
      maxX += extra;
    }
    if (maxY - minY < minimumHeight) {
      const extra = (minimumHeight - (maxY - minY)) / 2;
      minY -= extra;
      maxY += extra;
    }
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(WORLD_ART_WIDTH, maxX);
    maxY = Math.min(WORLD_ART_HEIGHT, maxY);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [locations, worldMap, worldScope]);

  const activeWorldViewport = worldViewport || worldScopeViewport;
  const worldViewBox = `${activeWorldViewport.x} ${activeWorldViewport.y} ${activeWorldViewport.width} ${activeWorldViewport.height}`;
  const worldIsZoomed = activeWorldViewport.width < WORLD_ART_WIDTH - 0.5 ||
    activeWorldViewport.height < WORLD_ART_HEIGHT - 0.5;

  const zoomWorldMap = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const svg = worldMapRef.current;
    if (!svg) return;
    const point = svgPoint(svg, event.clientX, event.clientY);
    if (!point) return;
    const deltaPixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
    const factor = Math.max(0.72, Math.min(1.28, Math.exp(deltaPixels * 0.0015)));
    const current = activeWorldViewport;
    const width = current.width * factor;
    const height = current.height * factor;
    if (width >= WORLD_ART_WIDTH || height >= WORLD_ART_HEIGHT) {
      setWorldScope("all");
      setWorldViewport(null);
      return;
    }
    const scale = width / current.width;
    setWorldViewport(clampWorldViewport({
      x: point.x - (point.x - current.x) * scale,
      y: point.y - (point.y - current.y) * scale,
      width,
      height,
    }));
  }, [activeWorldViewport]);

  useEffect(() => {
    const svg = worldMapRef.current;
    if (!svg || selectedRoomNum != null) return;
    svg.addEventListener("wheel", zoomWorldMap, { passive: false });
    return () => svg.removeEventListener("wheel", zoomWorldMap);
  }, [selectedRoomNum, zoomWorldMap]);

  const worldScaleX = worldMap ? WORLD_ART_WIDTH / worldMap.width : 1;
  const worldScaleY = worldMap ? WORLD_ART_HEIGHT / worldMap.height : 1;

  const roomMarkers = useMemo(() => {
    if (!roomMap) return [];
    const unitByAgent = new Map(selectedRoomUnits.map((unit) => [unit.agent, unit]));
    const uses = new Map<string, number>();
    return roomPositions.map((position) => {
      const key = `${position.col}:${position.row}`;
      const use = uses.get(key) || 0;
      uses.set(key, use + 1);
      const angle = use * 1.75;
      const labelDistance = 11 + use * 8;
      const x =
        ((position.col + 0.5) * roomMap.transform.fineness - roomMap.transform.minX) *
          roomMap.transform.scale +
        roomMap.transform.pad;
      const y =
        ((position.row + 0.5) * roomMap.transform.fineness - roomMap.transform.minY) *
          roomMap.transform.scale +
        roomMap.transform.pad;
      return {
        ...position,
        x,
        y,
        labelX: x + 8 + Math.cos(angle) * labelDistance,
        labelY: y - 8 + Math.sin(angle) * labelDistance,
        character: unitByAgent.get(position.agent)?.character || position.agent,
      };
    });
  }, [roomMap, roomPositions, selectedRoomUnits]);

  const roomMonsterMarkers = useMemo(() => {
    if (!roomMap) return [];
    const uses = new Map<string, number>();
    return roomMonsters.map((monster, index) => {
      const key = `${monster.col}:${monster.row}`;
      const use = uses.get(key) || 0;
      uses.set(key, use + 1);
      const angle = 2.35 + index * 1.17 + use * 1.8;
      const labelDistance = 12 + use * 8;
      const x =
        ((monster.col + 0.5) * roomMap.transform.fineness - roomMap.transform.minX) *
          roomMap.transform.scale +
        roomMap.transform.pad;
      const y =
        ((monster.row + 0.5) * roomMap.transform.fineness - roomMap.transform.minY) *
          roomMap.transform.scale +
        roomMap.transform.pad;
      return {
        ...monster,
        x,
        y,
        labelX: x + Math.cos(angle) * labelDistance,
        labelY: y + Math.sin(angle) * labelDistance,
      };
    });
  }, [roomMap, roomMonsters]);

  const roomSafeSpotMarkers = useMemo(() => {
    if (!roomMap) return [];
    return roomSafeSpots.map((spot) => {
      const kodToRoomScale = roomMap.transform.fineness / KOD_FINENESS;
      const fineX = spot.exactX != null
        ? spot.exactX * kodToRoomScale
        : (spot.col + 0.5) * roomMap.transform.fineness;
      const fineY = spot.exactY != null
        ? spot.exactY * kodToRoomScale
        : (spot.row + 0.5) * roomMap.transform.fineness;
      return {
        ...spot,
        x: (fineX - roomMap.transform.minX) * roomMap.transform.scale + roomMap.transform.pad,
        y: (fineY - roomMap.transform.minY) * roomMap.transform.scale + roomMap.transform.pad,
      };
    });
  }, [roomMap, roomSafeSpots]);

  const safeSpotCounts = useMemo(() => {
    const counts: Record<SafeSpotLayer, number> = { holds: 0, failed: 0, untested: 0 };
    for (const spot of roomSafeSpots) {
      const layer: SafeSpotLayer = spot.verdict === "verified" ? "holds" : spot.verdict;
      counts[layer] += 1;
    }
    return counts;
  }, [roomSafeSpots]);

  const visibleSafeSpotMarkers = useMemo(
    () => roomSafeSpotMarkers.filter((spot) => {
      const layer: SafeSpotLayer = spot.verdict === "verified" ? "holds" : spot.verdict;
      return safeSpotLayers[layer];
    }),
    [roomSafeSpotMarkers, safeSpotLayers],
  );

  const companyLegendCount = selectedRoomNum == null
    ? locations.reduce((count, location) => count + location.units.length, 0)
    : roomMarkers.length;

  const formationGhosts = useMemo(() => {
    if (!roomMap) return [];
    const positions = new Map(roomPositions.map((position) => [position.agent, position]));
    return groups.flatMap((group) => {
      if (!group.active) return [];
      const leader = positions.get(group.leader);
      if (!leader) return [];
      return group.slots.map((slot) => {
        const target = formationTarget({
          ...leader,
          cols: roomMap.cols,
          rows: roomMap.rows,
        }, slot);
        return {
          groupId: group.id,
          agent: slot.agent,
          leader: slot.agent === group.leader,
          x:
            ((target.col + 0.5) * roomMap.transform.fineness - roomMap.transform.minX) *
              roomMap.transform.scale +
            roomMap.transform.pad,
          y:
            ((target.row + 0.5) * roomMap.transform.fineness - roomMap.transform.minY) *
              roomMap.transform.scale +
            roomMap.transform.pad,
        };
      });
    });
  }, [groups, roomMap, roomPositions]);

  useEffect(() => {
    if (selectedRoomNum == null) {
      setRoomMap(null);
      setRoomPositions([]);
      setRoomMonsters([]);
      return;
    }
    let active = true;
    setMapLoading(true);
    fetch(`/maps/rooms/${selectedRoomNum}.json`)
      .then((response) => {
        if (!response.ok) throw new Error("This room has no .roo map");
        return response.json() as Promise<RoomMapData>;
      })
      .then((map) => {
        if (active) setRoomMap(map);
      })
      .catch(() => {
        if (active) setRoomMap(null);
      })
      .finally(() => {
        if (active) setMapLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedRoomNum]);

  const selectedRoomAgents = selectedRoomUnits.map((unit) => unit.agent).sort().join(",");
  useEffect(() => {
    if (selectedRoomNum == null || !selectedRoomAgents) {
      setRoomPositions([]);
      setRoomMonsters([]);
      return;
    }
    let active = true;
    const readPositions = async () => {
      const params = new URLSearchParams({ room: String(selectedRoomNum) });
      for (const agent of selectedRoomAgents.split(",")) params.append("agent", agent);
      try {
        const response = await fetch(`/api/room-state?${params}`, { cache: "no-store" });
        const payload = (await response.json()) as {
          positions?: RoomPosition[];
          monsters?: MonsterPosition[];
        };
        if (active) setRoomPositions(payload.positions || []);
        if (active) setRoomMonsters(payload.monsters || []);
      } catch {
        if (active) setRoomPositions([]);
        if (active) setRoomMonsters([]);
      }
    };
    void readPositions();
    const timer = window.setInterval(() => void readPositions(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedRoomAgents, selectedRoomNum]);

  useEffect(() => {
    if (!showSafeSpots || selectedRoomNum == null || !selectedRoomAgents) {
      setRoomSafeSpots([]);
      setSafeSpotsLoading(false);
      setSafeSpotsError(showSafeSpots && selectedRoomNum != null
        ? "A reporting unit is needed to read this zone's ledger"
        : null);
      return;
    }
    let active = true;
    let reading = false;
    const agent = selectedRoomAgents.split(",")[0];
    const readSafeSpots = async () => {
      if (reading) return;
      reading = true;
      if (active) setSafeSpotsLoading(true);
      try {
        const params = new URLSearchParams({ room: String(selectedRoomNum), agent });
        const response = await fetch(`/api/safe-spots?${params}`, { cache: "no-store" });
        const payload = (await response.json()) as { spots?: SafeSpotPosition[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Safe-spot ledger unavailable");
        if (active) {
          setRoomSafeSpots(payload.spots || []);
          setSafeSpotsError(null);
        }
      } catch (error) {
        if (active) {
          setRoomSafeSpots([]);
          setSafeSpotsError(error instanceof Error ? error.message : "Safe-spot ledger unavailable");
        }
      } finally {
        reading = false;
        if (active) setSafeSpotsLoading(false);
      }
    };
    void readSafeSpots();
    const timer = window.setInterval(() => void readSafeSpots(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedRoomAgents, selectedRoomNum, showSafeSpots]);

  useEffect(() => {
    if (!exitFollow) return;
    let active = true;
    let checking = false;
    const watched = new Set(exitFollow.agents);
    const checkFirstArrival = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch("/api/fleet", { cache: "no-store" });
        const snapshot = (await response.json()) as FleetResponse;
        if (!active) return;
        setData(snapshot);
        const scout = snapshot.fleet.find(
          (unit) =>
            watched.has(unit.agent) &&
            unit.room_num != null &&
            unit.room_num !== exitFollow.fromRoom,
        );
        if (scout?.room_num != null) {
          setSelectedRoomNum(scout.room_num);
          setExitFollow(null);
          setActivity((current) => [
            {
              id: crypto.randomUUID(),
              kind: "success",
              title: `${scout.character} is through`,
              detail: `Scouting ${scout.room} for the rest of the group`,
              time: "now",
            },
            ...current,
          ]);
          return;
        }
        if (Date.now() - exitFollow.startedAt > 120000) {
          setExitFollow(null);
          setActivity((current) => [
            {
              id: crypto.randomUUID(),
              kind: "warning",
              title: "No crossing reported",
              detail: "The local map stopped following after two minutes",
              time: "now",
            },
            ...current,
          ]);
        }
      } catch {
        // Keep watching; the ordinary fleet health indicator reports broker outages.
      } finally {
        checking = false;
      }
    };
    void checkFirstArrival();
    const timer = window.setInterval(() => void checkFirstArrival(), 800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [exitFollow]);

  const derivedSignals = useMemo<ActivityEntry[]>(() => {
    if (!data?.fleet.length) return [];
    const entries: ActivityEntry[] = [];
    const danger = data.fleet.filter(unitNeedsAttention);
    if (danger.length) {
      entries.push({
        id: "attention",
        kind: "warning",
        title: `${danger.length} ${danger.length === 1 ? "unit needs" : "units need"} attention`,
        detail: danger.slice(0, 3).map((unit) => unit.character).join(", "),
        time: timeLabel(data.refreshedAt),
      });
    }
    for (const location of locations.slice(0, 3)) {
      entries.push({
        id: `room-${location.roomNum ?? "unknown"}-${location.room}`,
        kind: "success",
        title: `${location.units.length} stationed`,
        detail: location.room,
        time: timeLabel(data.refreshedAt),
      });
    }
    return entries;
  }, [data, locations]);

  function toggleAgent(agent: string) {
    setSelection((current) =>
      current.includes(agent)
        ? current.filter((item) => item !== agent)
        : [...current, agent],
    );
  }

  function selectUnitStack(col: number, row: number) {
    setSelection(
      roomPositions
        .filter((position) => position.col === col && position.row === row)
        .map((position) => position.agent),
    );
  }

  function beginMapSelection(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".room-unit-marker, .room-monster-marker, .room-exit, .safe-spot-marker")) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragSelection({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      moved: false,
    });
  }

  function updateMapSelection(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragSelection || event.pointerId !== dragSelection.pointerId) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const moved =
      dragSelection.moved ||
      Math.hypot(point.x - dragSelection.startX, point.y - dragSelection.startY) > 2;
    const next = { ...dragSelection, currentX: point.x, currentY: point.y, moved };
    setDragSelection(next);
    if (!moved) return;
    const left = Math.min(next.startX, next.currentX);
    const right = Math.max(next.startX, next.currentX);
    const top = Math.min(next.startY, next.currentY);
    const bottom = Math.max(next.startY, next.currentY);
    setSelection(
      roomMarkers
        .filter((marker) => marker.x >= left && marker.x <= right && marker.y >= top && marker.y <= bottom)
        .map((marker) => marker.agent),
    );
  }

  function finishMapSelection(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragSelection || event.pointerId !== dragSelection.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!dragSelection.moved) setSelection([]);
    setDragSelection(null);
  }

  function cancelMapSelection(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragSelection?.pointerId === event.pointerId) setDragSelection(null);
  }

  function selectedAgentsOnOpenMap() {
    const selected = new Set(selection);
    return selectedRoomUnits
      .filter((unit) => selected.has(unit.agent))
      .map((unit) => unit.agent);
  }

  function unitName(agent: string) {
    return (data?.fleet || []).find((unit) => unit.agent === agent)?.character || agent;
  }

  function updateGroup(groupId: string, change: (group: UnitGroup) => UnitGroup) {
    setGroups((current) => current.map((group) => group.id === groupId ? change(group) : group));
  }

  async function formSelectedGroup() {
    const agents = selectedUnits.map((unit) => unit.agent);
    if (agents.length < 2) return;
    const overlapping = groups.filter((group) => group.agents.some((agent) => agents.includes(agent)));
    if (overlapping.length) {
      formationTickAbort.current?.abort();
      setIssuing(true);
      try {
        await Promise.all(overlapping.map((group) => sendFormationRelease(group, group.revision + 1)));
      } catch (error) {
        setActivity((current) => [{
          id: crypto.randomUUID(),
          kind: "warning",
          title: "Could not release the previous group",
          detail: error instanceof Error ? error.message : "Unknown broker response",
          time: "now",
        }, ...current]);
        setIssuing(false);
        return;
      }
      setIssuing(false);
    }
    const leader = agents[0];
    const id = crypto.randomUUID();
    const group: UnitGroup = {
      id,
      revision: 0,
      name: `Unit Group ${groups.length + 1}`,
      leader,
      agents,
      formation: "conga",
      spacing: 1,
      slots: buildFormationSlots("conga", agents, leader, 1),
      active: false,
    };
    setGroups((current) => [
      ...current.flatMap((existing) => {
        const remaining = existing.agents.filter((agent) => !agents.includes(agent));
        const membershipChanged = remaining.length !== existing.agents.length;
        if (!membershipChanged) return [existing];
        if (remaining.length < 2) return [];
        const nextLeader = remaining.includes(existing.leader) ? existing.leader : remaining[0];
        const preset = existing.formation === "custom" ? "conga" : existing.formation;
        return [{
          ...existing,
          revision: existing.revision + 1,
          active: false,
          leader: nextLeader,
          agents: remaining,
          formation: preset,
          slots: buildFormationSlots(preset, remaining, nextLeader, existing.spacing),
        }];
      }),
      group,
    ]);
    setSelectedGroupId(id);
    setSelectedSlotAgent(leader);
    setFormationManagerOpen(true);
    setDetailAgent(null);
  }

  function chooseGroup(group: UnitGroup) {
    setSelectedGroupId(group.id);
    setSelectedSlotAgent(group.leader);
    setSelection(group.agents);
  }

  function showGroupOnMap(group: UnitGroup) {
    chooseGroup(group);
    const leader = (data?.fleet || []).find((unit) => unit.agent === group.leader);
    if (leader?.room_num != null) setSelectedRoomNum(leader.room_num);
    setFormationManagerOpen(false);
  }

  function applyFormationPreset(kind: Exclude<FormationKind, "custom">) {
    if (!selectedGroup) return;
    updateGroup(selectedGroup.id, (group) => {
      const spacing = fitFormationSpacing(kind, group.agents.length, group.spacing);
      return {
        ...group,
        formation: kind,
        spacing,
        slots: buildFormationSlots(kind, group.agents, group.leader, spacing),
      };
    });
  }

  function changeGroupSpacing(spacing: number) {
    if (!selectedGroup) return;
    updateGroup(selectedGroup.id, (group) => {
      const requestedSpacing = Math.max(1, Math.min(4, Math.round(spacing)));
      if (group.formation === "custom") {
        const ratio = requestedSpacing / Math.max(1, group.spacing);
        return {
          ...group,
          spacing: requestedSpacing,
          slots: group.slots.map((slot) => slot.agent === group.leader
            ? slot
            : {
                ...slot,
                dx: Math.max(-MAX_FORMATION_OFFSET, Math.min(MAX_FORMATION_OFFSET, Math.round(slot.dx * ratio))),
                dy: Math.max(-MAX_FORMATION_OFFSET, Math.min(MAX_FORMATION_OFFSET, Math.round(slot.dy * ratio))),
              }),
        };
      }
      const nextSpacing = fitFormationSpacing(group.formation, group.agents.length, requestedSpacing);
      return {
        ...group,
        spacing: nextSpacing,
        slots: buildFormationSlots(group.formation, group.agents, group.leader, nextSpacing),
      };
    });
  }

  function changeGroupLeader(leader: string) {
    if (!selectedGroup || !selectedGroup.agents.includes(leader)) return;
    updateGroup(selectedGroup.id, (group) => {
      const nextLeaderSlot = group.slots.find((slot) => slot.agent === leader) || { dx: 0, dy: 1 };
      return {
        ...group,
        leader,
        slots: group.slots.map((slot) => {
          if (slot.agent === leader) return { ...slot, dx: 0, dy: 0 };
          if (slot.agent === group.leader) {
            return { ...slot, dx: nextLeaderSlot.dx, dy: nextLeaderSlot.dy };
          }
          return slot;
        }),
      };
    });
    setSelectedSlotAgent(leader);
  }

  function moveFormationSlot(dx: number, dy: number) {
    if (!selectedGroup || !selectedSlotAgent || selectedSlotAgent === selectedGroup.leader) return;
    updateGroup(selectedGroup.id, (group) => {
      const moving = group.slots.find((slot) => slot.agent === selectedSlotAgent);
      const occupied = group.slots.find((slot) => slot.dx === dx && slot.dy === dy);
      if (!moving || occupied?.agent === group.leader) return group;
      return {
        ...group,
        formation: "custom",
        slots: group.slots.map((slot) => {
          if (slot.agent === selectedSlotAgent) return { ...slot, dx, dy };
          if (occupied && slot.agent === occupied.agent) {
            return { ...slot, dx: moving.dx, dy: moving.dy };
          }
          return slot;
        }),
      };
    });
  }

  async function removeGroupMember(agent: string) {
    if (!selectedGroup || selectedGroup.agents.length <= 2) return;
    if (selectedGroup.active) {
      formationTickAbort.current?.abort();
      try {
        await sendFormationRelease(selectedGroup, selectedGroup.revision + 1);
      } catch (error) {
        setActivity((current) => [{
          id: crypto.randomUUID(),
          kind: "warning",
          title: "Member remains in the active formation",
          detail: error instanceof Error ? error.message : "Unknown broker response",
          time: "now",
        }, ...current]);
        return;
      }
    }
    updateGroup(selectedGroup.id, (group) => {
      const agents = group.agents.filter((member) => member !== agent);
      const leader = agent === group.leader ? agents[0] : group.leader;
      const preset = group.formation === "custom" ? "conga" : group.formation;
      return {
        ...group,
        revision: group.active ? group.revision + 1 : group.revision,
        active: false,
        agents,
        leader,
        formation: preset,
        slots: buildFormationSlots(preset, agents, leader, group.spacing),
      };
    });
    if (selectedSlotAgent === agent) setSelectedSlotAgent(selectedGroup.leader);
  }

  function formationPayload(group: UnitGroup, action: "start" | "stop" | "tick" | "move", revision = group.revision) {
    return {
      action,
      groupId: group.id,
      revision,
      leader: group.leader,
      agents: group.agents,
      slots: group.slots,
    };
  }

  async function sendFormationRelease(group: UnitGroup, revision: number) {
    const response = await fetch("/api/formations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formationPayload(group, "stop", revision)),
    });
    const result = (await response.json()) as {
      error?: string;
      accepted?: number;
      hardStopAvailable?: boolean;
    };
    if (!response.ok) throw new Error(result.error || "Formation release was refused");
    return result;
  }

  async function setGroupActive(group: UnitGroup, active: boolean) {
    setIssuing(true);
    const revision = group.revision + 1;
    if (!active) {
      formationTickAbort.current?.abort();
      updateGroup(group.id, (current) => ({ ...current, active: false, revision }));
    }
    try {
      let result: { error?: string; accepted?: number; hardStopAvailable?: boolean };
      if (active) {
        const response = await fetch("/api/formations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(formationPayload(group, "start", revision)),
        });
        result = (await response.json()) as typeof result;
        if (!response.ok) throw new Error(result.error || "Formation keeper refused");
        registeredFormations.current.add(`${group.id}:${revision}`);
        updateGroup(group.id, (current) => ({ ...current, active: true, revision }));
      } else {
        result = await sendFormationRelease(group, revision);
      }
      setSelection(group.agents);
      setActivity((current) => [{
        id: crypto.randomUUID(),
        kind: "success",
        title: `${group.name} ${active ? "formed up" : "released"}`,
        detail: active
          ? `${unitName(group.leader)} is leading ${group.formation} formation`
          : result.hardStopAvailable === false
            ? "Formation loop stopped; the running broker may finish its current movement until it is restarted with hard-stop support"
            : "Old formation movement interrupted; members are awaiting individual orders",
        time: "now",
      }, ...current]);
    } catch (error) {
      setActivity((current) => [{
        id: crypto.randomUUID(),
        kind: "warning",
        title: "Formation command failed",
        detail: error instanceof Error ? error.message : "Unknown broker response",
        time: "now",
      }, ...current]);
    } finally {
      setIssuing(false);
    }
  }

  async function deleteSelectedGroup() {
    if (!selectedGroup) return;
    setIssuing(true);
    formationTickAbort.current?.abort();
    try {
      await sendFormationRelease(selectedGroup, selectedGroup.revision + 1);
    } catch (error) {
      setActivity((current) => [{
        id: crypto.randomUUID(),
        kind: "warning",
        title: "Group was not dissolved",
        detail: error instanceof Error ? error.message : "Unknown broker response",
        time: "now",
      }, ...current]);
      setIssuing(false);
      return;
    }
    setGroups((current) => current.filter((group) => group.id !== selectedGroup.id));
    const remaining = groups.filter((group) => group.id !== selectedGroup.id);
    setSelectedGroupId(remaining[0]?.id || null);
    setSelectedSlotAgent(remaining[0]?.leader || null);
    setIssuing(false);
  }

  async function breakSelectedFormations() {
    const selectedAgents = selectedUnits.map((unit) => unit.agent);
    if (!selectedAgents.length) return;
    const related = groups.filter((group) => group.agents.some((agent) => selectedAgents.includes(agent)));
    formationTickAbort.current?.abort();
    setIssuing(true);
    try {
      let hardStopAvailable = true;
      if (related.length) {
        const results = await Promise.all(
          related.map((group) => sendFormationRelease(group, group.revision + 1)),
        );
        hardStopAvailable = results.every((result) => result.hardStopAvailable !== false);
        setGroups((current) => current.map((group) => related.some((item) => item.id === group.id)
          ? { ...group, active: false, revision: group.revision + 1 }
          : group));
      } else {
        const response = await fetch("/api/formations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "stop",
            groupId: `break-${crypto.randomUUID()}`,
            revision: 1,
            agents: selectedAgents,
          }),
        });
        const result = (await response.json()) as { error?: string; hardStopAvailable?: boolean };
        if (!response.ok) throw new Error(result.error || "Emergency break was refused");
        hardStopAvailable = result.hardStopAvailable !== false;
      }
      setActivity((current) => [{
        id: crypto.randomUUID(),
        kind: hardStopAvailable ? "success" : "warning",
        title: hardStopAvailable ? "Formation control broken" : "Formation loop broken; movement is settling",
        detail: hardStopAvailable
          ? `${selectedAgents.length} selected unit${selectedAgents.length === 1 ? " is" : "s are"} free for new orders`
          : "The running broker predates hard-stop support, so current steps may finish until the broker is restarted",
        time: "now",
      }, ...current]);
    } catch (error) {
      setActivity((current) => [{
        id: crypto.randomUUID(),
        kind: "warning",
        title: "Could not break formation control",
        detail: error instanceof Error ? error.message : "Unknown broker response",
        time: "now",
      }, ...current]);
    } finally {
      setIssuing(false);
    }
  }

  async function issueMapOrder(
    order: { kind: "move"; col: number; row: number } | {
      kind: "exit";
      to: number;
      label: string;
      exitKind: "door" | "edge";
      exitCol: number;
      exitRow: number;
      direction: "north" | "south" | "east" | "west" | null;
    },
  ) {
    if (selectedRoomNum == null) return;
    const agents = selectedAgentsOnOpenMap();
    const formationMove = order.kind === "move" ? activeSelectionGroup : null;
    if (!agents.length || !data?.broker.online) {
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          kind: "warning",
          title: "No local units selected",
          detail: "Select one or more blue units on this map first",
          time: "now",
        },
        ...current,
      ]);
      return;
    }

    const detail = order.kind === "move"
      ? `${formationMove ? `${formationMove.name} · ` : ""}Row ${order.row}, column ${order.col}`
      : `Use exit to ${order.label}`;
    setActivity((current) => [
      {
        id: crypto.randomUUID(),
        kind: "order",
        title: `${order.kind === "move" ? "Move" : "Exit"} order dispatched`,
        detail: `${formationMove?.agents.length || agents.length} ${(formationMove?.agents.length || agents.length) === 1 ? "unit" : "units"} · ${detail}`,
        time: "now",
      },
      ...current,
    ]);
    if (order.kind === "exit") {
      setExitFollow({
        agents,
        fromRoom: selectedRoomNum,
        toRoom: order.to,
        startedAt: Date.now(),
      });
    }

    setIssuing(true);
    try {
      const response = await fetch(formationMove ? "/api/formations" : "/api/map-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formationMove ? {
          ...formationPayload(formationMove, "move"),
          room: selectedRoomNum,
          anchor: { col: order.kind === "move" ? order.col : 0, row: order.kind === "move" ? order.row : 0 },
        } : {
          ...order,
          agents,
          room: selectedRoomNum,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        accepted?: number;
        failed?: number;
        skipped?: number;
      };
      if (!response.ok) throw new Error(result.error || "Map order refused");
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          kind: result.failed || result.skipped ? "warning" : "success",
          title: `${result.accepted || 0} map orders acknowledged`,
          detail: result.failed || result.skipped
            ? `${result.failed || 0} failed · ${result.skipped || 0} had already left`
            : order.kind === "exit"
              ? "Following the first unit through"
              : formationMove
                ? `${formationMove.name} is moving in ${formationMove.formation} formation`
                : "Units are pathfinding to the marked square",
          time: "now",
        },
        ...current,
      ]);
      if (order.kind === "exit" && !result.accepted) setExitFollow(null);
      window.setTimeout(() => void refresh(true), 900);
    } catch (error) {
      if (order.kind === "exit") setExitFollow(null);
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          kind: "warning",
          title: "Map order could not be issued",
          detail: error instanceof Error ? error.message : "Unknown broker response",
          time: "now",
        },
        ...current,
      ]);
    } finally {
      setIssuing(false);
    }
  }

  function commandMapSquare(event: ReactMouseEvent<SVGSVGElement>) {
    event.preventDefault();
    if (!roomMap) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const col = Math.max(
      1,
      Math.min(
        roomMap.cols,
        Math.floor(
          ((point.x - roomMap.transform.pad) / roomMap.transform.scale + roomMap.transform.minX) /
            roomMap.transform.fineness,
        ),
      ),
    );
    const row = Math.max(
      1,
      Math.min(
        roomMap.rows,
        Math.floor(
          ((point.y - roomMap.transform.pad) / roomMap.transform.scale + roomMap.transform.minY) /
            roomMap.transform.fineness,
        ),
      ),
    );
    void issueMapOrder({ kind: "move", col, row });
  }

  function beginWorldPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (!worldIsZoomed || event.button !== 0) return;
    if ((event.target as Element).closest(".world-unit-group")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    worldPanGesture.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewport: activeWorldViewport,
    };
    setWorldPanning(true);
  }

  function updateWorldPan(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = worldPanGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const renderedScale = Math.min(
      rect.width / gesture.viewport.width,
      rect.height / gesture.viewport.height,
    );
    if (!Number.isFinite(renderedScale) || renderedScale <= 0) return;
    setWorldViewport(clampWorldViewport({
      ...gesture.viewport,
      x: gesture.viewport.x - (event.clientX - gesture.startClientX) / renderedScale,
      y: gesture.viewport.y - (event.clientY - gesture.startClientY) / renderedScale,
    }));
  }

  function finishWorldPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (worldPanGesture.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    worldPanGesture.current = null;
    setWorldPanning(false);
  }

  function cancelWorldPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (worldPanGesture.current?.pointerId !== event.pointerId) return;
    worldPanGesture.current = null;
    setWorldPanning(false);
  }

  function toggleWorldScope() {
    setWorldViewport(null);
    setWorldScope((scope) => scope === "company" ? "all" : "company");
  }

  function beginCompanyNameEdit() {
    setCompanyNameDraft(companyName);
    setEditingCompanyName(true);
  }

  function commitCompanyName() {
    const nextName = companyNameDraft.trim().slice(0, 60) || DEFAULT_COMPANY_NAME;
    setCompanyName(nextName);
    setCompanyNameDraft(nextName);
    setEditingCompanyName(false);
    try {
      window.localStorage.setItem(COMPANY_NAME_STORAGE_KEY, nextName);
    } catch {
      // Session-only editing is still useful when browser storage is unavailable.
    }
  }

  function cancelCompanyNameEdit() {
    setCompanyNameDraft(companyName);
    setEditingCompanyName(false);
  }

  function openLocation(location: { roomNum: number | null; units: FleetUnit[] }) {
    setSelection(location.units.map((unit) => unit.agent));
    if (location.roomNum != null) setSelectedRoomNum(location.roomNum);
  }

  function openUnitMap(unit: FleetUnit) {
    setSelection([unit.agent]);
    if (unit.room_num != null) setSelectedRoomNum(unit.room_num);
  }

  function openUnitDetails(unit: FleetUnit) {
    setSelection([unit.agent]);
    setDetailAgent(unit.agent);
  }

  async function openStrategySheet() {
    if (!selection.length || !data?.broker.online) return;
    setStrategySheetOpen(true);
    setStrategyLoading(true);
    setStrategyError(null);
    setStrategyChanges({});
    try {
      const query = new URLSearchParams();
      for (const agent of selection) query.append("agent", agent);
      const response = await fetch(`/api/strategies?${query}`, { cache: "no-store" });
      const result = await response.json() as StrategyResponse;
      if (!response.ok) throw new Error(result.error || "DUM strategy control is unavailable");
      setStrategyCatalogue(result.catalogue || []);
      setStrategyStates(result.states || {});
    } catch (error) {
      setStrategyError(error instanceof Error ? error.message : "DUM strategy control is unavailable");
    } finally {
      setStrategyLoading(false);
    }
  }

  function toggleStrategy(strategy: DumStrategy) {
    const next = strategyStates[strategy.id]?.state !== "all";
    setStrategyChanges((current) => ({ ...current, [strategy.id]: next }));
    setStrategyStates((current) => ({ ...current, [strategy.id]: {
      state: next ? "all" : "none", enabled: next ? selection.length : 0, total: selection.length,
    } }));
  }

  async function saveStrategies() {
    if (!selection.length || !Object.keys(strategyChanges).length) {
      setStrategySheetOpen(false);
      return;
    }
    setStrategySaving(true);
    setStrategyError(null);
    try {
      const response = await fetch("/api/strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: selection, changes: strategyChanges }),
      });
      const result = await response.json() as StrategyResponse;
      if (!response.ok) throw new Error(result.error || "Strategy changes were refused");
      setActivity((current) => [{
        id: crypto.randomUUID(), kind: "success", title: "DUM strategies updated",
        detail: `${selection.length} selected ${selection.length === 1 ? "unit" : "units"} · ${Object.keys(strategyChanges).length} behavior ${Object.keys(strategyChanges).length === 1 ? "toggle" : "toggles"}`,
        time: "now",
      }, ...current]);
      setStrategySheetOpen(false);
      setStrategyChanges({});
    } catch (error) {
      setStrategyError(error instanceof Error ? error.message : "DUM strategy control is unavailable");
    } finally {
      setStrategySaving(false);
    }
  }

  function openOrder(action: OrderAction) {
    if (!selection.length || !data?.broker.online) return;
    setPendingAction(action);
  }

  async function issueOrder() {
    if (!pendingAction || !selection.length) return;
    setIssuing(true);
    const actionLabel = ACTIONS.find((action) => action.id === pendingAction)?.label || pendingAction;
    setActivity((current) => [
      {
        id: crypto.randomUUID(),
        kind: "order",
        title: `${actionLabel} order dispatched`,
        detail: `${selection.length} selected ${selection.length === 1 ? "unit" : "units"}`,
        time: "now",
      },
      ...current,
    ]);

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: pendingAction,
          agents: selection,
          options: { destination, hunt, roam },
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        accepted?: number;
        failed?: number;
      };
      if (!response.ok) throw new Error(result.error || "Order refused");
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          kind: result.failed ? "warning" : "success",
          title: `${result.accepted || 0} orders acknowledged`,
          detail: result.failed ? `${result.failed} could not be completed` : "Fleet keepers are responding",
          time: "now",
        },
        ...current,
      ]);
      setPendingAction(null);
      window.setTimeout(() => void refresh(true), 900);
    } catch (error) {
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          kind: "warning",
          title: "Order could not be issued",
          detail: error instanceof Error ? error.message : "Unknown broker response",
          time: "now",
        },
        ...current,
      ]);
    } finally {
      setIssuing(false);
    }
  }

  const workingCount = (data?.fleet || []).filter(unitWorking).length;
  const allVisibleSelected =
    visibleUnits.length > 0 && visibleUnits.every((unit) => selection.includes(unit.agent));

  return (
    <main className="command-app">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">M59</div>
          <div>
            <p className="eyebrow">Meridian field command</p>
            <h1
              className={`editable-company-name ${editingCompanyName ? "editing" : ""}`}
              onDoubleClick={beginCompanyNameEdit}
              title={editingCompanyName ? undefined : "Double click to rename the company"}
            >
              {editingCompanyName ? (
                <input
                  ref={companyNameInputRef}
                  className="company-name-input"
                  value={companyNameDraft}
                  maxLength={60}
                  onChange={(event) => setCompanyNameDraft(event.target.value)}
                  onBlur={commitCompanyName}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitCompanyName();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelCompanyNameEdit();
                    }
                  }}
                  aria-label="Company name"
                />
              ) : companyName}
            </h1>
          </div>
        </div>
        <div className="war-stats" aria-label="Fleet summary">
          <div><span>Company</span><strong>{data?.fleet.length || 0}</strong></div>
          <div><span>Deployed</span><strong>{workingCount}</strong></div>
          <div><span>Attention</span><strong className={data?.needsAttention ? "danger-text" : ""}>{data?.needsAttention || 0}</strong></div>
        </div>
        <div className="connection-block">
          <span className={`connection-dot ${data?.broker.online ? "online" : ""}`} />
          <div>
            <strong>{data?.broker.online ? `${data.broker.fleet} fleet online` : "Broker offline"}</strong>
            <span>Report {timeLabel(data?.refreshedAt || null)}</span>
          </div>
          <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh fleet" title="Refresh fleet">↻</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="roster-panel panel-frame">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Your company</p>
              <h2>Unit roster</h2>
            </div>
            <span className="count-badge">{visibleUnits.length}</span>
          </div>

          <label className="search-box">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find unit or territory" />
          </label>

          <div className="filter-tabs" role="tablist" aria-label="Roster filters">
            {(["all", "working", "attention"] as Filter[]).map((item) => (
              <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>
            ))}
          </div>

          <button
            className="select-visible"
            onClick={() =>
              setSelection((current) =>
                allVisibleSelected
                  ? current.filter((agent) => !visibleUnits.some((unit) => unit.agent === agent))
                  : [...new Set([...current, ...visibleUnits.map((unit) => unit.agent)])],
              )
            }
            disabled={!visibleUnits.length}
          >
            <span className={`check-box ${allVisibleSelected ? "checked" : ""}`}>{allVisibleSelected ? "✓" : ""}</span>
            Select visible
          </button>

          <div className="unit-list">
            {loading && !data ? <div className="empty-roster">Reading the field ledger…</div> : null}
            {!loading && !visibleUnits.length ? (
              <div className="empty-roster">
                <strong>No units reporting.</strong>
                <span>{data?.error || "Try another roster filter."}</span>
              </div>
            ) : null}
            {visibleUnits.map((unit) => {
              const selected = selection.includes(unit.agent);
              const attention = unitNeedsAttention(unit);
              return (
                <div
                  key={unit.agent}
                  className={`unit-card ${selected ? "selected" : ""} ${attention ? "attention" : ""}`}
                  onClick={() => toggleAgent(unit.agent)}
                  onDoubleClick={() => openUnitMap(unit)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleAgent(unit.agent);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${unit.character} in ${unit.room}. Click to select; double click to open the zone map.`}
                  title={`Double click to open ${unit.room}`}
                >
                  <button
                    className="unit-detail-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openUnitDetails(unit);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    aria-label={`Open detailed view for ${unit.character}`}
                    title={`View ${unit.character}'s full dossier`}
                  >
                    Details
                  </button>
                  <span className={`check-box ${selected ? "checked" : ""}`}>{selected ? "✓" : ""}</span>
                  <span className="portrait">{initials(unit.character)}</span>
                  <span className="unit-copy">
                    <span className="unit-name-line">
                      <strong>{unit.character}</strong>
                      <small>{unit.agent}</small>
                    </span>
                    <span className="unit-location">{unit.room}</span>
                    {(groupsByAgent.get(unit.agent) || []).length ? (
                      <span className="unit-groups">
                        {(groupsByAgent.get(unit.agent) || []).map((group) => (
                          <i key={group.id} className={group.active ? "active" : ""}>{group.name}</i>
                        ))}
                      </span>
                    ) : null}
                    <span className="health-line">
                      <span className="health-track"><i style={{ width: `${ratio(unit.health) * 100}%` }} /></span>
                      <small>{unit.health} hp</small>
                    </span>
                  </span>
                  <span className={`unit-state ${attention ? "danger" : unitWorking(unit) ? "working" : ""}`}>{statusLabel(unit)}</span>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="map-panel panel-frame" aria-label="Strategic field map">
          {detailAgent ? (
            <div className="hero-detail-view">
              <div className="hero-detail-toolbar">
                <div>
                  <p className="eyebrow">Unit dossier</p>
                  <h2>{(data?.fleet || []).find((unit) => unit.agent === detailAgent)?.character || detailAgent}</h2>
                </div>
                <button
                  className="close-hero-detail"
                  onClick={() => setDetailAgent(null)}
                  aria-label="Close unit detailed view"
                  title="Close dossier"
                >
                  ×
                </button>
              </div>
              <iframe
                key={detailAgent}
                className="hero-detail-frame"
                src={`/api/hero?agent=${encodeURIComponent(detailAgent)}`}
                title={`Detailed unit view for ${(data?.fleet || []).find((unit) => unit.agent === detailAgent)?.character || detailAgent}`}
                sandbox="allow-same-origin"
              />
            </div>
          ) : formationManagerOpen ? (
            <div className="formation-manager-view">
              <div className="formation-manager-toolbar">
                <div>
                  <p className="eyebrow">Company organization</p>
                  <h2>Formation editor</h2>
                </div>
                <div>
                  <button
                    className="map-scope-button"
                    onClick={() => void formSelectedGroup()}
                    disabled={selection.length < 2 || issuing}
                    title="Create a new group from the selected roster units"
                  >
                    + Form selected
                  </button>
                  <button
                    className="formation-disengage"
                    onClick={() => void breakSelectedFormations()}
                    disabled={!selection.length || issuing || !data?.broker.online}
                    title="Stop old formation ticks and interrupt formation movement for the selected units"
                  >
                    Break selected
                  </button>
                  <button className="close-hero-detail" onClick={() => setFormationManagerOpen(false)} aria-label="Close formation editor">×</button>
                </div>
              </div>
              <div className="formation-manager-body">
                <aside className="formation-group-list">
                  <div className="formation-section-title">
                    <span>Unit groups</span>
                    <b>{groups.length}</b>
                  </div>
                  {groups.map((group) => (
                    <button
                      key={group.id}
                      className={`formation-group-card ${selectedGroup?.id === group.id ? "selected" : ""}`}
                      onClick={() => chooseGroup(group)}
                    >
                      <span className={`formation-status-dot ${group.active ? "active" : ""}`} />
                      <span><strong>{group.name}</strong><small>{group.agents.length} units · {group.formation}</small></span>
                    </button>
                  ))}
                  {!groups.length ? (
                    <div className="empty-formation-groups">
                      <strong>No groups formed</strong>
                      <span>Select at least two units, then use Form Group.</span>
                    </div>
                  ) : null}
                </aside>

                {selectedGroup ? (
                  <section className="formation-editor-panel">
                    <div className="formation-editor-heading">
                      <label>
                        <span>Group name</span>
                        <input
                          value={selectedGroup.name}
                          maxLength={50}
                          onChange={(event) => updateGroup(selectedGroup.id, (group) => ({ ...group, name: event.target.value.slice(0, 50) }))}
                        />
                      </label>
                      <div className="formation-heading-actions">
                        <button className="secondary-button" onClick={() => showGroupOnMap(selectedGroup)}>Show on map</button>
                        <button
                          className={selectedGroup.active ? "formation-disengage" : "primary-button"}
                          onClick={() => void setGroupActive(selectedGroup, !selectedGroup.active)}
                          disabled={issuing || !data?.broker.online}
                        >
                          {issuing ? "Relaying…" : selectedGroup.active ? "Release formation" : "Engage formation"}
                        </button>
                      </div>
                    </div>

                    <div className="formation-presets" aria-label="Formation presets">
                      {FORMATION_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          className={selectedGroup.formation === preset.id ? "selected" : ""}
                          onClick={() => applyFormationPreset(preset.id)}
                          title={preset.hint}
                        >
                          <i className={`formation-icon ${preset.id}`} aria-hidden="true" />
                          <strong>{preset.label}</strong>
                          <span>{preset.hint}</span>
                        </button>
                      ))}
                    </div>

                    <div className="formation-workbench">
                      <div className="formation-board-wrap">
                        <div className="formation-board-heading">
                          <span>Front / leader facing</span>
                          <label>Spacing <input type="range" min="1" max="4" value={selectedGroup.spacing} onChange={(event) => changeGroupSpacing(Number(event.target.value))} /><b>{selectedGroup.spacing}</b></label>
                        </div>
                        <div className="formation-front-arrow">↑</div>
                        <div className="formation-grid" role="grid" aria-label={`${selectedGroup.name} formation positions`}>
                          {FORMATION_GRID.map(({ dx, dy }) => {
                            const occupant = selectedGroup.slots.find((slot) => slot.dx === dx && slot.dy === dy);
                            const isLeader = occupant?.agent === selectedGroup.leader;
                            const isSelected = occupant?.agent === selectedSlotAgent;
                            return (
                              <button
                                key={`${dx}:${dy}`}
                                className={`${occupant ? "occupied" : ""} ${isLeader ? "leader" : ""} ${isSelected ? "selected" : ""}`}
                                onClick={() => occupant ? setSelectedSlotAgent(occupant.agent) : moveFormationSlot(dx, dy)}
                                aria-label={occupant ? `${unitName(occupant.agent)} at ${dx}, ${dy}${isLeader ? ", group leader" : ""}` : `Move selected member to ${dx}, ${dy}`}
                                title={occupant ? `${unitName(occupant.agent)} · right ${dx}, behind ${dy}` : `right ${dx}, behind ${dy}`}
                              >
                                {occupant ? (isLeader ? "★" : initials(unitName(occupant.agent))) : ""}
                              </button>
                            );
                          })}
                        </div>
                        <p>Offsets rotate with the leader. Positive vertical positions trail behind; horizontal positions stay to the leader’s right or left.</p>
                      </div>

                      <aside className="formation-members">
                        <div className="formation-section-title"><span>Members & slots</span><b>{selectedGroup.agents.length}</b></div>
                        <label className="formation-leader-select">
                          <span>Group leader</span>
                          <select value={selectedGroup.leader} onChange={(event) => changeGroupLeader(event.target.value)}>
                            {selectedGroup.agents.map((agent) => <option key={agent} value={agent}>{unitName(agent)}</option>)}
                          </select>
                        </label>
                        <div className="formation-member-list">
                          {selectedGroup.agents.map((agent) => {
                            const slot = selectedGroup.slots.find((candidate) => candidate.agent === agent);
                            const leader = agent === selectedGroup.leader;
                            return (
                              <div key={agent} className={`${selectedSlotAgent === agent ? "selected" : ""} ${leader ? "leader" : ""}`}>
                                <button onClick={() => setSelectedSlotAgent(agent)}>
                                  <i>{leader ? "★" : initials(unitName(agent))}</i>
                                  <span><strong>{unitName(agent)}</strong><small>{leader ? "Leader · origin" : `right ${slot?.dx || 0} · behind ${slot?.dy || 0}`}</small></span>
                                </button>
                                {!leader ? <button className="remove-group-member" onClick={() => void removeGroupMember(agent)} aria-label={`Remove ${unitName(agent)} from group`}>×</button> : null}
                              </div>
                            );
                          })}
                        </div>
                        <button className="delete-group-button" onClick={() => void deleteSelectedGroup()} disabled={issuing}>Dissolve group</button>
                      </aside>
                    </div>
                  </section>
                ) : (
                  <div className="formation-empty-editor">
                    <span>⌘</span>
                    <strong>Select units, then form a group.</strong>
                    <p>Groups remember their leader, membership, spacing, and formation on this command post.</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
          <div className="map-toolbar">
            <div>
              <p className="eyebrow">{selectedRoomNum == null ? "The Meridian territories" : "Live zone geometry"}</p>
              <h2>{selectedRoomNum == null ? "Strategic field map" : roomMap?.name || selectedRoomUnits[0]?.room || `Room ${selectedRoomNum}`}</h2>
            </div>
            <div className="map-toolbar-actions">
              <button className="map-scope-button group-manager-button" onClick={() => { setFormationManagerOpen(true); setDetailAgent(null); }}>
                Groups {groups.length ? `(${groups.filter((group) => group.active).length}/${groups.length})` : ""}
              </button>
              {selectedRoomNum == null ? (
                <>
                  <label className="topology-toggle">
                    <input
                      type="checkbox"
                      checked={showTopology}
                      onChange={(event) => setShowTopology(event.target.checked)}
                    />
                    <span>Show game connections</span>
                  </label>
                   <button className="map-scope-button" onClick={toggleWorldScope}>
                    {worldScope === "company" ? "Show entire world" : "Focus company"}
                  </button>
                </>
              ) : (
                <>
                  <label className="topology-toggle safe-spot-toggle">
                    <input
                      type="checkbox"
                      checked={showSafeSpots}
                      onChange={(event) => setShowSafeSpots(event.target.checked)}
                    />
                    <span>Overlay safe spot ledger{showSafeSpots && roomSafeSpots.length ? ` (${roomSafeSpots.length})` : ""}</span>
                  </label>
                  <button className="map-scope-button" onClick={() => setSelectedRoomNum(null)}>← Meridian world</button>
                </>
              )}
              <div className="map-legend">
                <button
                  type="button"
                  className={`map-legend-toggle ${showCompanyLayer ? "" : "disabled"}`}
                  aria-pressed={showCompanyLayer}
                  onClick={() => setShowCompanyLayer((shown) => !shown)}
                >
                  <i className="legend-dot friendly" /> Company ({companyLegendCount})
                </button>
                {selectedRoomNum != null ? (
                  <>
                    <button
                      type="button"
                      className={`map-legend-toggle ${showMonsterLayer ? "" : "disabled"}`}
                      aria-pressed={showMonsterLayer}
                      onClick={() => setShowMonsterLayer((shown) => !shown)}
                    >
                      <i className="legend-dot hostile" /> Monster ({roomMonsterMarkers.length})
                    </button>
                    <button
                      type="button"
                      className={`map-legend-toggle ${showExitLayer ? "" : "disabled"}`}
                      aria-pressed={showExitLayer}
                      onClick={() => setShowExitLayer((shown) => !shown)}
                    >
                      <i className="legend-dot exit" /> Exit ({roomMap?.exits.length || 0})
                    </button>
                    {showSafeSpots ? (
                      <>
                        {(["holds", "failed", "untested"] as const).map((layer) => (
                          <button
                            key={layer}
                            type="button"
                            className={`map-legend-toggle ${safeSpotLayers[layer] ? "" : "disabled"}`}
                            aria-pressed={safeSpotLayers[layer]}
                            onClick={() => setSafeSpotLayers((current) => ({
                              ...current,
                              [layer]: !current[layer],
                            }))}
                          >
                            <i className={`legend-dot safe-${layer}`} /> {layer[0].toUpperCase() + layer.slice(1)} ({safeSpotCounts[layer]})
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className={`world-map geometry-map ${showTopology && selectedRoomNum == null ? "topology-on" : ""}`}>

            {!data?.broker.online ? (
              <div className="offline-map-message">
                <span className="offline-seal">!</span>
                <strong>The war table has no messenger.</strong>
                <p>Run the m59-harness broker on port 8901, then refresh this command post.</p>
              </div>
            ) : null}

            {mapLoading ? <div className="map-loading">Reading Meridian geometry…</div> : null}
            {selectedRoomNum != null && showSafeSpots && (safeSpotsLoading || safeSpotsError) ? (
              <div className={`safe-spot-overlay-status ${safeSpotsError ? "error" : ""}`}>
                {safeSpotsError || "Reading safe-spot ledger…"}
              </div>
            ) : null}

            {selectedRoomNum == null && worldMap ? (
              <svg
                ref={worldMapRef}
                className={`world-map-svg ${worldIsZoomed ? "zoomed" : "fit"} ${worldPanning ? "panning" : ""}`}
                viewBox={worldViewBox}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`Meridian 59 illustrated world map with fleet locations${showTopology ? " and game connections" : ""}; use the mouse wheel to zoom and drag to pan when zoomed`}
                onPointerDown={beginWorldPan}
                onPointerMove={updateWorldPan}
                onPointerUp={finishWorldPan}
                onPointerCancel={cancelWorldPan}
              >
                <image
                  className="world-map-art"
                  href="/maps/stratmap.png"
                  x="0"
                  y="0"
                  width={WORLD_ART_WIDTH}
                  height={WORLD_ART_HEIGHT}
                  preserveAspectRatio="xMidYMid meet"
                />
                {showTopology ? (
                  <g className="world-topology">
                    <g className="world-components">
                      {worldMap.components.map((component) => (
                        <g key={component.id}>
                          <rect
                            x={component.x * worldScaleX}
                            y={component.y * worldScaleY}
                            width={component.width * worldScaleX}
                            height={component.height * worldScaleY}
                            rx="12"
                          />
                          <text x={(component.x + 18) * worldScaleX} y={(component.y + 28) * worldScaleY}>{component.label}</text>
                        </g>
                      ))}
                    </g>
                    <g className="world-edges">
                      {worldMap.edges.map((edge) => (
                        <line
                          key={`${edge.from}:${edge.to}`}
                          x1={edge.x1 * worldScaleX}
                          y1={edge.y1 * worldScaleY}
                          x2={edge.x2 * worldScaleX}
                          y2={edge.y2 * worldScaleY}
                        />
                      ))}
                    </g>
                    <g className="world-nodes">
                      {worldMap.nodes.map((node) => (
                        <g key={node.roomNum} className="world-node" transform={`translate(${node.x * worldScaleX},${node.y * worldScaleY})`}>
                          <rect x="-45" y="-15" width="90" height="30" rx="4" />
                          <text y="-2">{node.name.length > 21 ? `${node.name.slice(0, 19)}…` : node.name}</text>
                          <text className="world-node-region" y="10">{node.region}</text>
                        </g>
                      ))}
                    </g>
                  </g>
                ) : null}
                <g className="world-units">
                  {showCompanyLayer ? locations.filter((location) => location.mapX != null && location.mapY != null).map((location) => {
                    const attention = location.units.some(unitNeedsAttention);
                    return (
                      <g
                        key={`${location.roomNum}:${location.room}`}
                        className={`world-unit-group ${attention ? "attention" : ""}`}
                        transform={`translate(${location.mapX},${location.mapY})`}
                        onClick={() => openLocation(location)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") openLocation(location);
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open local map for ${location.units.length} units in ${location.room}`}
                      >
                        <circle r="18" />
                        <text className="world-unit-count" y="4">{location.units.length}</text>
                        <g className="world-unit-label" transform="translate(24,-15)">
                          <rect width={Math.max(120, Math.min(220, location.room.length * 7 + 28))} height="34" rx="4" />
                          <text x="9" y="14">{location.room}</text>
                          <text className="world-unit-sub" x="9" y="27">click for zone map</text>
                        </g>
                      </g>
                    );
                  }) : null}
                </g>
              </svg>
            ) : null}

            {selectedRoomNum != null && roomMap ? (
              <svg
                ref={localMapRef}
                className={`local-map-svg ${dragSelection ? "selecting" : ""}`}
                viewBox={`0 0 ${roomMap.viewBox.width} ${roomMap.viewBox.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`${roomMap.name} interactive local map with live fleet and known monster positions`}
                onPointerDown={beginMapSelection}
                onPointerMove={updateMapSelection}
                onPointerUp={finishMapSelection}
                onPointerCancel={cancelMapSelection}
                onContextMenu={commandMapSquare}
              >
                <path className="room-passage" d={roomMap.passagePath} />
                <path className="room-wall" d={roomMap.solidPath} />
                <g className="room-exits">
                  {showExitLayer ? roomMap.exits.map((exit, index) => (
                    <g
                      key={`${exit.row}:${exit.col}:${index}`}
                      className={`room-exit ${exit.kind} ${exit.locked ? "locked" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!exit.locked && exit.toRoom != null) {
                          void issueMapOrder({
                            kind: "exit",
                            to: exit.toRoom,
                            label: exit.to,
                            exitKind: exit.kind,
                            exitCol: exit.col,
                            exitRow: exit.row,
                            direction: exit.direction as "north" | "south" | "east" | "west" | null,
                          });
                        }
                      }}
                      onKeyDown={(event) => {
                        if ((event.key === "Enter" || event.key === " ") && !exit.locked && exit.toRoom != null) {
                          event.preventDefault();
                          void issueMapOrder({
                            kind: "exit",
                            to: exit.toRoom,
                            label: exit.to,
                            exitKind: exit.kind,
                            exitCol: exit.col,
                            exitRow: exit.row,
                            direction: exit.direction as "north" | "south" | "east" | "west" | null,
                          });
                        }
                      }}
                      role={!exit.locked && exit.toRoom != null ? "button" : undefined}
                      tabIndex={!exit.locked && exit.toRoom != null ? 0 : undefined}
                      aria-label={!exit.locked && exit.toRoom != null ? `Right click to send selected units to ${exit.to}` : undefined}
                    >
                      <circle cx={exit.x} cy={exit.y} r="4" />
                      {exit.kind === "edge" ? (
                        <text x={exit.x} y={exit.y + 1.8}>{exit.direction?.slice(0, 1).toUpperCase()}</text>
                      ) : null}
                      <title>{exit.to} — row {Math.round(exit.row)}, column {Math.round(exit.col)}; right click to traverse</title>
                    </g>
                  )) : null}
                </g>
                {dragSelection ? (
                  <rect
                    className="room-selection-box"
                    x={Math.min(dragSelection.startX, dragSelection.currentX)}
                    y={Math.min(dragSelection.startY, dragSelection.currentY)}
                    width={Math.abs(dragSelection.currentX - dragSelection.startX)}
                    height={Math.abs(dragSelection.currentY - dragSelection.startY)}
                  />
                ) : null}
                <g className="room-monsters">
                  {showMonsterLayer ? roomMonsterMarkers.map((marker) => (
                    <g key={marker.id} className="room-monster-marker">
                      <circle className="room-monster-halo" cx={marker.x} cy={marker.y} r="8" />
                      <circle className="room-monster-dot" cx={marker.x} cy={marker.y} r="4.5" />
                      <line x1={marker.x - 4} y1={marker.y + 4} x2={marker.labelX} y2={marker.labelY + 4} />
                      <g transform={`translate(${marker.labelX},${marker.labelY})`}>
                        <rect width={Math.max(58, marker.name.length * 5.5 + 17)} height="17" rx="3" />
                        <text x="6" y="11.5">{marker.name}</text>
                      </g>
                      <title>{marker.name} — row {marker.row}, column {marker.col}; known by {marker.seenBy.join(", ")}</title>
                    </g>
                  )) : null}
                </g>
                {showSafeSpots ? (
                  <g className="safe-spot-ledger" aria-label={`${visibleSafeSpotMarkers.length} of ${roomSafeSpotMarkers.length} safe-spot ledger records visible`}>
                    {visibleSafeSpotMarkers.map((spot, index) => (
                      <g
                        key={`${spot.col}:${spot.row}:${index}`}
                        className={`safe-spot-marker ${spot.verdict}`}
                        transform={`translate(${spot.x},${spot.y})`}
                        role="img"
                        aria-label={`${spot.verdict} safe spot at row ${spot.row}, column ${spot.col}`}
                      >
                        {spot.verified ? <circle className="safe-spot-verification-ring" r="6" /> : null}
                        <circle className="safe-spot-core" r="3.6" />
                        {spot.verdict === "failed" ? (
                          <path className="safe-spot-failure-mark" d="M-2.2,-2.2 L2.2,2.2 M2.2,-2.2 L-2.2,2.2" />
                        ) : null}
                        <title>{`${spot.verified ? "Verified safe spot" : spot.verdict === "holds" ? "Held under attack" : spot.verdict === "failed" ? "Failed under attack" : "Untested ledger candidate"} — row ${spot.row}, column ${spot.col}; held ${spot.held} time(s) for ${spot.heldSeconds}s, failed ${spot.failed} time(s)${spot.damageTaken ? `, ${spot.damageTaken} damage taken` : ""}${spot.mostAttackers ? `, up to ${spot.mostAttackers} attacker(s)` : ""}${spot.exactX != null ? `; exact fine position ${spot.exactX},${spot.exactY}` : ""}`}</title>
                      </g>
                    ))}
                  </g>
                ) : null}
                <g className="formation-ghosts" aria-hidden="true">
                  {formationGhosts.map((ghost) => (
                    <g key={`${ghost.groupId}:${ghost.agent}`} className={ghost.leader ? "leader" : ""}>
                      <circle cx={ghost.x} cy={ghost.y} r="6" />
                      <text x={ghost.x} y={ghost.y + 2}>{ghost.leader ? "★" : initials(unitName(ghost.agent))}</text>
                    </g>
                  ))}
                </g>
                <g className="room-units">
                  {showCompanyLayer ? roomMarkers.map((marker) => (
                    <g
                      key={marker.agent}
                      className={`room-unit-marker ${selection.includes(marker.agent) ? "selected" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectUnitStack(marker.col, marker.row);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectUnitStack(marker.col, marker.row);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Select all units at row ${marker.row}, column ${marker.col}`}
                    >
                      <circle className="room-unit-halo" cx={marker.x} cy={marker.y} r="8" />
                      <circle className="room-unit-dot" cx={marker.x} cy={marker.y} r="4.5" />
                      <line x1={marker.x + 4} y1={marker.y - 4} x2={marker.labelX} y2={marker.labelY + 4} />
                      <g transform={`translate(${marker.labelX},${marker.labelY})`}>
                        <rect width={Math.max(58, marker.character.length * 6 + 17)} height="17" rx="3" />
                        <text x="6" y="11.5">{marker.character}</text>
                      </g>
                      <title>{marker.character} — row {marker.row}, column {marker.col}, facing {marker.facing || "unknown"}</title>
                    </g>
                  )) : null}
                </g>
              </svg>
            ) : null}

            {selectedRoomNum != null && !mapLoading && !roomMap ? (
              <div className="offline-map-message">
                <span className="offline-seal">?</span>
                <strong>No local geometry was found.</strong>
                <p>The broker still reports this room, but its `.roo` map is not present in the harness map model.</p>
              </div>
            ) : null}

            {selectedRoomNum != null && roomMap ? (
              <div className="room-map-caption">
                <strong>{roomMap.rows} × {roomMap.cols} squares</strong>
                <span>{roomMap.wallCount} walls · {roomMap.file}</span>
                <span>{roomMarkers.length} of {selectedRoomUnits.length} units positioned · {roomMonsterMarkers.length} monsters known · broker cache refreshes every 2s</span>
                <span>Drag to select · click a dot selects its stack · right-click to move or use an exit</span>
                {exitFollow ? <span className="follow-status">Following the first unit through to room {exitFollow.toRoom}…</span> : null}
              </div>
            ) : null}

          </div>

          <div className="command-dock">
            <div className="selection-summary">
              <span className="selection-stack">
                {selectedUnits.slice(0, 4).map((unit) => <i key={unit.agent}>{initials(unit.character)}</i>)}
              </span>
              <div>
                <strong>{activeSelectionGroup ? activeSelectionGroup.name : selection.length ? `${selection.length} selected` : "Choose units"}</strong>
                <span>{activeSelectionGroup ? `${activeSelectionGroup.formation} formation · ${selection.length} units` : selection.length ? selectedUnits.slice(0, 2).map((unit) => unit.character).join(", ") : "Select from the roster or map"}</span>
              </div>
            </div>
            <button
              className="form-group-button"
              onClick={() => void formSelectedGroup()}
              disabled={selection.length < 2}
              title="Create a persistent unit group from the current selection"
            >
              <span>⌘</span>
              <small>Form group</small>
            </button>
            <button
              className="set-strategy-button"
              onClick={() => void openStrategySheet()}
              disabled={!selection.length || !data?.broker.online}
              title="Enable or disable independent DUM behaviors for the selected units"
            >
              <span>Σ</span>
              <small>Set strategy</small>
            </button>
            <div className="order-buttons">
              {ACTIONS.map((action) => (
                <button
                  key={action.id}
                  onClick={() => openOrder(action.id)}
                  disabled={!selection.length || !data?.broker.online}
                  title={action.hint}
                >
                  <span>{action.glyph}</span>
                  <small>{action.label}</small>
                </button>
              ))}
            </div>
          </div>
            </>
          )}
        </section>

        <aside className="intel-panel panel-frame">
          <div className="panel-title-row">
            <div><p className="eyebrow">Field reports</p><h2>Command ledger</h2></div>
            <span className="live-pill">Live</span>
          </div>

          <div className="fleet-readiness">
            <div className="readiness-ring" style={{ "--ready": `${data?.fleet.length ? Math.round(((data.fleet.length - (data.needsAttention || 0)) / data.fleet.length) * 100) : 0}%` } as React.CSSProperties}>
              <strong>{data?.fleet.length ? Math.round(((data.fleet.length - (data.needsAttention || 0)) / data.fleet.length) * 100) : 0}%</strong>
              <span>ready</span>
            </div>
            <div><strong>Company readiness</strong><span>{workingCount} deployed · {data?.stalledCount || 0} stalled</span></div>
          </div>

          <div className="ledger-list">
            {[...activity, ...derivedSignals].slice(0, 8).map((entry) => (
              <article key={entry.id} className={`ledger-entry ${entry.kind}`}>
                <i />
                <div><strong>{entry.title}</strong><span>{entry.detail}</span><small>{entry.time}</small></div>
              </article>
            ))}
            {!activity.length && !derivedSignals.length ? (
              <div className="empty-ledger">Field reports will appear as the company checks in.</div>
            ) : null}
          </div>

          <div className="boundary-note">
            <span>Localhost control plane</span>
            <p>This interface is bound to this machine. Full fleet controls stay behind that boundary; credentials and sessions remain in the harness broker.</p>
          </div>
        </aside>
      </section>

      {pendingAction ? (
        <div className="order-overlay" role="presentation" onMouseDown={() => !issuing && setPendingAction(null)}>
          <section className="order-sheet" role="dialog" aria-modal="true" aria-labelledby="order-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-order" onClick={() => setPendingAction(null)} disabled={issuing} aria-label="Close">×</button>
            <p className="eyebrow">Issue company order</p>
            <h2 id="order-title">{ACTIONS.find((action) => action.id === pendingAction)?.label} {selection.length === 1 ? "unit" : `${selection.length} units`}</h2>
            <p className="order-explainer">{ACTIONS.find((action) => action.id === pendingAction)?.hint}. The harness will pace each unit and report the result.</p>

            {pendingAction === "march" ? (
              <label className="order-field"><span>Destination room</span><input autoFocus value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="e.g. Yonder Inn of Jasper" /></label>
            ) : null}
            {pendingAction === "farm" ? (
              <>
                <label className="order-field"><span>Creature to hunt</span><input autoFocus value={hunt} onChange={(event) => setHunt(event.target.value)} placeholder="e.g. spider" /></label>
                <label className="roam-toggle"><input type="checkbox" checked={roam} onChange={(event) => setRoam(event.target.checked)} /><span><strong>Roam for targets</strong><small>May move through up to six neighbouring rooms.</small></span></label>
              </>
            ) : null}

            <div className="order-units">
              {selectedUnits.slice(0, 8).map((unit) => <span key={unit.agent}><i>{initials(unit.character)}</i>{unit.character}</span>)}
              {selectedUnits.length > 8 ? <span>+{selectedUnits.length - 8} more</span> : null}
            </div>
            <div className="order-actions">
              <button className="secondary-button" onClick={() => setPendingAction(null)} disabled={issuing}>Cancel</button>
              <button
                className="primary-button"
                onClick={() => void issueOrder()}
                disabled={issuing || (pendingAction === "march" && !destination.trim()) || (pendingAction === "farm" && !hunt.trim())}
              >
                {issuing ? "Dispatching…" : "Issue orders"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {strategySheetOpen ? (
        <div className="order-overlay" role="presentation" onMouseDown={() => !strategySaving && setStrategySheetOpen(false)}>
          <section className="order-sheet strategy-sheet" role="dialog" aria-modal="true" aria-labelledby="strategy-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-order" onClick={() => setStrategySheetOpen(false)} disabled={strategySaving} aria-label="Close">×</button>
            <p className="eyebrow">DUM behavior control</p>
            <h2 id="strategy-title">Set strategy for {selection.length === 1 ? "1 unit" : `${selection.length} units`}</h2>
            <p className="order-explainer">Each behavior is independent. Mixed means only part of the current selection has it enabled; changing it applies that one behavior to every selected unit without disturbing the others.</p>

            {strategyLoading ? <div className="strategy-loading">Reading live DUM assignments…</div> : null}
            {strategyError ? <div className="strategy-error" role="alert">{strategyError}</div> : null}
            {!strategyLoading ? (
              <div className="strategy-groups">
                {strategyGroups.map(([group, strategies]) => (
                  <section className="strategy-group" key={group}>
                    <div className="strategy-group-title"><span>{group}</span><small>{strategies[0]?.requirements[0]}</small></div>
                    {strategies.map((strategy) => {
                      const state = strategyStates[strategy.id]?.state || "none";
                      return (
                        <button
                          type="button"
                          key={strategy.id}
                          className={`strategy-option ${state}`}
                          aria-pressed={state === "all"}
                          onClick={() => toggleStrategy(strategy)}
                        >
                          <i aria-hidden="true">{state === "all" ? "✓" : state === "some" ? "—" : ""}</i>
                          <span>
                            <strong>{strategy.title}</strong>
                            <small>{strategy.purpose}</small>
                            <em>{strategy.description}</em>
                            <b>{strategy.requirements.join(" · ")}</b>
                          </span>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
            ) : null}

            <div className="order-units">
              {selectedUnits.slice(0, 8).map((unit) => <span key={unit.agent}><i>{initials(unit.character)}</i>{unit.character}</span>)}
              {selectedUnits.length > 8 ? <span>+{selectedUnits.length - 8} more</span> : null}
            </div>
            <div className="order-actions">
              <button className="secondary-button" onClick={() => setStrategySheetOpen(false)} disabled={strategySaving}>Cancel</button>
              <button className="primary-button" onClick={() => void saveStrategies()} disabled={strategySaving || strategyLoading || Boolean(strategyError)}>
                {strategySaving ? "Saving…" : Object.keys(strategyChanges).length ? "Apply strategy changes" : "Done"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
