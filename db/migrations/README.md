# Database migrations

Every schema change is a file in this folder, applied in **filename order** and
recorded so it runs once. `db/schema.pg.sql` is the fresh-deploy baseline; these are
the increments on top of it. Both must agree — a column that exists only in a
migration is missing from a newly created environment, and one that exists only in
the baseline never reaches the environments already running.

## Naming

Use a **timestamp**, not the next number:

```
20260821-1430-add-quote-tags.sql
20260822-0915-widen-change-request-title.sql
```

Two people working the same afternoon will both reach for `003-`, and whoever merges
second silently overwrites the other. Timestamps cannot collide that way.

## Writing one

Plain PostgreSQL DDL, and **idempotent** — the runner may re-apply a file after a
partial failure, and the baseline is applied on every deploy:

```sql
ALTER TABLE quote ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS ix_quote_tags ON quote USING gin (tags);
```

Rules worth knowing before you write one:

- **Additive by default.** A deploy rolls the app forward and back, but a dropped
  column does not come back. Add the new column, move the reads, and drop the old one
  in a *later* migration once nothing references it.
- **No `CREATE TABLE` from application code.** The API's role is DML-only and cannot
  execute DDL at all — this is deliberate, so an internet-facing app can never alter
  its own schema. Schema changes only ever happen here.
- **Backfills belong in the migration**, not in a one-off script someone runs by
  hand and forgets on the next environment.
- **Watch the lock.** `ALTER TABLE … ADD COLUMN` with a non-volatile default is cheap
  in modern PostgreSQL, but adding a constraint or an index without `CONCURRENTLY`
  takes a write lock on a table three applications' worth of traffic may be using.
  The server is shared.

## Testing before you commit

Apply against your local database first and confirm the app still runs. A migration
that fails in the pipeline blocks the deploy for everyone; one that succeeds but is
wrong is worse, because it is already applied.
