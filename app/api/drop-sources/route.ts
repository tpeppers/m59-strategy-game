import { callBrokerTool } from "@/lib/m59-broker";
import { isLocalCommandRequest } from "@/lib/local-access";

export async function GET(request: Request) {
  if (!isLocalCommandRequest(request))
    return Response.json({ error: "Drop metadata is available only from the local command post." }, { status: 403 });
  try {
    const items = [...new Set(new URL(request.url).searchParams.getAll("item")
      .map(item => item.trim()).filter(Boolean))].slice(0, 24);
    if (!items.length) return Response.json(await callBrokerTool("drop_sources", {}));
    const matches = await Promise.all(items.map(async item => {
      const result = await callBrokerTool("drop_sources", { item, limit: 24 });
      return result && typeof result === "object" ? result : { item, sources: [] };
    }));
    return Response.json({ items, matches });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Drop metadata is unavailable" },
      { status: 503 });
  }
}
