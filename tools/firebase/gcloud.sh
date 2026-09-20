#!/usr/bin/env bash
set -euo pipefail

: "${AZ104_FIREBASE_TOOLS_HOME:?Set AZ104_FIREBASE_TOOLS_HOME to the isolated firebase-local session directory}"
: "${AZURE_CLOUD_JOURNEY_ADMIN_EMAIL:?Set AZURE_CLOUD_JOURNEY_ADMIN_EMAIL to the approved administrator}"

export CLOUDSDK_CONFIG="$AZ104_FIREBASE_TOOLS_HOME/gcloud-config"
export CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true
export CLOUDSDK_PAGER=cat
export TMPDIR="$AZ104_FIREBASE_TOOLS_HOME/runtime"

exec "$AZ104_FIREBASE_TOOLS_HOME/google-cloud-sdk/bin/gcloud" \
  "$@" --project study-az104 --account "$AZURE_CLOUD_JOURNEY_ADMIN_EMAIL"
