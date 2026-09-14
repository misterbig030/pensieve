CREATE TABLE "generation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller" text NOT NULL,
	"model" text NOT NULL,
	"effort" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"track_id" uuid,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
