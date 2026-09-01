# 06 - Cost Model

Budget: **~$100 in AWS credits.** Finite and expiring - check your expiry date in Billing >
Credits before planning. Assume a 4-6 month build, giving roughly **$16-25/month** sustainable.

The strategy is not "spend freely". It is tiering.

## Tier A - always on

Runs continuously for the life of the project.

| Service | Configuration | Monthly |
|---|---|---|
| Route 53 | 1 hosted zone | $0.50 |
| DynamoDB | On-demand, low volume, PITR | ~$0.30 |
| S3 | ~5 GB artifacts + sources | ~$0.15 |
| CloudFront | Well inside the 1 TB / 10M request free tier | $0.00 |
| CloudFront Functions | Inside 2M free invocations | $0.00 |
| Lambda | Inside 1M requests / 400k GB-s always-free tier | $0.00 |
| SQS | Inside 1M requests always-free tier | $0.00 |
| API Gateway | ~50k requests | ~$0.05 |
| ECR | ~1 GB image storage | ~$0.10 |
| CloudWatch Logs | ~2 GB ingest, 7-day retention | ~$0.00 (5 GB free) |
| Secrets Manager | 1 secret (GitHub App key) | $0.40 |
| KMS | 1 customer-managed key | $1.00 |
| ACM | Public certificate | $0.00 |
| VPC gateway endpoints | S3 + DynamoDB | $0.00 |
| **Total** | | **~$2.50 / month** |

**Not included and deliberately absent:** NAT Gateway ($32), interface VPC endpoints ($7.20 each),
WAF ($5 + $1/rule), ALB ($16). Every one of these has a cheaper substitute at this scale.

## Marginal cost per build

1 vCPU / 2 GB Fargate task, 3-minute build:

```
CPU     1.0 vCPU x 0.05 h x $0.04048  = $0.00202
Memory  2.0 GB   x 0.05 h x $0.004445 = $0.00044
S3 PUTs ~200 objects x $0.000005      = $0.00100
                                      ----------
                                       ~$0.0035 per build
```

**Roughly 285 builds per dollar.** Development at ~200 builds/month costs about $0.70. Compute is
not the risk here. Always-on infrastructure is.

## Tier B - stand up, evidence, destroy

Expensive per month, cheap per day. Deploy behind a Terraform variable, run for a few days, capture
evidence, `terraform destroy`. The Terraform code is the proof of competence; it does not need to
keep running for the skill to be demonstrable.

| Item | Per month | **Per day** | Suggested window |
|---|---|---|---|
| NAT Gateway + private subnets | $32 | **$1.07** | 3 days = $3.20 |
| Interface endpoints (ECR api/dkr, Logs) | $21.60 | $0.72 | same 3 days = $2.16 |
| WAF on CloudFront + 3 rules | $8 | $0.27 | 5 days = $1.35 |
| GuardDuty | ~$5 | $0.17 | **30-day free trial = $0.00** |
| VPC Flow Logs to S3 | ~$1 | $0.03 | during the window |
| **Full Tier B demonstration** | | | **~$7 total** |

Seven dollars buys the private-subnet, NAT, endpoint-hardened, WAF-protected, threat-detected
version of the architecture, fully working, with screenshots and flow logs to show for it. Then it
comes down. This is a better answer to "have you built a production VPC?" than leaving one running
and burning a third of the credits on idle infrastructure.

Capture before destroying: architecture diagram from the console, VPC Flow Log samples showing
build egress, a GuardDuty finding, `terraform plan` output, and the module source itself.

## What would actually blow the budget

Ranked by how easily it happens by accident.

| Risk | Cost if unchecked | Guardrail |
|---|---|---|
| **Forgetting to destroy Tier B** | $32-60/mo | Calendar reminder + `terraform destroy` + budget alarm |
| Crypto miner in `postinstall` | $0.07/build, bounded by 10-min timeout | Timeout x2, concurrency cap 2, 50 builds/day |
| Runaway build loop (webhook loop) | unbounded without a cap | Daily quota; alarm on task-count anomaly |
| CloudWatch log retention left at "never expire" | grows forever | 7-day retention set in Terraform, not the console |
| S3 artifacts never expiring | grows forever | Lifecycle rule: expire non-active deployments after 30 days |
| Leaving a NAT Gateway in a torn-down test VPC | $32/mo, invisible | Never create NAT outside `network_mode = "private"` |
| DynamoDB provisioned instead of on-demand | ~$14/mo idle | On-demand in Terraform |

## Mandatory guardrails, set up in week one

Before writing application code, not after.

1. **AWS Budgets:** alerts at $25, $50, $80, $95 of the credit pool, to email.
2. **Billing alarm** on estimated charges > $20/month.
3. **Cost Anomaly Detection** enabled (free).
4. **Cost allocation tags** (`project`, `tier`, `ephemeral`) on every resource, enforced in
   Terraform, so a stray Tier B resource is findable in Cost Explorer.
5. **A weekly 5-minute Cost Explorer check.** The most common way a credit pool dies is nobody
   looking at it for three weeks.
6. **MFA on root, root credentials never used.** An exposed key on a public repo is the fastest
   possible way to lose $100 and then some.

## Free tier expiry

Several always-free tiers are permanent (Lambda, SQS, DynamoDB 25 GB, CloudWatch 5 GB). Others are
12-month-only (S3 5 GB, ECR 500 MB, CloudFront 1 TB on newer accounts). Know which is which for
your account age; the difference is a few dollars a month, but it is the difference between $2.50
and $6.00 in the Tier A table.
