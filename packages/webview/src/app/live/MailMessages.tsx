import { entityOfRole, type MailView } from "@octocodeai/octocode-contracts/team";
import { TextFold } from "../ui/LongText.tsx";
import { Markdown } from "./Markdown.tsx";

/** Lines of a delivered message's body shown before it folds. */
const PREVIEW_LINES = 3;

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

function Mail({ mail }: { mail: MailView }) {
	const lines = mail.text.split("\n");
	const body = (
		<div className="mail-body">
			<Markdown text={mail.text} />
		</div>
	);
	const meta = [
		mail.number === undefined ? "" : `#${mail.number}`,
		...mail.kinds,
		mail.forwardedBy ? `forwarded by ${mail.forwardedBy}` : "",
		mail.at === undefined ? "" : clock(mail.at),
	].filter(Boolean);
	return (
		<section className="mail-message" aria-label={`Mail from ${mail.from}`}>
			<header className="mail-header">
				<span aria-hidden="true">✉</span>{" "}
				<strong>
					{mail.role !== undefined && `${entityOfRole(mail.role)} `}
					{mail.from}
					{mail.to !== undefined && ` → ${mail.to}`}
				</strong>
				<span className="muted"> · {meta.join(" · ")}</span>
			</header>
			<TextFold
				text={mail.text}
				label="Message"
				summary={
					lines.length > PREVIEW_LINES
						? `${lines.slice(0, PREVIEW_LINES).join("\n").slice(0, 160)} … ${lines.length - PREVIEW_LINES} more ${lines.length - PREVIEW_LINES === 1 ? "line" : "lines"}`
						: undefined
				}
			>
				{body}
			</TextFold>
		</section>
	);
}

/** Delivered agent mail: sender mark, `sender → recipient`, number, kind and time, then the body (long ones fold). */
export function MailMessages({ mail }: { mail: readonly MailView[] }) {
	return (
		<>
			{mail.map((entry, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- a batch is positional and never reorders.
				<Mail key={index} mail={entry} />
			))}
		</>
	);
}
