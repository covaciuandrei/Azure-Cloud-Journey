#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
python3 -c 'import shutil; raise SystemExit(shutil.disk_usage(".").free <= 2500000000)'
mkdir -p .data/sc900-emulator/home .data/sc900-emulator/runtime .data/firebase-emulator-cache
node --input-type=module <<'JS'
import { copyFile, writeFile } from "node:fs/promises";
for (const path of ["firestore.rules", "firestore.indexes.json", "storage.rules"]) {
  await copyFile(path, `.data/sc900-emulator/${path}`);
}
await writeFile(".data/sc900-emulator/config.json", JSON.stringify({
  firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
  storage: { rules: "storage.rules" },
  emulators: { firestore: { host: "127.0.0.1", port: 18180 },
    storage: { host: "127.0.0.1", port: 19199 }, ui: { enabled: false }, singleProjectMode: true },
}));
JS

firebase_cli="$(command -v firebase)"
exec env -u GOOGLE_APPLICATION_CREDENTIALS -u FIREBASE_TOKEN -u FIRESTORE_EMULATOR_HOST \
  -u FIREBASE_STORAGE_EMULATOR_HOST -u STORAGE_EMULATOR_HOST -u FIREBASE_AUTH_EMULATOR_HOST \
  -u CLOUDSDK_CONFIG -u CLOUDSDK_AUTH_ACCESS_TOKEN -u GOOGLE_OAUTH_ACCESS_TOKEN \
  -u GOOGLE_CLOUD_PROJECT -u GCLOUD_PROJECT \
  HOME="$PWD/.data/sc900-emulator/home" XDG_CONFIG_HOME="$PWD/.data/sc900-emulator/home" \
  TMPDIR="$PWD/.data/sc900-emulator/runtime" FIREBASE_EMULATORS_PATH="$PWD/.data/firebase-emulator-cache" \
  FIREBASE_CLI_DISABLE_USAGE_REPORTING=1 NO_UPDATE_NOTIFIER=1 CI=true \
  "$firebase_cli" emulators:exec --config .data/sc900-emulator/config.json \
  --only firestore,storage --project demo-az104-study \
  "node --import tsx --test tests/sc900-cloud-emulator.test.ts"
