let context: AudioContext | undefined;

/** The page's audio context; created inside a user gesture so the browser lets it run later. */
function audio(): AudioContext | undefined {
	if (typeof AudioContext === "undefined") return undefined;
	context ??= new AudioContext();
	return context;
}

/** Call from a click: autoplay rules keep a context made without a gesture silent. */
export function prepareChime(): void {
	void audio()?.resume();
}

/** A short two-note chime made with Web Audio: no media file, nothing from the network. */
export function playChime(): void {
	const ctx = audio();
	if (!ctx) return;
	void ctx.resume();
	const start = ctx.currentTime + 0.02;
	[659.25, 880].forEach((frequency, index) => {
		const oscillator = ctx.createOscillator();
		const gain = ctx.createGain();
		const at = start + index * 0.14;
		oscillator.type = "sine";
		oscillator.frequency.value = frequency;
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
		oscillator.connect(gain).connect(ctx.destination);
		oscillator.start(at);
		oscillator.stop(at + 0.32);
	});
}
