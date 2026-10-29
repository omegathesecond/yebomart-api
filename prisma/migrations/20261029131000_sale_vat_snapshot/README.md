Apply this migration before deploying the API revision, then regenerate Prisma.
The nullable columns intentionally leave existing sales without historical VAT
metadata. There is no backfill and no inference from current shop settings.

New sales read VAT settings within the same transaction that persists tax,
total and metadata. Idempotent replays return the original sale unchanged.
Receipts with missing metadata show an explicit warning; email tax invoices
are rejected with HTTP 400 before creating/sending a YeboPay invoice. Any
legacy reconstruction or backfill requires separate approval.

Offline receipts remain pending and have no authoritative server snapshot until
sync creates the sale. They show unavailable metadata rather than borrowing
current shop settings. This change does not backdate tax settings for delayed
syncs or reconstruct tax history.
