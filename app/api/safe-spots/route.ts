import { callBrokerTool } from "@/lib/m59-broker";

type SafeSpotRecord = Record<string, unknown>;

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function cleanRecord(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as SafeSpotRecord;
  const col = finiteNumber(record.col);
  const row = finiteNumber(record.row);
  if (col == null || row == null) return null;
  const held = nonnegativeInteger(record.held);
  const failed = nonnegativeInteger(record.failed);
  const verified = record.verified === true;
  return {
    col,
    row,
    held,
    failed,
    heldSeconds: nonnegativeInteger(record.held_seconds),
    damageTaken: nonnegativeInteger(record.damage_taken),
    mostAttackers: nonnegativeInteger(record.most_attackers),
    exactX: finiteNumber(record.x),
    exactY: finiteNumber(record.y),
    verified,
    verifiedBy: typeof record.verified_by === "string" ? record.verified_by.slice(0, 80) : null,
    verifiedNote: typeof record.verified_note === "string" ? record.verified_note.slice(0, 160) : null,
    observedAt: finiteNumber(record.at),
    verdict: verified ? "verified" : failed > 0 ? "failed" : held > 0 ? "holds" : "untested",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const room = Number(url.searchParams.get("room"));
  const agent = url.searchParams.get("agent") || "";
  if (!Number.isInteger(room) || room <= 0 || !/^[a-zA-Z0-9_-]{1,64}$/.test(agent)) {
    return Response.json({ error: "A room and reporting fleet unit are required" }, { status: 400 });
  }

  try {
    const payload = await callBrokerTool("safe_spots", { agent, limit: 1 }, 30000);
    const envelope = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    const reportedRoom = envelope.room && typeof envelope.room === "object"
      ? (envelope.room as Record<string, unknown>).num
      : null;
    if (reportedRoom !== room) {
      return Response.json({ error: "That unit is no longer reporting from this zone" }, { status: 409 });
    }
    const spots = Array.isArray(envelope.known)
      ? envelope.known.map(cleanRecord).filter((spot) => spot !== null)
      : [];
    return Response.json({
      room,
      spots,
      counts: {
        verified: spots.filter((spot) => spot.verdict === "verified").length,
        holds: spots.filter((spot) => spot.verdict === "holds").length,
        failed: spots.filter((spot) => spot.verdict === "failed").length,
        untested: spots.filter((spot) => spot.verdict === "untested").length,
      },
      refreshedAt: new Date().toISOString(),
      source: "broker safe-spot ledger",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Safe-spot ledger unavailable" },
      { status: 503 },
    );
  }
}
