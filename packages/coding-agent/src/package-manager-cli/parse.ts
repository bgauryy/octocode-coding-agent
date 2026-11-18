import type { PackageCommand } from "./help.ts";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "packages"; source?: string } | { type: "models" };

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	showPackagesSkippedNote: boolean;
	local: boolean;
	force: boolean;
	/** `--trust`: record the user's trust for this folder, then run. */
	trust: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

export function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let trust = false;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let packagesFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let packageFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--packages") {
			if (command === "update") {
				packagesFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--trust") {
			trust = true;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--package") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (packageFlagSource) {
				conflictingOptions = conflictingOptions ?? "--package can only be provided once";
				index++;
			} else {
				packageFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	let showPackagesSkippedNote = false;
	if (command === "update") {
		if (allFlag && (selfFlag || packagesFlag || modelsFlag || packageFlagSource)) {
			conflictingOptions =
				conflictingOptions ?? "--all cannot be combined with --self, --packages, --models, or --package";
		}
		if (allFlag && source) {
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		if (modelsFlag) {
			if (selfFlag || packagesFlag || allFlag || packageFlagSource) {
				conflictingOptions =
					conflictingOptions ?? "--models cannot be combined with --self, --packages, --all, or --package";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			updateTarget = { type: "models" };
		} else if (packageFlagSource) {
			if (selfFlag || packagesFlag || allFlag) {
				conflictingOptions = conflictingOptions ?? "--package cannot be combined with --self, --packages, or --all";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--package cannot be combined with a positional source";
			}
			updateTarget = { type: "packages", source: packageFlagSource };
		} else if (source) {
			if (source === "self") {
				updateTarget = packagesFlag ? { type: "all" } : { type: "self" };
			} else {
				if (packagesFlag || selfFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ?? "positional update targets cannot be combined with --self, --packages, or --all";
				}
				updateTarget = { type: "packages", source };
			}
		} else if (allFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag && packagesFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (packagesFlag) {
			updateTarget = { type: "packages" };
		} else {
			updateTarget = { type: "self" };
			showPackagesSkippedNote = true;
		}
	}

	return {
		command,
		source,
		updateTarget,
		showPackagesSkippedNote,
		local,
		force,
		trust,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

export function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

export function updateTargetIncludesPackages(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "packages";
}
