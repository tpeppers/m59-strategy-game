const DEFAULT_BROKER_URL = "http://127.0.0.1:8901";

type JsonObject = Record<string, unknown>;

type McpContent = {
  type?: string;
  text?: string;
};

type McpResponse = {
  error?: { code?: number; message?: string; data?: unknown };
  result?: {
    isError?: boolean;
    content?: McpContent[];
  };
};

export type FleetUnit = {
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
  learning: {
    progress: {
      target: string | null;
      label: string | null;
      source: string | null;
      current_level: number | null;
      next_level: number | null;
      points: number | null;
      ready_to_learn: boolean;
    } | null;
    planned: {
      configured: number;
      ready: number;
      next: {
        name: string;
        kind: string | null;
        level: number | null;
        price: number | null;
        expected_buyable: boolean;
        teacher: { name: string | null; room: number | null } | null;
      } | null;
    } | null;
  } | null;
  needs_operator: boolean | string | null;
  time: {
    fighting_s: number;
    recovering_s: number;
    travelling_s: number;
    trading_s: number;
    stalled_s: number;
    active_s: number;
  } | null;
  autopilot: {
    mode?: string;
    running?: boolean;
    kills?: number;
  } | null;
};

function brokerUrl() {
  return (process.env.M59_BROKER_URL || DEFAULT_BROKER_URL).replace(/\/$/, "");
}

function messageFromContent(content: McpContent[] | undefined) {
  return content?.find((item) => item.type === "text" && item.text)?.text;
}

function parseTextPayload(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function getBrokerHealth() {
  const response = await fetch(`${brokerUrl()}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Broker health returned ${response.status}`);
  return (await response.json()) as JsonObject;
}

export async function callBrokerTool(
  name: string,
  args: JsonObject,
  timeout = 90000,
) {
  const response = await fetch(`${brokerUrl()}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) throw new Error(`Broker returned ${response.status}`);
  const envelope = (await response.json()) as McpResponse;
  if (envelope.error) {
    throw new Error(envelope.error.message || `MCP error ${envelope.error.code}`);
  }

  const text = messageFromContent(envelope.result?.content);
  if (envelope.result?.isError) {
    throw new Error(text || `${name} failed`);
  }
  return parseTextPayload(text);
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

export function toSafeFleetUnit(value: unknown): FleetUnit | null {
  if (!value || typeof value !== "object") return null;
  const row = value as JsonObject;
  if (typeof row.agent !== "string" || typeof row.character !== "string") {
    return null;
  }
  const autopilot =
    row.autopilot && typeof row.autopilot === "object"
      ? (row.autopilot as JsonObject)
      : null;
  const learning = row.learning && typeof row.learning === "object"
    ? row.learning as JsonObject : null;
  const progress = learning?.progress && typeof learning.progress === "object"
    ? learning.progress as JsonObject : null;
  const planned = learning?.planned && typeof learning.planned === "object"
    ? learning.planned as JsonObject : null;
  const next = planned?.next && typeof planned.next === "object"
    ? planned.next as JsonObject : null;
  const teacher = next?.teacher && typeof next.teacher === "object"
    ? next.teacher as JsonObject : null;

  return {
    agent: row.agent,
    character: row.character,
    room: nullableString(row.room) || "Unknown territory",
    room_num: nullableNumber(row.room_num),
    health: nullableString(row.health) || "—",
    mana: nullableString(row.mana) || "—",
    level: nullableNumber(row.level),
    vigor: nullableNumber(row.vigor),
    vigor_of: nullableNumber(row.vigor_of),
    has_weapon: nullableBoolean(row.has_weapon),
    has_food: nullableBoolean(row.has_food),
    carrying: nullableNumber(row.carrying),
    reagents: nullableNumber(row.reagents),
    activity: nullableString(row.activity),
    busy: nullableString(row.busy),
    stalled:
      typeof row.stalled === "string" || typeof row.stalled === "boolean"
        ? row.stalled
        : null,
    strategy: nullableString(row.strategy),
    learning: learning ? {
      progress: progress ? {
        target: nullableString(progress.target),
        label: nullableString(progress.label),
        source: nullableString(progress.source),
        current_level: nullableNumber(progress.current_level),
        next_level: nullableNumber(progress.next_level),
        points: nullableNumber(progress.points),
        ready_to_learn: progress.ready_to_learn === true,
      } : null,
      planned: planned ? {
        configured: nullableNumber(planned.configured) || 0,
        ready: nullableNumber(planned.ready) || 0,
        next: next && typeof next.name === "string" ? {
          name: next.name,
          kind: nullableString(next.kind),
          level: nullableNumber(next.level),
          price: nullableNumber(next.price),
          expected_buyable: next.expected_buyable === true,
          teacher: teacher ? {
            name: nullableString(teacher.name), room: nullableNumber(teacher.room),
          } : null,
        } : null,
      } : null,
    } : null,
    needs_operator:
      typeof row.needs_operator === "string" ||
      typeof row.needs_operator === "boolean"
        ? row.needs_operator
        : null,
    time: row.time && typeof row.time === "object"
      ? {
          fighting_s: nullableNumber((row.time as JsonObject).fighting_s) || 0,
          recovering_s: nullableNumber((row.time as JsonObject).recovering_s) || 0,
          travelling_s: nullableNumber((row.time as JsonObject).travelling_s) || 0,
          trading_s: nullableNumber((row.time as JsonObject).trading_s) || 0,
          stalled_s: nullableNumber((row.time as JsonObject).stalled_s) || 0,
          active_s: nullableNumber((row.time as JsonObject).active_s) || 0,
        }
      : null,
    autopilot: autopilot
      ? {
          mode: nullableString(autopilot.mode) || undefined,
          running:
            typeof autopilot.running === "boolean"
              ? autopilot.running
              : undefined,
          kills: nullableNumber(autopilot.kills) ?? undefined,
        }
      : null,
  };
}
