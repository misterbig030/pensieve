import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import * as schema from "./schema";

// Uses the neon-serverless (Pool/websocket) driver rather than neon-http,
// because several query helpers in lib/db/queries.ts rely on db.transaction(),
// which the neon-http driver does not support.
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
export const db = drizzle(pool, { schema });
