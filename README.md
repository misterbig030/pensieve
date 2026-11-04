This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment

Besides the database, Clerk and AI Gateway keys:

- `TAVILY_API_KEY`: web search for the research step. Without it, plans draft from the learner's own sources and say
  research was unavailable.
- `RESEARCH_ARM`: `workers` runs research as one worker per direction (backbone, canonical, current) at once instead
  of one loop; unset, the single loop runs. Behind a flag until the research eval decides (`evals/research/README.md`).
- `MATERIALS_SIGNING_SECRET`: signs verified materials so a forged "verified" badge cannot be saved. Without it a
  random per-process secret is used, and plans confirmed on another instance re-verify their materials.
- `USER_KEY_ENCRYPTION_SECRET`: encrypts the API keys users store in Settings (AES-256-GCM). 32 random bytes, base64:
  `openssl rand -base64 32`. Without it, saving a key fails; nothing is ever stored in plaintext.
- `OPEN_LIBRARY_CONTACT`: an email or phone number Open Library may use to reach whoever runs this app, sent in the
  User-Agent of every request to Open Library (catalogue lookups and page reads alike) as its API terms ask. All of
  them share one pace per server: with a contact, up to 3 a second; without it, 1 a second. Going faster gets the
  server's address blocked, and every book then fails its catalogue check.

## Users and credits

Every user gets 500 free credits ($5 of model cost Pensieve pays) a period; a period starts at 00:00 UTC on their signup
day of the month (`lib/credits.ts`). There is no stored balance: credits left are worked out from `generation_log`,
whose `cost_usd` is what the AI Gateway charged for each call. Calls on a user's own key never reach the gateway: they
record no cost and use no credits. The admin's model-calls panel shows them at a list-price estimate (`pricing` in
`lib/ai/models.ts`), marked ≈, beside the gateway's charges for the rest.
Run these in the database (the Neon SQL editor), with the user's Clerk id:

- Give a user their full allowance back for the rest of this period:
  `UPDATE users SET credits_reset_at = now() WHERE id = 'user_…';` Spend before it stops counting; the next period
  starts fresh as usual, and their reset day does not change.
- Make a user an admin (no credit limit, the admin menu and the model-calls panel):
  `UPDATE users SET is_admin = true WHERE id = 'user_…';`

## Deployment checklist

There is no cloud deployment yet. The databases are two branches of one Neon project (connected through Vercel
Storage):

- **`main`** is production. Vercel's Production and Preview environments get it from the Neon integration.
- **`dev`** is a copy of `main` taken on 2026-11-04. Local `.env.local` and Vercel's Development environment
  (`vercel env pull`) point at it, so local work and `drizzle-kit migrate` never touch production.

Before the first deployment, in this order:

- [x] **Set `USER_KEY_ENCRYPTION_SECRET` in Vercel to the same value as the local `.env.local`.** Users' API keys
  already stored from the local app are sealed with that value; a different one makes them unreadable, and every
  user would have to re-enter their key. (Done 2026-11-04: Sensitive in production and preview, plain in
  development, copied from `.env.local` without printing it.)
- [x] Set the rest of the local environment: `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, `MATERIALS_SIGNING_SECRET`,
  `OPEN_LIBRARY_CONTACT` and `RESEARCH_ARM` (done 2026-11-04, same way). The database URLs come from the Neon
  integration and the Clerk keys from the Clerk integration. Admins are not an environment variable: they are
  `users.is_admin` in the database.
- [ ] Apply any pending migrations to **production** **before** the deploy that needs them. `npx drizzle-kit migrate`
  on its own migrates `dev`; for production, override the URL (the config's dotenv load does not replace a variable
  that is already set):
  `vercel env pull /tmp/pensieve-prod.env --environment=production && DATABASE_URL="$(grep '^DATABASE_URL=' /tmp/pensieve-prod.env | cut -d= -f2- | tr -d '"')" npx drizzle-kit migrate; rm -f /tmp/pensieve-prod.env`.
  New columns must exist before the new code inserts into them; old code tolerates new columns because they carry defaults.
  A migration that adds a foreign key is the exception: old code can insert rows it rejects (0017's `users` links
  need a user's row before their first track or key), so ship the code that keeps it satisfied right after.
- [ ] After the first deploy, run one plan draft on a stored user key and confirm the admin model-calls panel shows
  "user's key" on every row and the usage appears on that user's Anthropic Console, not the gateway.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
