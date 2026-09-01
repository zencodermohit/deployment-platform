# 05 - Threat Model

Scope: the deployment platform and its AWS account. The premise of the whole system is that we
execute code written by people we do not trust, so this document is not optional paperwork.

## Assets, ranked

1. **The AWS account.** Root credentials, IAM, the ability to create resources.
2. **The GitHub App private key.** Grants read access to every installed repository.
3. **Other users' artifacts and deployment metadata.**
4. **The credit balance.** Finite and exhaustible. Uniquely relevant to this project.
5. **Platform availability.**

## Trust boundary

Everything reduces to one boundary: control plane (trusted) versus build container (assume
compromised on every single build). Design rule: **assume every build is a successful attacker,
then ensure the blast radius is one disposable sandbox.**

## Threats and controls

| # | Threat | Vector | Control | Residual risk |
|---|---|---|---|---|
| T1 | Arbitrary code execution escapes to infrastructure | `postinstall`, build script | Fargate task isolation; no host to escape to; task destroyed after build | Container-escape 0-day. Accepted. |
| T2 | Steal GitHub credentials | Read env or disk in container | Container never receives a GitHub token; source arrives as a presigned S3 URL | Presigned URL leaks -> attacker reads one tarball they already have. Negligible. |
| T3 | Steal AWS credentials | Read ECS task metadata endpoint (169.254.170.2) | Task role grants only `s3:PutObject` to one prefix and `logs:PutLogEvents` | Attacker can write junk into their own prefix. Negligible. |
| T4 | Write into another deployment's artifacts | Manipulate upload path | `ARTIFACT_PREFIX` is server-generated; IAM policy is prefix-scoped; client never supplies a path | None if IAM is correct. **Must be tested.** |
| T5 | Read another user's artifacts | Guess a URL / S3 path | Bucket fully private, OAC only; no `s3:GetObject` in task role; edge maps host -> prefix, client never supplies a prefix | Deployment IDs must be unguessable: 128-bit random, not sequential. |
| T6 | Path traversal via API | `?path=../../other-project` | No endpoint accepts a path. Server derives every S3 key from IDs. | None by construction. |
| T7 | Zip-slip during extraction | Malicious tarball with `../` entries | Normalise and validate every entry; reject symlinks escaping root | **Commonly missed. Needs a regression test.** |
| T8 | Credit exhaustion | Crypto miner in `postinstall`; deployment flood | 10-min hard timeout (x2 mechanisms); 2 concurrent builds/user; 50 builds/day/user; Budgets alarms at 50/80/100% | Bounded worst case: ~$2/day/user. Acceptable. |
| T9 | CloudWatch cost explosion | Build prints infinite output | 10MB log cap per build; 7-day retention | Bounded. |
| T10 | Storage exhaustion | Many large artifacts | 500MB artifact cap; S3 lifecycle expires non-active deployments after 30 days | Bounded. |
| T11 | Cross-user data access via API | Manipulate IDs in URLs | Every project-scoped route re-checks `ownerId` with a consistent read; returns 404 on mismatch | None if middleware is applied everywhere. **Enforce in one place, not per-handler.** |
| T12 | SSRF via repository URL | `http://169.254.169.254/...` as repo URL | Strict allowlist: `https:` + hostname exactly `github.com`; parsed with `URL`, not regex | None. |
| T13 | Session theft | XSS in dashboard | React escaping; strict CSP; `HttpOnly` `SameSite=Strict` cookie; server-side revocable sessions | Reduced. |
| T14 | Status callback forgery | Guess `STATUS_URL` and mark a deployment `DEPLOYED` | Per-deployment 256-bit token, stored hashed, expires at `deadlineAt`, scoped to one deployment | Attacker can only forge status for *their own* build. Negligible. |
| T15 | Command injection | Branch name like `main; rm -rf /` | Never interpolate into a shell. No `shell: true`. Branch validated against `^[\w./-]+$`. Git ref passed as an argv element. | None. |
| T16 | Subdomain takeover | Dangling DNS to a deleted distribution | Route53 records managed only by Terraform; delete record and distribution together | Low. |

## Accepted risks

Stating these plainly is stronger than pretending they are solved.

1. **Unrestricted egress from the build container.** Restricting to npm and GitHub needs an egress
   proxy or Network Firewall (~$300/mo), which is out of budget. Mitigation: there is nothing in
   the container worth exfiltrating. Revisit if the platform ever handles user secrets.
2. **No container-escape defence beyond Fargate's own isolation.** gVisor/Firecracker-grade
   hardening is what Fargate already provides underneath; we do not add to it.
3. **Dependency confusion / malicious npm packages.** We do not scan the dependency tree. The build
   is sandboxed, so a malicious package gets the same nothing an malicious repo gets.
4. **No WAF on the API.** ~$8/mo. Deferred; API Gateway throttling is the interim control.

## Security tests that must exist

These belong in CI as executable tests, not in a checklist. This is what separates "documented
security" from "implemented security", and it is the single highest-value credibility item in the
project.

- [ ] **T3:** a fixture repo whose `postinstall` calls the ECS metadata endpoint and attempts
      `dynamodb:Scan`, `secretsmanager:GetSecretValue`, and `s3:GetObject` on another prefix.
      All must fail with `AccessDenied`. Assert on the denial.
- [ ] **T4:** a fixture repo that attempts `s3:PutObject` outside its own prefix. Must fail.
- [ ] **T7:** a crafted tarball containing `../../etc/passwd`. Extraction must reject it.
- [ ] **T8:** a fixture repo with an infinite loop. Must be killed at 10 minutes by the watchdog,
      and separately by `StopTask` when the watchdog is disabled.
- [ ] **T11:** user A requests user B's deployment by ID. Must return 404.
- [ ] **T12:** project creation with `http://169.254.169.254/`, `https://github.com.evil.io/a/b`,
      and `https://user:pass@github.com/a/b`. All must be rejected.
- [ ] **T15:** a branch named `main;whoami`. Must be rejected at validation.

## Detection

- CloudTrail on (management events are free) for an audit trail of every API call.
- **GuardDuty during the Tier B demonstration window.** The 30-day free trial covers it entirely.
  Findings on a subnet that runs untrusted code are a genuinely strong portfolio artifact - capture
  them before the trial ends.
- Alarms on `AccessDenied` spikes from the build task role: a compromised build probing its own
  permissions is exactly what that looks like.
