# 08 - Testing Strategy

Testing an asynchronous distributed system is genuinely harder than testing a CRUD app, and
"I'll check CloudWatch" is not a strategy. Decide this before writing code.

## Levels

```
  few    +-----------------------------------------+
         |  E2E   real AWS dev account, ~5 tests   |
         +-----------------------------------------+
         |  Integration   LocalStack, ~40 tests    |
         +-----------------------------------------+
  many   |  Unit   pure logic, no I/O, ~200 tests  |
         +-----------------------------------------+
```

### Unit - Vitest, no I/O

The valuable target is `packages/core`: the state machine, framework detection, all validation
schemas, path/prefix construction, tarball entry sanitisation, cache-header rules. These are pure
functions and should have near-total coverage because they encode the actual rules of the system.

State-machine tests worth writing explicitly:

- every valid transition is accepted
- every invalid transition is rejected (drive this from the transition table, not by hand)
- terminal states accept no transitions
- the `REMOVE gsi2pk` clause fires on every terminal transition (a missed one leaks into the
  sparse index forever and the sweeper eventually reprocesses it)

### Integration - LocalStack Community

**Know the limits before you rely on it.** LocalStack Community supports S3, DynamoDB, SQS, Lambda,
API Gateway, IAM (mocked, not enforced), and CloudWatch Logs. It does **not** support ECS/Fargate,
CloudFront, CloudFront Functions, or KeyValueStore - those are Pro-only.

So LocalStack covers the **control plane** and nothing else. That is still worth having: it gives
you a fast local loop for the API, the state machine against a real DynamoDB engine, the SQS
round-trip, and S3 upload behaviour.

Test the dispatcher against LocalStack with the ECS client mocked (`aws-sdk-client-mock`). The
interesting assertion is not that `RunTask` was called - it is that **on a duplicate message, it
was called exactly once.**

```
test: duplicate SQS delivery launches exactly one task
  - seed a QUEUED deployment in LocalStack DynamoDB
  - invoke the dispatcher twice concurrently with the same deploymentId
  - assert: RunTask called once; final status PROVISIONING;
            the losing invocation returned cleanly without throwing
```

That single test is the strongest evidence for the idempotency claim, and it runs in milliseconds.

**Critical caveat: LocalStack does not enforce IAM.** Every policy in this project will appear to
work locally regardless of whether it is correct. All IAM assertions must run against real AWS.

### E2E - real AWS dev account

Slow, costs pennies, few in number. Run nightly and before release, not on every push.

1. **Happy path.** Deploy a fixture Vite repo, poll to `DEPLOYED`, fetch the URL, assert the HTML
   contains a known marker.
2. **Build failure.** Fixture with a broken build. Assert `FAILED`, exit code 13, and logs
   retrievable through the API.
3. **Timeout.** Fixture with an infinite loop. Assert `FAILED`/`TIMEOUT` within 11 minutes.
4. **Rollback.** Deploy A, deploy B, promote A, assert the served content changed with no build.
5. **Security suite.** The seven tests from
   [05-threat-model.md](05-threat-model.md#security-tests-that-must-exist). **These only mean
   anything against real IAM.**

## The reconciler and sweeper are the hardest things to test

They exist for failures that are hard to cause on purpose. Test them by causing the failure
directly rather than waiting for it:

| Path | How to trigger it deliberately |
|---|---|
| Reconciler on OOM | Fixture that allocates past the memory limit; assert `FAILED`/`OUT_OF_MEMORY` from exit 137 |
| Reconciler on external kill | `aws ecs stop-task` mid-build; assert the deployment does not stay in `BUILDING` |
| Sweeper | Insert a deployment with `deadlineAt` in the past and `gsi2pk = INFLIGHT`; invoke the sweeper; assert `FAILED` |
| KVS drift | Write DynamoDB without writing KVS; assert the sweeper repairs it |

**The specific bug to guard against is a deployment stuck in a non-terminal state forever.** It is
the most likely real-world failure and the least likely to be noticed, because nothing errors -
the UI just spins. Add a nightly assertion that no deployment has been non-terminal for over an
hour.

## Fixtures

Keep as tarballs in `tests/fixtures/`, committed, so tests do not depend on GitHub availability:

`vite-ok`, `cra-ok`, `astro-ok`, `next-export-ok`, `static-ok`, `no-build-script`,
`build-fails`, `install-fails`, `empty-output`, `huge-output`, `infinite-loop`,
`memory-bomb`, `zip-slip` (crafted, not from a real repo), `credential-probe`,
`unsupported-framework`.

The last five are security fixtures. **Treat them as production code** - they are the executable
form of the threat model, and they are what makes the security claims verifiable rather than
aspirational.

## CI pipeline

```
on: pull_request
  -> lint (eslint)
  -> typecheck (tsc --noEmit)
  -> unit (vitest)
  -> integration (vitest + localstack service container)
  -> build (esbuild bundle for Lambda; docker build for the builder image)
  -> terraform fmt -check && terraform validate && terraform plan   [comment on PR]

on: push to main
  -> everything above
  -> docker push to ECR
  -> terraform apply   [environment: production, requires approval]

nightly
  -> e2e suite against the dev account
  -> security suite
  -> stuck-deployment assertion
```

On `tsc` vs esbuild, since the original document was unclear: use **both**, for different jobs.
`tsc --noEmit` for typechecking, `esbuild` for bundling Lambda handlers. They are not alternatives;
esbuild strips types without checking them, and `tsc` is slow at emitting. This is not a
controversial choice, it is just the standard split.

## What is deliberately not tested

- CloudFront caching behaviour. It is AWS's code.
- React component internals. A few smoke tests on critical flows; no snapshot suites.
- Terraform beyond `validate` and `plan`. Terratest is not worth the time here.
- Load and performance. There is no load. Saying so is better than a meaningless k6 run.
