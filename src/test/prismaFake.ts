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
type ModelName =
  | 'shop'
  | 'product'
  | 'sale'
  | 'saleItem'
  | 'stockLog'
  | 'customer'
  | 'customerCredit'
  | 'user'
  | 'admin'
  | 'expense';

// Composite/unique keys, mirroring the Prisma schema. Enforced only when every
// part is non-null (Postgres treats NULLs as distinct, so multiple null localIds
// are allowed — same as prod).
const UNIQUE_KEYS: Record<ModelName, string[][]> = {
  shop: [['ownerYeboidSub'], ['ownerPhone']],
  product: [['shopId', 'barcode']],
  sale: [['shopId', 'localId']],
  saleItem: [],
  stockLog: [],
  customer: [['shopId', 'phone']],
  customerCredit: [],
  user: [['shopId', 'phone']],
  admin: [['email']],
  expense: [],
};

// Nested-relation field -> child model, for `{ create: [...] }` writes.
const RELATIONS: Partial<Record<ModelName, Record<string, ModelName>>> = {
  sale: { items: 'saleItem' },
  customer: { credits: 'customerCredit' },
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
    customer: [],
    customerCredit: [],
    user: [],
    admin: [],
    expense: [],
  };
  private idCounter = 0;

  reset() {
    (Object.keys(this.tables) as ModelName[]).forEach((m) => (this.tables[m] = []));
    this.idCounter = 0;
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

  /**
   * Prisma-shaped aggregate. Supports `_sum`/`_avg`/`_min`/`_max` (each an
   * object of `{ field: true }`) and `_count` (either `true` → row count, or
   * `{ field: true }` → per-field non-null count). Mirrors Postgres/Prisma
   * semantics: with ZERO matching rows every `_sum`/`_avg`/`_min`/`_max` field
   * is `null` (so callers' `agg._sum.amount || 0` fallback is exercised, not
   * bypassed), while `_count` is always a real number.
   */
  aggregate(model: ModelName, args: Row = {}): Row {
    const rows = this.tables[model].filter((r) => matchesWhere(r, args.where));
    const out: Row = {};

    const fold = (
      spec: Row,
      reduce: (vals: number[]) => number | null,
    ): Row => {
      const res: Row = {};
      for (const [field, want] of Object.entries(spec)) {
        if (!want) continue;
        const vals = rows
          .map((r) => r[field])
          .filter((v) => v !== null && v !== undefined) as number[];
        res[field] = vals.length ? reduce(vals) : null;
      }
      return res;
    };

    if (args._sum) out._sum = fold(args._sum, (v) => v.reduce((a, b) => a + b, 0));
    if (args._avg) out._avg = fold(args._avg, (v) => v.reduce((a, b) => a + b, 0) / v.length);
    if (args._min) out._min = fold(args._min, (v) => Math.min(...v));
    if (args._max) out._max = fold(args._max, (v) => Math.max(...v));
    if (args._count !== undefined) {
      if (args._count === true) {
        out._count = rows.length;
      } else {
        const res: Row = {};
        for (const [field, want] of Object.entries(args._count)) {
          if (!want) continue;
          res[field] = rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
        }
        out._count = res;
      }
    }
    return out;
  }

  /**
   * Prisma-shaped groupBy. Groups matching rows by the `by` fields and folds
   * `_sum`/`_avg`/`_count` per group, returning the grouping keys inline on
   * each row (e.g. `{ productId, productName, _sum: { quantity } }`).
   */
  groupBy(model: ModelName, args: Row = {}): Row[] {
    const by: string[] = args.by ?? [];
    const rows = this.tables[model].filter((r) => matchesWhere(r, args.where));
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = by.map((f) => String(r[f])).join(' ');
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    return Array.from(groups.values()).map((groupRows) => {
      const rep = groupRows[0];
      const out: Row = {};
      for (const f of by) out[f] = rep[f];
      const fold = (spec: Row, reduce: (vals: number[]) => number | null): Row => {
        const res: Row = {};
        for (const [field, want] of Object.entries(spec)) {
          if (!want) continue;
          const vals = groupRows
            .map((r) => r[field])
            .filter((v) => v !== null && v !== undefined) as number[];
          res[field] = vals.length ? reduce(vals) : null;
        }
        return res;
      };
      if (args._sum) out._sum = fold(args._sum, (v) => v.reduce((a, b) => a + b, 0));
      if (args._avg) out._avg = fold(args._avg, (v) => v.reduce((a, b) => a + b, 0) / v.length);
      if (args._count !== undefined) {
        if (args._count === true) out._count = groupRows.length;
        else {
          const res: Row = {};
          for (const [field, want] of Object.entries(args._count)) {
            if (want) res[field] = groupRows.filter((r) => r[field] != null).length;
          }
          out._count = res;
        }
      }
      return out;
    });
  }

  update(model: ModelName, args: Row): Row {
    const hit = this.tables[model].find((r) => matchesWhere(r, args.where));
    if (!hit) {
      throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'fake',
      });
    }
    // Support Prisma's atomic numeric ops ({ increment } / { decrement }) in
    // addition to plain scalar assignment.
    for (const [field, val] of Object.entries(args.data)) {
      if (val && typeof val === 'object' && !(val instanceof Date)) {
        if ('increment' in val) {
          hit[field] = (hit[field] ?? 0) + (val as any).increment;
          continue;
        }
        if ('decrement' in val) {
          hit[field] = (hit[field] ?? 0) - (val as any).decrement;
          continue;
        }
      }
      hit[field] = val;
    }
    return { ...hit };
  }

  async transaction(arg: any): Promise<any> {
    if (typeof arg === 'function') {
      const snap = this.snapshot();
      try {
        return await arg(prismaFake);
      } catch (e) {
        this.restore(snap);
        throw e;
      }
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
    aggregate: async (args?: Row) => db.aggregate(name, args),
    groupBy: async (args?: Row) => db.groupBy(name, args),
    create: async (args: Row) =>
      db.includeOn(name, db.createOne(name, args.data), args.include),
    update: async (args: Row) => db.update(name, args),
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
  customer: model('customer'),
  customerCredit: model('customerCredit'),
  user: model('user'),
  admin: model('admin'),
  expense: model('expense'),
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

export function seedCustomer(partial: Partial<Row> = {}): Row {
  return db.createOne('customer', {
    shopId: 'shop_1',
    name: 'Test Customer',
    phone: null,
    creditLimit: 0,
    balance: 0,
    isActive: true,
    ...partial,
  });
}

export function seedUser(partial: Partial<Row> = {}): Row {
  return db.createOne('user', {
    shopId: 'shop_1',
    name: 'Test User',
    email: null,
    phone: partial.phone ?? `+2687${Math.floor(Math.random() * 1e7)}`,
    role: 'CASHIER',
    ...partial,
  });
}

// Seed a platform admin (the Admin model backing /api/admin/profile). `password`
// is stored as-is — pass an already-bcrypt-hashed value when a test needs
// changePassword's bcrypt.compare to succeed.
export function seedAdmin(partial: Partial<Row> = {}): Row {
  return db.createOne('admin', {
    email: partial.email ?? `admin-${Math.random().toString(36).slice(2)}@yebomart.com`,
    password: 'not-a-real-hash',
    name: 'Test Admin',
    role: 'ADMIN',
    isActive: true,
    updatedAt: new Date(),
    ...partial,
  });
}

// Seed an expense (backs prisma.expense.aggregate in the report services).
// `date` defaults to now; pass an explicit Date to land it in/out of a report
// range.
export function seedExpense(partial: Partial<Row> = {}): Row {
  return db.createOne('expense', {
    shopId: 'shop_1',
    category: 'OTHER',
    amount: 0,
    description: null,
    date: partial.date ?? new Date(),
    updatedAt: new Date(),
    ...partial,
  });
}
