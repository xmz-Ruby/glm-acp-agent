import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractChangedPaths,
  extractDelegationReports,
  planFileArtifacts,
} from "../tools/delegation-artifacts.js";

function envelope(tasks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ tasks });
}

test("extractDelegationReports keeps only completed tasks carrying a report", () => {
  const reports = extractDelegationReports(envelope([
    { task_id: "t1", status: "completed", text: "## 变更清单\n- `C:\\a\\b.md`" },
    { task_id: "t2", status: "running" },
    { task_id: "t3", status: "failed", text: "boom" },
    { task_id: "t4", status: "completed", text: "   " },
  ]));
  assert.deepEqual(reports.map((report) => report.taskId), ["t1"]);
});

test("extractDelegationReports rejects non-JSON and non-envelope text", () => {
  assert.deepEqual(extractDelegationReports("not json"), []);
  assert.deepEqual(extractDelegationReports(JSON.stringify({ tasks: "nope" })), []);
  assert.deepEqual(extractDelegationReports(JSON.stringify({ ok: true })), []);
});

test("extractChangedPaths counts only the change-list section when present", () => {
  const report = [
    "先读取了 `C:\\other\\mentioned.md`。",
    "## 变更清单",
    "- `C:\\Users\\mst\\.codeg\\AGENTS.md` 两处替换",
    "- `C:/Users/mst/workspace/x/src/a.ts` 新增",
    "## 下一步",
    "- `C:\\prose\\after.md`",
  ].join("\n");
  assert.deepEqual(extractChangedPaths(report), [
    "C:\\Users\\mst\\.codeg\\AGENTS.md",
    "C:/Users/mst/workspace/x/src/a.ts",
  ]);
});

test("extractChangedPaths reads backtick and table paths without a section", () => {
  const report = [
    "| 文件 | 改动 |",
    "|---|---|",
    "| `C:\\a\\b.md` | x |",
    "另外提到 `C:\\c c\\d.txt`。",
  ].join("\n");
  assert.deepEqual(extractChangedPaths(report), ["C:\\a\\b.md", "C:\\c c\\d.txt"]);
});

test("extractChangedPaths falls back to bare paths and dedupes case-insensitively", () => {
  const report = "改了 C:\\x\\y.md 以及 c:\\X\\Y.MD。";
  assert.deepEqual(extractChangedPaths(report), ["C:\\x\\y.md"]);
});

test("planFileArtifacts classifies existing files as edits and missing ones as writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "deleg-artifacts-"));
  const existing = join(dir, "exists.txt");
  writeFileSync(existing, "x", "utf8");
  const missing = join(dir, "missing.txt");
  const report = `## 变更清单\n- \`${existing}\` 两处替换\n- \`${missing}\` 新建`;
  const artifacts = planFileArtifacts("task-1", report);

  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]!.title, `Edit file: ${existing}`);
  assert.equal(artifacts[1]!.title, `Write file: ${missing}`);
  assert.deepEqual(artifacts[0]!.rawInput, { file_path: existing });

  const again = planFileArtifacts("task-1", report);
  assert.deepEqual(
    again.map((artifact) => artifact.toolCallId),
    artifacts.map((artifact) => artifact.toolCallId)
  );
  const otherTask = planFileArtifacts("task-2", report);
  assert.notEqual(otherTask[0]!.toolCallId, artifacts[0]!.toolCallId);
});
