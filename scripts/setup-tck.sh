#!/bin/bash
# Download the openCypher TCK feature files into test/tck/openCypher (gitignored)
#
# Pinned to the openCypher commit the TCK baseline was last checked against.
# Override with: TCK_COMMIT=<sha> npm run tck:setup

set -e

TCK_COMMIT=${TCK_COMMIT:-59edf2e1c17b845bf97c334ed06b2eb780950c13}
TCK_DIR="$(cd "$(dirname "$0")/.." && pwd)/test/tck/openCypher"

if [ ! -d "$TCK_DIR/.git" ]; then
  mkdir -p "$TCK_DIR"
  git -C "$TCK_DIR" init -q
  git -C "$TCK_DIR" remote add origin https://github.com/opencypher/openCypher.git
fi

# Sparse checkout: only the feature files are needed
git -C "$TCK_DIR" sparse-checkout set tck/features
git -C "$TCK_DIR" fetch -q --depth 1 --filter=blob:none origin "$TCK_COMMIT"
git -C "$TCK_DIR" checkout -q FETCH_HEAD

echo "openCypher TCK at $(git -C "$TCK_DIR" log -1 --format='%h %ad' --date=short):" \
  "$(find "$TCK_DIR/tck/features" -name '*.feature' | wc -l | tr -d ' ') feature files"
