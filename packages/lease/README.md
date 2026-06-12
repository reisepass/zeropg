# @zeropg/lease

A single-writer lease built entirely on object-storage conditional writes.
No coordination service, no clock dependence for correctness.

- `acquire()` — conditional create of `lease.json`; if held and unexpired →
  `LockedError`; if expired → CAS takeover with a strictly increasing
  **fencing token** (floored by the manifest, so tokens are monotonic across
  the bucket's whole history).
- `renew()` — CAS on our own version; failure means we were taken over →
  `FencedError`. `validate()` — cheap read-path check. `release()` — CAS-
  guarded delete so successors can acquire instantly.
- `tookOver` tells the caller a previous holder may still be alive (zeropg
  uses this to fence-stamp the manifest immediately).

Correctness comes from the conditional writes; the clock only tunes how
aggressively expired leases are taken over. Validated live: 100/100 stale
renewals rejected, 100/100 stale commits rejected, zero two-holder windows,
plus a live two-service zombie test on Cloud Run (repo experiments E1, E4).
