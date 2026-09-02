# 12 — Go-Live Runbook

The platform is built and deployed. Five things remain, and every one of them
needs an account, a browser click, or a secret that must not live in the repo —
which is exactly why they were left for you rather than automated.

Do them in this order. Each step says what to run, what you should see, and how
to check it worked before moving on.

## Values you'll reuse

| What | Value |
|---|---|
| AWS account | `220438080921` |
| Region | `ap-south-1` (edge/billing extras live in `us-east-1`) |
| API URL | `https://66y53za7pf.execute-api.ap-south-1.amazonaws.com` |
| CloudFront domain | `d3895jyfnxjrwh.cloudfront.net` |
| Dashboard | `https://d3895jyfnxjrwh.cloudfront.net/d/dashboard/` |
| Git author | `zencodermohit` |
| Alert email | `zenmohit08@gmail.com` |

> **Windows / Git Bash note.** Several `aws` commands take arguments that start
> with `/` (SSM parameter names, S3 keys). Git Bash rewrites those into Windows
> paths before the CLI sees them. When a command below has one, it is prefixed
> with `MSYS_NO_PATHCONV=1`. In PowerShell you don't need that — just drop the
> prefix.

---

## Step 1 — Push to GitHub

Eleven commits are sitting on `main` locally with no remote. Nothing else in
this runbook can proceed until the repository exists: the OAuth callback, the CI
roles, and the webhook all reference it by name.

### 1a. Create an empty repository

On GitHub: **New repository** → name it `deployment-platform` → **Private** is
fine → **do not** add a README, .gitignore, or licence (the repo already has
them, and an initialised remote would need a merge).

### 1b. Push

```bash
cd /c/Users/katre/Desktop/vercel
git remote add origin https://github.com/zencodermohit/deployment-platform.git
git push -u origin main
```

If it asks for a password, that's not your GitHub password — it's a Personal
Access Token (**Settings → Developer settings → Personal access tokens → Fine-grained**,
with `Contents: read and write` on this one repo), or install the
[GitHub CLI](https://cli.github.com/) and run `gh auth login` first.

**Check:** the repo page shows 11 commits and the `.github/workflows/` files.
Within a minute the **Actions** tab shows the `CI` workflow running. Lint,
typecheck, unit tests and the Docker build will pass; the `terraform plan` and
`integration tests` jobs will **fail** — that's expected, they need the AWS
roles you create next.

### 1c. Create the CI/CD roles

The OIDC roles were written in M7 but create nothing until they know the repo
name. Now they do:

```bash
cd /c/Users/katre/Desktop/vercel/infra/stacks/cicd
terraform apply -var github_repository=zencodermohit/deployment-platform
```

Type `yes`. It creates 7 resources: the GitHub OIDC provider, a read-only
`plan` role, and a `deploy` role locked to `main`.

```bash
terraform output plan_role_arn
terraform output deploy_role_arn
```

### 1d. Give the values to GitHub

Two repository **secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `AWS_PLAN_ROLE_ARN` | the `plan_role_arn` output |
| `AWS_DEPLOY_ROLE_ARN` | the `deploy_role_arn` output |

And one **environment** named `production` (Settings → Environments → New
environment). Add **yourself as a required reviewer** — that's the gate that
stops a deploy running without a human. The deploy workflow will not run until
this environment exists.

**Check:** push a trivial commit (or re-run the failed CI jobs). Every job goes
green, and a pull request now gets a Terraform plan commented on it.

---

## Step 2 — Create the GitHub OAuth app and turn auth on

Right now the API has no authentication: `identify()` falls back to a stand-in
user, so anyone with the URL is that user. Since M4 a request spends money, so
this is the step that makes the platform safe to leave running.

### 2a. Register the OAuth app

GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

| Field | Value |
|---|---|
| Application name | Deployment Platform |
| Homepage URL | `https://66y53za7pf.execute-api.ap-south-1.amazonaws.com` |
| Authorization callback URL | `https://66y53za7pf.execute-api.ap-south-1.amazonaws.com/auth/github/callback` |

The callback URL must match **exactly** — trailing slash included (there is
none). Register, then **Generate a new client secret**. You now have a Client ID
and a Client Secret; the secret is shown once.

### 2b. Store the credentials (never in Terraform)

```bash
MSYS_NO_PATHCONV=1 aws ssm put-parameter --region ap-south-1 \
  --name /deployment-platform/github/client_id \
  --value "Iv1.your_client_id" --type SecureString --overwrite

MSYS_NO_PATHCONV=1 aws ssm put-parameter --region ap-south-1 \
  --name /deployment-platform/github/client_secret \
  --value "your_client_secret" --type SecureString --overwrite
```

These parameters already exist as `PLACEHOLDER`; `--overwrite` replaces the
value. Terraform ignores changes to them, so it will never reset them and the
secret never enters state.

### 2c. Flip auth on

```bash
cd /c/Users/katre/Desktop/vercel/infra/stacks/app
terraform apply -var auth_enabled=true
```

To make this stick across future applies, put it in a tfvars file instead:

```bash
echo 'auth_enabled = true' > terraform.tfvars   # gitignored
terraform apply
```

**Check:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://66y53za7pf.execute-api.ap-south-1.amazonaws.com/projects
# expect 401 — previously this returned data
```

Then open the dashboard: it now shows **Continue with GitHub**, and the round
trip should log you in and list your projects. From this point the `X-Debug-User`
path is inert (`identify()` requires a real session once `AUTH_ENABLED=true`).

---

## Step 3 — Confirm the SNS email

Two SNS topics were created with your address, but AWS will not send to an email
until you confirm the subscription — so today the budget and operational alarms
have nowhere to go.

1. Check your inbox (and spam) at `zenmohit08@gmail.com` for two messages titled
   **"AWS Notification - Subscription Confirmation"**, one for
   `deployment-platform-billing-alerts`, one for
   `deployment-platform-operational-alerts`.
2. Click **Confirm subscription** in each.

If the emails have expired, resend them:

```bash
# billing topic lives in us-east-1; operational in ap-south-1
aws sns list-subscriptions --region us-east-1 \
  --query "Subscriptions[?contains(TopicArn,'billing')]"
```

If a subscription shows `PendingConfirmation`, delete it and re-apply the stack
that owns it (`infra/bootstrap` for billing, `infra/stacks/monitoring` for
operational) to trigger a fresh email.

Also, one console-only tick with no API: **Billing → Billing Preferences →
Receive CloudWatch billing alerts → Enable**. Without it the estimated-charges
alarm sits in `INSUFFICIENT_DATA` forever.

**Check:** both subscriptions read `Confirmed`, not `PendingConfirmation`.

---

## Step 4 — Custom domain

Optional, but it turns `…cloudfront.net/d/dep_abc/` into `dep-abc.yourdomain.com`.
Everything was built to accept a domain by flipping one variable; the routing
already handles both forms.

### 4a. The domain must be in Route53 in this account

If you registered it elsewhere, create a **public hosted zone** for it and point
your registrar's nameservers at the four Route53 nameservers. This propagates in
minutes to a day; the rest of this step waits on it.

```bash
aws route53 create-hosted-zone --name yourdomain.com \
  --caller-reference "$(date +%s)"
# then set the NS records at your registrar to the ones it returns
```

### 4b. Point the edge stack at it

```bash
cd /c/Users/katre/Desktop/vercel/infra/stacks/edge
terraform apply -var domain_name=yourdomain.com
```

This requests an ACM certificate in **us-east-1** (required for CloudFront),
validates it via a DNS record it adds to your zone, attaches the wildcard
`*.yourdomain.com` and apex to the distribution, and adds the alias records. The
certificate validation can take 5–30 minutes; Terraform waits.

### 4c. Tell the control plane the domain exists

```bash
cd /c/Users/katre/Desktop/vercel/infra/stacks/app
terraform apply -var auth_enabled=true -var deployment_domain=yourdomain.com
```

Now new deployments get a `hostname` and the API returns
`https://dep-xxxx.yourdomain.com/` as the deployment URL. Redeploy the dashboard
so its CORS origin and links pick up the domain, and add the domain to
`cors_allow_origins` in `infra/stacks/app/variables.tf`.

**Check:** deploy something, then `curl -I https://dep-<id>.yourdomain.com/` —
expect `200` and a valid certificate. A wildcard cert covers one level only, so
`dep-abc.yourdomain.com` works and `dep-abc.preview.yourdomain.com` would not —
the subdomain scheme was kept single-level for exactly this reason.

---

## Step 5 — Webhooks: auto-deploy on push

This is the one piece of *new engineering* rather than configuration, and it
genuinely needs the repo from Step 1 to exist, because it reacts to that repo's
push events. I have not built it yet; here is the shape it takes, and I can
implement it on your go.

### What it involves

1. **A public endpoint** — `POST /webhooks/github` on the existing API. It is
   unauthenticated in the session sense (GitHub has no session), so it is
   verified a different way: every GitHub webhook carries an
   `X-Hub-Signature-256` HMAC of the body, keyed by a shared secret. The handler
   recomputes it and rejects any request whose signature does not match, in
   constant time. Without that check the endpoint is a free "build anything"
   button for the internet.

2. **A secret**, generated once and stored in SSM alongside the OAuth
   credentials, given to GitHub when the webhook is created.

3. **Mapping push → project.** The payload names the repository and the branch.
   The handler looks up the project(s) whose `repositoryUrl` matches and whose
   `defaultBranch` equals the pushed branch, then creates a deployment for each —
   the same path `POST /deployments` already uses, so the quota, the queue and
   the whole pipeline apply unchanged. `trigger` is recorded as `webhook`, which
   the deployment model already has a slot for.

4. **Ignoring the noise.** Only `push` events, only to the default branch,
   skipping branch deletions (`deleted: true`) — otherwise every tag and every
   feature branch would start a build.

### Why it's safe to add last

The webhook is just another way to call the deployment pipeline that already
exists and is already bounded — the daily quota and the concurrency cap apply to
a webhook-triggered build exactly as to a manual one, so a push flood cannot
outspend a click flood. It reuses the state machine, the dispatcher, the
reconciler. There is no new trust boundary, only a new, signature-verified door
into an existing one.

**When you're ready:** say so, and I'll build the handler, its signature
verification with a deliberately-hostile test suite, the SSM secret, and a short
script that registers the webhook on the repo via the GitHub API.

---

## Order-of-operations summary

```
1. push to GitHub            → repo exists, CI runs
   └ apply cicd stack        → OIDC roles, CI goes fully green
2. OAuth app + auth_enabled  → the platform is no longer open to the world
3. confirm SNS email         → alarms can actually reach you
4. custom domain (optional)  → pretty per-deployment URLs
5. webhooks (new code)       → git push builds automatically
```

Steps 1–3 are the ones that matter for leaving this running safely. 4 is polish.
5 is the last feature.
