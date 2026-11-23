import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

const compile = <const T extends TSchema>(schema: T) => Compile(schema);

/**
 * A schema's validator, compiled on first use. A module-level `Compile` runs at every start whether or not the start
 * reads such a file (models.json, models-store.json, keybindings, themes, a child's skill snapshot: about 19 ms for
 * the six schemas the bundle loads); one call site per schema shares its compiled validator.
 */
export function compileLazily<const T extends TSchema>(schema: T): () => ReturnType<typeof compile<T>> {
	let validator: ReturnType<typeof compile<T>> | undefined;
	return () => (validator ??= compile(schema));
}
