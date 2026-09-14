import { getDb } from "../src/infra/db";
import { listAppliedMigrations } from "../src/infra/migrations";
import { getContextDb, listContextMigrations } from "../src/assistant/context-db";

const db = getDb();
const contextDb = getContextDb();
console.log(
  JSON.stringify(
    {
      ok: true,
      platformMigrations: listAppliedMigrations(db),
      contextMigrations: listContextMigrations(contextDb),
    },
    null,
    2,
  ),
);
