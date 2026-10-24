# Evidence-driven security demonstration

Pitch: SudoKO tests whether teams of agents can discover and reproduce an application
breach, apply a defense, and prove recovery while legitimate operations continue.

Armadin describes its platform in terms of validated attack paths, parallel agent activity
and testing defensive controls: https://www.armadin.com/platform . Its discussion of
closing attack paths emphasizes proving exploitable risk and verifying that paths are
closed: https://www.armadin.com/blog-posts/closing-attack-paths-that-lead-to-ot .
This motivates our demonstration; it is not a verified Cal Hacks prize rubric or a claim
of Armadin integration. Our target is a synthetic application, not operational technology.

## Reliable functional demonstration

```bash
npm test
npm run sandbox:validate
```

The validator makes actual authenticated HTTP requests to a fresh application instance.
It does not supply the attacker with the flag or pretend a request succeeded. Random
private flags come from the vulnerable application's response. Unexpected behavior fails
an assertion and returns a nonzero exit code.

1. A cross-tenant read leaks a private artifact and earns a verified capture.
2. A scout publishes evidence; a teammate claims the task and independently reproduces it.
3. A defender enables authorization. The same request is now rejected.
4. Untrusted telemetry requests a weaker policy. A susceptible decision fixture attempts
   it: baseline accepts and leaks again; hardened mode rejects the policy change.
5. Independent probes confirm isolation and three legitimate workflows at the current
   policy version. Only then can the referee restore asset control and revoke the token.
6. The stolen token fails when submitted again. Authorized application updates still work.

Both modes repeat three times with identical named assertion outcomes. This determinism
applies to ordered functional checks, not timestamps, random secrets, concurrent scheduling
or model decisions. Evidence is saved to `output/validation/evidence.json`, with no raw flags.
This proof currently concerns one asset per namespace and planted application weaknesses.

## Concurrent stress demonstration

```bash
npm run sandbox -- --compare --seconds 8 --attackers 6 --defenders 2 --clients 6 --load-profile burst
```

This uses 16 security actors, 12 normal clients and two probes. It measures steady, burst
and recovery traffic, captures, verified recovery, team handoffs, legitimate success and
latency. Inspect recorded reports with `web/report.html`. Availability is reported even
when it worsens; the desired story is not an assertion about a concurrent run's outcome.

## Actual AI evaluation

The two commands above use fixtures. To evaluate model choices, configure Bitdeer and run
`npm run sandbox -- --engine bitdeer --seconds 45 --load-profile burst`. Report the provider,
model, action traces, failures, and observed outcomes. Provider failures remain errors.
Do not describe ordered fixture handoffs as autonomous model discovery. Docker isolation
and actual inference still require separate verification. The drone fleet workspace is a
separate simulation with its own checks (`FLEET.md`); it is not evidence for this suite.
