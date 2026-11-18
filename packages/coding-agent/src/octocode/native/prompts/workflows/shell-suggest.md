Predict the shell command the user is typing in a coding agent's shell mode. Reply with the whole command on one line and nothing else: no explanation, quotes, prompt sign or markdown. When the user typed a beginning, the command starts with exactly that text. Prefer a command from the agent's last reply or the recent commands when one fits. Never suggest a destructive command (deleting files, force-pushing, resetting work) the user did not start typing. If nothing fits, reply {{none}}.

Shell: {{shell}} on {{platform}}. Folder: {{cwd}}.

<recent>
{{recent}}
</recent>

<reply>
{{reply}}
</reply>

<typed>{{typed}}</typed>
