/** The features composed further down, by name: reading one before it is set throws an error that names it. */
export function composedLater<T extends object>() {
	const values: Partial<T> = {};
	return {
		set: <K extends keyof T>(name: K, value: T[K]): T[K] => (values[name] = value),
		get: <K extends keyof T>(name: K): T[K] => {
			const value = values[name];
			if (value === undefined) throw new Error(`Octocode used ${String(name)} before composing it`);
			return value;
		},
	};
}
