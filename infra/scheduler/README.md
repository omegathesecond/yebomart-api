# Cloud Scheduler — daily WhatsApp report

The headline YeboMart daily WhatsApp report + low-stock alert pass is driven by
**Cloud Scheduler**, which does a daily authenticated POST to a secret-gated
internal endpoint. Nothing in application code creates that job — this directory
is the IaC for it.

| | |
|---|---|
| Job name (prod) | `yebomart-daily-notifications` |
| Job name (dev) | `yebomart-daily-notifications-dev` |
| Project / location | `hiyebo` / `europe-west1` |
| Schedule | `0 8 * * *` (08:00 `Africa/Mbabane`) |
| Target (prod) | `POST https://api.yebomart.com/api/internal/notifications/run` |
| Target (dev) | `POST https://dev-api.yebomart.com/api/internal/notifications/run` |
| Auth | header `X-Internal-Secret: <INTERNAL_NOTIFICATIONS_SECRET>` |
| Body | `{}` (the API defaults the report `date` to "now") |

Endpoint wiring: `src/routes/internal.routes.ts` (shared-secret guard) →
`src/controllers/notification.controller.ts` → `NotificationService.runDailyNotifications`.
Delivery goes through YeboLink (WhatsApp, SMS fallback).

## Provision

```bash
# prod (default) — reads the shared secret from Secret Manager so the header
# the job sends always matches what the API expects.
./provision-daily-notifications-job.sh

# dev
ENV=dev ./provision-daily-notifications-job.sh
```

The script is idempotent (create-or-update) and fails loud if the backing
secret is missing rather than provisioning a job that would 401 forever.

## ⚠️ Verification finding (2026-06-17) — DO NOT skip the prerequisites

A verification audit found the daily report **does not fire in prod**, for two
compounding reasons:

1. **The Cloud Scheduler job was never provisioned.** No yebomart job exists in
   `europe-west1` (only `ceodashboard-cron-tick`, `eneza-low-balance-alerts`,
   `money-coach-weekly-digest`).

2. **The target endpoint is dead in prod anyway.** `POST
   https://api.yebomart.com/api/internal/notifications/run` returns **404**
   because prod traffic is pinned to revision `yebomart-api-prod-00015-p7w`,
   which predates the notifications feature (shipped in commit `1b090ea`). Every
   newer revision (through `00027-tq5`) is stuck `Ready=False`.

   **Root cause:** `cloudbuild.yaml` binds `YEBOMART__YEBOLINK_API_KEY` and
   `YEBOMART__INTERNAL_NOTIFICATIONS_SECRET`, but **neither secret exists** in
   Secret Manager. The runtime SA
   (`yebomart-runtime@hiyebo.iam.gserviceaccount.com`) gets *"Permission denied
   on secret"* → new revisions never pass readiness → traffic never advances
   off `00015`. (`YEBOMART__YEBOPAY_API_KEY` does exist; the YeboLink + internal
   secrets do not.)

So provisioning the scheduler job is necessary but **not sufficient**. The full
fix, in order:

### Step 1 — create the two missing secrets

`INTERNAL_NOTIFICATIONS_SECRET` is a shared secret you control on both ends —
generate one:

```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create \
    YEBOMART__INTERNAL_NOTIFICATIONS_SECRET \
    --project=hiyebo --replication-policy=automatic --data-file=-
```

`YEBOLINK_API_KEY` must be a **real** YeboLink key (`ybk_*`) provisioned for
YeboMart in the Omevision Hub workspace — do **not** invent one. Use the
`yebolink-implementation` runbook, then:

```bash
printf '%s' "$YBK_KEY" | gcloud secrets create YEBOMART__YEBOLINK_API_KEY \
    --project=hiyebo --replication-policy=automatic --data-file=-
```

Grant the runtime SA accessor on each (do this for BOTH secrets):

```bash
for S in YEBOMART__INTERNAL_NOTIFICATIONS_SECRET YEBOMART__YEBOLINK_API_KEY; do
  gcloud secrets add-iam-policy-binding "$S" --project=hiyebo \
    --member='serviceAccount:yebomart-runtime@hiyebo.iam.gserviceaccount.com' \
    --role='roles/secretmanager.secretAccessor'
done
```

(Dev uses the `_DEV` secret variants per `cloudbuild.yaml`.)

### Step 2 — get the notifications release live

Redeploy so a revision that binds both secrets passes readiness and takes 100%
traffic (push to `main`, or roll forward the existing trigger). Confirm:

```bash
gcloud run services describe yebomart-api-prod --region=europe-west1 \
    --project=hiyebo --format='value(status.latestReadyRevisionName)'
# should be the NEW revision, not 00015-p7w
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    https://api.yebomart.com/api/internal/notifications/run \
    -H 'X-Internal-Secret: bogus' -d '{}'
# should be 401 (route exists, secret rejected) — NOT 404
```

> Note: advancing prod off `00015` also releases everything else queued since
> the notifications commit (e.g. the YeboPay billing cutover). Treat it as a
> real prod release, not a no-op.

### Step 3 — provision the scheduler job

```bash
./provision-daily-notifications-job.sh
```

### Step 4 — smoke-test

```bash
gcloud scheduler jobs run yebomart-daily-notifications \
    --project=hiyebo --location=europe-west1
# then check the run summary in the Cloud Run logs
```
