import type { ToolInvocation } from "../extensions/types.ts";

/** Snapshot JSON arguments without changing execution of custom SDK argument objects. */
export function captureToolInvocation(
	toolCallId: string,
	toolName: string,
	input: unknown,
	isActive: () => boolean = () => true,
): ToolInvocation | undefined {
	const active = new Set<object>();
	let nodes = 0,
		characters = 0;
	const copy = (value: unknown, depth: number): unknown => {
		if (++nodes > 100_000 || depth > 64)
			throw new Error("Invocation exceeds snapshot bounds");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") {
			characters += value.length;
			if (characters > 4 * 1024 * 1024)
				throw new Error("Invocation exceeds snapshot bounds");
			return value;
		}
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "object" || !value || active.has(value))
			throw new Error("Invocation is not JSON data");
		const prototype = Object.getPrototypeOf(value);
		if (
			!Array.isArray(value) &&
			prototype !== Object.prototype &&
			prototype !== null
		)
			throw new Error("Invocation is not JSON data");
		active.add(value);
		const result: any = Array.isArray(value) ? [] : Object.create(null);
		const keys = Reflect.ownKeys(value);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (!descriptor.enumerable) continue;
			if (typeof key !== "string" || !("value" in descriptor))
				throw new Error("Invocation is not JSON data");
			characters += key.length;
			if (characters > 4 * 1024 * 1024)
				throw new Error("Invocation exceeds snapshot bounds");
			Object.defineProperty(result, key, {
				value: copy(descriptor.value, depth + 1),
				enumerable: true,
			});
		}
		if (Array.isArray(value) && result.length !== value.length)
			throw new Error("Invocation is not JSON data");
		active.delete(value);
		return Object.freeze(result);
	};
	try {
		return Object.freeze(
			Object.defineProperty(
				{ toolCallId, toolName, input: copy(input, 0) },
				"active",
				{ get: isActive },
			),
		) as ToolInvocation;
	} catch {
		return undefined;
	}
}
