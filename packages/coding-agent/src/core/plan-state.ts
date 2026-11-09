import type { SessionEntry } from "./session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

export const PLAN_ENTRY = "octocode-plan";
export interface PlanState {
	active: boolean;
	revision: number;
	text: string;
}
export interface PlanOptions {
	action: "show" | "enter" | "leave" | "approve";
	revision?: number;
}

/** Read only the selected branch; an unknown persisted version fails closed. */
export function readPlan(entries: readonly SessionEntry[]): PlanState {
	const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === PLAN_ENTRY);
	if (!entry || entry.type !== "custom") return { active: false, revision: 0, text: "" };
	const data = entry.data;
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		typeof data.active !== "boolean" ||
		!Number.isSafeInteger(data.revision) ||
		Number(data.revision) < 0 ||
		typeof data.text !== "string"
	) {
		return {
			active: true,
			revision: 0,
			text: "Unrecognized saved planning state. Review this session before leaving plan mode.",
		};
	}
	return { active: data.active, revision: Number(data.revision), text: data.text };
}

const constraints = new Map<string, () => boolean>();
export function bindPlanConstraint(id: string, blocked: () => boolean): () => void {
	constraints.set(id, blocked);
	return () => {
		if (constraints.get(id) === blocked) constraints.delete(id);
	};
}
export function planConstraintActive(manager: { getSessionId(): string; getBranch(): SessionEntry[] }): boolean {
	return constraints.get(manager.getSessionId())?.() ?? readPlan(manager.getBranch()).active;
}

export function clearPlanConstraint(id: string): void {
	constraints.delete(id);
}
