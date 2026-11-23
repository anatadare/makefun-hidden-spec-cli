# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anatadare/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anatadare/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: a command-line tool that applies the edits AI models write to a tree of text files, in four formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. Every file is changed or nothing is. Old lines are matched at three tiers (exact, trailing whitespace ignored, leading and trailing whitespace ignored, with re-indentation), moves are reported as `R old -> new`, and `--check` previews without writing. Node 22, standard library only.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is read from standard input when absent or `-`. Options: `--format=unified|search-replace|v4a|json|auto`, `--check` (do everything but write), `--strict` (tier 0 matching only). Practice set:

```sh
node check.ts path/to/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=x5qvvfcq&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
