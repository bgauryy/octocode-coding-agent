import type { ProviderCredentialStatus } from "@octocodeai/octocode-contracts/config";
import { type SubmitEvent, useState } from "react";
import { Button } from "../ui/primitives.tsx";
import { type SetProvider, useSwitch } from "./ProviderControls.tsx";

const SOURCE_NOTES = {
	saved: "saved with the key",
	default: "official host",
	"models-json": "from models.json",
} as const;

/** The host a provider's requests go to and where it comes from; the host is public, the key is never shown. */
export function BaseUrlLine({ row }: { row: ProviderCredentialStatus }) {
	const baseUrl = row.baseUrl;
	if (!baseUrl) return null;
	const extra = [baseUrl.region ? `region ${baseUrl.region}` : undefined, baseUrl.api].filter(Boolean);
	return (
		<p className="muted config-base-url">
			Base URL: <code>{baseUrl.url}</code>
			<span> ({SOURCE_NOTES[baseUrl.source]})</span>
			{extra.length > 0 && <span> · {extra.join(" · ")}</span>}
		</p>
	);
}

function Failure({ message }: { message: string | undefined }) {
	if (!message) return null;
	return (
		<p className="callout tone-danger" role="alert">
			{message}
		</p>
	);
}

function HostEditor({
	row,
	title,
	set,
	close,
}: {
	row: ProviderCredentialStatus;
	title: string;
	set: SetProvider;
	close: () => void;
}) {
	const [host, setHost] = useState(row.baseUrl?.source === "models-json" ? row.baseUrl.url : "");
	const save = useSwitch(async () => {
		await set({ action: "edit-host", provider: row.provider, host: host.trim() });
		close();
	});
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		void save.click();
	};
	return (
		<form className="config-edit" onSubmit={submit} aria-label={`Edit host of ${title}`}>
			<input
				type="text"
				aria-label={`Host of ${title}`}
				value={host}
				maxLength={2048}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => setHost(event.target.value)}
			/>
			<Button type="submit" size="sm" variant="primary" loading={save.busy}>
				Save host
			</Button>
			<Button size="sm" disabled={save.busy} onClick={close}>
				Cancel
			</Button>
			<Failure message={save.error} />
		</form>
	);
}

type ModelLimits = NonNullable<ProviderCredentialStatus["customEdit"]>["models"][number];

const wholeNumber = (text: string): number | undefined =>
	/^[1-9]\d{0,15}$/.test(text.trim()) ? Number(text) : undefined;

function LimitsEditor({
	provider,
	model,
	set,
	close,
}: {
	provider: string;
	model: ModelLimits;
	set: SetProvider;
	close: () => void;
}) {
	const [context, setContext] = useState(String(model.contextWindow));
	const [output, setOutput] = useState(String(model.maxOutput));
	const contextWindow = wholeNumber(context);
	const maxOutput = wholeNumber(output);
	// The host refuses a maximum output above the window; the page does not send what it can tell is wrong.
	const valid = contextWindow !== undefined && maxOutput !== undefined && maxOutput <= contextWindow;
	const save = useSwitch(async () => {
		if (!valid) return;
		await set({ action: "edit-limits", provider, model: model.id, contextWindow, maxOutput });
		close();
	});
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		void save.click();
	};
	return (
		<form className="config-edit" onSubmit={submit} aria-label={`Limits of ${model.id}`}>
			<code>{model.id}</code>
			<input
				type="text"
				inputMode="numeric"
				aria-label={`Context window of ${model.id}`}
				value={context}
				onChange={(event) => setContext(event.target.value)}
			/>
			<input
				type="text"
				inputMode="numeric"
				aria-label={`Maximum output of ${model.id}`}
				value={output}
				onChange={(event) => setOutput(event.target.value)}
			/>
			<Button
				type="submit"
				size="sm"
				variant="primary"
				loading={save.busy}
				disabled={!valid}
				aria-label={`Save limits of ${model.id}`}
			>
				Save
			</Button>
			<Failure message={save.error} />
		</form>
	);
}

function RemoveConfirm({
	row,
	title,
	set,
	close,
}: {
	row: ProviderCredentialStatus;
	title: string;
	set: SetProvider;
	close: () => void;
}) {
	const remove = useSwitch(() => set({ action: "remove-custom", provider: row.provider }));
	return (
		<fieldset className="config-edit" aria-label={`Remove ${title}?`}>
			<p>Remove {title} from models.json, with its saved key and host. This cannot be undone.</p>
			<Button
				size="sm"
				variant="danger"
				loading={remove.busy}
				aria-label={`Confirm remove ${title}`}
				onClick={remove.click}
			>
				Remove
			</Button>
			<Button size="sm" disabled={remove.busy} onClick={close}>
				Cancel
			</Button>
			<Failure message={remove.error} />
		</fieldset>
	);
}

/**
 * Edit host, Edit limits and Remove of a custom provider the host defines in Octocode's models.json. The page only
 * relays: the host checks the host, the limits and the file, and answers with the fresh snapshot.
 */
export function CustomProviderControls({ row, set }: { row: ProviderCredentialStatus; set: SetProvider }) {
	const [panel, setPanel] = useState<"host" | "limits" | "remove" | undefined>();
	const edit = row.customEdit;
	if (!edit) return null;
	const title = row.name ?? row.provider;
	const close = () => setPanel(undefined);
	return (
		<div className="config-custom">
			<div className="config-edit">
				<Button size="sm" aria-label={`Edit host of ${title}`} onClick={() => setPanel("host")}>
					Edit host
				</Button>
				{edit.models.length > 0 && (
					<Button size="sm" aria-label={`Edit limits of ${title}`} onClick={() => setPanel("limits")}>
						Edit limits
					</Button>
				)}
				<Button size="sm" aria-label={`Remove ${title}`} onClick={() => setPanel("remove")}>
					Remove
				</Button>
			</div>
			{panel === "host" && <HostEditor row={row} title={title} set={set} close={close} />}
			{panel === "limits" &&
				edit.models.map((model) => (
					<LimitsEditor key={model.id} provider={row.provider} model={model} set={set} close={close} />
				))}
			{panel === "remove" && <RemoveConfirm row={row} title={title} set={set} close={close} />}
		</div>
	);
}
