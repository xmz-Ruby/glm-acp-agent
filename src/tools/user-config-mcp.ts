import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer, McpServerHttp, McpServerStdio } from "@agentclientprotocol/sdk";

/**
 * Load the MCP servers registered for this agent in `~/.glm/acp-mcp.json`
 * (top-level `mcpServers`, Claude-shaped entries; `enabled: false` skips an
 * entry). An unreadable or invalid file yields an empty list so a broken
 * config never blocks session creation.
 */
export function loadUserConfigMcpServers(configPath: string = join(homedir(), ".glm", "acp-mcp.json")): McpServer[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[MCP] skipping invalid user MCP config ${configPath}: ${err}\n`);
    return [];
  }
  const servers = isRecord(root) ? root["mcpServers"] : undefined;
  if (!isRecord(servers)) return [];

  const out: McpServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || entry["enabled"] === false) continue;
    if (entry["type"] === "http" && typeof entry["url"] === "string") {
      const http: McpServerHttp & { type: "http" } = {
        type: "http",
        name,
        url: entry["url"],
        headers: headerList(entry["headers"]),
      };
      out.push(http);
      continue;
    }
    if (typeof entry["command"] === "string") {
      const stdio: McpServerStdio = {
        name,
        command: entry["command"],
        args: stringList(entry["args"]),
        env: envList(entry["env"]),
      };
      out.push(stdio);
      continue;
    }
    process.stderr.write(`[MCP] skip user MCP server '${name}': needs url (http) or command (stdio)\n`);
  }
  return out;
}

/**
 * Merge user-config servers under the wire-provided list; a wire server
 * with the same name wins so the ACP client stays authoritative.
 */
export function mergeUserConfigMcpServers(wireServers: ReadonlyArray<McpServer>): McpServer[] {
  const userServers = loadUserConfigMcpServers();
  if (userServers.length === 0) return [...wireServers];
  const wireNames = new Set(wireServers.map((server) => server.name));
  return [...wireServers, ...userServers.filter((server) => !wireNames.has(server.name))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerList(value: unknown): McpServerHttp["headers"] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, value: v as string }));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function envList(value: unknown): McpServerStdio["env"] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, value: v as string }));
}
