import type { ProviderCredentialStatus } from "@octocodeai/octocode-contracts/config";

/** The host, region and API a sign-in saves beside its key. Empty strings mean "not entered". */
export interface HostAnswers {
	host: string;
	region: string;
	api: string;
}

export const NO_HOST: HostAnswers = { host: "", region: "", api: "" };

export type HostQuestion = NonNullable<NonNullable<ProviderCredentialStatus["auth"]>["keyAuth"]>["host"];

/** The fields of a sign-in command for these answers: only what was entered; region and API only beside a host. */
export function hostFields(answers: HostAnswers): { host?: string; region?: string; api?: string } {
	const host = answers.host.trim();
	if (!host) return {};
	const region = answers.region.trim();
	return { host, ...(region ? { region } : {}), ...(answers.api ? { api: answers.api } : {}) };
}

/**
 * The optional host question of a provider whose API takes a base URL, as the terminal sign-in asks it. The host
 * validates the answers; the page only shows the fields the provider's host option names.
 */
export function HostFields({
	title,
	question,
	value,
	onChange,
}: {
	title: string;
	question: NonNullable<HostQuestion>;
	value: HostAnswers;
	onChange: (next: HostAnswers) => void;
}) {
	const hasHost = value.host.trim().length > 0;
	return (
		<>
			<input
				type="text"
				aria-label={`Custom host for ${title} (optional)`}
				placeholder={question.example}
				value={value.host}
				maxLength={2048}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => onChange({ ...value, host: event.target.value })}
			/>
			{question.region && hasHost && (
				<input
					type="text"
					aria-label={`Region for ${title} (optional)`}
					placeholder="eu-central-1"
					value={value.region}
					maxLength={128}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => onChange({ ...value, region: event.target.value })}
				/>
			)}
			{question.apis && hasHost && (
				<select
					aria-label="Which API does this host serve?"
					value={value.api}
					onChange={(event) => onChange({ ...value, api: event.target.value })}
				>
					<option value="">The host name tells</option>
					{question.apis.map((choice) => (
						<option key={choice.id} value={choice.id}>
							{choice.label}
						</option>
					))}
				</select>
			)}
			{hasHost && <p className="muted">The host is saved with the key, and removed with it.</p>}
		</>
	);
}
