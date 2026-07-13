<!-- Fictional example of a filled-in checkpoint, so you can see what "good"
looks like. A real one from a production session ran ~165 lines and carried
user rulings across multiple days of resets. -->

# PRECOMPACTION checkpoint — session 84713ac6c05a

## PLAN

Migrate the auth service from session cookies to short-lived JWTs per the
approved plan: (1) token issuing endpoint, (2) middleware swap behind the
`jwt_auth` feature flag, (3) migrate the 3 internal consumers, (4) delete
cookie path after a week of dual-running. User approved 2026-07-13, with the
amendment that refresh tokens live in httpOnly cookies, not localStorage.

## STATUS

- DONE: issuing endpoint `src/auth/token.ts` — VERIFIED: 14 unit tests green,
  manual curl issued+validated a token end-to-end.
- DONE: middleware `src/middleware/auth.ts` behind flag — VERIFIED: staging
  deploy, both paths exercised, logs show correct fallthrough.
- IN PROGRESS: consumer migration 2/3 (billing done, cron done, admin-panel
  NOT started).
- NOT DONE: cookie-path removal (blocked on the one-week dual-run, ends 2026-07-20).

## USER NOTES

- Refresh tokens: httpOnly cookie, never localStorage (user was explicit).
- Do not touch the SSO integration in this pass — "separate project".
- User prefers small PRs per consumer, not one mega-PR.

## DECISIONS

- jose over jsonwebtoken — jsonwebtoken REJECTED: no ESM, stale maintenance.
  Do not switch back if a type error appears; fix the type instead.
- 15-min access token TTL (user confirmed; support burden of shorter deemed
  not worth it).

## INCIDENTS

- 2026-07-13 11:40 — staging deploy failed on missing JWT_SECRET env; RESOLVED
  11:55 (added to deploy manifest). Historical; do not re-investigate.

## POINTERS

- Branch: `feat/jwt-auth`, last commit `a3f9c21`.
- Flag config: `config/flags.yaml:12`.
- Dual-run dashboard: `ops/dashboards/auth-migration.json`.

## IN-FLIGHT

None. No subagents, no background processes, no locks.

## NEXT

Migrate admin-panel consumer: swap `requireSession` for `requireJwt` in
`admin/src/server/guards.ts` (3 call sites), mirror the billing PR structure.
Do NOT redo billing/cron — both merged and verified.

## WORKING SET

- `requireSession` defined at `src/middleware/auth.ts:88`; JWT twin at :114.
- Admin panel guards: `admin/src/server/guards.ts:31,57,102`.
- Test command that works: `pnpm test --filter auth` (root `pnpm test` is
  broken for unrelated reasons — known, ignore).
- Staging deploy: `ops/deploy.sh staging` (~4 min, needs VPN).
