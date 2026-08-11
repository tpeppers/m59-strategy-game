import { isLocalCommandRequest } from "@/lib/local-access";

const DUM_CONTROL_URL = process.env.M59_DUM_CONTROL_URL || "http://127.0.0.1:8916";

function cleanAgent(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : null;
}

function selectedAgents(values: unknown[]) {
  return [...new Set(values.map(cleanAgent).filter(Boolean))] as string[];
}

async function dum(path: string, init?: RequestInit) {
  const response = await fetch(`${DUM_CONTROL_URL}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error || "DUM strategy control refused the request");
  return body;
}

export async function GET(request: Request) {
  if (!isLocalCommandRequest(request))
    return Response.json({ error: "Strategies are available only from the local command post." }, { status: 403 });
  const agents = selectedAgents(new URL(request.url).searchParams.getAll("agent"));
  if (!agents.length || agents.length > 40)
    return Response.json({ error: "Choose between 1 and 40 fleet members" }, { status: 400 });
  try {
    return Response.json(await dum(`/strategies?agents=${encodeURIComponent(agents.join(","))}`));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DUM strategy control is unavailable" },
      { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!isLocalCommandRequest(request, true))
    return Response.json({ error: "Strategies may be changed only from the local command post." }, { status: 403 });
  try {
    const payload = await request.json() as { agents?: unknown[]; changes?: Record<string, unknown> };
    const agents = selectedAgents(payload.agents || []);
    if (!agents.length || agents.length > 40)
      return Response.json({ error: "Choose between 1 and 40 fleet members" }, { status: 400 });
    const changes = Object.fromEntries(Object.entries(payload.changes || {}).filter(([, value]) =>
      typeof value === "boolean"));
    if (!Object.keys(changes).length)
      return Response.json({ error: "Choose at least one strategy change" }, { status: 400 });
    return Response.json(await dum("/strategies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents, changes }),
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DUM strategy control is unavailable" },
      { status: 503 });
  }
}
