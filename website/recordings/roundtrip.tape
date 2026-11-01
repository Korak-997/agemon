# See README.md.
Output roundtrip.webm
Output roundtrip.gif
Source "/tapes/settings.tape"

Hide
Type `OUT=$PWD && source /env/roundtrip.env && export PATH=/opt/node/bin:/usr/bin:/bin && agemon() { node /agemon/bin/agemon.js "$@"; } && PS1="$ " && clear || exit 1`
Enter
Wait /\$$/
Show

Type "agemon --yes --skill-groups essentials"
Sleep 400ms
Enter
Wait@60s /\$$/
Sleep 1s
Screenshot roundtrip.png
Sleep 3s

Hide
Type `test -s AGENTS.md && cp .agemon/state.json "$OUT/recorded-ledger.json" && clear || exit 1`
Enter
Wait /\$$/
Show

Type "agemon nuke --yes"
Sleep 400ms
Enter
Wait@60s /\$$/
Sleep 2s
Type "git status --short --ignored"
Sleep 400ms
Enter
Wait /\$$/
Sleep 4s

Hide
Type `test -z "$(git status --porcelain --ignored)" || exit 1`
Enter
Wait /\$$/
