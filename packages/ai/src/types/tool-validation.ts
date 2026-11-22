/** What a tool's `validationHint` is told about the failure it follows. */
export interface ToolValidationFailure {
	/** Every problem is at the top level of the arguments, none inside a nested value. */
	envelope: boolean;
	/** Top-level properties the problems sit at or under, by name. */
	properties: string[];
	/** The arguments as the model sent them. */
	arguments?: unknown;
	/** Rejected properties of the alternatives selected for the error message. schemaPath is absent when the validator's error budget ends inside a union. */
	unexpected?: { instancePath: string; schemaPath?: string; names: string[] }[];
	/** Check a proposed example against the same compiled schema without invoking the tool. */
	accepts?: (example: unknown) => boolean;
}
