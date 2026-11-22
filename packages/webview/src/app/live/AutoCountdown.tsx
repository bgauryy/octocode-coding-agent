import { useState } from "react";
import { clockNow, useNow } from "./profiler/use-now.ts";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/**
 * What the host takes when askUser's timeout runs out, and the seconds left: `auto: <label> in 18s`. The host owns the
 * timer and starts it with the dialog; this counts from the moment the card appears and stops when it goes away.
 */
export function AutoCountdown({ seconds, labels }: { seconds: number; labels: readonly string[] }) {
	const [started, setStarted] = useState({ seconds, at: clockNow() });
	if (started.seconds !== seconds) setStarted({ seconds, at: clockNow() });
	const now = useNow();
	const left = Math.min(seconds, Math.max(0, Math.ceil((started.at + seconds * 1000 - now) / 1000)));
	return (
		<p className="muted dialog-answer-countdown" role="timer">
			auto: {labels.map((label) => label.replace(RECOMMENDED, "")).join(", ")} in {left}s
		</p>
	);
}
