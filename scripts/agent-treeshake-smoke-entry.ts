import { Agent } from "@octocodeai/octocode-agent-core";
import { createModels } from "@octocodeai/octocode-ai";
import { anthropicProvider } from "@octocodeai/octocode-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
