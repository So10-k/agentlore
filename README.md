# agentlore

**Memory for Claude Code and Codex.** Your agents learn from your corrections, pick up where the last session left
off, and you can measure whether it's working.

```bash
npm i -g agentlore
lore install            # Claude Code
lore install --codex    # Codex (then trust the hooks with /hooks)
lore backfill           # turn this project's recent sessions into handoffs
lore score              # your baseline
```

## Why

Coding agents forget everything between sessions, and you pay for it twice. Here's one developer's real history
(92 sessions, measured with `lore score`):

| | |
|---|---|
| Context re-sent with **every** request | **344K tokens** on average |
| Requests made with over 200K of context | **64%** |
| Sessions that opened by re-explaining earlier work ("Continue X. Read CLAUDE.md, then the handoff doc…") | **10%** |
| Instructions typed again in a later session ("don't commit until I say", "never stage launch.json") | yes, every time |

Sessions run for days because starting fresh means re-explaining everything, and every message in a 400K session
re-sends all 400K. Corrections are forgotten, so they get made again. The usual fix is a giant CLAUDE.md, sent with
every request whether it's relevant or not.

agentlore makes a fresh session cheap and keeps what agents learn.

## 1. Lessons: agents learn from your corrections

When you correct your agent ("no, don't use inline styles", "never add a Co-Authored-By line to commits"), a hook
spots it and asks the agent to save it as a lesson, with the files or commands it applies to:

```bash
lore learn "Spacing comes from theme tokens, never raw px" --scope "src/ui/**, *.css" --why "the design system owns spacing"
```

Lessons live in `.lore/lessons.md`. It's plain Markdown, meant to be committed and reviewed like code:

```markdown
## Use pnpm, never npm
- scope: bash:npm, package.json
- why: the repo is a pnpm workspace; npm writes a stray package-lock.json
- learned: 2026-10-25 (claude)
- reinforced: 2
- id: Lf7bc77
```

**Each lesson is shown only when it applies.** The scope decides when:

| Scope | Shown |
|---|---|
| *(none)* or `*` | At every session start |
| `src/ui/**`, `*.tsx`, `package.json` | Just before the agent reads or edits a matching file (gitignore-style globs) |
| `bash:git commit` | Just before a matching shell command |

Each lesson appears once per session, and again after a compaction (which forgets it). Being taught the same thing
twice reinforces the existing lesson instead of duplicating it; the reinforcement count is the "memory failed" signal.
Use `--user` for preferences that follow you across projects (stored in `~/.agentlore/lessons.md`).

**This is how agents get better at design:** design feedback ("cards never get shadows", "use the 8pt grid") becomes
a lesson scoped to your UI files, and it's in front of the agent every time it touches one.

## 2. Handoffs: fresh sessions that know what happened

Whenever a session compacts, you `/clear`, or it ends, agentlore writes a handoff to `.lore/handoffs/`, built
directly from the transcript:

```markdown
# Add dark mode
- **When:** Oct 20, 10:00 → 11:42 · claude · session 3f2a9c1e
- **Size:** 128 requests · peak context 468K · branch `feat/dark-mode`

## What the user asked          ← verbatim, corrections marked ⚑
## Where it ended               ← the agent's last message
## Summary                      ← the agent's own compaction summary, when there was one
## Files changed
## Checks (last run of each)    ← ✓ / ✗ for test, build and lint commands
## Still open                   ← unfinished items from the agent's task list
```

The next session's brief lists recent handoffs in one line each, and the agent runs `lore recall 2` (or
`lore recall dark mode`) to load one: about 1K tokens instead of a 400K-token session. When a conversation passes
200K tokens, agentlore tells you (not the agent) that starting fresh is now cheap.

Handoffs quote your prompts, so `.lore/handoffs/` is gitignored by default. Secrets are redacted.

**Claude Code and Codex share it:** a session in one shows up in the other's brief.

## 3. The scoreboard: is it working?

```
 agentlore score · last 30 days · 92 sessions
                                                   before   since install
 Context re-sent per request                         344K
 Requests over 200K context                           64%
 Peak context per session (median)                   214K
 Re-exploration at session start                 4.5K tok
 Sessions opened by re-explaining                     10%
 Corrections per session                             0.32
 Instructions you had to repeat                         3
```

Everything is measured from your transcripts, before and after `lore install`. "Instructions you had to repeat"
lists each one, and each is a lesson waiting to be saved.

## Also included

- **Output compressor** (Claude Code): noisy test, build, lint and install output is cut by 88% on
  [real tool output](bench/), with every failure message kept. File contents, diffs and search results are never
  touched. Full output is saved to `~/.agentlore/logs`. Turn it off with `lore install --no-compress`.
- **`lore scan`**: where your tokens go (tool output, noisy commands, waste patterns), with fixes.

## What agentlore costs

- **Session brief:** about 150 tokens with no lessons, and 15 lines at most with many.
- **A scoped lesson:** about 30 tokens, only when it's relevant.
- **A correction nudge:** about 80 tokens, only on messages that look like corrections.
- **Everything runs locally:** nothing leaves your machine. Hook errors are logged to `~/.agentlore/errors.log` and
  never block the agent.

## Codex

`lore install --codex` writes `~/.codex/hooks.json`. Codex runs hooks only after you trust them: open Codex and run
`/hooks`. Lessons, briefs, nudges and handoffs work the same in Codex. The compressor doesn't, because Codex only
accepts rewritten commands together with an automatic approval, which agentlore never grants. Use
`lore run -- <command>` there instead.

## Honest caveats

- **Correction detection is a heuristic** that decides when to *ask* the agent. The agent decides whether something
  is worth a lesson, and a false alarm costs about 80 tokens.
- **Lessons are only as good as their wording.** Edit `.lore/lessons.md` freely.
- **"Where it ended" in a handoff** is the agent's last message, so it's most useful when the session ended on a
  summary.
- **Codex support** is built on Codex's documented hook format and tested with Codex-shaped events and real Codex
  transcripts. It hasn't yet been run inside a live Codex session.

## Commands

```
lore install [--codex] [--settings project|local] [--no-compress]    lore uninstall [--codex]
lore learn "<rule>" [--scope ...] [--why ...] [--user]               lore lessons    lore forget <id>
lore recall [n | words]    lore handoff [--transcript <path>]        lore backfill [--days 14]
lore score [--days 30]     lore scan [--days 30]    lore brief       lore stats
lore run -- <command>      lore filter [--cmd <c>]
```

## Development

Node 18 or later, zero dependencies. `npm test` runs 41 tests, including real tool-output fixtures and a full
hook-to-handoff run. `bench/make-fixtures.sh` regenerates the compressor fixtures.

MIT licensed.
