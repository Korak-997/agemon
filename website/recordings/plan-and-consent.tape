# See README.md.
Output plan-and-consent.webm
Source "/tapes/settings.tape"

Hide
Type `OUT=$PWD && source /env/plan-and-consent.env && export PATH=/opt/node/bin:/usr/bin:/bin && agemon() { node /agemon/bin/agemon.js "$@"; } && PS1="$ " && clear || exit 1`
Enter
Wait /\$$/
Show

Type "agemon --skill-groups essentials"
Sleep 400ms
Enter
Wait+Screen@60s /Gate 1 \/ 3/
Sleep 2500ms
Screenshot plan-and-consent.png
Up
Sleep 700ms
Enter
Wait+Screen@30s /Gate 2 \/ 3/
Sleep 2500ms
Up
Sleep 700ms
Enter
Wait+Screen@30s /Gate 3 \/ 3/
Sleep 2500ms
Down
Sleep 700ms
Enter
Sleep 5s
Up
Sleep 700ms
Enter
Wait@60s /\$$/
Sleep 4s

Hide
Type `test -s AGENTS.md && test -s .agemon/state.json || exit 1`
Enter
Wait /\$$/
