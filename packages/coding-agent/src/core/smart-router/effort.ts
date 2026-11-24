import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@octocodeai/octocode-ai";
import { EFFORT_LADDER } from "./signals.ts";

export function effortIndex(level: ModelThinkingLevel): number {
	return EFFORT_LADDER.indexOf(level);
}

/** Highest effort the model supports at or below the ceiling index; `off` when it reasons not at all. */
export function effortCapacity(model: Model<Api>, ceilingIndex: number): number {
	let best = 0;
	for (const level of getSupportedThinkingLevels(model)) {
		const index = effortIndex(level);
		if (index <= ceilingIndex && index > best) best = index;
	}
	return best;
}

/** Highest supported effort not above `wanted`. */
export function snapEffort(model: Model<Api>, wanted: number, capacity: number): ModelThinkingLevel {
	const limit = Math.min(wanted, capacity);
	let best = 0;
	for (const level of getSupportedThinkingLevels(model)) {
		const index = effortIndex(level);
		if (index <= limit && index > best) best = index;
	}
	return EFFORT_LADDER[best];
}
