import { formationTarget, MAX_FORMATION_OFFSET, type FormationSlot } from "@/lib/formations";
import {
  engageFormation,
  formationIsEngaged,
  releaseFormation,
} from "@/lib/formation-control";
import { callBrokerTool, toSafeFleetUnit, type FleetUnit } from "@/lib/m59-broker";
import { isLocalCommandRequest } from "@/lib/local-access";

type FormationRequest = {
  action?: "start" | "stop" | "tick" | "move";
  groupId?: string;
  revision?: number;
  leader?: string;
  agents?: string[];
  slots?: FormationSlot[];
  room?: number;
  anchor?: { col?: number; row?: number };
};

type LookPayload = {
  room?: { num?: number; name?: string; size?: { rows?: number; cols?: number } };
  you?: { col?: number; row?: number; facing_degrees?: number };
};

type Report = {
  agent: string;
  roomNum: number;
  room: string;
  col: number;
  row: number;
  facingDegrees: number;
  cols: number | null;
  rows: number | null;
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

function cleanGroupId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value)
    ? value
    : null;
}

function revisionNumber(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function cleanSlots(value: unknown, agents: Set<string>) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const agent = cleanAgent(row.agent);
    const dx = typeof row.dx === "number" && Number.isInteger(row.dx) ? row.dx : null;
    const dy = typeof row.dy === "number" && Number.isInteger(row.dy) ? row.dy : null;
    if (!agent || !agents.has(agent) || seen.has(agent) || dx == null || dy == null) return [];
    if (Math.abs(dx) > MAX_FORMATION_OFFSET || Math.abs(dy) > MAX_FORMATION_OFFSET) return [];
    seen.add(agent);
    return [{ agent, dx, dy }];
  });
}

async function fleetSnapshot() {
  const snapshot = await callBrokerTool("fleet", {});
  const envelope = snapshot && typeof snapshot === "object"
    ? (snapshot as Record<string, unknown>)
    : {};
  return Array.isArray(envelope.fleet)
    ? envelope.fleet.map(toSafeFleetUnit).filter((unit) => unit !== null)
    : [];
}

async function cachedReport(agent: string): Promise<Report | null> {
  try {
    const look = (await callBrokerTool("look", { agent, cached: true })) as LookPayload;
    if (
      !Number.isInteger(look.room?.num) ||
      !Number.isFinite(look.you?.col) ||
      !Number.isFinite(look.you?.row)
    ) return null;
    return {
      agent,
      roomNum: look.room?.num as number,
      room: look.room?.name || `Room ${look.room?.num}`,
      col: look.you?.col as number,
      row: look.you?.row as number,
      facingDegrees: Number.isFinite(look.you?.facing_degrees)
        ? (look.you?.facing_degrees as number)
        : 0,
      cols: Number.isInteger(look.room?.size?.cols) ? (look.room?.size?.cols as number) : null,
      rows: Number.isInteger(look.room?.size?.rows) ? (look.room?.size?.rows as number) : null,
    };
  } catch {
    return null;
  }
}

async function stopKeeper(agent: string) {
  try {
    await callBrokerTool("autopilot", { agent, action: "stop" });
  } catch {
    // No running keeper is already the desired state.
  }
}

async function cancelMovement(agent: string, controlToken?: string) {
  try {
    await callBrokerTool("cancel_movement", {
      agent,
      ...(controlToken ? { control_token: controlToken } : {}),
    });
    return { agent, ok: true, message: "Movement interrupted" };
  } catch (error) {
    return {
      agent,
      ok: false,
      message: error instanceof Error ? error.message : "Movement cancellation unavailable",
    };
  }
}

function resultSummary(results: Array<{ agent: string; ok: boolean; message: string }>) {
  return {
    results,
    accepted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  };
}

async function moveToFormation(
  eligible: string[],
  slots: FormationSlot[],
  anchor: {
    col: number;
    row: number;
    facingDegrees: number;
    cols: number | null;
    rows: number | null;
  },
  stillEngaged: () => boolean,
  controlToken: string,
) {
  const slotByAgent = new Map(slots.map((slot) => [slot.agent, slot]));
  const settled = await Promise.allSettled(
    eligible.map(async (agent) => {
      if (!stillEngaged()) throw new Error("Formation was released");
      const slot = slotByAgent.get(agent);
      if (!slot) throw new Error("No formation slot assigned");
      await stopKeeper(agent);
      if (!stillEngaged()) throw new Error("Formation was released");
      const target = formationTarget(anchor, slot);
      return callBrokerTool(
        "walk_to",
        { agent, col: target.col, row: target.row, max_steps: 120, control_token: controlToken },
        150000,
      );
    }),
  );
  return resultSummary(settled.map((result, index) => ({
    agent: eligible[index],
    ok: result.status === "fulfilled",
    message: result.status === "fulfilled"
      ? "Formation position acknowledged"
      : result.reason instanceof Error ? result.reason.message : "Formation move failed",
  })));
}

export async function POST(request: Request) {
  if (!isLocalCommandRequest(request, true)) {
    return Response.json(
      { error: "Formation controls are accepted only from the local command post." },
      { status: 403 },
    );
  }

  let payload: FormationRequest;
  try {
    payload = (await request.json()) as FormationRequest;
  } catch {
    return Response.json({ error: "Invalid formation payload" }, { status: 400 });
  }
  if (!payload.action || !["start", "stop", "tick", "move"].includes(payload.action)) {
    return Response.json({ error: "Unknown formation action" }, { status: 400 });
  }

  const groupId = cleanGroupId(payload.groupId);
  const revision = revisionNumber(payload.revision);
  if (!groupId || revision == null) {
    return Response.json({ error: "Formation commands need a group id and revision" }, { status: 400 });
  }

  const agents = [...new Set((payload.agents || []).map(cleanAgent).filter(Boolean))] as string[];
  if (payload.action === "stop") {
    const released = releaseFormation(groupId, revision, agents);
    const controlToken = released.previousRevision == null
      ? undefined
      : `${groupId}:${released.previousRevision}`;
    const cancellations = await Promise.all(
      released.agents.map((agent) => cancelMovement(agent, controlToken)),
    );
    return Response.json({
      stopped: true,
      revision,
      ...resultSummary(cancellations),
      hardStopAvailable: cancellations.every((result) => result.ok),
    });
  }

  const agentSet = new Set(agents);
  const leader = cleanAgent(payload.leader);
  const slots = cleanSlots(payload.slots, agentSet);
  if (!leader || !agentSet.has(leader) || agents.length < 2 || agents.length > 40) {
    return Response.json({ error: "A formation needs a leader and 2 to 40 fleet members" }, { status: 400 });
  }
  if (slots.length !== agents.length || !slots.some((slot) => slot.agent === leader && slot.dx === 0 && slot.dy === 0)) {
    return Response.json({ error: "Every member needs one slot and the leader must occupy the origin" }, { status: 400 });
  }

  const fleet = await fleetSnapshot();
  const byAgent = new Map(fleet.map((unit) => [unit.agent, unit]));
  const eligible = agents.filter((agent) => byAgent.has(agent));
  if (!eligible.includes(leader)) {
    return Response.json({ error: "The group leader is not reporting" }, { status: 409 });
  }

  if (payload.action === "start") {
    if (!engageFormation(groupId, revision, eligible)) {
      return Response.json({ error: "A newer formation command has already replaced this one" }, { status: 409 });
    }
    const settled = await Promise.allSettled(eligible.map((agent) => stopKeeper(agent)));
    return Response.json({
      started: true,
      ...resultSummary(settled.map((result, index) => ({
        agent: eligible[index],
        ok: result.status === "fulfilled",
        message: result.status === "fulfilled" ? "Formation keeper engaged" : "Could not stop individual keeper",
      }))),
    });
  }

  const stillEngaged = () => formationIsEngaged(groupId, revision);
  if (!stillEngaged()) {
    return Response.json({ error: "This formation has been released" }, { status: 409 });
  }

  const reports = (await Promise.all(eligible.map(cachedReport))).filter(
    (report): report is Report => report !== null,
  );
  const reportByAgent = new Map(reports.map((report) => [report.agent, report]));
  const leaderReport = reportByAgent.get(leader);
  if (!leaderReport) {
    return Response.json({ error: "The leader has not reported a position yet" }, { status: 409 });
  }

  if (!stillEngaged()) {
    return Response.json({ error: "This formation was released while positions were being read" }, { status: 409 });
  }

  if (byAgent.get(leader)?.autopilot?.running) await stopKeeper(leader);

  if (payload.action === "move") {
    const room = positiveInteger(payload.room);
    const col = positiveInteger(payload.anchor?.col);
    const row = positiveInteger(payload.anchor?.row);
    if (!room || !col || !row || room !== leaderReport.roomNum) {
      return Response.json({ error: "The leader is no longer on that map" }, { status: 409 });
    }
    const local = eligible.filter((agent) => reportByAgent.get(agent)?.roomNum === room);
    return Response.json({
      action: "move",
      ...(await moveToFormation(local, slots, {
        col,
        row,
        facingDegrees: leaderReport.facingDegrees,
        cols: leaderReport.cols,
        rows: leaderReport.rows,
      }, stillEngaged, `${groupId}:${revision}`)),
      skipped: eligible.length - local.length,
    });
  }

  const slotByAgent = new Map(slots.map((slot) => [slot.agent, slot]));
  const corrections = eligible.filter((agent) => agent !== leader).map(async (agent) => {
    if (!stillEngaged()) return { agent, ok: false, message: "Formation released" };
    const unit = byAgent.get(agent) as FleetUnit;
    const report = reportByAgent.get(agent);
    const slot = slotByAgent.get(agent);
    if (!report || !slot) return { agent, ok: false, message: "Awaiting position report" };
    if (unit.autopilot?.running) await stopKeeper(agent);
    if (!stillEngaged()) return { agent, ok: false, message: "Formation released" };
    if (report.roomNum !== leaderReport.roomNum) {
      if (unit.busy) return { agent, ok: true, message: "Catching up between zones" };
      if (!stillEngaged()) return { agent, ok: false, message: "Formation released" };
      await callBrokerTool("travel", {
        agent,
        to: leaderReport.roomNum,
        max_hops: 3,
        background: true,
        control_token: `${groupId}:${revision}`,
      });
      return { agent, ok: true, message: `Following leader to ${leaderReport.room}` };
    }
    const target = formationTarget(leaderReport, slot);
    const distance = Math.hypot(target.col - report.col, target.row - report.row);
    if (distance <= 1) return { agent, ok: true, message: "Holding formation" };
    if (!stillEngaged()) return { agent, ok: false, message: "Formation released" };
    await callBrokerTool(
      "walk_to",
      {
        agent,
        col: target.col,
        row: target.row,
        max_steps: Math.min(8, Math.max(2, Math.ceil(distance) + 1)),
        control_token: `${groupId}:${revision}`,
      },
      15000,
    );
    return { agent, ok: true, message: "Corrected formation position" };
  });
  const settled = await Promise.allSettled(corrections);
  return Response.json({
    action: "tick",
    leader: leaderReport,
    ...resultSummary(settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : {
          agent: eligible.filter((agent) => agent !== leader)[index],
          ok: false,
          message: result.reason instanceof Error ? result.reason.message : "Formation correction failed",
        })),
  });
}
