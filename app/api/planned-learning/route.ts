import { callBrokerTool } from "@/lib/m59-broker";
import { isLocalCommandRequest } from "@/lib/local-access";

type LearningRequest = { agents?: unknown[] };

export async function POST(request: Request) {
  if (!isLocalCommandRequest(request, true)) {
    return Response.json(
      { error: "Planned learning is accepted only from the local command post." },
      { status: 403 },
    );
  }
  let payload: LearningRequest;
  try { payload = await request.json() as LearningRequest; }
  catch { return Response.json({ error: "Invalid planned-learning payload" }, { status: 400 }); }
  const agents = [...new Set((payload.agents || [])
    .filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)))];
  if (!agents.length || agents.length > 40) {
    return Response.json({ error: "Choose between 1 and 40 eligible fleet members" }, { status: 400 });
  }
  try {
    return Response.json(await callBrokerTool("buy_next_planned_skills", { agents }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The learning errand was refused" },
      { status: 502 },
    );
  }
}
