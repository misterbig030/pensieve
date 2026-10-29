/**
 * Loads `.env.local` as a side effect. Import it first: the modules under `@/lib` read env when they load (the
 * database client builds its pool from DATABASE_URL), and ES imports run in order.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
