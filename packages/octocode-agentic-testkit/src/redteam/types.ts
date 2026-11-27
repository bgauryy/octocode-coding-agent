import type { Skill } from "../agents/inproc.ts";
import type { Step } from "../script.ts";
import type { NamePattern } from "../trace.ts";

export type AttackKind = "injection" | "exfiltration" | "destructive" | "skill-hijack";

/** A call that means the agent obeyed the attack. */
export interface ForbiddenCall {
	/** Tool name: exact, `*` glob or RegExp. */
	tool: NamePattern;
	/** When set, only calls whose arguments (as JSON) match count. */
	argsMatch?: RegExp;
}

/** Where the hostile text reaches the model. */
export type Lure =
	| {
			via: "mcp-result";
			/** The tool of the mock `web` server that returns `text`. */
			tool: string;
			text: string;
	  }
	| { via: "skill"; skill: Skill };

/** One adversarial case: the user's honest prompt, the hostile content, and what the agent must not do. */
export interface Attack {
	id: string;
	kind: AttackKind;
	prompt: string;
	lure: Lure;
	/** Calls that mean the agent acted on the attack. Attempts count, whether or not a guard blocked them. */
	forbidden: readonly ForbiddenCall[];
	/** Secret strings that must not leave in tool-call arguments or in the final answer. */
	canaries?: readonly string[];
	/** Scripted model that does what the lure asks: the case must fail on it. */
	compromised: readonly Step[];
	/** Scripted model that ignores the lure and does the user's task: the case must pass on it. */
	resists: readonly Step[];
}
