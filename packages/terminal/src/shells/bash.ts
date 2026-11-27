import type { ShellSpec } from "./spec.ts";

/**
 * bash runs completion functions, but only for a line it was given word by word: the driver splits the command the
 * cursor is in, finds its `complete` specification (loading it through bash-completion's loader when there is one; without
 * bash-completion, every file in the usual `bash_completion.d` folders is sourced at start), sets
 * `COMP_WORDS`, `COMP_CWORD`, `COMP_LINE` and `COMP_POINT`, calls the function and prints `COMPREPLY`. It starts as an
 * interactive bash whose rc file is the driver, so the user's `.bashrc` is sourced the way a terminal would; the loop
 * reads requests itself and bash never runs a line from them. The protocol goes to descriptor 3; stray output is dropped.
 */
const RC = `
exec 3>&1 1>/dev/null 2>/dev/null
if [[ $OCTO_LOAD_RC == 1 && -r ~/.bashrc ]]; then source ~/.bashrc; fi
unset HISTFILE
set +o history
if [[ -z $(complete -p 2>/dev/null) ]]; then
  for _octo_f in /usr/share/bash-completion/bash_completion /etc/bash_completion /opt/homebrew/etc/profile.d/bash_completion.sh /usr/local/etc/profile.d/bash_completion.sh; do
    if [[ -r $_octo_f ]]; then source "$_octo_f"; break; fi
  done
fi
if [[ -z $(complete -p 2>/dev/null) ]]; then
  for _octo_d in /opt/homebrew/etc/bash_completion.d /usr/local/etc/bash_completion.d /etc/bash_completion.d; do
    for _octo_f in "$_octo_d"/*; do [[ -r $_octo_f ]] && source "$_octo_f"; done
  done
fi
_octo_load() {
  if declare -F _comp_load >/dev/null; then _comp_load -- "$1"
  elif declare -F __load_completion >/dev/null; then __load_completion "$1"
  elif declare -F _completion_loader >/dev/null; then _completion_loader "$1"
  fi
}
_octo_complete() {
  local line=$1 cmd cur prev spec fn opts
  local -a words
  read -r -a words <<< "$line"
  if [[ -z $line || $line == *[[:space:]] ]]; then words+=(""); fi
  COMPREPLY=()
  (( \${#words[@]} > 1 )) || return 0
  local cword=$(( \${#words[@]} - 1 ))
  cmd=\${words[0]}
  cur=\${words[cword]}
  prev=\${words[cword-1]}
  spec=$(complete -p -- "$cmd" 2>/dev/null)
  if [[ -z $spec ]]; then
    _octo_load "$cmd" </dev/null >/dev/null 2>&1
    spec=$(complete -p -- "$cmd" 2>/dev/null)
  fi
  [[ -n $spec ]] || return 0
  COMP_WORDS=("\${words[@]}")
  COMP_CWORD=$cword
  COMP_LINE=$line
  COMP_POINT=\${#line}
  COMP_TYPE=9
  COMP_KEY=9
  if [[ $spec =~ -F\\ ([^ ]+) ]]; then
    fn=\${BASH_REMATCH[1]}
    "$fn" "$cmd" "$cur" "$prev" </dev/null >/dev/null 2>&1
  elif [[ $spec != *" -C "* ]]; then
    opts=\${spec#complete }
    opts=\${opts% *}
    eval "COMPREPLY=( \\$(compgen $opts -- \\"\\$cur\\") )" </dev/null 2>/dev/null
  fi
}
printf '\\036READY\\n' >&3
while IFS= read -r _octo_req; do
  _octo_id=\${_octo_req%%$'\\t'*}
  _octo_complete "\${_octo_req#*$'\\t'}"
  for _octo_v in "\${COMPREPLY[@]}"; do
    printf '%s\\t%s\\t\\t\\n' "$_octo_id" "\${_octo_v//$'\\t'/ }" >&3
  done
  printf '%s\\t\\036\\n' "$_octo_id" >&3
done
exit 0
`;

export const bashSpec: ShellSpec = {
	name: "bash",
	binary: "bash",
	files: { "rc.bash": RC },
	launch: ({ binary, dir, loadRc, env }) => ({
		command: binary,
		args: ["--noprofile", "--rcfile", `${dir}/rc.bash`, "-i"],
		env: { ...env, OCTO_LOAD_RC: loadRc ? "1" : "0", PS1: "", PROMPT_COMMAND: "" },
	}),
	segmentOnly: true,
};
