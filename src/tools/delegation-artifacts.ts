import { existsSync } from "node:fs";

/**
 * Delegation reports reach the main session as text only: the Codeg broker
 * runs the sub-agent in a child session and get_delegation_status returns
 * just that child's report. The sub-agent's file writes therefore never show
 * up as main-session tool calls, so the client's per-reply "Files changed"
 * card (built from edit/write tool calls in this transcript) stays empty even
 * though files changed. These helpers mine the change list out of a report
 * and shape it as synthetic edit/write announcements the client can render —
 * display-only, never appended to the model history.
 */

const CHANGE_LIST_HEADER_RE =
  /^[#\s>*-]*(?:变更清单|变更列表|变更文件|changed\s+files|files\s+changed)/im;
const SECTION_HEADING_RE = /^#{1,6}\s+\S/m;
const BACKTICK_PATH_RE = /`([A-Za-z]:[\\/][^`\n]*)`/g;
const TABLE_CELL_PATH_RE = /\|([^|\n]*[A-Za-z]:[\\/][^|\n]*)\|/g;
const BARE_PATH_RE = /[A-Za-z]:[\\/][^\s`'"|<>()[\]{}，。；、！？]+/g;
const TRAILING_NOISE_RE = /[.,;:、）)】」』*·—]+$/;
const MAX_PATHS_PER_REPORT = 32;

/** A terminal delegation report carried in a get_delegation_status result. */
export interface DelegationTaskReport {
  taskId: string;
  text: string;
}

/** One synthetic edit/write announcement describing a file the child changed. */
export interface SyntheticFileArtifact {
  toolCallId: string;
  title: string;
  rawInput: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse the `{"tasks":[{task_id,status,text}]}` envelope the delegation
 * broker returns. Only completed tasks with a non-empty report count —
 * running tasks have no report yet and failed ones claim no changes.
 */
export function extractDelegationReports(resultText: string): DelegationTaskReport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["tasks"])) return [];
  const reports: DelegationTaskReport[] = [];
  for (const task of parsed["tasks"]) {
    if (!isRecord(task) || task["status"] !== "completed") continue;
    const taskId = task["task_id"];
    const text = task["text"];
    if (typeof taskId !== "string" || taskId.length === 0) continue;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    reports.push({ taskId, text });
  }
  return reports;
}

/**
 * Absolute Windows paths named in a report's change list. When a
 * 变更清单/Files changed section exists only paths inside it count; otherwise
 * backtick-quoted and markdown-table paths are accepted, with bare paths as a
 * last resort.
 */
export function extractChangedPaths(reportText: string): string[] {
  const scope = changeListSection(reportText) ?? reportText;
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const path = raw
      .trim()
      .replace(/^[`*]+|[`*]+$/g, "")
      .replace(TRAILING_NOISE_RE, "")
      .trim();
    if (!/[A-Za-z]:[\\/]/.test(path)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };

  for (const regex of [BACKTICK_PATH_RE, TABLE_CELL_PATH_RE]) {
    for (const match of scope.matchAll(regex)) add(match[1] ?? "");
  }
  if (paths.length === 0) {
    for (const match of scope.matchAll(BARE_PATH_RE)) add(match[0]);
  }
  return paths.slice(0, MAX_PATHS_PER_REPORT);
}

function changeListSection(reportText: string): string | null {
  const header = CHANGE_LIST_HEADER_RE.exec(reportText);
  if (!header) return null;
  const rest = reportText.slice(header.index + header[0].length);
  const end = SECTION_HEADING_RE.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

/**
 * One synthetic tool call per changed file, shaped like this fork's real
 * edit_file/write_file announcements (the title prefix is what the client's
 * tool-name classifier keys on; rawInput carries `file_path`). Files that
 * exist count as edits, missing ones as new-file writes. IDs derive from
 * task + path so repeated polls of the same report collapse into one card.
 */
export function planFileArtifacts(taskId: string, reportText: string): SyntheticFileArtifact[] {
  return extractChangedPaths(reportText).map((path) => {
    const operation = existsSync(path) ? "Edit" : "Write";
    return {
      toolCallId: `delegated-${sanitizeId(taskId)}-${hashPath(path)}`,
      title: `${operation} file: ${path}`,
      rawInput: { file_path: path },
    };
  });
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "task";
}

function hashPath(path: string): string {
  let hash = 5381;
  const key = path.toLowerCase();
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
