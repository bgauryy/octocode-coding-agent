import type { ShellSpec } from "./spec.ts";

/**
 * PowerShell answers `TabExpansion2` with the matches Tab would cycle through. Each is already quoted (`q`); containers
 * are directories (`d`); `@N` is where the replaced text starts in the request.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rs = [char]0x1e
[Console]::Out.WriteLine("\${rs}READY")
while ($null -ne ($req = [Console]::In.ReadLine())) {
  $i = $req.IndexOf("\`t")
  $id = $req.Substring(0, $i)
  $line = $req.Substring($i + 1)
  try {
    $r = TabExpansion2 -inputScript $line -cursorColumn $line.Length
    foreach ($m in $r.CompletionMatches) {
      $k = if ($m.ResultType -eq 'ProviderContainer') { 'qd' } else { 'q' }
      $t = ($m.ToolTip -replace '[\\t\\r\\n]+', ' ').Trim()
      if ($t -eq $m.CompletionText -or $t -eq $m.ListItemText) { $t = '' }
      $v = $m.CompletionText -replace '[\\t\\r\\n]', ' '
      [Console]::Out.WriteLine("$id\`t$v\`t$t\`t$k@$($r.ReplacementIndex)")
    }
  } catch {}
  [Console]::Out.WriteLine("$id\`t$rs")
}
`;

export const pwshSpec: ShellSpec = {
	name: "pwsh",
	binary: ["pwsh", "powershell"],
	files: {},
	launch: ({ binary, loadRc, env }) => ({
		command: binary,
		args: [
			"-NoLogo",
			"-NonInteractive",
			...(loadRc ? [] : ["-NoProfile"]),
			"-EncodedCommand",
			Buffer.from(SCRIPT, "utf16le").toString("base64"),
		],
		env,
	}),
	segmentOnly: false,
};
