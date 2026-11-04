import { bedrockProviderModule } from "@octocodeai/octocode-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@octocodeai/octocode-ai/bun-oauth";
import { setBedrockProviderModule } from "@octocodeai/octocode-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import { initialTitle, setProcessTitle } from "../octocode/processes/title.ts";

// The role and id come with the session (`octocode/processes/register.ts`); a subagent already has its own.
setProcessTitle(initialTitle(process.env, "main"));
process.emitWarning = () => {};
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
