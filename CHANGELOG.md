# Changelog

## 0.1.3 (2026-11-26)

- **`notify.canSend` must answer exactly `true` to send.** A truthy answer such as `'yes'` or `1` used to send the arrival email; now it counts as email off.

- **Fix: finds that can run inside a transaction no longer paginate.** A paginated find makes Payload's Mongo adapter send the find and its count together on the request's session. When that is the first query in a transaction, the two race to start it and one can fail with `NoSuchTransaction`. These finds only use the rows, so they now pass `pagination: false`; any limit still applies. Lists that page for people are unchanged.

Tested: 27 tests (1 new, for `canSend`) and the build. Not tested: the transaction race itself, which isn't reproduced here, and a real site.

## 0.1.2 (2026-11-11)

- **`arrived` says which site each order belongs to.** The function Restock puts on `config.custom.restock` for other plugins now returns `scope` with each order: the order's site, the ID in `scopeField`, or `null` when Restock runs without one. Kitting uses it to show its "Arrived, please confirm" line to staff who manage only some sites, with only those sites' deliveries. The other fields are unchanged, so callers that ignore `scope` work as before. The contract is in [docs/contracts/kitting-restock.md](docs/contracts/kitting-restock.md).

Tested: 26 tests (1 extended). Not tested: Kitting's Today line in a real admin with both plugins installed.
