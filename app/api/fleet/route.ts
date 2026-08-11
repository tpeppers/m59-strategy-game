import {
  callBrokerTool,
  getBrokerHealth,
  toSafeFleetUnit,
} from "@/lib/m59-broker";

export async function GET() {
  try {
    const [health, snapshot] = await Promise.all([
      getBrokerHealth(),
      callBrokerTool("fleet", {}),
    ]);
    const payload =
      snapshot && typeof snapshot === "object"
        ? (snapshot as Record<string, unknown>)
        : {};
    const rows = Array.isArray(payload.fleet) ? payload.fleet : [];
    const fleet = rows.map(toSafeFleetUnit).filter((unit) => unit !== null);

    return Response.json({
      broker: {
        online: true,
        fleet:
          typeof health.fleet === "string" ? health.fleet : "default",
        pid: typeof health.pid === "number" ? health.pid : null,
      },
      fleet,
      stalledCount:
        typeof payload.stalled_count === "number" ? payload.stalled_count : 0,
      needsAttention:
        typeof payload.needs_attention === "number"
          ? payload.needs_attention
          : 0,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({
      broker: { online: false, fleet: null, pid: null },
      fleet: [],
      stalledCount: 0,
      needsAttention: 0,
      refreshedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Broker unavailable",
    });
  }
}

