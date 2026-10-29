# Records docs/demo/agemon.gif from the repository root; see docs/demo/README.md.
Output docs/demo/agemon.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Type "npm run -s sandbox -- run clean-repo --dry-run --skip-daemon --only skills,cli-tool"
Sleep 500ms
Enter
Sleep 7s
Type "npm run -s sandbox -- roundtrip clean-repo --skip-daemon --quiet"
Sleep 500ms
Enter
Sleep 9s
