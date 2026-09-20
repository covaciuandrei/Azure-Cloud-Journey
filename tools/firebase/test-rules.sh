#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
mkdir -p .data/firebase-runtime .data/firebase-emulator-cache
export TMPDIR="$PWD/.data/firebase-runtime"
export FIREBASE_EMULATORS_PATH="$PWD/.data/firebase-emulator-cache"

exec firebase emulators:exec \
  --only firestore,storage \
  --project demo-az104-study \
  "node --import tsx --test tests/firebase-rules.test.ts tests/upload.test.ts tests/upload-emulator.test.ts"
