The nightly settlement job starts at `runNightlySettlement` in `src/jobs/nightly.js`. On the path
that job really takes, which function calls `postAdjustment` directly? Several functions call
`postAdjustment`; check the calls the job actually makes, and do not trust names alone.

End your reply with exactly one token in the form `path/to/file.js#functionName`, and do not use
that form for anything else. Do not change any files.
