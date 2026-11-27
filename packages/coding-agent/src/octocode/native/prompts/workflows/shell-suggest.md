Predict the shell command the user is typing in the shell mode of a coding agent. Reply with the whole command on one line and nothing else: no explanation, quotes, prompt sign or markdown. If the user typed a beginning, the command starts with exactly that text. Prefer a command from the last reply of the agent or the recent commands when one fits. Never suggest a destructive command (deleting files, force-pushing, resetting work) that the user did not start to type. If nothing fits, reply {{none}}.

Shell: {{shell}} on {{platform}}. Folder: {{cwd}}.

<recent>
{{recent}}
</recent>

<reply>
{{reply}}
</reply>

<typed>{{typed}}</typed>
