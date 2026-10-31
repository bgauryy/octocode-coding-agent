/**
 * Request and error behavior that belongs to one provider's service, keyed by provider id. Adapters ask for a
 * capability here instead of comparing provider ids themselves, so a provider's quirks live in one table.
 * Quirks that follow the model or endpoint rather than the provider belong in `model.compat`.
 */
export interface ProviderCapabilities {
	/** Sends the Copilot `X-Initiator`, `Openai-Intent` and vision headers computed from the transcript. */
	copilotDynamicHeaders: boolean;
	/** Authenticates the Anthropic Messages API with a bearer token instead of an `x-api-key`. */
	anthropicBearerAuth: boolean;
	/** Sends the session id as `x-grok-conv-id`, which xAI uses to route to a cache. */
	grokConversationHeader: boolean;
	/** Always asks Responses for `reasoning.encrypted_content`, even when no reasoning level is requested. */
	alwaysIncludeEncryptedReasoning: boolean;
	/** Accepts an explicit "reasoning off" effort on the Responses API. */
	acceptsReasoningOff: boolean;
	/** Forwards Claude 5.5 over the Messages API, so its effort limits apply to the model. */
	claudeEffortLimits: boolean;
	/** Reports context overflow as a bodyless error that only its message pattern identifies. */
	bodylessContextOverflow: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
	copilotDynamicHeaders: false,
	anthropicBearerAuth: false,
	grokConversationHeader: false,
	alwaysIncludeEncryptedReasoning: false,
	acceptsReasoningOff: true,
	claudeEffortLimits: false,
	bodylessContextOverflow: false,
};

const PROVIDER_CAPABILITIES: Readonly<Record<string, Partial<ProviderCapabilities>>> = {
	"github-copilot": {
		copilotDynamicHeaders: true,
		anthropicBearerAuth: true,
		acceptsReasoningOff: false,
		claudeEffortLimits: true,
	},
	xai: { grokConversationHeader: true, alwaysIncludeEncryptedReasoning: true },
	anthropic: { claudeEffortLimits: true },
	opencode: { claudeEffortLimits: true },
	"opencode-go": { claudeEffortLimits: true },
	cerebras: { bodylessContextOverflow: true },
};

export function getProviderCapabilities(provider: string): ProviderCapabilities {
	return { ...DEFAULT_CAPABILITIES, ...PROVIDER_CAPABILITIES[provider] };
}
