# ADR-0007: Run build tasks in a public subnet with no NAT Gateway

**Status:** Accepted | **Date:** 2026-09-01

## Context

Build tasks need outbound internet access to reach the npm registry. The textbook pattern is a
private subnet behind a NAT Gateway, which costs **~$32/month** plus data processing.

Against a finite ~$100 credit pool spread over 4-6 months, a NAT Gateway consumes roughly a third
of the entire budget while idle. The apparent alternative - interface VPC endpoints for ECR, Logs
and friends - costs ~$7.20/month **each**, and the four needed cost more than the NAT being
avoided.

The original design's network diagram showed the build task blocked from internal services with X
marks. That diagram describes an intention, not an enforceable configuration: any task with egress
to npm has egress to the internet.

## Decision

Build tasks run in a **public subnet** with `assignPublicIp: ENABLED`:

- Security group with **zero inbound rules**; egress restricted to 443/80.
- **Gateway** VPC endpoints for S3 and DynamoDB - these are free and keep artifact traffic off the
  internet gateway.
- No NAT Gateway, no interface endpoints.

The private-subnet topology is written in Terraform behind `var.network_mode = "private"` and is
stood up temporarily for demonstration (see
[06-cost-model.md](../06-cost-model.md#tier-b---stand-up-evidence-destroy)), then destroyed.

## Consequences

- Networking cost: **$0/month** instead of $32.
- A public IP with no inbound rules is not "exposed" - nothing can initiate a connection to it.
- The build subnet has no route to anything internal because **there is nothing internal**: the
  control plane is entirely serverless and reachable only over authenticated public APIs. This is
  a genuine architectural property, not a workaround.
- **Honest limitation:** egress is unrestricted. Limiting it to npm and GitHub requires an egress
  proxy or AWS Network Firewall (~$300/month). The mitigation is that outbound access buys an
  attacker nothing, because the container holds no credential worth exfiltrating. This is recorded
  as an accepted risk in [05-threat-model.md](../05-threat-model.md#accepted-risks) rather than
  drawn as a control that does not exist.
- Terraform proves the private topology can be built. It does not have to be running for that to
  be true, and $1.07/day for a three-day demonstration is a far better trade than $32/month idle.

## Alternatives considered

- **Private subnet + NAT Gateway.** The textbook answer, and correct with a real budget. Rejected
  on cost; implemented behind a flag and demonstrated temporarily.
- **Private subnet + interface endpoints, no NAT.** Rejected: ~$29/month for four endpoints, worse
  than the NAT it replaces, and npm is still unreachable without one.
- **NAT instance on t4g.nano** (~$3/month). Tempting, but it is a single point of failure that has
  to be patched and monitored, and operating one teaches nothing this project needs.
- **Pre-baking dependencies into the build image.** Would remove the need for egress entirely, but
  it cannot work for arbitrary user repositories.
