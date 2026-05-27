# Paperclip on Render — Deployment Runbook

This runbook hosts the Paperclip control plane on Render so the
Infrakaihatsu admin portal (`infrakaihatsu.com/admin/paperclip`) can
talk to a real upstream 24/7. It pairs with `render.yaml` at the repo
root.

> Wave 1 scope: blueprint + runbook only. No code in this repo is
> deployed by Claude; an operator (Gus) applies the blueprint in the
> Render dashboard.

## Architecture summary

- **Web service** `paperclip` — Docker, oregon, starter plan,
  health check `/api/health`.
- **Managed Postgres** `paperclip-postgres` — starter plan, oregon,
  PG 16. Connection string injected as `DATABASE_URL`.
- **Persistent disk** `paperclip-home` — 10 GB mounted at
  `/paperclip`. Backs the secrets master key, the local-disk storage
  provider, and the agent workspace cache. Without this disk, the
  encrypted-secrets vault is rebuilt from scratch on every restart.

## Auth model — why there is no env service token

Paperclip's API middleware
(`server/src/middleware/auth.ts`) recognises three actor flavors:

1. **`local_trusted`** — implicit board user (only usable when
   `PAPERCLIP_DEPLOYMENT_MODE=local_trusted`; not used in this
   deployment).
2. **Better Auth session cookie** — set by `/api/auth/*` after a
   user signs in through the UI.
3. **Board API key** — bearer token stored sha256-hashed in
   `board_api_keys`. Created from inside the UI (or via the CLI
   challenge flow) once an `instance_admin` exists.

There is **no `PAPERCLIP_SERVICE_TOKEN` env var read by Paperclip
itself**. The variable of that name on the Infrakaihatsu backend
holds a **board API key** that an operator mints after onboarding.
Board API keys expire after 30 days
(`BOARD_API_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000` in
`server/src/services/board-auth.ts`) — rotation is mandatory.

## Pre-deploy checklist

Before pushing the `render.yaml` to Render, the operator needs the
following values ready to paste in the dashboard (each one is
`sync: false` in the blueprint):

| Env var | How to generate | Notes |
|---|---|---|
| `PAPERCLIP_SECRETS_MASTER_KEY` | `openssl rand -base64 32` | 32-byte key. Stored once; rotating it invalidates every secret in the vault. Save to a password manager. |
| `PAPERCLIP_API_URL` | Render assigns after first deploy | Paste the final `https://paperclip-<hash>.onrender.com` URL back into this env on a second redeploy. Better Auth and agent JWT issuance need a stable public URL. |
| `ANTHROPIC_API_KEY` | Anthropic console | Required for Claude-Local adapter runs. |
| `OPENAI_API_KEY` | OpenAI console | Required for Codex-Local adapter runs. |

The Infrakaihatsu backend env trio (`PAPERCLIP_API_URL`,
`PAPERCLIP_SERVICE_TOKEN`, `PAPERCLIP_COMPANY_ID`) is filled in
**after** the first successful onboarding pass — see Cutover below.

## Deploy

1. Confirm `render.yaml` is committed and pushed to the **repo
   configured in render.yaml's `repo:` field**. Codex round-5 found
   the placeholder `gqanalema/paperclip` did not exist; the file now
   points at `paperclipai/paperclip` with a comment instructing Gus
   to fork to a repo Render has access to before applying the
   blueprint. The runbook intentionally does not hardcode an org/name
   here — read `render.yaml` for the current value.
2. In Render dashboard → **Blueprints** → **New Blueprint Instance**,
   point at the repo. Render reads `render.yaml`, prompts for the
   `sync: false` env values, and creates both the web service and
   the Postgres database in one transaction. The `sync: false` envs
   to fill at this point are:

   - `PAPERCLIP_SECRETS_MASTER_KEY` — `openssl rand -base64 32`
   - `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — provider keys
   - `PAPERCLIP_API_URL`, `PAPERCLIP_PUBLIC_URL`,
     `PAPERCLIP_AUTH_PUBLIC_BASE_URL` — leave empty for now;
     filled in step 5 once the assigned URL is known.

3. Render builds the Docker image (multi-stage,
   `node:lts-trixie-slim` base, pnpm install + workspace build) and
   starts the container with the existing
   `scripts/docker-entrypoint.sh` → `node server/dist/index.js`
   command.
4. **First-deploy expected failure.** Because `PAPERCLIP_AUTH_PUBLIC_BASE_URL`
   is not yet set, the server will exit with
   `authenticated public exposure requires auth.publicBaseUrl`
   (`server/src/index.ts:459-464`). This is expected — it confirms
   the auth gate is wired correctly. Migrations may or may not have
   applied yet depending on where the boot crashed; that's resolved
   in step 5's redeploy.
5. Copy the assigned service URL from Render (e.g.
   `https://paperclip-abc123.onrender.com`). Set ALL of these envs
   on the SAME service to the URL, then click **Save, redeploy**:

   | Env var | Value |
   |---|---|
   | `PAPERCLIP_API_URL` | `https://paperclip-<hash>.onrender.com` |
   | `PAPERCLIP_PUBLIC_URL` | same URL |
   | `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | same URL |

   The next boot completes auth init, applies migrations if needed,
   and reaches `Live`.

## First-boot smoke

After the redeploy completes:

```sh
# 1. Public health probe (no auth required).
curl -sS https://paperclip-<hash>.onrender.com/api/health | jq .
# Expect: { "status": "ok", "deploymentMode": "authenticated",
#          "bootstrapStatus": "bootstrap_pending",
#          "bootstrapInviteActive": false }

# 2. Confirm Postgres reachability.
# /api/health returns status: "unhealthy" with error:
# "database_unreachable" if the DB probe fails — re-check
# DATABASE_URL wiring in the Render env tab.
```

The `bootstrap_pending` state is expected on a cold database — no
`instance_admin` exists yet.

**Codex round-7 correction:** the board-claim URL on a COLD start is
suppressed. `initializeBoardClaimChallenge` runs once at boot and only
generates a challenge when `instance_user_roles` contains exactly one
admin and that admin is the `local-board` placeholder
(`server/src/board-claim.ts:42-65`). On a totally empty DB
(`admins.length === 0`), no challenge is generated. The flow becomes
usable only after Path A's pg_dump restore brings in the `local-board`
row AND the service is restarted so the challenge initializer
re-runs.

A true cold-start bootstrap (no local data restored) is **deferred
and not supported by this runbook** in this release — see
"Cold-start path — deferred" at the end of the data-migration section.
Shipping cold-start needs a separately verified bootstrap runbook
plus explicit Gus approval.

The URL format when active is
`http(s)://<host>:<port>/board-claim/<token>?code=<code>` (search the
logs for `board-claim`). It is NOT `/admin/claim`.

## Onboarding the first admin

**Codex round-6 fix:** the Path A flow restores the existing Analema
company/agents into hosted Postgres FIRST, then the claim flow
attaches a fresh user identity to that preserved state. Codex round-8
removed the earlier Path B "cold-start" alternative because it
contradicted the documented `initializeBoardClaimChallenge` behavior
(empty DB → no challenge URL emitted). True cold-start is a
follow-up workstream.

### Path A — preserve + migrate (recommended, default)

Codex round-7 fix: the steps are ordered so the challenge initializer
sees the restored `local-board` row.

1. **Run "Data migration — preserve" (section below) FIRST.** The
   restore brings in the `local-board` admin row, the Analema
   company, and the agent directories.
2. **Restart the Paperclip Render service.** Render dashboard →
   `paperclip` service → **Manual Deploy** → **Clear build cache and
   deploy** (or **Restart Service** if no code change). The restart
   re-runs `initializeBoardClaimChallenge` against the now-restored
   DB and emits a fresh board-claim URL to the logs. Without this
   restart the challenge never activates.
3. **Locate the board-claim URL in the Render service logs of the
   restart.** Search for `board-claim`. The format is
   `http://localhost:<port>/board-claim/<token>?code=<code>` —
   replace `localhost:<port>` with the public Render URL.
4. **Open the URL in a browser.** Sign up via Better Auth, then accept
   the claim. This:
   - Inserts an `instance_admin` row for the signed-in user.
   - Demotes the placeholder `local-board` user.
   - Grants the new admin an `active` `owner` membership on **every
     existing company** — including the migrated Analema company.
5. **Do NOT create a new company.** The Analema company already
   exists with UUID `f41d00fa-0d70-4f53-b7f4-35c0df3814d8` from the
   preserve step. Verify in the company list dropdown that all the
   migrated agents are visible.
6. From the Paperclip UI, mint a **Board API Key** for this user
   (Settings → API Keys → Create). Copy the plaintext token — it is
   shown once.

### Path B — cold-start (deferred; not supported by this runbook)

Codex round-8 found that the previous Path B contradicted itself: it
told the operator to "hit the board-claim URL directly" on a fresh
deploy, but on a totally empty DB `initializeBoardClaimChallenge`
exits early (`admins.length === 0`) and no claim URL is ever emitted
to the logs. Documenting the real cold-start bootstrap requires
either:

- a verified server-side seed step that inserts the `local-board`
  placeholder admin row so a subsequent restart can emit a claim
  URL, OR
- a verified Better-Auth-only sign-up + DB-level grant of
  `instance_admin` to that user without going through the claim
  flow.

Neither path has been exercised against the hosted blueprint in this
release, so cold-start is **deliberately not documented here**. If
Gus wants a true greenfield deploy without local-state migration,
the cold-start sequence is a follow-up workstream that needs
upstream Paperclip verification.

For this release, use **Path A**. The Analema company and its agent
roster already exist locally; preserve them.

## Cutover — point the Infrak backend at hosted Paperclip

In the Render dashboard → `analema-backend` service → Environment:

| Env var | New value |
|---|---|
| `PAPERCLIP_API_URL` | `https://paperclip-<hash>.onrender.com` (no trailing slash; matches the Paperclip service URL) |
| `PAPERCLIP_SERVICE_TOKEN` | The board API key minted above |
| `PAPERCLIP_COMPANY_ID` | The Analema company UUID from step 4 (default `f41d00fa-0d70-4f53-b7f4-35c0df3814d8`) |

Click **Save, redeploy** to restart the Infrak backend with the new
env. Verify:

```sh
# Health (Infrak backend's own probe of Paperclip):
curl -sS https://analema-backend.onrender.com/api/admin/paperclip/health \
  -H "Authorization: Bearer <admin-jwt>" | jq .
# Expect status: "ok" (NOT "not_configured" and NOT "auth_failed").

# Direct authenticated probe of Paperclip itself:
curl -sS https://paperclip-<hash>.onrender.com/api/companies/$PAPERCLIP_COMPANY_ID \
  -H "Authorization: Bearer $PAPERCLIP_SERVICE_TOKEN" | jq '.id, .name'
# Expect the Analema company JSON.
```

In the live admin portal at `/admin/paperclip`, the page should now
show green health, the company name, and the agent roster. The
"deployment pending" banner from the not_configured state is gone.

## Rollback

If the cutover surfaces a regression, revert by editing the Infrak
backend env:

- Set `PAPERCLIP_API_URL` to the previous value (or empty to trip
  the fail-closed `not_configured` branch in
  `app/services/paperclip_client.py`).
- Leave `PAPERCLIP_SERVICE_TOKEN` and `PAPERCLIP_COMPANY_ID` in place
  — they're inert without a reachable URL.

Click **Save, redeploy**. The hosted Paperclip stays up; the admin
portal merely stops pointing at it. No data loss.

## Rotation runbook (30-day cadence)

1. From Paperclip UI → Settings → API Keys → Create a new board API
   key. Copy the plaintext token.
2. Update `PAPERCLIP_SERVICE_TOKEN` on the Infrak backend service in
   Render. Save + redeploy.
3. Verify `/api/admin/paperclip/health` still returns ok.
4. Revoke the old board API key in the Paperclip UI.

## Data migration — preserve the existing Analema company + agents

**Codex round-5 update + round-9 clarification:** cold-start would
lose the operating state already invested in
`~/.paperclip/instances/default/` — the Analema company
`f41d00fa-0d70-4f53-b7f4-35c0df3814d8`, its agent directories
(Kenji/Takashi/Yuki/Daisuke/Aoi/Hiroko/etc.), and any issues/
heartbeats. **The supported cutover path in this release is
preserve + migrate.** Cold-start is **deferred and not supported by
this runbook** — it has not been exercised against the hosted
blueprint and would require a separately verified bootstrap runbook
plus explicit Gus approval before being shipped.

### Path A — preserve and migrate (recommended)

Run this BEFORE the bootstrap_ceo claim flow on the hosted instance,
during a short Paperclip maintenance window (~30 min):

1. **Dump the local embedded Postgres, excluding Better Auth tables
   at the dump level.** Read the embedded port from
   `~/.paperclip/instances/default/config.json` (default `54329`).

   Codex round-6 fix: `pg_dump --clean --if-exists` emits
   `DROP TABLE ... IF EXISTS` statements for every table it dumps,
   even if a later post-process script removes the `COPY` block.
   That would drop the freshly-migrated `user`/`session` tables
   the hosted instance just created. Use `--exclude-table` so the
   tables are absent from the dump entirely (no DROP, no COPY,
   nothing to strip after the fact):

   ```bash
   PCP_PORT=$(jq -r '.embeddedPostgres.port // 54329' \
       ~/.paperclip/instances/default/config.json)

   pg_dump \
       --host=127.0.0.1 --port="$PCP_PORT" \
       --username=paperclip paperclip \
       --clean --if-exists --no-owner --no-acl \
       --exclude-table='public.user' \
       --exclude-table='public.session' \
       --exclude-table='public.account' \
       --exclude-table='public.verification' \
       --exclude-table='public.board_api_keys' \
       --exclude-table='public.board_claims' \
       --exclude-table-data='public.local_board_*' \
       > /tmp/local-paperclip-clean.sql
   ```

   Verify nothing referencing the excluded tables made it through:

   ```bash
   grep -Ei "DROP|CREATE|COPY" /tmp/local-paperclip-clean.sql \
       | grep -Ei "(\.|^)(user|session|account|verification|board_api_keys|board_claims)([\.\" ]|$)" \
       && echo "FAILED: excluded tables still present — abort the restore" \
       || echo "OK: dump is free of Better Auth artifacts"
   ```

2. **Apply migrations on hosted Paperclip first.** The blueprint sets
   `PAPERCLIP_MIGRATION_AUTO_APPLY=true` so the first deploy creates
   every table. Confirm by `curl https://<url>/api/health` returning
   `bootstrapStatus: "bootstrap_pending"`.

3. **Restore the clean dump into the hosted Postgres.** Use the
   external connection string (Render dashboard → paperclip-postgres
   → "External Database URL"):

   ```bash
   psql "$PAPERCLIP_RENDER_EXTERNAL_DB_URL" \
       --single-transaction \
       --set ON_ERROR_STOP=on \
       -f /tmp/local-paperclip-clean.sql
   ```

   `ON_ERROR_STOP=on` aborts on the first row-level error so we don't
   end up with partial state. Because the dump excluded Better Auth
   tables, none of those tables' rows are touched.

4. **Restart the Paperclip service after restore.** Render dashboard
   → `paperclip` → **Restart Service**. The restart is required: the
   board-claim challenge is generated by `initializeBoardClaimChallenge`
   ONLY at startup, and only when `instance_user_roles` contains
   exactly one admin (`local-board`). The restore loaded that row;
   the restart triggers the initializer against the new state.
   Without restart, no claim URL is emitted to the logs.

5. **Promote the operator via bootstrap_ceo.** After the restart,
   search the new boot's logs for `board-claim`. The URL is in the
   form
   `http://localhost:<port>/board-claim/<token>?code=<code>` — replace
   `localhost:<port>` with the public Render URL. Open in a browser,
   sign up via Better Auth, accept the claim. This creates a fresh
   `user` row and grants `instance_admin` against every existing
   company (including the restored Analema company).

6. **Mint a board API key** from the Paperclip UI (Settings → Board API
   Keys → Mint). Paste plaintext into the Infrak backend env
   `PAPERCLIP_SERVICE_TOKEN`.

7. **Verify company UUID is preserved:**

   ```bash
   curl -H "Authorization: Bearer $PAPERCLIP_SERVICE_TOKEN" \
        "https://<url>/api/companies/f41d00fa-0d70-4f53-b7f4-35c0df3814d8"
   # Expect the Analema company JSON.
   ```

   If this returns 404, the restore step lost the row — check step 3's
   psql output for errors before re-running.

8. **Verify agent roster:** `curl .../api/companies/<id>/agents` should
   list all six (or however many you had locally) agents with their
   original IDs.

### Cold-start path — deferred

Codex round-8 removed the prior cold-start procedure (previously
labeled "Path B") because it told the operator to hit a board-claim
URL on a fresh deploy, but `initializeBoardClaimChallenge` only emits
a URL when `instance_user_roles` already contains the `local-board`
placeholder. On a totally empty DB no URL is ever produced.

A verified cold-start bootstrap requires either a server-side
`local-board` seed step or a Better-Auth-only sign-up + DB-level
`instance_admin` grant — neither of which has been exercised against
the hosted blueprint in this release. Documenting an unverified path
risks bricking the deploy.

For this release, the Analema preserve+migrate flow above IS the
supported onboarding path. The admin portal at
`infrakaihatsu.com/admin/paperclip` queries live state either way;
the only thing the preserve flow guarantees is that the operating
history (company UUID, agent IDs, prior issues/runs) survives
cutover.
