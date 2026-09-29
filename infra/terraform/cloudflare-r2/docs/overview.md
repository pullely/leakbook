# cloudflare-r2

Provisions the Cloudflare R2 bucket holding inspection-record PDF exports (stage and prod)

Terraform-managed infrastructure for leakbook, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **leak-worker** — binds the bucket as `EXPORTS` and writes the inspection PDFs
