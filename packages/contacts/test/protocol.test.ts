import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	BacklogMutationSchema,
	ReportFileSchema,
	ReportsIndexSchema,
	WorkspaceCommandSchema,
	WORKSPACE_ROUTES,
} from "../src/protocol.ts";

it("validates commands without admitting unknown actions or fields", () => {
	expect(
		Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "message", to: "worker", text: "Review this" }),
	).toBe(true);
	expect(Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "exec", text: "run" })).toBe(false);
	expect(Value.Check(WorkspaceCommandSchema, { id: "request-1", action: "stop", permissions: "all" })).toBe(false);
});
it("shares entity schemas with transport and rejects invalid lifecycle values", () => {
	expect(
		Value.Check(BacklogMutationSchema, { op: "add", title: "Plan", type: "epic", state: "todo", dependsOn: ["B1"] }),
	).toBe(true);
	expect(Value.Check(BacklogMutationSchema, { op: "update", state: "invented" })).toBe(false);
	expect(Value.Check(BacklogMutationSchema, { op: "update", priority: 9 })).toBe(false);
	expect(new Set(Object.values(WORKSPACE_ROUTES)).size).toBe(8);
});
it("validates report index and file payloads without admitting unknown kinds", () => {
	const summary = {
		id: "2026-10-25-webview-voice-engine",
		kind: "rfc",
		title: "Spoken agent conversations in the webview",
		status: "Proposed",
		confidence: "medium",
		question: "How should the webview get voice?",
		updated: "2026-10-25T12:00:00.000Z",
		files: [{ name: "RFC.md", bytes: 23474 }],
	};
	expect(Value.Check(ReportsIndexSchema, { reports: [summary] })).toBe(true);
	expect(Value.Check(ReportsIndexSchema, { reports: [{ ...summary, kind: "note" }] })).toBe(false);
	expect(Value.Check(ReportsIndexSchema, { reports: [{ ...summary, extra: true }] })).toBe(false);
	expect(
		Value.Check(ReportFileSchema, {
			id: "2026-10-25-webview-voice-engine",
			kind: "rfc",
			file: "RFC.md",
			markdown: "# Spoken agent conversations",
		}),
	).toBe(true);
	expect(
		Value.Check(ReportFileSchema, {
			id: "2026-10-25-webview-voice-engine",
			kind: "rfc",
			file: "RFC.md",
			markdown: "x".repeat(524289),
		}),
	).toBe(false);
});
