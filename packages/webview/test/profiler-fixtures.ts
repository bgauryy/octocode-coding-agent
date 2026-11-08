import type { ProfileAgent, ProfileLayer, ProfileRequest } from "@octocodeai/octocode-contracts";

export function agent(id: string, patch: Partial<ProfileAgent> = {}): ProfileAgent {
	return {
		id,
		role: patch.parentId ? "researcher" : "main",
		status: "idle",
		requests: 0,
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		profiled: true,
		...patch,
	};
}

export function layer(patch: Partial<ProfileLayer> = {}): ProfileLayer {
	return { kind: "message", label: "user", tokens: 100, state: "cached", changed: false, ...patch };
}

export function request(agentId: string, index: number, patch: Partial<ProfileRequest> = {}): ProfileRequest {
	return {
		agentId,
		index,
		at: Date.UTC(2026, 10, 8, 10, 30, index),
		durationMs: 2400,
		model: "opus-5-5",
		usage: { input: 200, output: 50, cacheRead: 38_000, cacheWrite: 81_000, cost: 0.42 },
		layers: [layer({ kind: "tools", label: "tools (42)", tokens: 38_000 })],
		estimated: false,
		...patch,
	};
}
