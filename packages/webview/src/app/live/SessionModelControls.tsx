import type {
	ApplicationModelOption,
	ApplicationSnapshot,
	ApplicationThinkingLevel,
} from "@octocodeai/octocode-contracts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useState } from "react";
import { useStore } from "zustand";
import { Field, SearchField, Select } from "../ui/fields.tsx";
import { hashFor } from "../model/route.ts";
import { Badge, Button, cx } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";
import { groupModels, modelPrice, providerWords } from "./usage-text.ts";

type Session = Pick<ApplicationSnapshot, "sessionId" | "model" | "models" | "capabilities" | "receipts">;
const UNCHANGED = "The session did not change.";
type ModelCommand =
	| { action: "setModel"; provider: string; modelId: string }
	| { action: "setThinking"; level: ApplicationThinkingLevel };

/** The models `setModel` accepts, searchable and grouped by provider, each with its list price and who pays. */
function ModelList({
	models,
	current,
	disabled,
	onPick,
}: {
	models: readonly ApplicationModelOption[];
	current: Session["model"];
	disabled: boolean;
	onPick: (model: ApplicationModelOption) => void;
}) {
	const [query, setQuery] = useState("");
	const groups = groupModels(models, query);
	return (
		<div className="model-list">
			<SearchField
				label="Search models"
				placeholder="Search models"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			{groups.length === 0 && (
				<p className="muted">{models.length ? "No model matches." : "The session lists no models."}</p>
			)}
			{groups.map(([provider, options]) => (
				<section key={provider} aria-label={provider}>
					<h4>{provider}</h4>
					<ul>
						{options.map((option) => {
							const selected = current?.provider === option.provider && current.id === option.id;
							return (
								<li key={option.id}>
									<button
										type="button"
										className={cx("model-option", selected && "is-selected")}
										aria-pressed={selected}
										aria-label={`${option.name || option.id} (${option.id}), ${modelPrice(option)}, ${providerWords(option)}`}
										disabled={disabled}
										onClick={() => onPick(option)}
									>
										<span className="model-option-name">{option.name || option.id}</span>
										<code>{option.id}</code>
										<span className="muted">{modelPrice(option)}</span>
										<Badge tone={option.billing === "plan" ? "accent" : "neutral"}>{providerWords(option)}</Badge>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</div>
	);
}

/**
 * The session's model as a chip that opens the model list, and its thinking level, each shown only when the host
 * advertises the command (`setModel`, `setThinking`). A change is a command the host may refuse; the refusal shows here.
 */
export function SessionModelControls({ session }: { session: Session }) {
	const { session: sessionStore } = useLive();
	const connection = useStore(sessionStore, (state) => state.connection);
	const connected = useStore(sessionStore, (state) => state.connection?.connected ?? false);
	const [open, setOpen] = useState(false);
	const [sent, setSent] = useState<string | undefined>(undefined);
	const [status, setStatus] = useState("");
	// The command is in flight until the session's receipt for it settles; it is then forgotten (the session keeps only
	// recent receipts), and a failed one leaves the host's reason.
	const receipt = sent ? session.receipts.find((item) => item.id === sent) : undefined;
	if (receipt && receipt.status !== "accepted") {
		setSent(undefined);
		if (receipt.status === "failed") setStatus(receipt.message ?? UNCHANGED);
	}
	const canModel = session.capabilities.includes("setModel");
	const levels = session.model?.thinkingLevels ?? [];
	const canThinking = session.capabilities.includes("setThinking") && levels.length > 1;
	if ((!canModel && !canThinking) || !connection) return null;
	const pending = sent !== undefined;
	const send = async (command: ModelCommand) => {
		if (pending) return;
		const id = crypto.randomUUID();
		setSent(id);
		setStatus("");
		try {
			const first = await connection.execute({ id, sessionId: session.sessionId, ...command });
			if (first.status === "failed") {
				setStatus(first.message ?? UNCHANGED);
				setSent(undefined);
			}
		} catch (error) {
			setStatus(errorMessage(error));
			setSent(undefined);
		}
	};
	const model = session.model;
	const words = model && providerWords(model);
	return (
		<div className="model-controls">
			{canModel && !model && (
				// No usable model: nothing to pick until a provider is set up, as the terminal opens /providers.
				<a
					className="btn btn-secondary btn-sm model-chip"
					href={hashFor("settings", { section: "providers" })}
					title="Set up a provider in Settings → Providers"
				>
					No model
					<span className="muted"> · set up a provider</span>
				</a>
			)}
			{canModel && model && (
				<Button
					size="sm"
					className="model-chip"
					aria-expanded={open}
					loading={pending}
					disabled={!connected}
					onClick={() => setOpen(!open)}
					title={`${model.provider}/${model.id}`}
				>
					Model: {model.name}
					{words && <span className="muted"> · {words}</span>}
				</Button>
			)}
			{canThinking && model?.thinkingLevel && (
				<Field label="Thinking">
					{(props) => (
						<Select
							{...props}
							value={model.thinkingLevel}
							disabled={!connected || pending}
							onChange={(event) =>
								void send({
									action: "setThinking",
									level: levels.find((level) => level === event.target.value) ?? levels[0],
								})
							}
							options={levels}
						/>
					)}
				</Field>
			)}
			{canModel && model && open && (
				<ModelList
					models={session.models ?? []}
					current={model}
					disabled={!connected || pending}
					onPick={(option) => {
						setOpen(false);
						void send({ action: "setModel", provider: option.provider, modelId: option.id });
					}}
				/>
			)}
			{status && (
				<p className="callout tone-danger" role="alert">
					{status}
				</p>
			)}
		</div>
	);
}
