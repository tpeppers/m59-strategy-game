import { callBrokerTool } from "@/lib/m59-broker";

type LookPayload = {
  room?: { num?: number; name?: string };
  you?: { col?: number; row?: number; facing?: string; facing_degrees?: number };
  objects?: Array<{
    id?: number;
    name?: string;
    col?: number;
    row?: number;
    is_player?: boolean;
    can?: unknown;
  }>;
};

function cleanAgents(searchParams: URLSearchParams) {
  return [...new Set(searchParams.getAll("agent"))]
    .filter((agent) => /^[a-zA-Z0-9_-]{1,64}$/.test(agent))
    .slice(0, 40);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomNum = Number(url.searchParams.get("room"));
  const agents = cleanAgents(url.searchParams);
  if (!Number.isInteger(roomNum) || roomNum <= 0 || !agents.length) {
    return Response.json({ error: "A room and at least one fleet agent are required" }, { status: 400 });
  }

  const reports = await Promise.all(
    agents.map(async (agent) => {
      try {
        const look = (await callBrokerTool("look", { agent, cached: true })) as LookPayload;
        if (look.room?.num !== roomNum || !Number.isFinite(look.you?.col) || !Number.isFinite(look.you?.row)) {
          return null;
        }
        const monsters = (look.objects || [])
          .filter(
            (object) =>
              object.is_player !== true &&
              Array.isArray(object.can) &&
              object.can.includes("attack") &&
              Number.isFinite(object.id) &&
              Number.isFinite(object.col) &&
              Number.isFinite(object.row) &&
              typeof object.name === "string",
          )
          .map((object) => ({
            id: object.id as number,
            name: (object.name as string).slice(0, 100),
            col: object.col as number,
            row: object.row as number,
          }));
        return {
          position: {
            agent,
            roomNum: look.room.num,
            room: look.room.name || null,
            col: look.you?.col,
            row: look.you?.row,
            facing: look.you?.facing || null,
            facingDegrees: look.you?.facing_degrees ?? null,
          },
          monsters,
        };
      } catch {
        return null;
      }
    }),
  );

  const validReports = reports.filter((report) => report !== null);
  const monstersById = new Map<
    number,
    { id: number; name: string; col: number; row: number; seenBy: string[] }
  >();
  for (const report of validReports) {
    for (const monster of report.monsters) {
      const known = monstersById.get(monster.id);
      if (known) {
        known.col = monster.col;
        known.row = monster.row;
        known.seenBy.push(report.position.agent);
      } else {
        monstersById.set(monster.id, {
          ...monster,
          seenBy: [report.position.agent],
        });
      }
    }
  }

  return Response.json({
    roomNum,
    positions: validReports.map((report) => report.position),
    monsters: [...monstersById.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    ),
    refreshedAt: new Date().toISOString(),
    source: "broker cached perception",
  });
}
