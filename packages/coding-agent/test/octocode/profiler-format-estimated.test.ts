import type { ProfileRequest } from "@octocodeai/octocode-contracts/profiler";
import { expect, it } from "vitest";
import { requestsTable } from "../../src/octocode/profiler/format.ts";

const request = (estimated: boolean): ProfileRequest => ({
	agentId: "main",
	index: 0,
	at: 0,
	model: "m",
	usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
	layers: [{ kind: "system", label: "system", tokens: 1000, state: "uncached", changed: false }],
	estimated,
});

it("marks layer rows of an estimated request and explains the mark", () => {
	const estimated = requestsTable({ agentId: "main", requests: [request(true)] } as never, true);
	expect(estimated).toContain("~1.0k");
	expect(estimated).toContain("~ estimated");
	const recorded = requestsTable({ agentId: "main", requests: [request(false)] } as never, true);
	expect(recorded).not.toContain("~");
});
