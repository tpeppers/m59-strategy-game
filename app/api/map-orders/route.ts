import { callBrokerTool, toSafeFleetUnit } from "@/lib/m59-broker";
import { isLocalCommandRequest } from "@/lib/local-access";

type MapOrderRequest = {
  kind?: "move" | "exit";
  agents?: string[];
  room?: number;
  col?: number;
  row?: number;
  to?: number;
  exitKind?: "door" | "edge";
  exitCol?: number;
  exitRow?: number;
  direction?: "north" | "south" | "east" | "west";
};

function cleanAgent(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
    ? value
    : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

async function stopKeeper(agent: string) {
  try {
    await callBrokerTool("autopilot", { agent, action: "stop" });
  } catch {
    // A direct command still applies when no keeper was running.
  }
}

async function takeDirectControl(agent: string) {
  await stopKeeper(agent);
  try {
    await callBrokerTool("cancel_movement", { agent });
  } catch {
    // Older running brokers do not expose the hard-stop tool. The keeper stop
    // still prevents another pass; the direct command follows the current one.
  }
}

export async function POST(request: Request) {
  if (!isLocalCommandRequest(request, true)) {
    return Response.json(
      { error: "Map orders are accepted only from the local command post." },
      { status: 403 },
    );
  }

  let payload: MapOrderRequest;
  try {
    payload = (await request.json()) as MapOrderRequest;
  } catch {
    return Response.json({ error: "Invalid map order payload" }, { status: 400 });
  }

  if (payload.kind !== "move" && payload.kind !== "exit") {
    return Response.json({ error: "Unknown map order" }, { status: 400 });
  }

  const agents = [...new Set((payload.agents || []).map(cleanAgent).filter(Boolean))] as string[];
  const room = positiveInteger(payload.room);
  if (!room || !agents.length || agents.length > 40) {
    return Response.json(
      { error: "Choose between 1 and 40 units from an open local map" },
      { status: 400 },
    );
  }

  const snapshot = await callBrokerTool("fleet", {});
  const envelope = snapshot && typeof snapshot === "object"
    ? (snapshot as Record<string, unknown>)
    : {};
  const fleet = Array.isArray(envelope.fleet)
    ? envelope.fleet.map(toSafeFleetUnit).filter((unit) => unit !== null)
    : [];
  const currentRoomAgents = new Set(
    fleet.filter((unit) => unit.room_num === room).map((unit) => unit.agent),
  );
  const eligible = agents.filter((agent) => currentRoomAgents.has(agent));
  if (!eligible.length) {
    return Response.json(
      { error: "Those units are no longer in the open zone" },
      { status: 409 },
    );
  }

  const col = positiveInteger(payload.col);
  const row = positiveInteger(payload.row);
  const to = positiveInteger(payload.to);
  if (payload.kind === "move" && (!col || !row)) {
    return Response.json({ error: "A valid map square is required" }, { status: 400 });
  }
  if (payload.kind === "exit" && !to) {
    return Response.json({ error: "That exit has no known destination" }, { status: 400 });
  }

  const settled = await Promise.allSettled(
    eligible.map(async (agent) => {
      await takeDirectControl(agent);
      if (payload.kind === "exit") {
        const exactDoor = payload.exitKind === "door" &&
          Number.isInteger(payload.exitCol) && Number.isInteger(payload.exitRow);
        const direction = payload.exitKind === "edge" &&
          ["north", "south", "east", "west"].includes(payload.direction || "")
          ? payload.direction
          : undefined;
        return callBrokerTool(
          "go_through",
          {
            agent,
            to: to as number,
            ...(exactDoor ? { col: payload.exitCol, row: payload.exitRow } : {}),
            ...(direction ? { direction } : {}),
          },
          180000,
        );
      }
      return callBrokerTool(
        "walk_to",
        { agent, col: col as number, row: row as number, max_steps: 120 },
        150000,
      );
    }),
  );

  const results = settled.map((result, index) => {
    if (result.status === "rejected") {
      return {
        agent: eligible[index],
        ok: false,
        message: result.reason instanceof Error ? result.reason.message : "Order failed",
      };
    }
    if (payload.kind === "exit") {
      const report = result.value && typeof result.value === "object"
        ? result.value as Record<string, unknown>
        : {};
      const ok = report.left === true;
      return {
        agent: eligible[index],
        ok,
        message: ok
          ? `Entered ${typeof report.arrived_in === "string" ? report.arrived_in : "the next zone"}`
          : typeof report.reason === "string"
            ? report.reason
            : typeof report.note === "string" ? report.note : "The selected exit did not open",
      };
    }
    return { agent: eligible[index], ok: true, message: "Order acknowledged" };
  });

  return Response.json({
    kind: payload.kind,
    results,
    accepted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    skipped: agents.length - eligible.length,
  });
}
