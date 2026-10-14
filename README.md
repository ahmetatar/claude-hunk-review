# hunk-review

A review pane for [Claude Code](https://code.claude.com). Let Claude write, then go through what it changed **hunk by hunk**: accept what is good, undo what is not, and leave comments on single lines that Claude can act on.

It is a Claude Code *mod* (a function-hooks plugin), so it lives inside the terminal session: no editor, no extra window. Review state is part of the Claude session, which is what lets comments reach Claude.

> **Early access.** Claude Code's mod API is early access and may change between releases. Built and tested against Claude Code 2.1.296.

## Install

In a Claude Code session:

```
/plugin install hunk-review --marketplace <owner>/<repo>
```

(`<owner>/<repo>` is the GitHub repository that holds this project.) Answer `y` to add the marketplace and pick a scope. To try it from a checkout without installing:

```
claude --plugin-dir /path/to/claude-hunk-review
```

Requirements: a git repository, and a terminal wide enough for the pane (about 110 columns for a docked pane).

## Use

Open the pane with **`/hunks`**. (`/review` is a built-in Claude Code command, so this one is named differently.) `/hunks demo` opens it on fixture data without needing any changes.

While Claude works the list updates live. When a turn leaves changes you get a toast, and the status line shows the pending count.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous hunk |
| `n` / `p` | move the line cursor inside the hunk |
| `s` / `w` | scroll a long hunk |
| `a` / `u` | accept / undo the hunk |
| `f` / `d` | accept / undo the whole file |
| `y` / `r` | accept all / undo all (`r` asks for a second press) |
| `z` | restore the last undo |
| `c` | comment on the cursor line (Enter saves, Enter on empty cancels) |
| `x` | resolve the comments on this hunk |
| `m` | send all open comments to Claude |
| `e` | put them in the prompt box to edit first |
| `g` | refresh |
| `q` | close the pane |

Esc hands the keyboard back to the prompt without closing the pane. Click the pane or use `ctrl+x tab` to return to it.

### Comments

A comment is about **one line**. Move the cursor with `n`/`p`, press `c`, type, press Enter. The comment shows under its line and the hunk is marked `✎` in the list.

`m` (or `/hunks send`) sends every open comment as one prompt. Each comment names the exact line (`src/server.js:53`), quotes that line and its hunk with the line marked, and asks Claude to change only what the comment says. `e` (or `/hunks fill`) puts the same text in the prompt box so you can edit it.

- Comments are stored per repository and survive restarts.
- They stay after sending, marked `sent`, and can be sent again.
- Accepting a hunk (or file, or all) resolves its comments. Undo keeps them.
- If Claude edits the hunk again, the comment follows it to the new hunk and line. If it cannot, it stays, detached, with the hunk it quoted.

### Commands

| Command | |
| --- | --- |
| `/hunks` | open the pane |
| `/hunks send` / `/hunks fill` | send the open comments / put them in the prompt box |
| `/hunks comments` | list open comments |
| `/hunks clear` | delete resolved comments |
| `/hunks restore` | restore the last undo |
| `/hunks refresh` / `status` | recompute / print the summary |
| `/hunks demo` | open the pane on sample data |

### Options

Set in `/config` (or `pluginConfigs` in settings):

| Option | Default | |
| --- | --- | --- |
| `theme` | `tokyo-night` | code view colors: `tokyo-night`, `catppuccin`, `dracula`, `github-light` |
| `autoOpen` | off | open the pane when a turn leaves changes |
| `liveRefresh` | on | refresh after each file-changing tool call; turn off in very large repos |
| `injectComments` | off | attach comments you have not sent yet to your next typed prompt, as hidden context |

## How it works

- **Baseline.** At the start of a turn with nothing pending, the mod records the working copy as a git *tree object* (built in a private index, so your staging area is untouched) and keeps it alive with `refs/claude-hunk-review/base`. The review is the diff from that tree to the working copy, so it catches anything that changed files, shell commands included, and ignores your own earlier uncommitted work.
- **Undo** reverse-applies that one hunk to the working copy with `git apply -R`. The patch is saved first, so `z` can put it back.
- **Accept** applies the hunk to the baseline tree. Nothing is committed and your files are not touched.
- Nothing is written to your index, branches or stash. Remove the review state with `git update-ref -d refs/claude-hunk-review/base`.

## Limits

- Needs a git repository. Files ignored by git are not reviewed.
- Reviews working-copy content only, not file moves as renames (they show as a delete plus an add).
- The syntax highlighter is a small line-by-line one, tuned for the common languages (JS/TS, Swift, Python, Go, Rust, JSON, CSS, HTML, Markdown and similar).

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .          # hot-reloads on save; reopen /hunks after changes
```

Pure logic (diff parsing, highlighting, comments) is in `hooks/diff.ts`, `hooks/highlight.ts` and `hooks/comments.ts` and is covered by the tests; git access is in `hooks/git.ts`; the pane is in `hooks/register.tsx`. See [PLAN.md](PLAN.md) for status and decisions.

## License

MIT
