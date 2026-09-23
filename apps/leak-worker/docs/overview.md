# leak-worker — overview

Owns the `leak` bounded context: a contractor's customer **sites** (the
regulation's operating facility, which fixes the leak-rate method), the
refrigerant-containing **appliances** at each (one row per independent
circuit, 40 CFR 84.102) with their refrigerant, class, category and full
charge in integer ounces, and the immutable log of **service events** —
refrigerant added, recovered and returned — logged from the console or from a
phone that scanned the appliance's QR label.

The invariant this worker holds: the log is a compliance record. An event is
never edited or deleted; a mistake is voided with a reason, and the void is
audited. Every quantity is an integer number of ounces.

## What it serves

| Route | Who |
|---|---|
| `GET/POST /v1/organizations/{org}/sites` | `leak.read` / `leak.write` |
| `GET/PATCH /v1/organizations/{org}/sites/{ste}` | `leak.read` / `leak.write` |
| `POST /v1/organizations/{org}/sites/{ste}/appliances` | `leak.write` |
| `GET/PATCH /v1/organizations/{org}/appliances/{apl}` | `leak.read` / `leak.write` |
| `POST /v1/organizations/{org}/appliances/{apl}/qr-token` | `leak.write` (rotate the label) |
| `GET/POST /v1/organizations/{org}/appliances/{apl}/events` | `leak.read` / `leak.write` |
| `POST /v1/organizations/{org}/appliances/{apl}/events/{sev}/void` | `leak.write` |
| `GET /v1/qr/{token}`, `POST /v1/qr/{token}/events` | `leak.read` / `leak.write` on the token's organization |
