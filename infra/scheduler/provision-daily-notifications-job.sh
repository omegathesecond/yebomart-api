#!/usr/bin/env bash
#
# Provision (create or update) the Cloud Scheduler job that fires the YeboMart
# daily WhatsApp report + low-stock alert pass.
#
# The job does a plain HTTP POST to the secret-gated internal endpoint:
#     POST https://api.yebomart.com/api/internal/notifications/run
#     header: X-Internal-Secret: <INTERNAL_NOTIFICATIONS_SECRET>
#     body:   {}            (empty -> the API defaults `date` to "now")
#
# The endpoint runs NotificationService.runDailyNotifications across every
# opted-in shop and returns a per-run summary (see
# src/controllers/notification.controller.ts + src/routes/internal.routes.ts).
#
# This script is IDEMPOTENT: it creates the job if absent, otherwise updates it.
# Safe to re-run.
#
# ──────────────────────────────────────────────────────────────────────────
# PREREQUISITES (see README.md in this directory — DO NOT skip):
#   1. The Secret Manager secret bound as INTERNAL_NOTIFICATIONS_SECRET must
#      EXIST and be readable by the Cloud Run runtime SA, AND the Cloud Run
#      service must be serving a revision that actually has the
#      /api/internal/notifications/run route (i.e. the notifications release,
#      commit 1b090ea or later, must be LIVE — see the outage note in README).
#   2. The X-Internal-Secret value this job sends MUST be byte-identical to the
#      INTERNAL_NOTIFICATIONS_SECRET the API reads from Secret Manager, else the
#      endpoint correctly rejects with 401.
# ──────────────────────────────────────────────────────────────────────────
#
# Usage:
#   # prod (default)
#   ./provision-daily-notifications-job.sh
#
#   # dev
#   ENV=dev ./provision-daily-notifications-job.sh
#
#   # override the shared secret value explicitly (otherwise it is read from
#   # Secret Manager so the job and the API stay in lockstep)
#   INTERNAL_SECRET='...' ./provision-daily-notifications-job.sh
#
set -euo pipefail

PROJECT="${PROJECT:-hiyebo}"
LOCATION="${LOCATION:-europe-west1}"
ENV="${ENV:-prod}"

case "$ENV" in
  prod)
    JOB_NAME="yebomart-daily-notifications"
    TARGET_URL="https://api.yebomart.com/api/internal/notifications/run"
    SECRET_NAME="YEBOMART__INTERNAL_NOTIFICATIONS_SECRET"
    ;;
  dev)
    JOB_NAME="yebomart-daily-notifications-dev"
    TARGET_URL="https://dev-api.yebomart.com/api/internal/notifications/run"
    SECRET_NAME="YEBOMART__INTERNAL_NOTIFICATIONS_SECRET_DEV"
    ;;
  *)
    echo "ERROR: ENV must be 'prod' or 'dev' (got '$ENV')" >&2
    exit 1
    ;;
esac

# 08:00 Africa/Mbabane (SAST, UTC+2) — owners get yesterday's summary first thing.
# Matches the cadence of the existing eneza-low-balance-alerts job.
SCHEDULE="${SCHEDULE:-0 8 * * *}"
TZ="${TZ:-Africa/Mbabane}"

# Resolve the shared secret. Default: read the LIVE value from Secret Manager so
# the header the scheduler sends always matches what the API expects. Fail loud
# if it is missing — we never provision a job that will 401 forever in silence.
INTERNAL_SECRET="${INTERNAL_SECRET:-}"
if [[ -z "$INTERNAL_SECRET" ]]; then
  echo "Reading $SECRET_NAME from Secret Manager (project=$PROJECT)..."
  if ! INTERNAL_SECRET="$(gcloud secrets versions access latest \
        --secret="$SECRET_NAME" --project="$PROJECT" 2>/dev/null)"; then
    cat >&2 <<EOF
ERROR: secret '$SECRET_NAME' does not exist (or no version) in project '$PROJECT'.

The daily-notifications feature cannot run until this secret is created AND the
Cloud Run runtime SA (yebomart-runtime@hiyebo.iam.gserviceaccount.com) can read
it. To create it (value is a shared secret you control on both ends):

  SECRET_VALUE="\$(openssl rand -hex 32)"
  printf '%s' "\$SECRET_VALUE" | gcloud secrets create $SECRET_NAME \\
      --project=$PROJECT --replication-policy=automatic --data-file=-
  gcloud secrets add-iam-policy-binding $SECRET_NAME --project=$PROJECT \\
      --member='serviceAccount:yebomart-runtime@hiyebo.iam.gserviceaccount.com' \\
      --role='roles/secretmanager.secretAccessor'

Then redeploy the API so a revision that binds the secret goes Ready, and re-run
this script. See README.md.
EOF
    exit 1
  fi
fi
# Strip any trailing newline so the header matches the API's stored value exactly.
INTERNAL_SECRET="${INTERNAL_SECRET%$'\n'}"

COMMON_ARGS=(
  "$JOB_NAME"
  --project="$PROJECT"
  --location="$LOCATION"
  --schedule="$SCHEDULE"
  --time-zone="$TZ"
  --uri="$TARGET_URL"
  --http-method=POST
  --headers="Content-Type=application/json,X-Internal-Secret=${INTERNAL_SECRET}"
  --message-body={}
  --attempt-deadline=300s
  --description="Fires YeboMart daily WhatsApp report + low-stock alerts (POST /api/internal/notifications/run)."
)

if gcloud scheduler jobs describe "$JOB_NAME" \
      --project="$PROJECT" --location="$LOCATION" >/dev/null 2>&1; then
  echo "Job '$JOB_NAME' exists — updating..."
  gcloud scheduler jobs update http "${COMMON_ARGS[@]}"
else
  echo "Job '$JOB_NAME' missing — creating..."
  gcloud scheduler jobs create http "${COMMON_ARGS[@]}"
fi

echo
echo "Done. Verify with:"
echo "  gcloud scheduler jobs describe $JOB_NAME --project=$PROJECT --location=$LOCATION"
echo "Trigger a one-off run with:"
echo "  gcloud scheduler jobs run $JOB_NAME --project=$PROJECT --location=$LOCATION"
