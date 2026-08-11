import { callBrokerTool } from "@/lib/m59-broker";

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:8902";

function dashboardUrl() {
  return (process.env.M59_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

function errorPage(message: string) {
  const safe = message.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:2rem;background:#121714;color:#d8d3c4;font:14px/1.5 system-ui}
    div{max-width:520px;margin:10vh auto;padding:1.4rem;border:1px solid #554a35;background:#1a201d}
    h1{margin:0 0 .5rem;font:500 22px Georgia,serif}p{margin:0;color:#9a9f97}
  </style><div><h1>Unit dossier unavailable</h1><p>${safe}</p></div>`;
}

function sanitizeHeroPage(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<h2>Play as this character<\/h2>[\s\S]*?(?=<footer\b)/i, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(
      "</style>",
      `.back{display:none!important}.wrap{max-width:none!important}.launch{display:none!important}
       body{padding:1.1rem 1.25rem 3rem!important}footer{margin-top:1.5rem!important}</style>`,
    );
}

export async function GET(request: Request) {
  const agent = new URL(request.url).searchParams.get("agent") || "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agent)) {
    return new Response(errorPage("A valid fleet agent is required."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  try {
    const snapshot = await callBrokerTool("fleet", {});
    const payload = snapshot && typeof snapshot === "object"
      ? snapshot as Record<string, unknown>
      : {};
    const rows = Array.isArray(payload.fleet) ? payload.fleet : [];
    const row = rows.find((value) => {
      if (!value || typeof value !== "object") return false;
      return (value as Record<string, unknown>).agent === agent;
    }) as Record<string, unknown> | undefined;
    const character = typeof row?.character === "string" ? row.character : null;
    if (!character) throw new Error("That unit is not currently present in the fleet.");

    const response = await fetch(
      `${dashboardUrl()}/hero/${encodeURIComponent(character)}`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) throw new Error(`The read-only hero ledger returned ${response.status}.`);

    return new Response(sanitizeHeroPage(await response.text()), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        "x-frame-options": "SAMEORIGIN",
      },
    });
  } catch (error) {
    return new Response(
      errorPage(error instanceof Error ? error.message : "The broker did not return this dossier."),
      {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'self'",
          "x-frame-options": "SAMEORIGIN",
        },
      },
    );
  }
}
