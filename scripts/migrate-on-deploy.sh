#!/bin/sh
# Applies pending Drizzle migrations at the start of a Vercel build, so the schema is up to date before the new code
# serves (vercel.json runs this before `next build`). Production migrates Neon `main`; a preview migrates the Neon
# branch the integration made for that deployment. Every migration must keep working with the code already live:
# see "Migrations" in the README.
set -e

url="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
if [ -z "$url" ]; then
  if [ "$VERCEL_ENV" = "production" ]; then
    echo "migrate-on-deploy: no database URL in a production build; refusing to deploy unmigrated" >&2
    exit 1
  fi
  echo "migrate-on-deploy: no database URL in this ${VERCEL_ENV:-local} build; skipping migrations"
  exit 0
fi

echo "migrate-on-deploy: applying migrations (${VERCEL_ENV:-local})"
# drizzle.config.ts reads DATABASE_URL; its .env.local load never replaces a variable already set.
DATABASE_URL="$url" npx drizzle-kit migrate
