# leak-worker — architecture

```
technician's phone / office ──► api-edge ──(resolveActor)──► leak-worker ──► D1 (leak_*)
                                                                        ├─► membership-worker (context)
                                                                        └─► policy-worker (authorize)
```

- Reachable only over the `LEAK_WORKER` service binding (`workers_dev: false`).
- Every route runs membership authorization-context then policy authorize; a
  deny is `404`, never `403`.
- The QR lane (`/v1/qr/{token}`) looks the token up across organizations,
  then authorizes the caller against the appliance's own organization. A
  stranger and a dead token get the same 404.
- D1 has no interactive transactions: every write whose outcome matters uses
  `RETURNING` (the D1 executor's `rowCount` is 0 for a bare write), and audit
  appends are best-effort after the write they describe.
- Depends on `db-migrate`, so a run that adds a migration applies it before this
  worker's code that reads the new columns goes live.
