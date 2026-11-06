import { fauxToolCall } from "@octocodeai/octocode-ai";

/**
 * The arguments a scripted model sends to `name`. The registry requires the top-level `reason` every native call carries
 * (`src/octocode/shared/reason.ts`) and rejects a native call without it, so the fixture states one unless the test names
 * its own. An MCP tool (`mcp__<server>__<tool>`) gets its arguments as given: its input belongs to its server, which may
 * refuse a property its schema lacks.
 */
export const scriptedArgs = (name: string, args: Record<string, unknown> = {}) => ({
	...(name.startsWith("mcp__") ? {} : { reason: "scripted e2e step" }),
	...args,
});

/** A scripted call to a tool, native (`file`, `bash`, `web`, `agent`, ...) or MCP, with {@link scriptedArgs}. */
export const nativeCall = (name: string, args: Record<string, unknown>) => fauxToolCall(name, scriptedArgs(name, args));
