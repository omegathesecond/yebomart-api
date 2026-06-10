/**
 * In-memory Prisma fake for the money-critical service tests.
 *
 * WHY a fake (and not the real Neon DB / a Docker Postgres):
 *   - Tests must be deterministic and CI-safe with ZERO external services —
 *     no network, no Docker, no `prisma migrate` against a live DB. They must
 *     never touch the prod Neon DB.
 *   - The yebomart schema uses Postgres-only features (native enums, @db.Uuid,
 *     mode:'insensitive'), so a SQLite swap would silently diverge from prod.
 *
 * This fake implements ONLY the operations the services under test actually
 * call (sale.service.ts + billing.service.ts), and — crucially — it enforces
 * the one DB invariant those services lean on: the @@unique([shopId, localId])
 * constraint on Sale. On a duplicate insert it throws a REAL
 * `Prisma.PrismaClientKnownRequestError` with code 'P2002', exactly like
 * Postgres would, so the idempotency backstop in sale.service.ts (which does
 * `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'`)
 * runs against the genuine error type — not a stub that happens to pass.
 *
 * It is intentionally small and generic (a where-matcher + a tiny write
 * engine), not special-cased to make individual assertions pass.
 */
import { Prisma } from '@prisma/client';

type Row = Record<string, any>;

// Models this fake knows about (only what the tests need).
type ModelName = 'shop' | 'product' | 'sale' | 'saleItem' | 'stockLog';

// Composite/unique keys, mirroring the Prisma schema. Enforced only when every
// part is non-null (Postgres treats NULLs as distinct, so multiple null localIds
// are allowed — same as prod).
const UNIQUE_KEYS: Record<ModelName, string[][]> = {
  shop: [['ownerYeboidSub'], ['ownerPhone']],
  product: [['shopId', 'barcode']],
  sale: [['shopId', 'localId'], ['shopId', 'receiptNumber']],
  saleItem: [],
  stockLog: [],
};

// Nested-relation field -> child model, for `{ create: [...] }` writes.
const RELATIONS: Partial<Record<ModelName, Record<string, ModelName>>> = {
  sale: { items: 'saleItem' },
};

function matchesWhere(rec: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const val = rec[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as any[]).includes(val);
      if ('not' in cond) return val !== cond.not;
      let ok = true;
      if ('gte' in cond) ok = ok && val >= cond.gte;
      if ('gt' in cond) ok = ok && val > cond.gt;
      if ('lte' in cond) ok = ok && val <= cond.lte;
      if ('lt' in cond) ok = ok && val < cond.lt;
      if ('contains' in cond) {
        ok = ok && String(val ?? '').toLowerCase().includes(String(cond.contains).toLowerCase());
      }
      return ok;
    }
    return val === cond;
  });
}

function project(rec: Row, select: Row | undefined): Row {
  if (!select) return { ...rec };
  const out: Row = {};
  for (const [k, want] of Object.entries(select)) {
    if (want) out[k] = rec[k];
  }
  return out;
}

class FakeDb {
  private tables: Record<ModelName, Row[]> = {
    shop: [],
    product: [],
    sale: [],
    saleItem: [],
    stockLog: [],
  };
  private idCounter = 0;
  // Promise chain that serializes interactive $transaction callbacks (see
  // transaction()). Reset between tests so a failed tx can't poison the chain.
  private txChain: Promise<unknown> = Promise.resolve();

  reset() {
    (Object.keys(this.tables) as ModelName[]).forEach((m) => (this.tables[m] = []));
    this.idCounter = 0;
    this.txChain = Promise.resolve();
  }

  rows(model: ModelName): Row[] {
    return this.tables[model];
  }

  private snapshot(): Record<ModelName, Row[]> {
    const out = {} as Record<ModelName, Row[]>;
    (Object.keys(this.tables) as ModelName[]).forEach(
      (m) => (out[m] = this.tables[m].map((r) => ({ ...r })))
    );
    return out;
  }

  private restore(snap: Record<ModelName, Row[]>) {
    (Object.keys(snap) as ModelName[]).forEach((m) => (this.tables[m] = snap[m]));
  }

  private enforceUnique(model: ModelName, rec: Row) {
    for (const keyset of UNIQUE_KEYS[model]) {
      if (keyset.some((f) => rec[f] === undefined || rec[f] === null)) continue;
      const clash = this.tables[model].some((r) => keyset.every((f) => r[f] === rec[f]));
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          `Unique constraint failed on the fields: (${keyset.join(',')})`,
          { code: 'P2002', clientVersion: 'fake', meta: { target: keyset } }
        );
      }
    }
  }

  includeOn(model: ModelName, rec: Row, include: Row | undefined): Row {
    if (!include) return { ...rec };
    const out = { ...rec };
    const rels = RELATIONS[model] ?? {};
    for (const [field, want] of Object.entries(include)) {
      if (!want) continue;
      const childModel = rels[field];
      if (childModel) {
        const fk = `${model}Id`;
        out[field] = this.tables[childModel]
          .filter((r) => r[fk] === rec.id)
          .map((r) => ({ ...r }));
      }
    }
    return out;
  }

  createOne(model: ModelName, data: Row): Row {
    const rec: Row = {};
    const children: Array<[string, Row | Row[]]> = [];
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        if ('connect' in v) {
          rec[`${k}Id`] = (v as any).connect.id;
          continue;
        }
        if ('create' in v) {
          children.push([k, (v as any).create]);
          continue;
        }
      }
      rec[k] = v;
    }
    if (rec.id === undefined) rec.id = `${model}_${++this.idCounter}`;
    if (rec.createdAt === undefined) rec.createdAt = new Date();

    this.enforceUnique(model, rec);
    this.tables[model].push(rec);

    const rels = RELATIONS[model] ?? {};
    for (const [field, childData] of children) {
      const childModel = rels[field];
      if (!childModel) continue;
      const fk = `${model}Id`;
      const list = Array.isArray(childData) ? childData : [childData];
      for (const cd of list) this.createOne(childModel, { ...cd, [fk]: rec.id });
    }
    return rec;
  }

  // --- query engine ---
  findFirst(model: ModelName, args: Row = {}): Row | null {
    const hit = this.tables[model].find((r) => matchesWhere(r, args.where));
    if (!hit) return null;
    return args.select ? project(hit, args.select) : this.includeOn(model, hit, args.include);
  }

  findUnique(model: ModelName, args: Row = {}): Row | null {
    const hit = this.tables[model].find((r) => matchesWhere(r, args.where));
    if (!hit) return null;
    return args.select ? project(hit, args.select) : this.includeOn(model, hit, args.include);
  }

  findMany(model: ModelName, args: Row = {}): Row[] {
    let out = this.tables[model].filter((r) => matchesWhere(r, args.where));
    if (typeof args.skip === 'number') out = out.slice(args.skip);
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    return out.map((r) =>
      args.select ? project(r, args.select) : this.includeOn(model, r, args.include)
    );
  }

  count(model: ModelName, args: Row = {}): number {
    return this.tables[model].filter((r) => matchesWhere(r, args.where)).length;
  }

  // Apply a Prisma `data` payload to a row, honouring the atomic field
  // operators the services rely on ({ increment }, { decrement }, { set }).
  // These matter for correctness: the real overselling fix uses
  // `{ quantity: { decrement: n } }`, so the fake must compute it the same way
  // the DB would rather than storing the operator object verbatim.
  private applyData(rec: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        if ('decrement' in v) {
          rec[k] = (rec[k] ?? 0) - (v as any).decrement;
          continue;
        }
        if ('increment' in v) {
          rec[k] = (rec[k] ?? 0) + (v as any).increment;
          continue;
        }
        if ('set' in v) {
          rec[k] = (v as any).set;
          continue;
        }
      }
      rec[k] = v;
    }
  }

  update(model: ModelName, args: Row): Row {
    const hit = this.tables[model].find((r) => matchesWhere(r, args.where));
    if (!hit) {
      throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'fake',
      });
    }
    this.applyData(hit, args.data);
    return { ...hit };
  }

  // Bulk conditional update. Crucially returns `{ count }` like Prisma — the
  // atomic guarded decrement in sale.service.ts keys off count === 0 to detect
  // "someone else took the stock". The where-match + applyData run as one
  // synchronous step, so the guard is evaluated and applied atomically (no
  // check-then-act gap), exactly like a single SQL UPDATE ... WHERE.
  updateMany(model: ModelName, args: Row): { count: number } {
    const hits = this.tables[model].filter((r) => matchesWhere(r, args.where));
    for (const hit of hits) this.applyData(hit, args.data);
    return { count: hits.length };
  }

  async transaction(arg: any): Promise<any> {
    if (typeof arg === 'function') {
      // Serialize interactive transactions. A real DB gives each transaction
      // isolation; this fake has a single shared store, so we run transaction
      // callbacks one-at-a-time. Without this, two "concurrent" callbacks would
      // interleave at await points and the snapshot/restore-on-error would
      // clobber a sibling's committed writes — a fake artefact, not a code bug.
      // Sequential callers (every existing test) are unaffected: the chain is
      // already resolved, so there is no added latency or ordering change.
      const run = async () => {
        const snap = this.snapshot();
        try {
          return await arg(prismaFake);
        } catch (e) {
          this.restore(snap);
          throw e;
        }
      };
      const result = this.txChain.then(run, run);
      // Keep the chain alive regardless of this transaction's outcome.
      this.txChain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
    return Promise.all(arg);
  }
}

const db = new FakeDb();

function model(name: ModelName) {
  return {
    findFirst: async (args?: Row) => db.findFirst(name, args),
    findUnique: async (args?: Row) => db.findUnique(name, args),
    findMany: async (args?: Row) => db.findMany(name, args),
    count: async (args?: Row) => db.count(name, args),
    create: async (args: Row) =>
      db.includeOn(name, db.createOne(name, args.data), args.include),
    update: async (args: Row) => db.update(name, args),
    updateMany: async (args: Row) => db.updateMany(name, args),
  };
}

/**
 * The fake Prisma client. Shape-compatible with the bits of PrismaClient that
 * sale.service.ts and billing.service.ts use.
 */
export const prismaFake: any = {
  shop: model('shop'),
  product: model('product'),
  sale: model('sale'),
  saleItem: model('saleItem'),
  stockLog: model('stockLog'),
  $transaction: (arg: any) => db.transaction(arg),
};

export default prismaFake;

// Named `prisma` export so this module is a drop-in replacement for
// `@config/prisma` (the vitest.config alias redirects that import here).
export const prisma = prismaFake;

/** Clear every table between tests. Call in beforeEach. */
export function resetDb() {
  db.reset();
}

/** Raw access for assertions (e.g. read back stock logs). */
export function table(name: ModelName): Row[] {
  return db.rows(name);
}

// --- seed helpers ---

export function seedShop(partial: Partial<Row> = {}): Row {
  return db.createOne('shop', {
    name: 'Test Shop',
    ownerYeboidSub: partial.ownerYeboidSub ?? `yeboid-${Math.random().toString(36).slice(2)}`,
    ownerName: 'Owner',
    ownerPhone: partial.ownerPhone ?? `+2687${Math.floor(Math.random() * 1e7)}`,
    currency: 'SZL',
    ...partial,
  });
}

export function seedProduct(partial: Partial<Row> = {}): Row {
  return db.createOne('product', {
    shopId: 'shop_1',
    name: 'Widget',
    costPrice: 5,
    sellPrice: 10,
    quantity: 100,
    isActive: true,
    trackStock: true,
    ...partial,
  });
}
