#!/bin/sh
# Rewrites Postiz's Postgres Prisma schema into a D1 (SQLite) one, in place.
# Usage: ./to-d1-schema.sh path/to/schema.prisma
# Works on the upstream schema instead of a forked copy so upstream changes flow
# in; extend the rules if `prisma validate` starts failing.
set -e
sed -i.bak -E \
  -e 's/provider = "postgresql"/provider = "sqlite"/' \
  -e 's/runtime  = "nodejs"/runtime  = "nodejs"\
  previewFeatures = ["driverAdapters"]/' \
  -e 's/@db\.[A-Za-z]+(\([^)]*\))?//g' \
  -e 's/, type: [A-Za-z]+\)/)/' \
  -e 's/(@@id\(\[[^]]*\]), map: "[^"]*"\)/\1)/' \
  "$1"
rm -f "$1.bak"
