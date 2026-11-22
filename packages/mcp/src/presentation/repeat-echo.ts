import { liftedProperties, resolveLocalRef } from "@octocodeai/octocode-ai/utils/json-schema-shape";
import { MAX_ECHOED_ARGUMENTS_CHARS, type ToolValidationFailure } from "@octocodeai/octocode-ai";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { queriesCap } from "./validation-hint.ts";

type Schema = Record<string, unknown>;

/** Move a rejected root field only when exactly one declared child owns that name and has one unoccupied destination. */
function relocate(args: Schema, names: string[], schema: Schema): Schema | undefined {
	const fields = liftedProperties(schema);
	const result = { ...args };
	for (const name of names) {
		if (!Object.hasOwn(args, name) || Object.hasOwn(fields, name)) return undefined;
		const destinations = Object.entries(fields).filter(([, field]) => {
			const child = resolveLocalRef(field, schema);
			if (!isRecord(child)) return false;
			return Object.hasOwn(liftedProperties(child.items ?? child, schema), name);
		});
		if (destinations.length !== 1) return undefined;
		const [key] = destinations[0];
		const child = result[key];
		const item = Array.isArray(child) && child.length === 1 ? child[0] : child;
		if (!isRecord(item) || Object.hasOwn(item, name)) return undefined;
		const moved = { [name]: args[name], ...item };
		result[key] = Array.isArray(child) ? [moved] : moved;
		delete result[name];
	}
	return result;
}

/** Text only. Keep all values, check every proposed call against the original validator and bound the complete example. */
export function correctedCalls(schema: Schema, failure: ToolValidationFailure): string | undefined {
	const { arguments: args, accepts, unexpected } = failure;
	if (!isRecord(args) || !accepts) return undefined;
	const names = [...new Set(unexpected?.filter((error) => !error.instancePath).flatMap((error) => error.names))];
	const candidate = names.length ? relocate(args, names, schema) : args;
	if (!candidate) return undefined;
	const cap = queriesCap(schema);
	const queries = candidate.queries;
	const split =
		Array.isArray(queries) && Number.isSafeInteger(cap) && cap !== undefined && cap > 0 && queries.length > cap;
	if (!split && !names.length) return undefined;
	const count = split ? Math.ceil(queries.length / cap) : 1;
	let example = `This failed identically twice. Send ${count === 1 ? "this call" : `these ${count} calls in the same turn`}:`;
	for (let index = 0; index < count; index++) {
		const call = split ? { ...candidate, queries: queries.slice(index * cap, (index + 1) * cap) } : candidate;
		const text = JSON.stringify(call);
		if (example.length + 1 + text.length > MAX_ECHOED_ARGUMENTS_CHARS || !accepts(call)) return undefined;
		example += `\n${text}`;
	}
	return example;
}
