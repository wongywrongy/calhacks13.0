# Maincloud runtime

Production uses the Rust `arena-live` module on SpacetimeDB Maincloud, the existing
Vercel project for static frontend assets, and Bitdeer for inference. The synthetic
fleet is separate from the local HTTP scenario suite. No real aircraft are involved.

Database: `sudoko-maincloud-20261025` at `https://maincloud.spacetimedb.com`.
The previous `sudoko-chat-live-20261024` database is retained intact for rollback;
publishing a module does not copy its rows or grants. The replacement has explicitly
provisioned role grants and a new 120-drone session, with zero agents until prompted.

`backend::hosted` in `arena-live/src/maincloud.rs` schedules conversation decisions and
specialist loops. It reuses the existing prompts, chat tables, plan validation,
versioned policies, and evidence-producing action reducers. Movement remains scheduled
independently of inference. More drones do not create more model calls.

Admission writes a durable job and schedule. A short transaction claims the job,
reserves its budget, and snapshots its input and policy version. The procedure calls
only the fixed Bitdeer HTTPS endpoint outside the transaction. The completion transaction
rechecks the epoch, conversation, live session, operation cancellation, original caller's
current role grant, assignment, deadline, and policy version before applying an action.
Duplicate jobs cannot claim twice. Duplicate message keys accept only identical input.

Limits: four concurrent inference reservations globally, one pending conversation and
one operation per role, two to four specialists per operation, eight decisions per
specialist, 33 model calls per operation including its coordinator, a 75-second operation
deadline, a 30-second conversation deadline, and a 20-second HTTP timeout. Deadlines have
scheduled watchdogs. Cancellation/reset cannot abort a provider request already sent;
its result cannot apply, and it continues occupying its reservation until it returns or
the watchdog expires. Failures are recorded without fixture replacement or provider retries.

The installed CLI/SDK is 2.13.0, with Rust's `unstable` feature enabled for procedures.
A separate hosted capability probe verified a scheduled procedure, server-side environment
access, and a real Bitdeer HTTP 200 before the runtime port. Its 20-second timeout worked
on Maincloud despite an older 500 ms comment in the installed HTTP client's source.

## Deploy

1. Build and test the module: `npm run spacetime:build`, `cargo test --manifest-path arena-live/Cargo.toml`.
2. Supply `BITDEER_API_KEY` in the publisher's environment and publish without clearing data:
   `spacetime publish sudoko-maincloud-20261025 -s maincloud --bin-path arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm --delete-data=never --yes=remote,skip-login`.
   The declared key is stored in SpacetimeDB's private environment. Never put it in Vercel's
   frontend configuration, a table view, a prompt, or a browser credential.
3. `npm run maincloud:prepare` provisions attacker/defender identities and saves scoped
   demo configuration under ignored `output/maincloud/`. It never resets existing data.
   On a new empty database only, initialize with `spacetime call -s maincloud sudoko-maincloud-20261025 start_fleet 120 0 0 false -y`.
4. `npm run test:maincloud` checks the real connection, 120 updating rows, subscriptions,
   private-table denial and owner-only mutation rejection. Add `-- --live` only for an
   explicitly intended paid model interaction and shared reset: it verifies takeover,
   defense, reconnect, budgets, concurrency and rejection of an in-flight completion after reset.
5. Supply `FLEET_MAINCLOUD_CONFIG_JSON` to the Vercel build, or a local file path through
   `FLEET_MAINCLOUD_CONFIG`. `npm run build:vercel` refuses a missing configuration.
   The existing Vercel project has the JSON variable for Preview and Production.
   Deploy the static output after verification. `/fleet-config` resolves to that static
   JSON; no production routes proxy to Neo, Tailscale, Node, or an inference API.
6. `node scripts/check-maincloud-browser.ts` verifies the deployed browser, both guided
   roles, laptop layout, refresh, forced WebSocket reconnect and absence of legacy requests.
   `--send --reset` also runs the actual judge challenge/defense flow, follows evidence,
   and resets to 120 drones with zero agents. Use `MAINCLOUD_FRONTEND_URL` for a candidate.

The browser subscribes directly to identity-scoped fleet/chat views and invokes scoped
reducers through SpacetimeDB. Maincloud reconnect uses Maincloud again, without an API
proxy fallback. The public demo deliberately offers both role credentials through its
Attack/Defend controls. They cannot grant roles, read private tables, start fixtures, or
publish code. Defender may reset the shared demo; attacker may stop its own operation or
start its own new chat. These are shared demo workspaces, not individual user accounts.
The publisher identity and Bitdeer key remain server-side.

## Verification evidence

`output/maincloud/verification.json` records the real backend check; `browser/report.json`
records the browser check. Private artifacts stay outside git. The initial hosted check
observed two concurrent model calls, two accepted unauthorized commands, two versioned
policies and two verified recoveries; reset rejected stale work and discarded a real
in-flight completion. This bounded run is not a security guarantee or a statistical
availability evaluation. The Findings drawer keeps observed evidence distinct from
unverified susceptibility or spread.

The local commit `d984de7` and branch `feat/compact-fleet-75` were absent from local refs,
worktrees, unreachable commits and the remote's branch listing. Available uncommitted
fleet/reset/resilience/viewport work was preserved on `preserve/pre-maincloud-workspace`
and integrated with latest main `be8a54b` on `feat/maincloud-runtime`. Compact controls,
Activity, viewport, concise conversation, and the newer judge/findings flow are retained;
the new default is 120 actual persisted drones.
