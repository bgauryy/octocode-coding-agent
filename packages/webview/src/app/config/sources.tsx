import type {
	ConfigSnapshot,
	CredentialSourceStatus,
	ProviderCredentialStatus,
} from "@octocodeai/octocode-contracts/config";
import { stamp } from "../model/format.ts";
import { StateMark } from "../ui/StateMark.tsx";
import { Badge, type BadgeTone } from "../ui/primitives.tsx";

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

function SourceItem({ source, now }: { source: CredentialSourceStatus; now: number }) {
	return (
		<li className="config-source">
			<SourceBadge source={source} />
			{source.kind === "auth-json" && (
				<span className="muted">Moving it to the OS keychain will be possible from this page later.</span>
			)}
			{source.kind === "oauth" && source.expiresAt !== undefined && <Expiry expiresAt={source.expiresAt} now={now} />}
		</li>
	);
}

export function ProviderRow({ row, now }: { row: ProviderCredentialStatus; now: number }) {
	const title = row.name ?? row.provider;
	return (
		<li className="config-row">
			<div className="config-row-head">
				<span className="config-name">{title}</span>
				{row.name && row.name !== row.provider && <code className="muted">{row.provider}</code>}
				<Badge
					tone={row.configured ? "success" : "neutral"}
					icon={<StateMark state={row.configured ? "done" : "pending"} size={12} />}
				>
					{row.configured ? "Configured" : "Not configured"}
				</Badge>
			</div>
			{row.sources.length > 0 && (
				<ul className="config-sources" aria-label={`Credential sources for ${title}`}>
					{row.sources.map((source) => (
						<SourceItem key={`${source.kind}:${source.envVar ?? ""}`} source={source} now={now} />
					))}
				</ul>
			)}
		</li>
	);
}

export type ConfigProviders = ConfigSnapshot["providers"];
