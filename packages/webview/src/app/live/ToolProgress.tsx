import { toolProgressFraction, toolProgressText, type ApplicationToolProgress } from "@octocodeai/octocode-contracts";

/** A running tool's reported progress: a bar when the total is known, an indeterminate one otherwise. */
export function ToolProgress({ progress }: { progress: ApplicationToolProgress }) {
	const fraction = toolProgressFraction(progress);
	return (
		<p className="tool-progress muted">
			<progress aria-label="Tool progress" {...(fraction === undefined ? {} : { value: fraction, max: 1 })} />{" "}
			{toolProgressText(progress)}
		</p>
	);
}
