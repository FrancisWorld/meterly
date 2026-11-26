import { createDb } from "./client.ts";
import { migrate } from "./migrate.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(url, 2);
try {
  const applied = await migrate(db);
  console.log(applied.length === 0 ? "schema is up to date" : `applied: ${applied.join(", ")}`);
} finally {
  await db.close();
}
