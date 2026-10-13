# claude-hunk-review: Claude Code mod plan

A Claude Code mod that gives a terminal-native, Copilot-style review of the changes Claude made:
a side pane with per-hunk Accept / Undo / Comment, bulk actions, and **comments that persist and can be re-sent**.

## Why (findings from the Warp trial, 2026-10-13)
- Warp's Code Review panel: hunk revert works (needs a save to reach disk), but there is no "accept" notion.
- Warp comments are sent via "send to agent" as a plain prompt into the chat box, then vanish from the file.
  Editing the prompt afterwards leaves no way to re-run the comments.
- Warp's review state lives outside the Claude session, so Claude cannot see it.
- Goal: review state lives *inside* Claude Code, so Claude can read/re-read it.

## What the mod API gives us (verified in this build's `claude-code.d.ts` / reference.md)
| Need | API |
|---|---|
| Side pane, focusable, keyboard | `$.ui.open({ id, title, focus })`, `ui.render` hook on `Pane` |
| Hunk diff rendering | `<Code format="diff" source=... />` (unified diff, native highlighting) |
| Buttons / hotkeys | `<Button hotkey onPress>`; `Input` for comment text; `Select` |
| Run git | `$.process.run({ argv })` |
| Read/write files | `$.fs` |
| Persist across turns/sessions | `$.state` (session), `$.store` (cross-session) |
| Detect Claude's turns | `turn.start`, `turn.complete`, `tool.call` hooks |
| Put text in the prompt / start a turn | `$.prompt.fill({ text, mode })`, `$.prompt.submit({ text })` |
| Slash commands | `$.command.register` + `command.run` |
| Status line / toast | `$.ui.status`, `$.ui.toast` |

Constraints: pane seats from ~110-144 columns (narrower terminals will not open it unasked);
module has no Node, everything goes through `$`; Bash-made edits are not seen by `tool.call`
hooks, so the diff source must be git, not tool hooks.

## Design
**Baseline = snapshot at turn start.**
At `turn.start`, if no review is pending, record a baseline tree of the working tree
(temp index + `git add -A` + `git write-tree`; no commits, no stash, `.gitignore` respected).
Review diff = baseline tree vs. current working tree, so only what Claude changed since the baseline
shows up, not older uncommitted work. Catches Bash edits too.

**Hunk model.** Parse `git diff <baseline> --` into files and hunks. Identity = `file + hash(hunk body)`.
- **Undo hunk**: `git apply -R` of just that hunk's patch (refuse + toast if it no longer applies).
- **Accept hunk**: add its identity to the accepted ledger (hidden from the list). v2: fold into baseline.
- **Accept all / Undo all / per file**.
- **Comment**: text attached to the hunk identity, stored in `$.store`, survives turns and restarts.

**Comments that persist (the thing Warp lacks).**
- `/hunks send` builds one prompt from all open comments (file, line range, the hunk, the comment)
  and submits it; `/hunks fill` puts it in the prompt box to edit first.
- Comments stay until resolved/deleted, so they can be re-sent any number of times.
- After Claude's next turn the hunk is re-matched by file and nearby context; if the hunk changed,
  the comment is marked "needs re-check" instead of silently dropping.

**UI sketch (pane).**
```
Review: 3 files, 7 hunks   [A]ccept all  [U]ndo all  [S]end comments (2)
> src/server.js  (+34)
    @@ -5,6 +5,14 @@  middleware          [a]ccept [u]ndo [c]omment
    <Code format=diff ...>
    💬 "log the request id too"
```
Keys: j/k move, a/u/c act, Enter expand, s send comments.

## Milestones
1. **M0, spike (half day):** empty mod that opens a pane via `/hunks`, renders a static `Code format=diff`,
   one Button, and an Input. Confirms interactivity (focus, hotkeys, text entry) works in Warp.
   Kill criterion: if Input/Button focus is unusable in the pane, fall back to slash-command-driven UI.
2. **M1, read-only review:** baseline at `turn.start`, diff parsing, file/hunk list, live refresh on
   `turn.complete`, status line count.
3. **M2, actions:** per-hunk Undo (`git apply -R`), Accept ledger, bulk actions, conflict handling.
4. **M3, comments:** add/edit/delete, `$.store` persistence, `/hunks send` and `/hunks fill`,
   re-match logic after edits.
5. **M4, polish:** keyboard map, narrow-terminal fallback (inline list via `/hunks` output),
   large-diff paging, `/hunks baseline reset`, tests with `claude plugin test`.
6. **M5, optional:** fold accepted hunks into baseline; PreToolUse "ask Claude to read open comments"
   hook so Claude auto-sees unresolved comments at the start of each turn.

## Repo layout
```
claude-hunk-review/
  PLAN.md
  README.md                      (later)
  .claude-plugin/plugin.json
  .claude-plugin/marketplace.json (to share via /plugin install)
  hooks/hooks.json
  hooks/register.tsx             (events, pane render)
  hooks/git.ts, hooks/diff.ts    (baseline, parse, apply)
  hooks/*.test.ts
  types/index.d.ts               (state contract)
```
Develop in this repo; load with `claude --plugin-dir ~/Desktop/Repos/claude-hunk-review`
(hot-reloads on save). Test target: `~/Desktop/Repos/warp-review-demo`.

## Risks / open questions
- Pane interactivity details (Input focus, key capture) are unverified until M0.
- `$.process.run` env support for the temp `GIT_INDEX_FILE` (else use `sh -c` with env prefix).
- Hunk identity drift after Claude edits the same region again.
- Hot reload resets module variables, so all review state must live in `$.state`/`$.store`.
- API is "early access" per the docs and may change between releases.

## Decisions needed from the owner
1. Accept semantic: ledger-only (v1) vs. fold into baseline (more correct, more work)?
2. Should unresolved comments be auto-injected into Claude's next turn, or only on explicit `/hunks send`?
3. Share publicly later (marketplace file) or keep personal?
