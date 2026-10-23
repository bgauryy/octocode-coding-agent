export function shellCompletion(shell: "bash" | "zsh" | "fish", executable: string): string {
	const name = executable.replace(/[^a-zA-Z0-9_-]/g, "");
	if (shell === "bash") return `_${name.replace(/-/g, "_")}_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do COMPREPLY+=("$candidate"); done < <("\${COMP_WORDS[0]}" completion --values "\${COMP_WORDS[@]:1:COMP_CWORD}")
}
complete -F _${name.replace(/-/g, "_")}_complete ${name}
`;
	if (shell === "zsh") return `_${name.replace(/-/g, "_")}_complete() {
  local -a candidates
  candidates=("\${(@f)$("\${words[1]}" completion --values "\${(@)words[2,CURRENT-1]}" "$PREFIX")}")
  (( \${#candidates} )) && compadd -a candidates
}
compdef _${name.replace(/-/g, "_")}_complete ${name}
`;
	return `function __${name.replace(/-/g, "_")}_complete
  set -l words (commandline -opc)
  set -e words[1]
  set -l current (commandline -ct)
  command ${name} completion --values $words "$current"
end
complete -c ${name} -f -a '(__${name.replace(/-/g, "_")}_complete)'
`;
}

