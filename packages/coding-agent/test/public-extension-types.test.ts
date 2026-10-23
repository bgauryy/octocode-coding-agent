import { expect, it } from "vitest";
import type {
	BashToolResultEvent,
	CustomToolResultEvent,
	EditorFactory,
	ExtensionErrorListener,
	ExtensionMode,
	ReplacedSessionContext,
	SessionEvent,
	ToolResultEvent,
	TreePreparation,
} from "../src/index.ts";
import { isBashToolResult } from "../src/index.ts";

/** Compile-time check (`tsc` covers tests): types reachable from public signatures can be named from the root. */
type Exported = [
	BashToolResultEvent,
	CustomToolResultEvent,
	EditorFactory,
	ExtensionErrorListener,
	ExtensionMode,
	ReplacedSessionContext,
	SessionEvent,
	TreePreparation,
];

it("exports the types that public extension signatures return", () => {
	const narrowed = (event: ToolResultEvent): BashToolResultEvent | undefined =>
		isBashToolResult(event) ? event : undefined;
	const names: Exported | undefined = undefined;
	expect(names).toBeUndefined();
	expect(typeof narrowed).toBe("function");
});
