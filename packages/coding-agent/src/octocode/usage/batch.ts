import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { UsageBilling, UsageDailyRow } from "../../../../db/src/api.ts";
import { finiteOrZero } from "../shared/util.ts";

/** One model request as `usage_daily` adds it up: who answered, the kind of request, who paid, and its usage. */
export interface UsageRequest {
	provider: string;
	model: string;
	/** `reply` for the session's own turns, else what the request was for (`compaction_attempt`, `cache_warm`…). */
	kind: string;
	billing: UsageBilling;
	usage: unknown;
	/** It came from a model without pricing: its tokens cost $0 here. */
	unpriced: boolean;
}

/** Whether `usage` reports any tokens or cost: an empty usage is no request to count (an aborted call). */
export function spent(usage: unknown): boolean {
	if (!isRecord(usage)) return false;
	const tokens = ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + finiteOrZero(usage[key]), 0);
	return tokens > 0 || finiteOrZero(isRecord(usage.cost) ? usage.cost.total : undefined) > 0;
}

const rowKey = (row: Pick<UsageDailyRow, "day" | "workspaceId" | "provider" | "model" | "kind" | "billing">) =>
	JSON.stringify([row.day, row.workspaceId, row.provider, row.model, row.kind, row.billing]);

/** The requests not yet written, added up by their `usage_daily` key: a flush writes one row per key however many it made. */
export class UsageBatch {
	private readonly rows = new Map<string, UsageDailyRow>();

	private row(
		key: Omit<UsageDailyRow, "requests" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "unpriced">,
	) {
		const id = rowKey(key);
		let row = this.rows.get(id);
		if (!row) {
			row = { ...key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
			this.rows.set(id, row);
		}
		return row;
	}

	add(day: string, workspaceId: string, request: UsageRequest): void {
		const { provider, model, kind, billing } = request;
		const row = this.row({ day, workspaceId, provider, model, kind, billing });
		const usage = isRecord(request.usage) ? request.usage : {};
		row.requests += 1;
		row.input += finiteOrZero(usage.input);
		row.output += finiteOrZero(usage.output);
		row.cacheRead += finiteOrZero(usage.cacheRead);
		row.cacheWrite += finiteOrZero(usage.cacheWrite);
		row.cost += finiteOrZero(isRecord(usage.cost) ? usage.cost.total : undefined);
		if (request.unpriced) row.unpriced += 1;
	}

	/** The rows added since the last take, and an empty batch. */
	take(): UsageDailyRow[] {
		const rows = [...this.rows.values()];
		this.rows.clear();
		return rows;
	}

	/** Puts back rows a write did not take, adding them to any the same key gained meanwhile. */
	restore(rows: readonly UsageDailyRow[]): void {
		for (const taken of rows) {
			const { day, workspaceId, provider, model, kind, billing } = taken;
			const row = this.row({ day, workspaceId, provider, model, kind, billing });
			row.requests += taken.requests;
			row.input += taken.input;
			row.output += taken.output;
			row.cacheRead += taken.cacheRead;
			row.cacheWrite += taken.cacheWrite;
			row.cost += taken.cost;
			row.unpriced += taken.unpriced;
		}
	}
}
