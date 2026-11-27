let active = false;

/** Whether a left click reaches components: true while the fullscreen renderer runs with mouse reporting on. */
export function pointerClicksActive(): boolean {
	return active;
}

/** Set by the fullscreen renderer as it starts and stops; tests set it directly. */
export function setPointerClicksActive(value: boolean): void {
	active = value;
}
