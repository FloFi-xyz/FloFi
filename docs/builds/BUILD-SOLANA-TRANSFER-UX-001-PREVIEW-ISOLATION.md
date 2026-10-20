**Applied 2026-10-20 under the owner's release instruction:** the branch exclusion below is now in `apps/reference-dapp/vercel.json` (preferred procedure, step 2). See [the release record](BUILD-SOLANA-TRANSFER-UX-001-RELEASE.md).

# Vercel Preview isolation decision — 2026-10-19

**HOLD before push or PR. No Vercel configuration was changed.** This branch must have no connection to production PostgreSQL, including under a different tenant. Accepting the currently configured Preview is not an option.

## Evidence and limits

Read-only Vercel plugin calls `get_project` and `filter_project_envs` inspected project `flofi` (`prj_2fqdtcn7AUVmGxGswx6OAAIleIe6`). Environment values were not decrypted, displayed or pulled into this worktree. The metadata shows a single `DATABASE_URL` entry targeting **both Production and Preview**, with no branch-specific override for `claude/build-solana-transfer-ux-001`. Branch-specific Preview variables exist for two other branches only. The earlier audit identifies that shared entry as the production database; this continuation did not connect to it to inspect its identity or data.

The checked-in `apps/reference-dapp/vercel.json` selects Next.js and the existing install/build scripts; it has no branch exclusion. The preceding audit recorded Git deployments enabled and no Ignored Build Step. The current plugin project summary does not expose those full Git settings, so the owner must verify the effective settings before allowing a remote action. Treat a push as deployment-triggering until exclusion is verified.

Source explains why the shared URL is unsafe:

- `src/server/postgres-config.ts` accepts the configured URL without checking whether it belongs to production. `deploymentTenant` only changes the SQL tenant identifier to `pv-…`.
- `src/server/flow-runtime.ts` chooses an embedded backend on a hosted deployment with `DATABASE_URL`. Platform state (`src/server/platform-state-host.ts`) also uses PostgreSQL independently of financial-flow enablement. Disabling execution, MCP, channels or migrations does not establish database isolation.
- `backend/preview-migration.ts` checks database contents **after connecting**, and is invoked only for opted-in migrations. It cannot enforce a requirement to never connect to production. This branch has no migration opt-in or new migration, but runtime state can still write.
- A protected Preview URL, separate tenant, unset production alias or read-only RPC is not a database access boundary.

## Preferred procedure: exclude this branch from Git deployments

1. Obtain owner approval for an exact branch exclusion in the existing Vercel project. Review the effective Root Directory, Git settings and current configuration first. Do not disable or change production deployment behavior.
2. The smallest repository change to propose is the following **additional** property in `apps/reference-dapp/vercel.json`, preserving all existing properties. It is documented here only and has **not** been applied:

   ```json
   {
     "git": {
       "deploymentEnabled": {
         "claude/build-solana-transfer-ux-001": false
       }
     }
   }
   ```

   Vercel documents per-branch deployment exclusions and leaves unspecified branches enabled. This controls Git deployments; it does not disable manual CLI/API deployments or deploy hooks. Those remain prohibited for this branch. [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration)
3. If the owner prefers a project setting instead of a repository patch, an exact-branch Ignored Build Step can skip this branch before installation/build. Preserve any existing ignore rules. The branch predicate must return **0 to skip**, **1 to build**; test both this branch and `main` using local strings before applying it. This skips a build rather than removing every possible deployment trigger, so it needs the same prohibition on manual deployments/hooks. [Ignored Build Step behavior](https://vercel.com/kb/guide/how-do-i-use-the-ignored-build-step-field-on-vercel)
4. Record the approved mechanism and read-back of the exact branch match before any push/PR. Do not prove the exclusion by pushing an unsafe branch. After a separately authorized push, inspect deployment metadata only; a build/install/runtime start or ambiguous exclusion is a stop condition. Do not visit or exercise an unexpected Preview.

## Alternative: a dedicated Preview database and runtime

Use this only if the owner actually needs a Preview and approves provisioning and configuration. Before the first deployment:

1. Create a disposable PostgreSQL service/cluster with synthetic data, a distinct endpoint and dedicated credentials. Do not copy production records. The Preview identity must have no production database grants, production credential access or permitted production connection path. A tenant/schema in production, or another database using a production-capable role, is insufficient.
2. Add a **branch-specific Preview** `DATABASE_URL` pointing only to that service. Review project/team/integration-provided variables and build/runtime overrides for alternate PostgreSQL URLs, credentials and remote API fallbacks. Remove production API access from this branch; leave `API_BASE_URL`/`API_AUTH_TOKEN` absent or bind both to an independently isolated test API. Use fresh Preview-only session/OAuth/channel secrets and the exact Preview origin if those features are needed. No production webhook/provider credentials or live execution opt-ins.
3. Verify the effective branch override and endpoint/role identity through provider metadata and a sanitized comparison performed by the owner. Never connect to production to perform this check. Verify build-time and function-runtime selection, not just the dashboard label or local environment. Only after this passes may an owner-approved Preview deploy; then probe only the dedicated database, confirm its known identity and exercise the synthetic journey.
4. Preview branch overrides supersede generic Preview variables with the same key; configuration changes apply to future deployments, not existing ones. Any already unsafe Preview needs a separately approved retirement/access-revocation action. A redeploy is itself a deployment and requires approval. [Vercel environment-variable scopes and overrides](https://vercel.com/docs/environment-variables)

This alternative leaves other branches' inherited shared URL outside this build's remediation scope; do not silently rescope the global variable or rotate production credentials. The owner can approve a separate project-wide cleanup.

## Approval and release record

Still required: **owner choice and approval of branch exclusion or genuinely isolated Preview provisioning/configuration**, followed by evidence that it is effective. None was applied. The historical conditional authorization for one CircleCI attempt does not authorize Vercel changes, an unsafe Preview, a push/PR in this turn, or production access. Keep all of those actions on hold.

Local verification instead used a new pinned PostgreSQL container, `flofi-transfer-owner-audit-20261019`, on `127.0.0.1:29433`, with no production credentials, volumes or database. No Vercel Preview or production database was used.
