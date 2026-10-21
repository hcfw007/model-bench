# model-bench

[中文](README.md) | **English**

> ### 📊 [v1.0 rankings](rankings/v1.0.md)
>
> | # | Model | Score |
> |---|---|---|
> | 1 | `kiro/claude-sonnet-5-5` | **100.0** |
> | 2 | `volc/deepseek-v4.1-flash` | **96.3** |
> | 3 | `kiro/claude-opus-5-5` | **96.3** |
>
> 31 cases · 2026-10-22

A personal benchmark reverse-engineered from my own opencode usage: 1,053 sessions,
3,651 user turns, 60,036 assistant messages.

It does not try to be fair. It only tries to match my own workflow: a multi-service
monorepo, SOP-driven iterations, fan-out to subagents, frequent model switching,
and an absolute requirement to converge.

## Scope and limits

This is a benchmark built around my personal habits, not a general-purpose eval.
Please do not use it for cross-comparison.

**Not suitable for:**

| Use case | Why not |
|---|---|
| Comparing models against each other | The L0–L3 weights follow my own workflow (58% of my prompts are under 120 chars, 87% of sessions happen in one repo). Another team would get different conclusions |
| Comparing harnesses against each other | The runner only ships an opencode adapter and reads `opencode.db` telemetry. Claude Code / Codex / Cursor cannot run it as-is |
| Citing as an industry benchmark | Only 1,053 sessions, all from one monorepo, and rewritten for de-identification |

**Good for:**

- **Picking a model for myself**: replay the same real tasks across models and compare rework turns and tool errors, not single-item scores
- **Longitudinal regression for opencode**: after an upgrade or config change, check whether subagents, compaction, or hot model switching regressed
- **Validating rules**: turn recurring failure modes into AGENTS.md clauses, then verify the clause actually changes behavior

The conclusions are only valid for me, and only comparable within the same snapshot of configuration.

## How the cases were derived

The task shapes were not invented. They were inferred from session history:

| Real data | Design decision |
|---|---|
| 87% of sessions in one 68-service monorepo | The testbed must be multi-service and cross-stack, not single-file puzzles |
| 58% of prompts ≤120 chars, median 1 turn | Many probe-style short sessions → dedicated L0 layer |
| 64 sessions over 10 turns, longest 170 | Long-running flows are the main battlefield → L2 gets 40% |
| shell 34.7k / read 14.3k / edits 8.2k calls | Root-cause analysis starts with these tools |
| 1,296 subagent calls, 52 model switches, 24 compactions | L3 tests the harness itself |
| Tool errors concentrated in read / edit / grep | Pain-point analysis → dedicated cases |

## Scoring (deliberately unfair)

100 points, weighted by what actually costs me time:

| Layer | Weight | What it measures |
|---|---|---|
| L0 Channel | 10 | Connectivity, instruction following, refusal of dangerous commands, language discipline |
| L1 Single-point | 20 | Cross-service localization, minimal edits, evidence gathering, not over-claiming |
| L2 Pipeline | 40 | End-to-end SOP execution; the metric is rework turns |
| L3 Harness | 25 | Subagent fan-out / two-level nesting, compaction recall, permission boundaries, tool-failure recovery |
| Cost | 5 | Tokens and duration, tie-breaker only |

Scores are reported per layer because they answer different questions:

- `L0 + cost` → can I adopt a new provider at all (I ran 22 such probes by hand)
- `L1 + L2` → which model reworks less on the same task
- `L3` → did opencode regress after an upgrade

## Why scoring is fully automated

opencode already persists every turn. After each case, the runner reads
`session_v2` / `session_message` from `~/.local/share/opencode/opencode.db` and gets:

- every tool call's name, input, and status (`completed` / `error`)
- turn index, model, token counts, agent name
- `parent_id` chains → the subagent tree, and whether children overlapped in time
- `compaction` / `model-switched` events

That yields three assertion families, all programmatic:

1. **Artifacts**: changed file set, diff size, required/forbidden symbols, `go build` / `go test` / `tsc` results
2. **Trajectory**: tool call sequence, read failures, subagent count and parallelism, turn count, forbidden commands
3. **Text**: required IDs, forbidden over-claiming phrases (regex blacklist with negation-context exemption)

All 31 cases use hard assertions. There is no LLM judge — anything requiring subjective
scoring stays out of this benchmark. See `judges/README.md`.

## Layout

```
bench.config.jsonc      models, layer switches, concurrency
mockrepo/               de-identified monorepo (git submodule)
  go-projects/            Kratos-style layering, realistic shape, zero dependencies
  ts-projects/            NestJS / React directory shapes
  .tasks/                 cross-session state files
cases/l0..l3/           one json per case (prompt + env + assertions + weight)
runners/                orchestration / collection / scoring
judges/                 assertion-boundary notes
fixtures/               synthetic logs, mongo documents, case trees
reports/                conclusion documents (run baselines are gitignored and regenerable)
```

## Rankings

Historical results live in [`rankings/`](rankings/). Case sets and weights differ between
versions, so scores are not directly comparable.

| Version | Cases | Released | Ranking |
|---|---|---|---|
| v1.0 | 31 | 2026-10-22 | [View](rankings/v1.0.md) |

Current config version: `v1.0.0` (`bench.version` in `bench.config.jsonc`).

## Running it

```bash
git clone --recursive https://github.com/hcfw007/model-bench.git
cd model-bench
node runners/selftest.ts                       # validate assertions and scoring
node runners/run-bench.ts --dry-run            # validate all 31 cases
node runners/run-bench.ts --layers l0 --models pro-opus,flash-sonnet
```

No `npm install` needed. It only uses Node built-ins (`node:sqlite` and type stripping).

Results land in `reports/<timestamp>/leaderboard.md` and `failures.md`.

Per-case status and known limits live in [`reports/COVERAGE.md`](reports/COVERAGE.md).

## Known calibration points

Two calls in `runners/lib/runner.ts` depend on the real opencode CLI surface:

1. `opencode run -m <provider/model#variant> "<prompt>"` — model argument format
2. `opencode run --session <id> "<msg>"` — resuming a session

Also, `bench.config.jsonc` references tier files via `{file:~/.config/opencode/models/pro}`.
If those files do not exist, put `provider/model` directly in the config.

## Safety boundary

`mockrepo` is a fresh local git repository with no real remote. Every case enforces:

- no `git push` / `git push --force`
- no calls to real broadcast or messaging endpoints
- no writes to `~/.config/opencode`, business repositories, or `~/.claude`

Any violation zeroes the run and marks it `VIOLATION`; it never reaches the leaderboard.
