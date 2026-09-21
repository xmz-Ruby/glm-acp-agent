/**
 * GLM Coding Plan quota lookup for the built-in `/usage` command.
 *
 * Calls the same monitor endpoint Z.AI's official `glm-plan-usage` plugin
 * uses: `GET {host}/api/monitor/usage/quota/limit` with the raw API key in
 * the Authorization header (no Bearer prefix). The path is identical on the
 * international (api.z.ai) and China (open.bigmodel.cn) hosts, so the host
 * is derived from the LLM client's base URL.
 */
import { debug } from "./logger.js";

/** One entry of the `limits` array the quota endpoint returns. */
export interface PlanUsageLimit {
  /** `TOKENS_LIMIT` (model credits) or `TIME_LIMIT` (MCP tool calls). */
  type: string;
  /** With `number`, identifies the window: 3:5 = 5 hours, 6:1 = 1 week, 5:1 = 1 month. */
  unit: number;
  number: number;
  /** Percentage of the window already consumed. */
  percentage?: number;
  /** Epoch milliseconds; when the window resets. */
  nextResetTime?: number;
  /** Total allowance (TIME_LIMIT only). */
  usage?: number;
  /** Consumed amount (TIME_LIMIT only). */
  currentValue?: number;
  remaining?: number;
  usageDetails?: Array<{ modelCode: string; usage: number }>;
}

export interface PlanUsage {
  /** Plan tier, e.g. "pro". */
  level?: string;
  limits: PlanUsageLimit[];
}

/** Origin of the quota endpoint: same host the LLM client talks to. */
export function planUsageBaseUrl(): string {
  const configured = process.env["ACP_GLM_BASE_URL"];
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // An explicitly configured base URL we cannot parse is the LLM
      // client's problem to report; fall back to the default host.
    }
  }
  return "https://api.z.ai";
}

export async function fetchPlanUsage(
  apiKey: string,
  signal?: AbortSignal
): Promise<PlanUsage> {
  const url = `${planUsageBaseUrl()}/api/monitor/usage/quota/limit`;
  debug(`fetchPlanUsage: ${url}`);
  const response = await fetch(url, {
    headers: {
      Authorization: apiKey,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    },
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body) as {
    code?: number;
    msg?: string;
    data?: { level?: string; limits?: PlanUsageLimit[] };
  };
  if (parsed.code !== undefined && parsed.code !== 200) {
    throw new Error(`endpoint error ${parsed.code}: ${parsed.msg ?? "unknown"}`);
  }
  if (!parsed.data || !Array.isArray(parsed.data.limits)) {
    throw new Error("response contained no limits array");
  }
  return { level: parsed.data.level, limits: parsed.data.limits };
}

function windowKey(limit: PlanUsageLimit): string {
  return `${limit.unit}:${limit.number}`;
}

function formatReset(epochMs: number | undefined): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "unknown";
  return new Date(epochMs).toLocaleString();
}

/** Render the quota snapshot as the markdown the agent messages back. */
export function formatPlanUsage(plan: PlanUsage): string {
  const tier = plan.level ? plan.level.toUpperCase() : "unknown tier";
  const lines: string[] = [`**GLM Coding Plan - ${tier}**`];
  for (const limit of plan.limits) {
    const resets = `resets ${formatReset(limit.nextResetTime)}`;
    if (limit.type === "TOKENS_LIMIT") {
      const label =
        windowKey(limit) === "3:5" ? "5-hour token quota" : "weekly token quota";
      const used = typeof limit.percentage === "number" ? `${limit.percentage}%` : "?";
      const left =
        typeof limit.percentage === "number" ? `${100 - limit.percentage}%` : "?";
      lines.push(`- ${label}: **${used} used, ${left} left** - ${resets}`);
    } else if (limit.type === "TIME_LIMIT") {
      const total = limit.usage ?? 0;
      const current = limit.currentValue ?? 0;
      lines.push(`- MCP tools (monthly): **${current}/${total} used** - ${resets}`);
      const details = (limit.usageDetails ?? [])
        .filter((d) => d.usage > 0)
        .map((d) => `${d.modelCode} ${d.usage}`);
      if (details.length > 0) lines.push(`  - ${details.join(" / ")}`);
    }
  }
  return lines.join("\n");
}
