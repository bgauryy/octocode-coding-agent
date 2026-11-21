import type {
	ConfigSnapshot,
	CredentialSourceStatus,
	ProviderCredentialStatus,
} from "@octocodeai/octocode-contracts/config";
import { safeWebLink } from "../../link.ts";
import { stamp } from "../model/format.ts";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, type BadgeTone } from "../ui/primitives.tsx";
import { CredentialEditor, type SaveCredential } from "./CredentialEditor.tsx";
import { ProviderSwitch, type SetProvider } from "./ProviderControls.tsx";
import { SignInControl, type SignInRequest } from "./SignIn.tsx";

/** What a source is called on the page. Environment variables and expiry are added by `SourceBadge`. */
const SOURCE_LABELS = {
	keychain: "OS keychain",
	"auth-json": "Plaintext in auth.json",
	"custom-command": "Custom command",
	env: "Environment variable",
	oauth: "Signed in",
} as const;

const SOURCE_HELP = {
	keychain: "The key is stored in the operating system keychain; auth.json holds only a reference.",
	"auth-json": "The key is stored as text in auth.json.",
	"custom-command": "auth.json runs a command to get the key. The command is not shown.",
	env: "A provider environment variable is set. Its value is not shown.",
	oauth: "Signed in with the provider.",
} as const;

/** Plaintext is the one source that needs attention; the others are neutral or good news. */
function toneOf(kind: CredentialSourceStatus["kind"]): BadgeTone {
	if (kind === "auth-json") return "warning";
	if (kind === "keychain" || kind === "oauth") return "success";
	return "neutral";
}

function SourceBadge({ source }: { source: CredentialSourceStatus }) {
	const mark = <StateMark state={source.kind === "auth-json" ? "waiting" : "done"} size={12} />;
	return (
		<Badge tone={toneOf(source.kind)} icon={mark} title={SOURCE_HELP[source.kind]}>
			{source.kind === "env" && source.envVar ? (
				<>
					<span className="visually-hidden">{SOURCE_LABELS.env} </span>
					<code>{source.envVar}</code>
				</>
			) : (
				SOURCE_LABELS[source.kind]
			)}
		</Badge>
	);
}

function Expiry({ expiresAt, now }: { expiresAt: number; now: number }) {
	return (
		<span className="muted">
			Access token {expiresAt <= now ? "expired" : "expires"}{" "}
			<time dateTime={new Date(expiresAt).toISOString()}>{stamp(expiresAt)}</time>
		</span>
	);
}

function SourceItem({ source, now, editable }: { source: CredentialSourceStatus; now: number; editable: boolean }) {
	return (
		<li className="config-source">
			<SourceBadge source={source} />
			{source.kind === "auth-json" && (
				<span className="muted">
					{editable
						? "Replace the key to move it to the OS keychain when one is available."
						: "Moving it to the OS keychain is possible from the page opened in the terminal."}
				</span>
			)}
			{source.kind === "oauth" && source.expiresAt !== undefined && <Expiry expiresAt={source.expiresAt} now={now} />}
		</li>
	);
}

/** Names the sign-ins a provider offers, and links the page that issues its keys. */
function Methods({ row }: { row: ProviderCredentialStatus }) {
	const { oauth, keyAuth: apiKey, plan } = row.auth ?? {};
	const names = [
		oauth ? (oauth.isSubscription ? "Subscription sign-in" : "Account sign-in") : undefined,
		apiKey?.name,
	].filter((name): name is string => !!name);
	if (names.length === 0 && !plan && !row.route) return null;
	const keyPage = apiKey?.keyPage ? safeWebLink(apiKey.keyPage) : null;
	return (
		<div className="config-methods muted">
			{names.length ? `Sign in with: ${names.join(" · ")}` : plan ? "Plan access" : null}
			{keyPage && (
				<>
					{" "}
					<a
						href={keyPage}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`Get key for ${row.name ?? row.provider}`}
					>
						Get key
					</a>
				</>
			)}
			{row.route && <p>Route: {row.route}</p>}
			{plan && (
				<p>
					{plan.billing === "plan" ? "Billed by plan" : "Billed per token"}.{" "}
					{safeWebLink(plan.terms) ? (
						<a href={safeWebLink(plan.terms)!} target="_blank" rel="noopener noreferrer">
							Plan terms
						</a>
					) : (
						plan.terms
					)}
					{plan.disabled && <output> · Paused: {plan.disabled}</output>}
				</p>
			)}
		</div>
	);
}

export function ProviderRow({
	row,
	now,
	save,
	keychainAvailable,
	signIn,
	onSignedIn,
	setProvider,
}: {
	row: ProviderCredentialStatus;
	/** Present only when the host allows this connection to turn providers on or off. */
	setProvider?: SetProvider;
	now: number;
	/** Present only when the host allows this connection to change credentials. */
	save?: SaveCredential;
	keychainAvailable: boolean;
	/** Present only when the host allows this connection to sign in; the host runs the login. */
	signIn?: SignInRequest;
	/** Called when a sign-in finished, so the page reads the fresh snapshot. */
	onSignedIn?: () => void;
}) {
	const title = row.name ?? row.provider;
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{title}</span>
				{row.name && row.name !== row.provider && <code className="muted">{row.provider}</code>}
				<Badge tone="neutral" icon={<StateMark state={row.configured ? "waiting" : "pending"} size={12} />}>
					{row.configured ? "Configured" : "Not configured"}
				</Badge>
			</div>
			{row.sources.length > 0 && (
				<ul className="config-sources" aria-label={`Credential sources for ${title}`}>
					{row.sources.map((source) => (
						<SourceItem key={`${source.kind}:${source.envVar ?? ""}`} source={source} now={now} editable={!!save} />
					))}
				</ul>
			)}
			<ProviderSwitch row={row} set={setProvider} />
			<Methods row={row} />
			{signIn && row.auth?.oauth && <SignInControl row={row} signIn={signIn} onSignedIn={onSignedIn ?? (() => {})} />}
			{save && row.editable !== false && (
				<CredentialEditor row={row} save={save} keychainAvailable={keychainAvailable} />
			)}
			{save && row.editable === false && (
				<p className="muted">This provider name cannot be changed from this page. Edit auth.json in a terminal.</p>
			)}
		</li>
	);
}

export type ConfigProviders = ConfigSnapshot["providers"];
