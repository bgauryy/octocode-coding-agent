# Discover vendor models

Run `octocode models discover` to query documented vendor model-list APIs and compare their IDs with the configured catalog. This makes listing requests, never inference requests. Normal credential resolution can refresh and save an expired OAuth token.

```bash
octocode models discover --provider openai
octocode models discover --provider google --json
octocode models discover --offline --json
```

`--provider` limits discovery to one provider; omitting it checks all registered providers. Requests run in groups of four with a 60-second command deadline and a 15-second deadline per vendor list. `--offline` or `OCTOCODE_OFFLINE=1` reads only local model definitions and does not resolve credentials. An error or unconfigured provider gives the command a nonzero exit status; unavailable discovery contracts are reported separately.

| Status         | Meaning                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `verified`     | The documented model-list request succeeded. This does not prove inference access or feature compatibility.        |
| `catalog`      | Offline result from configured model definitions.                                                                  |
| `unsupported`  | No verified HTTP list contract is implemented for this provider; consult the result's documentation link and note. |
| `unconfigured` | The list needs authentication and none resolved.                                                                   |
| `error`        | Authentication or the list request failed. Local definitions remain available in the result.                       |

Every built-in provider has a strategy and official reference in [the discovery source registry](../../ai/src/providers/discovery-sources.ts). The same registry drives the implementation. Public Hugging Face, OpenCode Console and Vercel catalogs need no credentials and do not establish subscription entitlement. Subscription plans use their own supported-model lists, rather than borrowing the pay-as-you-go catalog.

Azure deployments, Bedrock regional foundation-model availability, Vertex publisher models, Fireworks deployments and Cloudflare account models have separate control-plane contracts. The command reports guidance for these instead of guessing an inference `/models` route or sending inference credentials to a different API.

The `known` flag means an ID already has a configured model definition. Unknown IDs are marked **metadata required**. Vendor lists frequently omit verified context limits, prices, modalities, reasoning and tool support. Discovery never guesses those fields or automatically adds runnable models. Check the vendor's model documentation, add an explicit definition in [models.json](models.md), then validate its required features with a controlled inference call. `missingFromVendor` reports configured IDs absent from the response; absence alone is not proof of retirement.

OpenAI API keys use the standard `data[].id` list. Sign in with ChatGPT uses the account's `models[].slug` list, preserves the vendor's order and display names, and includes only `visibility: "list"`. OAuth availability is restricted to IDs that also have trusted runtime metadata. Login saves the list; refresh can update it without mixing accounts. A list failure does not replace renewable credentials with guessed model access.

The SDK exposes the same behavior without importing every provider:

```typescript
import { discoverProviderModels } from "@octocodeai/octocode-ai/providers/discovery";

const result = await discoverProviderModels(models, "openai", {
	allowNetwork: true,
	signal: AbortSignal.timeout(15_000),
});
```

See the [provider audit](../../../docs/PROVIDER_PROTOCOL_AUDIT.md) for the documentation review, repairs and live-validation limits.
