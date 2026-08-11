import { callBrokerTool } from "@/lib/m59-broker";
import { isLocalCommandRequest } from "@/lib/local-access";

type OrderAction = "march" | "farm" | "survive" | "hold" | "stop" | "equip";

type OrderRequest = {
  action?: OrderAction;
  agents?: string[];
  options?: {
    destination?: string;
    hunt?: string;
    roam?: boolean;
  };
};

const ALLOWED_ACTIONS = new Set<OrderAction>([
  "march",
  "farm",
  "survive",
  "hold",
  "stop",
  "equip",
]);

function cleanAgent(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
    ? value
    : null;
}

function textOption(value: unknown, max = 100) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

async function runOrder(agent: string, action: OrderAction, options: OrderRequest["options"]) {
  switch (action) {
    case "march": {
      const destination = textOption(options?.destination);
      if (!destination) throw new Error("A destination is required");
      return callBrokerTool("travel", {
        agent,
        to: destination,
        background: true,
      });
    }
    case "farm": {
      const hunt = textOption(options?.hunt);
      if (!hunt) throw new Error("A creature to hunt is required");
      return callBrokerTool("autopilot", {
        agent,
        action: "start",
        mode: "farm",
        hunt,
        roam: options?.roam === true,
      });
    }
    case "survive":
      return callBrokerTool("autopilot", {
        agent,
        action: "start",
        mode: "survive",
      });
    case "hold":
      return callBrokerTool("autopilot", {
        agent,
        action: "start",
        mode: "idle",
      });
    case "stop":
      return callBrokerTool("autopilot", { agent, action: "stop" });
    case "equip":
      return callBrokerTool("equip_best", { agent });
  }
}

export async function POST(request: Request) {
  if (!isLocalCommandRequest(request, true)) {
    return Response.json(
      { error: "Fleet orders are accepted only from the local command post." },
      { status: 403 },
    );
  }

  let payload: OrderRequest;
  try {
    payload = (await request.json()) as OrderRequest;
  } catch {
    return Response.json({ error: "Invalid order payload" }, { status: 400 });
  }

  if (!payload.action || !ALLOWED_ACTIONS.has(payload.action)) {
    return Response.json({ error: "Unknown order" }, { status: 400 });
  }

  const agents = [...new Set((payload.agents || []).map(cleanAgent).filter(Boolean))] as string[];
  if (!agents.length || agents.length > 40) {
    return Response.json(
      { error: "Choose between 1 and 40 fleet members" },
      { status: 400 },
    );
  }

  const results: Array<{ agent: string; ok: boolean; message: string }> = [];
  for (const agent of agents) {
    try {
      await runOrder(agent, payload.action, payload.options);
      results.push({ agent, ok: true, message: "Order acknowledged" });
    } catch (error) {
      results.push({
        agent,
        ok: false,
        message: error instanceof Error ? error.message : "Order failed",
      });
    }
  }

  return Response.json({
    action: payload.action,
    results,
    accepted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  });
}
