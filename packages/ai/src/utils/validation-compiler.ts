import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Compile } from "typebox/compile";
import type { Tool } from "../types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

export function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const cached = validatorCache.get(schema);
	if (cached) return cached;
	const validator = Compile(schema);
	validatorCache.set(schema, validator);
	return validator;
}

/** A malformed definition is not an argument error the model can repair by changing its call. */
export function getToolValidator(schema: Tool["parameters"], toolName: string): ReturnType<typeof Compile> {
	try {
		return getValidator(schema);
	} catch (cause) {
		throw new Error(
			`Invalid schema for tool "${toolName}": ${errorMessage(cause)}. Fix the tool definition before retrying.`,
			{ cause },
		);
	}
}
