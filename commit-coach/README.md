# commit-coach

Catches the `git commit` calls Claude makes and fixes two things before they land:

1. **Attribution.** `Co-Authored-By:` trailers and `🤖 Generated with ...` lines are taken out of the message. Claude is also no longer told to add them, so they mostly stop showing up at all.
2. **Lazy subjects.** A subject like `fix`, `wip`, `update`, `stuff`, a single word, anything over 72 characters, or anything without a conventional prefix (`feat|fix|chore|docs|refactor|test|perf|build|ci|style`) is rewritten from the actual diff by a fast model:

```
commit-coach: 'fix' → 'fix(scheduler): handle empty slot list'
```

Your own body is kept if you wrote one; the model only adds a short body when there was none. If the model's answer is not a clean conventional subject of 72 characters or less, your message goes through as it was, and a toast says so.

It reads every way a message gets into a commit: `-m`, several `-m`, `-m"..."`, `--message=`, `-am`, `$'...'`, the `-m "$(cat <<'EOF' ... EOF)"` heredoc agents like to use, `-F file`, and `-F -` fed by a heredoc. The new message goes back in as plain single-quoted `-m` arguments; everything else in the command (`git add -A && ... && git push`) is left exactly as it was.

It leaves a commit entirely alone while a merge is in progress (`MERGE_HEAD` exists), for `--amend` without a new message, `-C`/`-c`/`--fixup`/`--squash`, and when the shell builds the message at run time (`"$MSG"`, `"$(git log ...)"`). Subjects starting with `Merge `, `Revert "`, `fixup!` or `squash!` are never rewritten.

## Install

```sh
claude --plugin-dir ./commit-coach
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

| option | default | what it does |
| --- | --- | --- |
| `stripAttribution` | `true` | Remove `Co-Authored-By:` and "Generated with" lines, and empty the commit attribution text Claude is given. Note: this strips every `Co-Authored-By:` trailer, a human pair's included. |
| `rewriteSubjects` | `true` | Rewrite lazy subjects from the diff. |
| `model` | `haiku` | The model that writes the new subject: an alias or a full model id. |

## How it works

A `tool.call` hook on Bash lexes the command (keeping each token's position), reads the commit message, and when it needs a new subject runs `git diff --cached` (or `git diff HEAD` after `-a` or a `git add` in the same command) and asks `$.model.complete`; it then calls `next({ ...e, command })` with the rewritten command, and adds a note to the result so Claude knows the new message is intended and doesn't amend it back. An `attribution.text` hook for `commit` answers an empty string.

Only the first `git commit` in a command is coached.
