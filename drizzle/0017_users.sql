CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"signed_up_at" timestamp,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A row for every user already in the data, so the foreign keys below hold. Signup dates fill from Clerk on first read.
INSERT INTO "users" ("id")
SELECT "user_id" FROM "tracks"
UNION SELECT "user_id" FROM "user_api_keys"
UNION SELECT "user_id" FROM "generation_log" WHERE "user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;