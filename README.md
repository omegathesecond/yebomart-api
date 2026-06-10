# YeboMart API

Smart Shop Management for Eswatini — POS, inventory, sales, billing.

## Development

```bash
npm install
npm run db:generate   # generate the Prisma client
npm run dev           # nodemon + ts-node on src/server.ts
```

## Tests

The money-critical paths (sale creation, offline idempotency, billing credits)
have an automated [Vitest](https://vitest.dev) suite.

```bash
npm test          # run once (CI)
npm run test:watch
```

### How the tests stay deterministic & CI-safe

Tests **never** touch a real database — not Neon, not a local Postgres, not
Docker. They run against a small **in-memory Prisma fake** at
[`src/test/prismaFake.ts`](src/test/prismaFake.ts).

- `vitest.config.ts` aliases the `@config/prisma` import to that fake, so the
  services under test transparently use it.
- The fake implements only the operations the services call, and it **enforces
  the `@@unique([shopId, localId])` constraint on `Sale`** by throwing a real
  `Prisma.PrismaClientKnownRequestError` with code `P2002` — exactly like
  Postgres. That makes the offline-idempotency backstop in `sale.service.ts`
  run against the genuine error type, not a stub.
- `$transaction` snapshots state and rolls back on throw, so "rejected sale
  writes nothing" is faithfully verified.

Because there is no DB, no `DATABASE_URL` / network is required to run the
suite. Prerequisite: the Prisma client must be generated once
(`npm run db:generate`) so `@prisma/client` enums and error classes resolve.

### What's covered

`src/services/sale.service.test.ts` — `SaleService.create`:

- stock is decremented by the sold quantity and a `SALE` `StockLog` is written
  with correct `previousQty`/`newQty`
- `SaleItem` snapshots `unitPrice` + `costPrice` (profit calc depends on it)
- tax/total/change math (VAT is hardcoded to 0 today; `it.todo`s mark the
  exclusive/inclusive cases to fill in once the VAT task makes tax configurable)
- **offline idempotency**: replaying the same `localId` creates exactly one
  `Sale` and decrements stock once — both the `findFirst` fast-path and the
  `P2002` race backstop
- insufficient payment is rejected and writes nothing
- overselling available stock is rejected and writes nothing

`src/services/billing.service.test.ts` — `BillingService`:

- balance reads surface shop-not-found loudly (no silent fallback)
- charges forward the `idempotencyKey` (a retry can't double-spend) and merge
  `shopId` into metadata
- `INSUFFICIENT_BALANCE` propagates loudly instead of masking a failed debit
- top-up math (packs + custom amount) and the `credit_amount` metadata the
  yebopay webhook needs to actually deliver credits

> Regression guard: if the `localId` dedup is removed from `sale.service.ts`,
> the offline-idempotency tests fail (a duplicate `Sale` / double stock
> decrement, or an unrecovered `P2002`).

## Build & Deploy

```bash
npm run build   # tsc + tsc-alias -> dist/ (test files are excluded)
```

Pushing the production branch triggers Cloud Build → `yebomart-api-prod`
(Cloud Run, `europe-west1`) serving `api.yebomart.com`. The `dev` branch → 
`yebomart-api-dev` → `dev-api.yebomart.com`.
