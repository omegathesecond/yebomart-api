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
  | 'expense'
  | 'user'
  | 'admin'
  | 'supplier'
  | 'purchaseOrder'
  | 'pOItem'
  | 'supplierLedger'
  | 'return'
  | 'returnItem'
  | 'returnExchangeItem'
  | 'cashSession';

// Composite/unique keys, mirroring the Prisma schema. Enforced only when every
// part is non-null (Postgres treats NULLs as distinct, so multiple null localIds
// are allowed — same as prod).
const UNIQUE_KEYS: Record<ModelName, string[][]> = {
  shop: [['ownerYeboidSub'], ['ownerPhone']],
  product: [['shopId', 'barcode']],
  sale: [['shopId', 'localId'], ['shopId', 'receiptNumber']],
  saleItem: [],
  stockLog: [],
  customer: [['shopId', 'phone']],
  customerCredit: [],
  expense: [],
  user: [['shopId', 'phone']],
  admin: [['email']],
  supplier: [['shopId', 'phone']],
  purchaseOrder: [],
  pOItem: [],
  supplierLedger: [],
  return: [],
  returnItem: [],
  returnExchangeItem: [],
  cashSession: [],
};

// Nested-relation field -> child model, for `{ create: [...] }` writes.
const RELATIONS: Partial<Record<ModelName, Record<string, ModelName>>> = {
  sale: { items: 'saleItem' },
  customer: { credits: 'customerCredit' },
  purchaseOrder: { items: 'pOItem' },
  return: { items: 'returnItem', exchangeItems: 'returnExchangeItem' },
};

// Belongs-to (parent) relation field -> [parent model, FK field on this row].
// Used by includeOn for `include: { shop: { select } }`-style joins, where the
// row carries a FK (e.g. Sale.shopId) pointing at the parent's id.
const PARENT_RELATIONS: Partial<Record<ModelName, Record<string, [ModelName, string]>>> = {
  sale: { shop: ['shop', 'shopId'], customer: ['customer', 'customerId'] },
  purchaseOrder: { shop: ['shop', 'shopId'], supplier: ['supplier', 'supplierId'] },
  user: { shop: ['shop', 'shopId'] },
  cashSession: { shop: ['shop', 'shopId'], user: ['user', 'userId'] },
};

// Column defaults from the schema (`@default(...)`), applied on create when the
// caller leaves the field undefined — exactly as Postgres would. These are load-
// bearing, not a convenience: CashSessionService.open() inserts a row carrying
// only shopId/userId/openingFloat and then relies on the DB to stamp
// `status = OPEN` (@default(OPEN)) and `openedAt = now()` (@default(now())).
// Those two columns are precisely what the "one open till per shop" conflict
// check and the cash-sales time window key off, so a fake that left them
// undefined would make both code paths silently untestable.
const MODEL_DEFAULTS: Partial<Record<ModelName, Record<string, () => any>>> = {
  cashSession: {
    openedAt: () => new Date(),
    status: () => 'OPEN',
  },
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
    expense: [],
    user: [],
    admin: [],
    supplier: [],
    purchaseOrder: [],
    pOItem: [],
    supplierLedger: [],
    return: [],
    returnItem: [],
    returnExchangeItem: [],
    cashSession: [],
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
    const parents = PARENT_RELATIONS[model] ?? {};
    for (const [field, want] of Object.entries(include)) {
      if (!want) continue;
      const childModel = rels[field];
      if (childModel) {
        const fk = `${model}Id`;
        out[field] = this.tables[childModel]
          .filter((r) => r[fk] === rec.id)
          .map((r) => ({ ...r }));
        continue;
      }
      const parent = parents[field];
      if (parent) {
        const [parentModel, fkField] = parent;
        const parentRow = this.tables[parentModel].find((r) => r.id === rec[fkField]);
        // Honour a nested `select` (e.g. shop: { select: { name: true } }).
        const select = want && typeof want === 'object' ? (want as Row).select : undefined;
        out[field] = parentRow ? (select ? project(parentRow, select) : { ...parentRow }) : null;
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
    for (const [field, make] of Object.entries(MODEL_DEFAULTS[model] ?? {})) {
      if (rec[field] === undefined) rec[field] = make();
    }

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
    // Pair each row with its insertion index so ties (e.g. identical
    // createdAt millisecond in fast synchronous tests) break deterministically
    // in the direction of the primary sort clause, instead of an arbitrary
    // stable-sort fallback to insertion order.
    let out = this.tables[model]
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => matchesWhere(r, args.where));
    if (args.orderBy) {
      const clauses = Object.entries(args.orderBy as Row);
      const primaryDir = clauses[0]?.[1];
      out = [...out].sort((a, b) => {
        for (const [field, dir] of clauses) {
          const av = a.r[field];
          const bv = b.r[field];
          const cmp = av instanceof Date || bv instanceof Date
            ? new Date(av).getTime() - new Date(bv).getTime()
            : av > bv
              ? 1
              : av < bv
                ? -1
                : 0;
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        const idxCmp = a.i - b.i;
        return primaryDir === 'desc' ? -idxCmp : idxCmp;
      });
    }
    let rows = out.map(({ r }) => r);
    if (typeof args.skip === 'number') rows = rows.slice(args.skip);
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    return rows.map((r) =>
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

  // --- aggregation ---
  // Postgres semantics, faithfully: SUM over an empty (or all-NULL) set is NULL,
  // which Prisma surfaces as `null`. The services under test lean on that with
  // `agg._sum.totalAmount ?? 0`, so returning a helpful 0 here would hide the
  // very branch those `??`s exist for.
  private aggregateRows(rows: Row[], args: Row): Row {
    const out: Row = {};
    if (args._sum) {
      out._sum = {};
      for (const field of Object.keys(args._sum)) {
        const vals = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
        out._sum[field] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      }
    }
    if (args._count !== undefined) {
      // `_count: true` -> a plain number; `_count: { field: true }` -> an object
      // of per-field non-null counts. Same discrimination Prisma makes.
      if (args._count === true) {
        out._count = rows.length;
      } else {
        out._count = {};
        for (const field of Object.keys(args._count)) {
          out._count[field] =
            field === '_all' ? rows.length : rows.filter((r) => r[field] != null).length;
        }
      }
    }
    return out;
  }

  aggregate(model: ModelName, args: Row = {}): Row {
    return this.aggregateRows(
      this.tables[model].filter((r) => matchesWhere(r, args.where)),
      args
    );
  }

  groupBy(model: ModelName, args: Row = {}): Row[] {
    const by: string[] = Array.isArray(args.by) ? args.by : [args.by];
    const groups = new Map<string, Row[]>();
    for (const r of this.tables[model].filter((rec) => matchesWhere(rec, args.where))) {
      const key = JSON.stringify(by.map((f) => r[f] ?? null));
      const bucket = groups.get(key);
      if (bucket) bucket.push(r);
      else groups.set(key, [r]);
    }
    return [...groups.values()].map((bucket) => {
      const out: Row = {};
      for (const f of by) out[f] = bucket[0][f] ?? null;
      return { ...out, ...this.aggregateRows(bucket, args) };
    });
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
    aggregate: async (args?: Row) => db.aggregate(name, args),
    groupBy: async (args?: Row) => db.groupBy(name, args),
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
  expense: model('expense'),
  user: model('user'),
  admin: model('admin'),
  supplier: model('supplier'),
  purchaseOrder: model('purchaseOrder'),
  pOItem: model('pOItem'),
  supplierLedger: model('supplierLedger'),
  return: model('return'),
  returnItem: model('returnItem'),
  returnExchangeItem: model('returnExchangeItem'),
  cashSession: model('cashSession'),
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

export function seedExpense(partial: Partial<Row> = {}): Row {
  return db.createOne('expense', {
    shopId: 'shop_1',
    category: 'SUPPLIES',
    amount: 100,
    description: 'Packaging',
    date: new Date('2026-08-01T00:00:00.000Z'),
    receiptUrl: null,
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
    isActive: true,
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

// Seed a Supplier. `balance` defaults to 0 (positive = we owe them).
export function seedSupplier(partial: Partial<Row> = {}): Row {
  return db.createOne('supplier', {
    shopId: 'shop_1',
    name: 'Test Supplier',
    phone: partial.phone ?? null,
    currency: 'SZL',
    balance: 0,
    isActive: true,
    updatedAt: new Date(),
    ...partial,
  });
}

// Seed a PurchaseOrder, optionally with line items. Pass `items: [{ productId,
// productName, quantity, unitCost, totalCost, receivedQty? }]`.
let poSeq = 0;
export function seedPurchaseOrder(partial: Partial<Row> = {}): Row {
  const { items, ...rest } = partial;
  const subtotal =
    rest.subtotal ??
    (items ? items.reduce((s: number, i: Row) => s + (i.totalCost ?? i.quantity * i.unitCost), 0) : 0);
  return db.createOne('purchaseOrder', {
    shopId: 'shop_1',
    supplierId: 'supplier_1',
    orderNumber: `PO-${++poSeq}`,
    status: 'SENT',
    subtotal,
    tax: 0,
    totalAmount: subtotal,
    amountReceived: 0,
    amountPaid: 0,
    updatedAt: new Date(),
    ...(items ? { items: { create: items } } : {}),
    ...rest,
  });
}

// Seed a completed Sale (optionally with line items). Used by the receipt
// controller tests, which read the persisted sale back to build the message.
export function seedSale(partial: Partial<Row> = {}): Row {
  const { items, ...rest } = partial;
  return db.createOne('sale', {
    shopId: 'shop_1',
    subtotal: 100,
    discount: 0,
    tax: 0,
    totalAmount: 100,
    paymentMethod: 'CASH',
    amountPaid: 100,
    change: 0,
    status: 'COMPLETED',
    receiptNumber: 'RCP-260626-0001',
    ...(items ? { items: { create: items } } : {}),
    ...rest,
  });
}

// Seed a CashSession (till). Defaults to an OPEN drawer for shop_1 with a float
// of 100. Pass `status: 'CLOSED'` plus closedAt/countedCash/expectedCash/variance
// to stage an already-cashed-up shift, and an explicit `openedAt` when the test
// needs a deterministic window for the cash-sales tally.
export function seedCashSession(partial: Partial<Row> = {}): Row {
  return db.createOne('cashSession', {
    shopId: 'shop_1',
    userId: null,
    openingFloat: 100,
    closedAt: null,
    countedCash: null,
    expectedCash: null,
    variance: null,
    notes: null,
    updatedAt: new Date(),
    ...partial,
  });
}
