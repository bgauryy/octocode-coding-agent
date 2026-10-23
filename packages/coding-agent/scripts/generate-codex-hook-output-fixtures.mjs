import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately opt-in: normal tests consume the generated fixtures without Rust or network access.
const RUST_MAIN = "#![allow(dead_code)]\nmod schema;\nmod output_parser;\nuse std::io::{self,BufRead};\nfn main(){for line in io::stdin().lock().lines(){let v:serde_json::Value=serde_json::from_str(&line.unwrap()).unwrap();let event=v[\"event\"].as_str().unwrap();let raw=v[\"output\"].to_string();\nlet valid=match event {\n \"PermissionRequest\"=>output_parser::parse_permission_request(&raw).map(|o|o.invalid_reason.is_none()),\n \"PreToolUse\"=>output_parser::parse_pre_tool_use(&raw).map(|o|o.invalid_reason.is_none()),\n \"PostToolUse\"=>output_parser::parse_post_tool_use(&raw).map(|o|o.invalid_reason.is_none()&&o.invalid_block_reason.is_none()),\n \"UserPromptSubmit\"=>output_parser::parse_user_prompt_submit(&raw).map(|o|o.invalid_block_reason.is_none()),\n \"Stop\"=>output_parser::parse_stop(&raw).map(|o|o.invalid_block_reason.is_none()),\n \"SessionStart\"=>output_parser::parse_session_start(&raw).map(|_|true),\n \"PreCompact\"=>output_parser::parse_pre_compact(&raw).map(|_|true),\n \"PostCompact\"=>output_parser::parse_post_compact(&raw).map(|_|true),\n \"SubagentStart\"=>output_parser::parse_subagent_start(&raw).map(|_|true),\n \"SubagentStop\"=>output_parser::parse_subagent_stop(&raw).map(|o|o.invalid_block_reason.is_none()),\n \"Interrupt\"=>output_parser::parse_interrupt(&raw).map(|_|true),\n _=>panic!(\"unsupported fixture event\")};println!(\"{}\",valid.unwrap_or(false));}}\n";
const revision = "8eaf5fd115f036d207be236009938261758e30f2";
const sourceRoot = `https://raw.githubusercontent.com/openai/codex/${revision}/`;
const sources = {
 "codex-rs/hooks/src/schema.rs": "fe45c68cd552fb32e155de09ed492856f7c0baaa5c9a9ac535f24b7a480a2209",
 "codex-rs/hooks/src/engine/output_parser.rs": "ae4b2a80569025e97d3ca39d5f4b7383c1c836ca29fe3980f18029ac4e00336f",
};
const events = ["PermissionRequest", "PreToolUse", "PostToolUse", "SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop", "Interrupt"];
const values = [null, true, false, "", "reason", "block", "allow", "deny", "ask", 0, [], {}, ["block"]];
const fixtures = [];
for (const event of events) {
 fixtures.push({ event, output: {} });
 for (const key of ["continue", "stopReason", "suppressOutput", "systemMessage", "decision", "reason", "hookSpecificOutput", "unknown"])
  for (const value of values) fixtures.push({ event, output: { [key]: value } });
 for (const key of ["hookEventName", "additionalContext", "permissionDecision", "permissionDecisionReason", "updatedInput", "updatedMCPToolOutput", "unknown"])
  for (const value of values) fixtures.push({ event, output: { hookSpecificOutput: { hookEventName: event, [key]: value } } });
 for (const decision of ["allow", "deny", "ask", null]) for (const reason of ["", "explain", null]) for (const updatedInput of [null, { command: "true" }, "primitive"])
  fixtures.push({ event, output: { decision: "block", reason: "legacy", hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: reason, updatedInput } } });
}

for (const behavior of ["allow","deny",null,"ask"]) {
 fixtures.push({event:"PermissionRequest",output:{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior}}}});
 for(const key of ["updatedInput","updatedPermissions","message","interrupt","unknown"]) for(const value of values) fixtures.push({event:"PermissionRequest",output:{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior,[key]:value}}}});
}

async function download(file) {
 const response = await fetch(sourceRoot + file, { signal: AbortSignal.timeout(30_000) });
 if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
 const text = await response.text();
 if (sources[file] && createHash("sha256").update(text).digest("hex") !== sources[file]) throw new Error(`Pinned source hash mismatch: ${file}`);
 return text;
}
const [schemaSource, parser, license] = await Promise.all([...Object.keys(sources), "LICENSE"].map(download));
const parts = [];
for (const match of schemaSource.matchAll(/^pub\(crate\) (?:struct|enum) (\w+)/gm)) {
 if (!match[1].endsWith("Wire")) continue;
 const start = schemaSource.lastIndexOf("#[derive", match.index);
 const end = schemaSource.indexOf("\n}", match.index) + 2;
 if (start < 0 || end < match.index) throw new Error("Unrecognized upstream declaration boundary");
 parts.push(schemaSource.slice(start, end).replace(/^\s*#\[schemars\([^\n]*\)\]\n/gm, "").replaceAll(", JsonSchema", ""));
}
if (parts.length !== 24) throw new Error(`Expected 24 pinned wire declarations, got ${parts.length}`);
const temporary = mkdtempSync(path.join(tmpdir(), "octocode-codex-output-"));
function run(command, args, input) {
 const result = spawnSync(command, args, { cwd: temporary, input, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
 if (result.status !== 0) throw new Error(result.stderr || String(result.error));
 return result.stdout;
}
try {
 mkdirSync(path.join(temporary, "src"));
 writeFileSync(path.join(temporary, "LICENSE"), license);
 writeFileSync(path.join(temporary, "Cargo.toml"), '[package]\nname="codex-output-reference"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[dependencies]\nserde={version="=1.0.229",features=["derive"]}\nserde_json="=1.0.154"\n');
 writeFileSync(path.join(temporary, "src/schema.rs"), 'use serde::{Serialize,Deserialize};\nuse serde_json::Value;\n' + parts.join("\n") + '\nfn default_continue()->bool{true}\n');
 writeFileSync(path.join(temporary, "src/output_parser.rs"), parser);
 writeFileSync(path.join(temporary, "src/main.rs"), RUST_MAIN);
 run("cargo", ["build", "--quiet"]);
 const executable = path.join(temporary, "target/debug/codex-output-reference" + (process.platform === "win32" ? ".exe" : ""));
 const answers = run(executable, [], fixtures.map(fixture => JSON.stringify(fixture)).join("\n") + "\n").trim().split("\n");
 if (answers.length !== fixtures.length || answers.some(answer => answer !== "true" && answer !== "false")) throw new Error("Invalid reference results");
 const header = { revision, sources, scope: "JSON object acceptance and semantic validation; excludes event dispatch and tool-specific rewrite validation" };
 const content = JSON.stringify(header, null, 2).slice(0, -2) + ',\n  "fixtures": [\n' + fixtures.map((fixture, index) => "    " + JSON.stringify({ ...fixture, valid: answers[index] === "true" })).join(",\n") + "\n  ]\n}\n";
 const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/hooks/codex-output-contract.json");
 if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== content) throw new Error("Codex output fixtures differ from pinned reference");
 } else {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
 }
 console.log(`${fixtures.length} pinned Codex output fixtures ${process.argv.includes("--check") ? "verified" : "generated"}`);
} finally {
 rmSync(temporary, { recursive: true, force: true });
}
