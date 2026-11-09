import type {
	ProviderCredentialStatus,
	SignInCommand,
	SignInEvent,
	SignInState,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { Button } from "../ui/primitives.tsx";

/** Runs one sign-in command on the host and returns the sign-in's state. The host runs the login; this page only relays. */
export type SignInRequest = (command: SignInCommand) => Promise<SignInState>;

/** How often a running sign-in is asked for news. */
const SIGN_IN_POLL_MS = 1000;

const WEB_URL = /^https?:\/\/\S+$/;

/** A link from the host is shown and opened only when it is an http(s) address. */
function SafeLink({ url, label }: { url: string; label?: string }) {
	if (!WEB_URL.test(url)) return <code>{label ?? "(link not shown)"}</code>;
	return (
		<a href={url} target="_blank" rel="noopener noreferrer">
			{label ?? url}
		</a>
	);
}

function EventLine({ event }: { event: SignInEvent }) {
	if (event.type === "auth_url")
		return (
			<p>
				{event.instructions ?? "Open this link to sign in:"} <SafeLink url={event.url} />
			</p>
		);
	if (event.type === "device_code")
		return (
			<p>
				Enter the code <code>{event.userCode}</code> at <SafeLink url={event.verificationUri} />
			</p>
		);
	if (event.type === "info")
		return (
			<p className="muted">
				{event.message}{" "}
				{event.links?.map((link, index) => (
					// oxlint-disable-next-line react/no-array-index-key -- links repeat no stable id and never reorder
					<SafeLink key={index} url={link.url} label={link.label} />
				))}
			</p>
		);
	return <p className="muted">{event.message}</p>;
}

function PromptForm({ state, title, answer }: { state: SignInState; title: string; answer: (value: string) => void }) {
	const prompt = state.prompt;
	const [value, setValue] = useState("");
	if (!prompt) return null;
	if (prompt.type === "select")
		return (
			<fieldset className="config-edit" aria-label={prompt.message}>
				<p>{prompt.message}</p>
				{prompt.options?.map((option) => (
					<Button key={option.id} size="sm" title={option.description} onClick={() => answer(option.id)}>
						{option.label}
					</Button>
				))}
			</fieldset>
		);
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!value && prompt.type !== "text") return;
		answer(value);
		setValue("");
	};
	return (
		<form className="config-edit" onSubmit={submit} aria-label={`${title} sign-in question`}>
			<p>{prompt.message}</p>
			<input
				type={prompt.type === "text" ? "text" : "password"}
				aria-label={prompt.message}
				placeholder={prompt.placeholder}
				value={value}
				maxLength={8192}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => setValue(event.target.value)}
			/>
			<Button type="submit" size="sm" variant="primary" disabled={!value && prompt.type !== "text"}>
				Continue
			</Button>
		</form>
	);
}

/**
 * Signs in to one provider's account or subscription. The page asks the host to start the login, shows what the host
 * relays (a link, a device code, progress), answers the host's questions and offers Cancel. It runs no login itself and
 * never holds a token: the host stores the result, and `onSignedIn` makes the page read the fresh snapshot.
 */
export function SignInControl({
	row,
	signIn,
	onSignedIn,
	pollMs = SIGN_IN_POLL_MS,
}: {
	row: ProviderCredentialStatus;
	signIn: SignInRequest;
	onSignedIn: () => void;
	pollMs?: number;
}) {
	const title = row.name ?? row.provider;
	const label = row.auth?.oauth?.isSubscription ? "Sign in with subscription" : "Sign in with account";
	const [state, setState] = useState<SignInState | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [polls, setPolls] = useState(0);
	const opened = useRef(new Set<string>());
	const status = state?.status;
	const signedIn = useRef(onSignedIn);
	useEffect(() => {
		signedIn.current = onSignedIn;
	}, [onSignedIn]);

	const run = async (command: SignInCommand) => {
		setBusy(true);
		setError(undefined);
		try {
			setState(await signIn(command));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	// A page that was reloaded or left meanwhile finds a sign-in the host still runs, and can cancel it.
	useEffect(() => {
		let current = true;
		void (async () => {
			try {
				const found = await signIn({ action: "status", provider: row.provider });
				// Never over a state the user already produced by clicking while this was in flight.
				if (current && found?.status === "running") setState((now) => now ?? found);
			} catch {
				// Not shown: the page works without it, and Sign in reports the host's answer.
			}
		})();
		return () => {
			current = false;
		};
	}, [signIn, row.provider]);

	// While the host runs the login, ask for news; the host ends a sign-in that nobody finishes.
	useEffect(() => {
		if (status !== "running") return;
		let current = true;
		const poll = async () => {
			try {
				const next = await signIn({ action: "status", provider: row.provider });
				if (current) setState(next);
			} catch (cause) {
				if (!current) return;
				setError(errorMessage(cause));
				// Try again: one failed request must not leave a running sign-in unwatched.
				setPolls((count) => count + 1);
			}
		};
		const timer = setTimeout(() => void poll(), pollMs);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [state, status, signIn, row.provider, pollMs, polls]);

	useEffect(() => {
		if (status === "succeeded" || (status === "failed" && state?.credentialSaved)) signedIn.current();
	}, [status, state?.credentialSaved]);

	// The first link of a sign-in is opened for the user; the same link is also shown, in case the browser blocks it.
	useEffect(() => {
		const link = state?.events.find((event) => event.type === "auth_url");
		if (link?.type !== "auth_url" || opened.current.has(link.url) || !WEB_URL.test(link.url)) return;
		opened.current.add(link.url);
		if (typeof window.open === "function") window.open(link.url, "_blank", "noopener,noreferrer");
	}, [state]);

	const running = status === "running";
	return (
		<div className="config-signin">
			{!running && (
				<Button
					size="sm"
					aria-label={`${label} for ${title}`}
					loading={busy}
					onClick={() => {
						opened.current.clear();
						void run({ action: "start", provider: row.provider });
					}}
				>
					{label}
				</Button>
			)}
			{state && running && (
				<div className="config-signin-live" aria-live="polite">
					<p className="muted">Signing in to {title}. The host runs the sign-in; this page only shows it.</p>
					{state.events.map((event, index) => (
						// oxlint-disable-next-line react/no-array-index-key -- events are an append-only list; two can be identical
						<EventLine key={index} event={event} />
					))}
					<PromptForm
						key={state.prompt?.id ?? "none"}
						state={state}
						title={title}
						answer={(value) =>
							void run({ action: "answer", provider: row.provider, promptId: state.prompt?.id ?? "", value })
						}
					/>
					<Button
						size="sm"
						aria-label={`Cancel sign-in for ${title}`}
						onClick={() => void run({ action: "cancel", provider: row.provider })}
					>
						Cancel
					</Button>
				</div>
			)}
			{status === "succeeded" && <p className="muted">Signed in to {title}.</p>}
			{status === "cancelled" && <p className="muted">Sign-in cancelled.</p>}
			{(status === "failed" || error) && (
				<p className="callout tone-danger" role="alert">
					{error ?? state?.error ?? "The sign-in failed."}
				</p>
			)}
		</div>
	);
}
