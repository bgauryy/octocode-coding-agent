import { useEffect, useState } from "react";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/**
 * What the host takes when askUser's timeout runs out, and the seconds left: `auto: <label> in 18s`. The host owns the
 * timer and starts it with the dialog; this counts from the moment the card appears and stops when it goes away.
 */
export function AutoCountdown({ seconds, labels }: { seconds: number; labels: readonly string[] }) {
	const [left, setLeft] = useState(seconds);
	useEffect(() => {
		const end = Date.now() + seconds * 1000;
		const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 1000);
		return () => clearInterval(tick);
	}, [seconds]);
	return (
		<p className="muted dialog-answer-countdown" role="timer">
			auto: {labels.map((label) => label.replace(RECOMMENDED, "")).join(", ")} in {left}s
		</p>
	);
}
