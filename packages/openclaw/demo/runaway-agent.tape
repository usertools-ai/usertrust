# VHS tape — runaway-agent governance demo for usertrust.ai
# Render from repo root:  vhs packages/openclaw/demo/runaway-agent.tape
# Requires: brew install vhs
#
# THE GEOMETRY IS DERIVED, NOT EYEBALLED.
#
# This recording is embedded on usertrust.ai as the counterfactual replay, in a
# column ~741px wide at a 1512 viewport. The type has to clear the site's 12px
# rendered-glyph floor THERE, not in the raw file: a glyph's rendered size is
# `FontSize x (displayed width / recorded width)`, so the only lever that
# matters is the COLUMN COUNT. An early cut recorded ~135 columns to keep the
# longest line on one row, and its type landed at ~8px over that column —
# unreadable without leaning in.
#
# Wrapping the long BLOCK line is explicitly blessed, which frees the frame to
# be narrow. 79 columns is the choice, and it is a choice. The BLOCK line is
# 213 characters (the deny reason AND the high-cost warning the same evaluation
# raised), so it wraps to three rows, and a terminal wraps at the column edge
# without caring about words. 79 is the narrowest column count at which BOTH
# breaks land on a space — after "...drive remaining budget below zero;" is not
# where they fall, but after "...Deny pre-spend when " and after
# "[warn-high-cost]" is: a sentence continuing, never a word torn in half.
# (74, the previous count, tears "[warn-high-cost]" into "[warn-" + "high-cost]".
# The next clean counts are 89 and 94, and both drop the rendered type toward
# the floor for no gain.) No other line in the demo exceeds 79 columns.
#
# Width/Height are pixels, and the terminal grid they produce is a floor
# division the renderer does internally — so both numbers were measured with
# `tput cols` / `tput lines` against this exact FontSize, Padding and WindowBar
# rather than computed from a font metric:
#   Width  1590 -> 79 columns  (1580 is the first width that yields 79; 1600 gives 80)
#   Height 1104 -> 25 rows     (1090 yields 25; 1080 gives 24 and 1130 gives 26)
# Both sit mid-band so a renderer or font update cannot flip them by a pixel,
# and both are even, which h264 requires.
# 25 rows is 24 rows of content (command, the demo's output with the BLOCK line
# wrapped to three, and the returned prompt) plus one, so the frame FILLS
# without scrolling the header off the top. Nothing downstream crops it.
#
# Re-measure both if FontSize, Padding or WindowBar changes — or if the demo's
# output grows a line. The site's aspect-[1590/1104] box in exhibit-c.tsx is
# this frame's own aspect and moves with it.
#
# NO GIF OUTPUT. The tape used to also write packages/openclaw/demo/runaway-agent.gif,
# which nothing reads: the site embeds the mp4/webm pair and this directory's
# README embeds nothing. At this frame size the gif is the largest artifact of
# the three, and it would land untracked in a public repo. Add it back only
# with a consumer.

Output site/public/demo/runaway-agent.mp4
Output site/public/demo/runaway-agent.webm

Set Shell "bash"
Set FontSize 30
Set Width 1590
Set Height 1104
Set Padding 24
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 45ms
Set Theme { "name": "usertrust", "background": "#0a0a1a", "foreground": "#ebebeb", "cursor": "#34d399", "black": "#1a1a2e", "red": "#ef4444", "green": "#34d399", "yellow": "#f59e0b", "blue": "#6ca0c0", "magenta": "#c084fc", "cyan": "#7dd3fc", "white": "#ebebeb", "brightBlack": "#555570", "brightRed": "#f87171", "brightGreen": "#6ee7b7", "brightYellow": "#fbbf24", "brightBlue": "#93b8d8", "brightMagenta": "#d8b4fe", "brightCyan": "#bae6fd", "brightWhite": "#ffffff", "selection": "#2d2d50" }

# Pace the demo output for readability (presentation-only knob in the script).
# One fused command: a hidden `clear` on its own Enter leaves the export's own
# echo on screen for a frame, and VHS has no way to un-draw it.
Hide
Type "export DEMO_PACE_MS=700 && clear"
Enter
Show

Sleep 800ms
Type "npx tsx packages/openclaw/demo/runaway-agent.ts"
Sleep 700ms
Enter
# demo runs ~6s with pacing (npx/tsx startup + 4 paced calls + ledger)
Sleep 10s
# hold the final ledger frame
Sleep 4s
