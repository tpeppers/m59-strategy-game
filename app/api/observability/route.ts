import { isLocalCommandRequest } from "@/lib/local-access";

const DUM_CONTROL_URL = process.env.M59_DUM_CONTROL_URL || "http://127.0.0.1:8916";

export async function GET(request: Request) {
  if (!isLocalCommandRequest(request))
    return Response.json({ error: "Observability is available only from the local command post." }, { status: 403 });
  try {
    const response = await fetch(`${DUM_CONTROL_URL}/observability`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error || "DUM observability refused the request");
    return Response.json(body);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "DUM observability is unavailable" },
      { status: 503 });
  }
}
