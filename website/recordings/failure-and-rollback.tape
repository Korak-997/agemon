# See README.md.
Output failure-and-rollback.webm
Source "/tapes/settings.tape"

Hide
Type `OUT=$PWD && source /env/failure-and-rollback.env && export PATH=/opt/node/bin:/usr/bin:/bin && agemon() { node /agemon/bin/agemon.js "$@"; } && PS1="$ " && clear || exit 1`
Enter
Wait /\$$/
Show

Type "agemon --dry-run --skill-groups essentials"
Sleep 400ms
Enter
Wait@60s /\$$/
Sleep 2s

Hide
Type `set -- .agemon/plans/*.json && [ "$#" -eq 1 ] && PLAN=$(basename "$1" .json) && clear || exit 1`
Enter
Wait /\$$/
Show

Type "chmod a-w ."
Sleep 400ms
Enter
Wait /\$$/
Sleep 1s
Type 'agemon apply --plan "$PLAN" --yes --skill-groups essentials'
Sleep 400ms
Enter
Wait@60s /\$$/
Sleep 1s
Screenshot failure-and-rollback.png
Sleep 3s

Hide
Type `APPLY_STATUS=$? && chmod u+w . && [ "$APPLY_STATUS" -eq 1 ] && clear || exit 1`
Enter
Wait /\$$/
Show

Type "git status --short"
Sleep 400ms
Enter
Wait /\$$/
Sleep 4s

Hide
Type `test -z "$(git status --porcelain)" || exit 1`
Enter
Wait /\$$/
