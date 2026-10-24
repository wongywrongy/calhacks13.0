# SECURITY.md — rules of engagement

This project runs autonomous agents in an adversarial security game. That only stays safe
because the whole thing is boxed in. These rules are binding on all code and all contributors
(human or coding-agent). Read before writing anything.

## What this is

A **self-contained educational evaluation harness**. The "attacks" exist only to test whether
the defense closes a **fixed, documented set of planted weaknesses** in our own practice
service. It is not a pentest tool and must never be pointed at anything we don't own and
didn't build for this.

## Hard boundaries

1. **One target, ever.** Agents reach only the arena practice service. No other host, URL, IP,
   or service is reachable or referenceable. The attacker tool (`request`) is hardwired to the
   service base URL.
2. **No egress.** All containers run on one internal Docker network with outbound access
   disabled. The only external call allowed is agent inference to the Bitdeer endpoint, via the
   `agents/common` client — nothing else makes outbound requests.
3. **Synthetic everything.** Fake flags, fake data, no real credentials, no real user data, no
   real CVEs. The practice service is purpose-built; its weaknesses are fixtures.
4. **Catalog-bounded.** Attack behavior is limited to the documented weakness catalog
   (`practice-app/catalog/`). Agents select from it; they do **not** synthesize or fetch novel
   exploit techniques. If it's not in the catalog, it doesn't happen.
5. **Tiny tool surface.** The tools in `AGENTS.md` are the complete list. No shell, no
   filesystem, no arbitrary network. Widening the surface is a security decision — raise it,
   don't just add it.
6. **Scoped writes.** A defender writes only its own rule namespace; the reducer enforces this.
   An agent cannot alter the referee, the score, or the other team's rules.
7. **Referee kill switch.** `start_match`/stop is referee-only; the referee can halt a match
   and freeze the arena at any time.

## What must not land in this repo

- Real exploit payloads, real CVE reproductions, or anything targeting real software.
- Network egress from the service, guard, or agents (beyond Bitdeer inference).
- Secrets in code or fixtures. Use env vars; keep `.env` out of git.
- Any capability that lets an agent act outside the arena.

## For demos

- Pre-record a full match and replay it; don't run live agents against anything on the venue
  network. The arena is internal-only regardless.
- The pitch frames this as a **defensive** tool: it finds and closes planted holes before a
  real attacker would. Keep that framing accurate — don't overclaim it as a general pentester.

If a task seems to require crossing any boundary above, it's out of scope for this project.
Stop and rescope.