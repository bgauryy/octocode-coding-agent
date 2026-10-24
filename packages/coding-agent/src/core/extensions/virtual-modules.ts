import * as bundledAgentCore from "@octocodeai/octocode-agent-core";
import * as bundledAiCompat from "@octocodeai/octocode-ai/compat";
import * as bundledAiOauth from "@octocodeai/octocode-ai/oauth";
import * as bundledAiProviders from "@octocodeai/octocode-ai/providers/all";
import * as bundledTui from "@octocodeai/octocode-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import type { HostModuleSpecifier } from "./host-modules.ts";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @octocodeai/octocodecode.
import * as bundledCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<HostModuleSpecifier, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@octocodeai/octocode-agent-core": bundledAgentCore,
	"@octocodeai/octocode-tui": bundledTui,
	// Extensions resolve the octocode-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@octocodeai/octocode-ai": bundledAiCompat,
	"@octocodeai/octocode-ai/compat": bundledAiCompat,
	"@octocodeai/octocode-ai/oauth": bundledAiOauth,
	"@octocodeai/octocode-ai/providers/all": bundledAiProviders,
	"@octocodeai/octocodecode": bundledCodingAgent,
};
