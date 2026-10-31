import { fauxToolCall } from "@octocodeai/octocode-ai";

/**
 * A scripted call to a native Octocode tool (`file`, `bash`, `web`, `agent`, `askUser`, `backlog`, `memory`). The
 * registry requires the top-level `reason` every native call carries (`src/octocode/shared/reason.ts`) and rejects the
 * call without it, so the fixture states one unless the test names its own.
 */
export const nativeCall = (name: string, args: Record<string, unknown>) =>
	fauxToolCall(name, { reason: "scripted e2e step", ...args });
