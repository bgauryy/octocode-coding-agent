import { describe, expect, it } from "vitest";
import { deferredParameters } from "../../../mcp/src/deferred-schema.ts";
import {
	RESTORED_SCHEMAS_TYPE,
	RESTORE_SCHEMAS_CHARS,
	restoredSchemas,
	restoreDeferredSchemas,
} from "../../src/octocode/compaction/deferred-schemas.ts";
import { asSetup } from "./fake-host.ts";

const schemaOf = (name: string) => ({
	type: "object",
	properties: { [`${name}Field`]: { type: "string" } },
	required: [`${name}Field`],
});
/** A deferred tool: the declared parameters remember the full schema (`deferredInputSchema`). */
const deferred = (name: string) => ({
	name,
	parameters: deferredParameters({ type: "object", properties: {} }, schemaOf(name)),
});

const call = (...names: string[]) => ({
	role: "assistant",
	content: names.map((name) => ({ type: "toolCall", id: name, name })),
});
const result = (toolName: string, text: string) => ({
	role: "toolResult",
	toolCallId: toolName,
	toolName,
	isError: false,
	content: [{ type: "text", text }],
});

function fixture(declared: ReturnType<typeof deferred>[], tail: unknown[], branchCalls: string[]) {
	const sent: Array<Record<string, unknown>> = [];
	const api = asSetup({
		getAllTools: () => declared as never,
		getActiveTools: () => declared.map((tool) => tool.name),
		sendMessage: (message: Record<string, unknown>) => void sent.push(message),
	});
	const ctx = {
		model: { contextWindow: 200_000 },
		sessionManager: {
			getBranch: () => [call(...branchCalls)].map((message) => ({ type: "message", message })),
			buildSessionProjection: () => ({
				entries: tail.map((message) => ({ sourceEntry: { id: "e" }, messages: [message] })),
			}),
		},
	} as never;
	return { api: api as never, ctx, sent };
}

describe("restored schemas against the kept tail", () => {
	it("skips a tool whose schema the tail holds as an mcp tools result or a refused call", () => {
		const declared = [deferred("alpha"), deferred("beta"), deferred("gamma")];
		const tail = [
			result("mcp", `alpha [deferred] — Search.\nInput schema:\n${JSON.stringify(schemaOf("alpha"), null, 2)}`),
			result(
				"beta",
				`Refused: load the schema first.\n\nInput schema (JSON Schema):\n${JSON.stringify(schemaOf("beta"))}`,
			),
		];
		const { api, ctx, sent } = fixture(declared, tail, ["alpha", "beta", "gamma"]);
		expect(restoreDeferredSchemas(api, ctx)).toEqual(["gamma"]);
		expect(String(sent[0].content)).not.toContain("alphaField");
		expect(String(sent[0].content)).not.toContain("betaField");
	});

	it("restores a tool the tail only mentions without its schema", () => {
		const declared = [deferred("alpha")];
		const { api, ctx } = fixture(declared, [result("mcp", "alpha [deferred] — Search.")], ["alpha"]);
		expect(restoreDeferredSchemas(api, ctx)).toEqual(["alpha"]);
	});

	it("renders the schemas sorted by name whatever the call order, so equal tool sets give equal bytes", () => {
		const declared = [deferred("alpha"), deferred("beta"), deferred("gamma")];
		const active = declared.map((tool) => tool.name);
		const one = restoredSchemas(declared, active, ["gamma", "alpha", "beta"], RESTORE_SCHEMAS_CHARS)!;
		const two = restoredSchemas(declared, active, ["beta", "gamma", "alpha"], RESTORE_SCHEMAS_CHARS)!;
		expect(one.content).toBe(two.content);
		expect(one.tools).toEqual(["alpha", "beta", "gamma"]);
	});

	it("still picks the most recently called tools when the budget holds only some", () => {
		const declared = [deferred("alpha"), deferred("beta"), deferred("gamma")];
		const active = declared.map((tool) => tool.name);
		const all = restoredSchemas(declared, active, ["gamma", "beta", "alpha"], RESTORE_SCHEMAS_CHARS)!;
		const tight = restoredSchemas(declared, active, ["gamma", "beta", "alpha"], all.content.length - 10)!;
		expect(tight.tools).toEqual(["beta", "gamma"]);
		expect(tight.omitted).toEqual(["alpha"]);
		expect(RESTORED_SCHEMAS_TYPE).toBeTruthy();
	});
});
