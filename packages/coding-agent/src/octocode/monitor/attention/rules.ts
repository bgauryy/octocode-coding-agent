import type { MachineRule } from "../rules.ts";

/**
 * How a rule tells its session: starts a turn, joins the next request, wakes only when paced (else a note), wakes only the
 * session that owns the cause (else records it in the ledger), or only records the alert in the ledger (its hook and room)
 * and shows it to the user once, when the model can do nothing about it.
 */
type AttentionDelivery = "wake" | "note" | "wake or note" | "wake or ledger" | "ledger";

export interface AttentionRule {
	id: string;
	/** Where and when the rule is checked. */
	trigger: string;
	delivery: AttentionDelivery;
	/** The settings that tune it (dotted paths). */
	settings: readonly string[];
}

/**
 * The closed list of monitor rules: the machine thresholds, the stuck-job watch and the attention nudges. The ledger keeps
 * one entry per id in this order, the configuration docs list each one, and a test checks both, so a new rule cannot
 * skip its settings or docs.
 */
export const ATTENTION_RULES = [
	{ id: "load", trigger: "machine sample", delivery: "wake or ledger", settings: ["monitor.loadPerCore"] },
	{ id: "memory", trigger: "machine sample", delivery: "wake or ledger", settings: ["monitor.memoryAvailablePercent"] },
	{ id: "swap", trigger: "machine sample", delivery: "wake or ledger", settings: ["monitor.swapPercent"] },
	{ id: "gpu", trigger: "machine sample", delivery: "wake or ledger", settings: ["monitor.gpuPercent"] },
	{ id: "job", trigger: "machine sample", delivery: "wake", settings: ["monitor.stuckJobMinutes"] },
	{ id: "context", trigger: "turn end", delivery: "note", settings: ["monitor.contextBands"] },
	{
		id: "check-in",
		trigger: "between a child's steps",
		delivery: "note",
		settings: ["monitor.checkInSeconds"],
	},
	{
		id: "idle-agent",
		trigger: "team ticker, once a minute",
		delivery: "wake or note",
		settings: ["monitor.idleAgentMinutes"],
	},
	{ id: "compaction-prewarm", trigger: "compaction cycle", delivery: "ledger", settings: [] },
	{ id: "idle-items", trigger: "main session settles", delivery: "wake", settings: [] },
	{ id: "stalled-item", trigger: "once a minute while children run", delivery: "wake", settings: [] },
] as const satisfies readonly AttentionRule[];

export type AttentionRuleId = (typeof ATTENTION_RULES)[number]["id"];

/** A machine rule's registry id: the same name, checked here so every machine rule has an entry. */
export const machineRuleId = (rule: MachineRule | "job"): AttentionRuleId => rule;
