import type { ShellSpec } from "./spec.ts";

/**
 * zsh has no command that prints completions, so the driver (`zsh -f driver.zsh`) starts the user's interactive zsh in a
 * pseudo-terminal with the `zsh/zpty` module, types the line and a Tab, and reads back what the completion system
 * offered. The interactive zsh reads Octocode's `.zshenv` and `.zshrc` (through `ZDOTDIR`), which source the user's own
 * files when `loadRc` is on, then `capture.zsh`. That file replaces `compadd`: every match the completion functions add
 * is also written, with its description, to a FIFO the driver reads. No command line is ever run in that shell, so
 * nothing reaches the user's history.
 */

const ZSHENV = `
if [[ $OCTO_LOAD_RC == 1 ]]; then
  ZDOTDIR=$OCTO_USER_ZDOTDIR
  [[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
  OCTO_USER_ZDOTDIR=\${ZDOTDIR:-$HOME}
  ZDOTDIR=$OCTO_DIR
fi
`;

const ZSHRC = `
if [[ $OCTO_LOAD_RC == 1 ]]; then
  ZDOTDIR=$OCTO_USER_ZDOTDIR
  [[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
fi
source $OCTO_DIR/capture.zsh
`;

const CAPTURE = `
unset HISTFILE
SAVEHIST=0
PROMPT='' RPROMPT='' PS2='' RPS1='' RPS2=''
KEYTIMEOUT=1
LISTMAX=1000000
unsetopt zle_bracketed_paste correct correct_all list_beep beep 2>/dev/null
zmodload zsh/zutil
(( $+functions[disable-fzf-tab] )) && disable-fzf-tab
if (( ! $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i -d $OCTO_DIR/zcompdump
fi
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' insert-tab false
zstyle ':completion:*' list-prompt ''
zstyle ':completion:*' menu no
typeset -a _octo_completers
zstyle -a ':completion:*' completer _octo_completers
(( $#_octo_completers )) && zstyle ':completion:*' completer \${_octo_completers:#_expand}
unset _octo_completers
exec {OCTO_FD}>>$OCTO_FIFO

compadd() {
  if [[ " \${(j: :)@[1,(i)(-|--)]} " == *" -"[OAD]* ]]; then
    builtin compadd "$@"
    return
  fi
  setopt localoptions extendedglob no_ksharrays
  local -a _octo_hits _octo_descs
  integer _octo_di=\${@[(i)-d]}
  if (( _octo_di < $# )); then
    local _octo_dn=\${@[_octo_di+1]}
    if [[ $_octo_dn == \\(* ]]; then eval "_octo_descs=$_octo_dn"; else _octo_descs=( "\${(@P)_octo_dn}" ); fi
  fi
  builtin compadd -O _octo_hits "$@"
  (( $#_octo_descs )) && builtin compadd -D _octo_descs "$@"
  local -A _o
  zparseopts -E -A _o P: p: s: S: Q f q 2>/dev/null
  local _pre="$IPREFIX\${_o[-P]}\${_o[-p]}" _suf="\${_o[-s]}" _flags=""
  (( \${+_o[-Q]} )) && _flags+=q
  integer _octo_i
  local _v _d _k
  for (( _octo_i = 1; _octo_i <= $#_octo_hits; _octo_i++ )); do
    _v=$_pre$_octo_hits[_octo_i]$_suf
    _d=\${_octo_descs[_octo_i]-}
    if [[ $_d == *" -- "* ]]; then _d=\${_d#* -- }; elif [[ $_d == $_octo_hits[_octo_i] ]]; then _d=; fi
    _d=\${\${_d##[[:space:]]#}%%[[:space:]]#}
    _k=$_flags
    if (( \${+_o[-f]} )) && [[ -d \${~\${(Q)_v}} ]]; then _k+=d; fi
    print -u $OCTO_FD -r -- "\${_v//[$'\\t\\n']/ }"$'\\t'"\${_d//[$'\\t\\n']/ }"$'\\t'"$_k"
  done
  builtin compadd "$@"
}

_octo_quiet() { compstate[list]=''; compstate[insert]=''; }
_octo_complete() {
  comppostfuncs=( _octo_quiet )
  zle complete-word
  print -u $OCTO_FD -r -- $'\\x1e'
  BUFFER='' CURSOR=0
}
zle -N _octo_complete
bindkey -e
bindkey '^I' _octo_complete
print -u $OCTO_FD -r -- $'\\x1e'READY
`;

const DRIVER = `
zmodload zsh/zpty 2>/dev/null || exit 3
mkfifo -m 600 $OCTO_DIR/fifo || exit 3
exec {res}<>$OCTO_DIR/fifo
export OCTO_FIFO=$OCTO_DIR/fifo
if [[ $OCTO_LOAD_RC == 1 ]]; then
  zpty octo "ZDOTDIR=\${(q)OCTO_DIR} exec \${(q)OCTO_ZSH} -i"
else
  zpty octo "ZDOTDIR=\${(q)OCTO_DIR} exec \${(q)OCTO_ZSH} -d -i"
fi
_drain() { local _junk; while zpty -r -t octo _junk 2>/dev/null; do :; done; }
_await() {
  local out
  while true; do
    if read -r -t 0.05 -u $res out; then
      [[ $out == $'\\x1e'* ]] && return 0
      [[ -n $1 ]] && print -r -- "$1"$'\\t'"$out"
    else
      _drain
      zpty -t octo 2>/dev/null || return 1
    fi
  done
}
_await '' || exit 4
print -r -- $'\\x1e'READY
while IFS= read -r req; do
  id=\${req%%$'\\t'*}
  zpty -n -w octo "\${req#*$'\\t'}"$'\\t'
  if ! _await $id; then print -r -- "$id"$'\\t'$'\\x1e'; exit 4; fi
  print -r -- "$id"$'\\t'$'\\x1e'
  _drain
done
zpty -d octo
`;

export const zshSpec: ShellSpec = {
	name: "zsh",
	binary: "zsh",
	files: { ".zshenv": ZSHENV, ".zshrc": ZSHRC, "capture.zsh": CAPTURE, "driver.zsh": DRIVER },
	launch: ({ binary, dir, loadRc, env }) => ({
		command: binary,
		args: ["-f", `${dir}/driver.zsh`],
		env: {
			...env,
			OCTO_DIR: dir,
			OCTO_ZSH: binary,
			OCTO_LOAD_RC: loadRc ? "1" : "0",
			OCTO_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || "",
		},
	}),
	segmentOnly: false,
};
