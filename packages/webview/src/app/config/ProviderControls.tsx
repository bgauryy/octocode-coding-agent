import type {
	ConfigProviderCommand,
	ProviderCredentialStatus,
	ProviderOrigin,
	ProviderSourceState,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useState } from "react";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, Button } from "../ui/primitives.tsx";

/** Sends one typed switch to the host; the host writes the setting and answers. The page decides nothing. */
export type SetProvider = (command: ConfigProviderCommand) => Promise<void>;

const PRODUCT_LABELS = { octocode: "Octocode", pi: "Pi" } as const;
const FILE_LABELS = { "auth-json": "auth.json", "models-json": "models.json" } as const;

/** A switch button that shows the host's refusal next to it instead of changing anything itself. */
export function useSwitch(run: () => Promise<void>) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	async function click() {
		setBusy(true);
		setError(undefined);
		try {
			await run();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}
	return { busy, error, click };
}

function SourceRow({ source, set }: { source: ProviderSourceState; set?: SetProvider }) {
	const toggle = useSwitch(() => set!({ action: "set-source", source: "pi", enabled: !source.enabled }));
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{source.label}</span>
				<Badge
					tone={source.enabled ? "success" : "neutral"}
					icon={<StateMark state={source.enabled ? "done" : "stopped"} size={12} />}
				>
					{source.toggleable ? (source.enabled ? "On" : "Off") : "Always on"}
				</Badge>
				{!source.present && <span className="muted">No configuration files found</span>}
				{source.toggleable && set && (
					<Button
						size="sm"
						onClick={toggle.click}
						loading={toggle.busy}
						aria-label={`${source.enabled ? "Turn off" : "Turn on"} ${source.label}`}
					>
						{source.enabled ? "Turn off" : "Turn on"}
					</Button>
				)}
			</div>
			{source.id === "pi" && (
				<p className="muted config-methods">
					Pi's auth.json and models.json add providers beside Octocode's. Turning it off keeps its files unchanged.
				</p>
			)}
			{toggle.error && (
				<p className="callout tone-danger" role="alert">
					{toggle.error}
				</p>
			)}
		</li>
	);
}

/** Octocode (always on) and Pi (can be turned off): the places providers are read from. */
export function SourcesPanel({ sources, set }: { sources: readonly ProviderSourceState[]; set?: SetProvider }) {
	if (sources.length === 0) return null;
	return (
		<section className="panel" aria-labelledby="config-sources">
			<div className="panel-header">
				<h2 id="config-sources">Provider sources</h2>
				<p className="muted">Where credentials and model definitions are read from. Files are never changed here.</p>
			</div>
			<ul className="row-list" aria-label="Provider sources">
				{sources.map((source) => (
					<SourceRow key={source.id} source={source} set={source.toggleable ? set : undefined} />
				))}
			</ul>
		</section>
	);
}

function originText(origin: ProviderOrigin): string {
	const base = `${PRODUCT_LABELS[origin.product]} ${FILE_LABELS[origin.file]}`;
	return origin.file === "models-json" && origin.hasKey ? `${base} (API key set)` : base;
}

/** Where a provider is configured, and the Enable/Disable control. Disabling hides its models and keeps its credentials. */
export function ProviderSwitch({ row, set }: { row: ProviderCredentialStatus; set?: SetProvider }) {
	const title = row.name ?? row.provider;
	const toggle = useSwitch(() => set!({ action: "set-provider", provider: row.provider, enabled: !!row.disabled }));
	if (!row.origins?.length && !row.disabled && !set) return null;
	return (
		<div className="config-sources">
			{row.origins && row.origins.length > 0 && (
				<ul className="config-sources" aria-label={`Configured in for ${title}`}>
					{row.origins.map((origin) => (
						<li key={`${origin.product}:${origin.file}`} className="config-source">
							<Badge tone="neutral" title="The file that configures this provider. Its content is not shown.">
								{originText(origin)}
							</Badge>
						</li>
					))}
				</ul>
			)}
			{(row.disabled || set) && (
				<div className="config-edit">
					{row.disabled && (
						<Badge tone="warning" title="Its models are hidden. Credentials are kept.">
							Disabled
						</Badge>
					)}
					{set && (
						<Button
							size="sm"
							onClick={toggle.click}
							loading={toggle.busy}
							aria-label={`${row.disabled ? "Enable" : "Disable"} ${title}`}
						>
							{row.disabled ? "Enable" : "Disable"}
						</Button>
					)}
				</div>
			)}
			{toggle.error && (
				<p className="callout tone-danger" role="alert">
					{toggle.error}
				</p>
			)}
		</div>
	);
}
