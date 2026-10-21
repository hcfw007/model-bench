# Rankings

[中文](README.md) | **English**

Historical results for model-bench. Each version corresponds to a frozen set of cases
and weights. Scores are not comparable across versions.

## Version rules

| Change | Action |
|---|---|
| Add a model, rerun the same cases | Update that version's table, keep the version number, note the rerun date |
| Add/remove cases, change assertion semantics | Bump minor (1.0 → 1.1) |
| Change layer weights or scoring | Bump minor and note it in the table |
| Restructure the testbed incompatibly | Bump major (1.x → 2.0) |

Once a version is published, its case set and weights are frozen. To change the tasks,
open a new version instead of editing historical tables in place.

## Versions

| Version | Cases | Released | Link |
|---|---|---|---|
| v1.0 | 31 | 2026-10-22 | [v1.0.md](v1.0.md) |

## Adding a model

```bash
# 1. add an entry to models in bench.config.jsonc
# 2. run the full set under the same version
node runners/run-bench.ts --models <model-id> --out reports/<date>-<model>

# 3. merge into that version's aggregate
node runners/merge-results.ts reports/<version-run-dir> reports/<date>-<model>

# 4. re-render and update the version markdown by hand
node runners/render-report.ts reports/<version-run-dir>
```

If a model has not run a given version, leave its column empty. Never fill it with
scores from another version.
