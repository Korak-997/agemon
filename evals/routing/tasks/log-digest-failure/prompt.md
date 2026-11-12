`logs/app.log` records every API request by its `request=` id. Many requests hit a server error and
then succeeded on a retry. Exactly one request never recovered: its last recorded status is `500`.
Which request is it?

End your reply with exactly one token in the form `logs/app.log#<request id>`, and do not use that
form for anything else. Do not change any files.
