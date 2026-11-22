import type { ProviderTemplateInfo } from "@octocodeai/octocode-contracts/config";
import { PROVIDER_TEMPLATES } from "../../core/provider-templates/templates.ts";

/** The templates the form offers: names, hosts and key hints only. */
export function providerTemplateInfos(): ProviderTemplateInfo[] {
	return PROVIDER_TEMPLATES.map((template) => ({
		id: template.id,
		name: template.name,
		kind: template.kind,
		api: template.api,
		...(template.baseUrl ? { baseUrl: template.baseUrl } : {}),
		...(template.hostHint ? { hostHint: template.hostHint } : {}),
		...(template.hostDefault ? { hostDefault: true } : {}),
		...(template.keyEnv ? { keyEnv: template.keyEnv } : {}),
		keyOptional: template.key === "optional",
	}));
}
