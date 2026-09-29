export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** LB3: the repair-clock emails (leak-worker is on the internal-actor allow-list). */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** LB3: the inspection PDFs (stg-leakbook-exports-stage / prod-leakbook-exports-prod). */
  EXPORTS?: R2Bucket;
  ENVIRONMENT: string;
}
