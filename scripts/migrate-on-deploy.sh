#!/bin/sh
# Applies pending Drizzle migrations to production (Neon `main`) at the end of a Vercel production build: vercel.json
# runs this after `next build`, so a build that fails never touches the database, and Vercel only promotes the
# deployment once this has succeeded too. Any other build skips it, whatever database URL it has, so an unmerged pull
# request's migration can never reach production. Every migration must keep working with the code already live: see
# "Migrations" in the README.
set -e

if [ "$VERCEL_ENV" != "production" ]; then
  echo "migrate-on-deploy: ${VERCEL_ENV:-local} build; migrations run only in production builds"
  exit 0
fi

url="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
if [ -z "$url" ]; then
  echo "migrate-on-deploy: no database URL in a production build; refusing to deploy unmigrated" >&2
  exit 1
fi

echo "migrate-on-deploy: applying migrations (production)"
# drizzle.config.ts reads DATABASE_URL; its .env.local load never replaces a variable already set.
DATABASE_URL="$url" npx drizzle-kit migrate
