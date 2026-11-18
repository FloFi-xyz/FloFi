# Agent Evolution

Run `python3 scripts/agent_evolution.py --base origin/main` from the repo root.
The JSON compares the given ref's merge base with the working tree, including
untracked files. CircleCI publishes the report in the governance job after the
existing gate. Review the highlights in the PR and record which knowledge
changed, which claims still hold, and any open gaps. Use `agent_guard.py impact`
and `agent_guard.py domain` to select reviewers and the relevant skills and
suites. Keep at most three specialists active and give each the relevant diff.

| Report field | Disposition |
| --- | --- |
| `capabilityCandidates`, `capabilityCandidatesWithoutSkillMatch` | Inspect action/adapter/chain identity, stage support, deployment gates and evidence ceiling. Check whether existing guidance covers the changed behavior and whether it can be found by path. |
| `sourceChanges`, `roleChanges`, `engineeringDocChanges` | Compare current source and tests with the role and engineering guidance. Remove obsolete claims, or record why existing guidance still holds. A changed document does not resolve the signal by itself. |
| `regressionChanges`, `unlinkedChangedTests`, `missingSuites`, `suiteContractChanges`, `requiredSuiteChanges`, `coverageGaps` | Read the affected assertions. Preserve required cases, map relevant regressions or record the gap, and capture reusable failure modes in the most relevant guidance. |
| `inventoryChanges`, `missingOwners`, `staleOwners` | Review exact source ownership, dependencies and suite links in `coverage.json` with the affected domains. Regenerate `COVERAGE.md` after reviewed edits. |
| `suggestedSkills`, `skillReviewDomains`, `skillReviewNotes`, `upstreamActions` | Check scope, applicability, provenance and license with the registered owners. Selection uses every changed path, including new files and tests. The report lists missing owners independently. Inspect changed and unavailable sources and treat pending references as leads until reviewed. |
| `claudeParity` | Inspect `agent_guard.py claude-agents`, review the proposed diff, regenerate with `--overwrite`, then run the guard. |

The report uses local Git, the existing inventory, path patterns, registry
metadata and the supplied review date. It reads no application state, test
results or agent sessions. It flags where to check semantics. It cannot infer
changed capabilities, determine whether prose is correct, recover a missing
base, or replace required tests and certification. On a source-only Cloud
Build snapshot, use `--inventory` or run the comparison in the original
checkout. To reproduce the same date-dependent results, pass `--as-of YYYY-MM-DD`.

## Weekly maintenance

1. Use a clean checkout of current `origin/main` and the last audited main
   revision for the comparison. Review intervening merged PRs, ADRs and
   incident fixes for lessons beyond path matches. If the last audited revision
   is unavailable, do the inventory and record the missing diff.
2. Run the upstream verifier and combine its result with the current inventory.
   Keep the reports in a temporary directory and review their contents before
   attaching them to an issue or PR.

   ```sh
   review_dir=$(mktemp -d)
   python3 scripts/agent_guard.py check
   python3 scripts/skill_registry.py verify
   python3 scripts/skill_registry.py check-upstream --fetch \
     --proposal "$review_dir/upstream-proposal.json" > "$review_dir/upstream.json"
   python3 scripts/agent_evolution.py --inventory \
     --upstream-report "$review_dir/upstream.json" > "$review_dir/inventory.json"
   python3 scripts/agent_evolution.py --base LAST_AUDITED_MAIN_SHA \
     --upstream-report "$review_dir/upstream.json" > "$review_dir/changes.json"
   ```

3. Assign the open findings to affected domains. The verifier enumerates all
   registered network, protocol, operation and engineering skills. Check
   publisher release notes
   and source history for newer revisions because a digest for a pinned commit
   only checks that commit. Investigate unavailable responses and mutable pages
   before changing pins. Review facts and licensing independently, write
   FloFi-specific guidance, and record the reviewed revision, date and digests.
   The proposal contains observations for a human reviewer.
4. Record the audited SHA and disposition, including open work and evidence
   gaps. Use the normal branch, PR and CircleCI process for reviewed changes.
   Run the installed CLI probes after a role or harness change.

## Optional scheduling

The manual procedure uses existing tooling and public reference URLs. An
owner-managed CircleCI schedule would require a separate decision about the
trigger, runner budget, repository checkout, outbound HTTPS and report access.
If approved, run the weekly commands in a dedicated report-only workflow and
publish only the reviewed metadata. Keep that workflow independent of PR
certification, and give it no production credentials or repository write
permissions. This build adds no scheduled workflow.
