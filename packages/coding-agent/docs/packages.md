# Octocode packages

A package distributes skills, prompt templates and themes through npm or git as one unit. It is not a [plugin](plugins.md): a package's `hooks/hooks.json` and Claude or Codex plugin manifests are not loaded. Add that directory as a plugin instead.

A package is a directory or npm package with conventional resource folders, an optional `octocode` key in `package.json` (Pi's `pi` key is not read) and its own runtime dependencies. There is no package gallery.

## Install and manage

```bash
octocode install npm:@example/octocode-tools@1.0.0
octocode install git:github.com/example/octocode-tools@v1
octocode install ./local-package --local
octocode list
octocode remove npm:@example/octocode-tools
octocode update --packages
```

`octocode update --packages` reconciles package installations (`octocode update --package <source>` updates one); [Command line](cli.md) lists every option.

| Source | Example                                     | Behavior                                                                     |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------------- |
| npm    | `npm:@example/octocode-tools@1.0.0`         | Installed under the Octocode npm directory; a versioned spec is pinned       |
| git    | `git:github.com/example/octocode-tools@v1`  | Cloned and reconciled to the ref; a tag or commit is pinned, updates keep it |
| URL    | `https://github.com/example/octocode-tools` | Treated as a git source                                                      |
| Local  | `./octocode-tools`                          | Loaded from the resolved path without copying                                |

- Personal installs go to `~/.octocode/octocodecode/settings.json`. `--local` (`-l`) writes `.octocode/settings.json`, which loads only in a trusted project.
- Relative local paths resolve from the settings file that holds them.
- Packages can carry skills that tell the model to run programs. Read third-party source before installing it, and project package declarations before trusting a project.
- Package code is never run: a package contributes skills, prompts and themes only, and a folder of code in it is not a resource. See [changing configuration](configuration.md#changing-configuration).

## Create a package

```text
my-octocode-package/
├── package.json
├── skills/
├── prompts/
└── themes/
```

Without an `octocode` key, Octocode reads `skills/`, `prompts/` and `themes/`. Declare paths when resources live elsewhere:

```json
{
	"name": "my-octocode-package",
	"octocode": {
		"skills": ["./resources/skills"],
		"prompts": ["./resources/prompts/*.md"],
		"themes": ["./resources/themes/*.json"]
	},
	"peerDependencies": { "@octocodeai/octocodecode": "*" }
}
```

Paths are relative to the package root. Arrays accept globs and exclusions; list dot-prefixed or symlinked roots directly, because globs skip them. List host packages such as `@octocodeai/octocodecode` in `peerDependencies`.

Octocode installs `dependencies` of npm and git sources; local packages are not installed or modified. Installed packages load with separate module roots, so do not share a dependency instance between packages or resolve another package's undeclared dependency. Design each resource with [Skills](skills.md), [Prompt templates](prompt-templates.md) and [Themes](themes.md).

## Select resources

The object form in settings narrows what loads from a package; it cannot expose what the package did not declare:

```json
{
	"packages": [
		{
			"source": "npm:@example/octocode-tools",
			"skills": ["skills/*", "!skills/legacy"],
			"prompts": ["prompts/review.md"]
		}
	]
}
```

| Entry            | Effect                             |
| ---------------- | ---------------------------------- |
| property omitted | Load everything the package allows |
| `[]`             | Load none of that type             |
| `!pattern`       | Exclude glob matches               |
| `+path`, `-path` | Include or exclude one exact path  |

To switch discovered resources and built-in features, use `octocode configuration` or `/configuration` ([changing configuration](configuration.md#changing-configuration)).

## Scope and identity

A project entry normally replaces the personal entry for the same package. With `autoload: false` it acts as a filter over the personal package. Identity: npm by package name, git by repository URL without the ref, local by resolved absolute path, so equivalent declarations never load twice.
