CREATE TABLE "user_api_keys" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_api_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "generation_log" ADD COLUMN "key_owner" text DEFAULT 'app' NOT NULL;