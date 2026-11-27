# Test audit

Each audit maps what Restock promises (README, `docs/decisions.md`) to the tests that prove it.

## 2026-11-26: sweep after the transaction fix

Suite: 27 tests before, 34 after (`npm test`). Two new files, both with a made-up Payload and no database. Since the 2026-11-11 entries: the transaction fix (`bec7a21`) and the exact-`true` rule for `notify.canSend` (`bf00766`), both released in 0.1.3. This entry is at the top; the older ones below run oldest first.

- **Promises.**
  - Finds that can run inside a request's transaction pass `pagination: false`, and any limit still applies (CHANGELOG 0.1.3).
  - The arrival email goes out only when `canSend` answers exactly `true`, once per delivered parcel (CHANGELOG 0.1.3, README "Shipments and arrivals").
  - Access: `read`, `manage` and `approve` count only as exactly `true` or a query applied to the order; endpoints answer 403 and the admin page reads nothing (README "Access").
  - Site isolation, the order life cycle, whole packs, and nothing approved or ordered by Restock (README, `docs/decisions.md`).
  - Receiving: more than ordered is refused, a refused receipt writes nothing, and lots are never made up (README "Receiving").
  - A delivery never adds stock; the same event twice changes nothing; another site's tracker is refused (README "Safety").
  - Exports: one document feeds the JSON, CSV and PDF; CSV formula cells are defused; only http and https links (README "Placing an order").
  - The cart API changes only its own status (`docs/decisions.md`, Tier 2).
  - Each works alone: Kitting is an optional peer behind a guarded import (`docs/decisions.md`).
  - The try-out app runs only on its throwaway database (README "Commands").
- **Covered.**
  - No paginated finds with a `req`: `transactions.test.ts`: "numbering a new order reads the highest number so far without a count, and still asks for one row"; "building the purchase-order document reads the site’s settings without a count, and still asks for one row"; "the other finds made with a req don’t paginate either: settings, drafting, deliveries, arrivals and the cart list".
  - `canSend` exactly `true`: `kitting.test.ts`: "sends the arrival email only when canSend answers exactly true" (truthy answers, real database); `notify.test.ts`: all four tests.
  - One email per parcel, a delivery never adds stock, idempotent events, another site's tracker: `kitting.test.ts`: "tracks shipments, and a delivered event lists the order but never adds stock, once".
  - Access answers read strictly: `restock.test.ts`: "refuses a truthy non-true answer, a malformed or unrunnable query, and a throw; applies a query; never 500s" (`allows` and the export endpoint); `view.test.ts`: "reads orders only when read answers true or a well-formed query, and suppliers only when manage does".
  - Who may do what, with refusals: `restock.test.ts`: "moves draft → approved → ordered by hand, refuses the rest, and freezes lines after the draft"; "keeps each site’s suppliers and orders to itself, and lets viewers only read"; "drafts only for people who manage that site"; "records what arrived, for people who manage that site only"; "lists approved orders and records the cart, for people who may place orders, and changes nothing else"; "shows arrivals and the confirm actions only to people who may receive".
  - Site isolation and whole packs: `restock.test.ts`: "refuses lines from another supplier or site, and packs that aren’t whole"; `kitting-0.1.test.ts`: "drafts from Kitting’s below-level list, for this site only, in whole packs".
  - Receiving: `kitting.test.ts`: "adds stock (with lots) through Kitting, refuses more than ordered, and moves the order on"; "asks for lot and use-by on lot-tracked supplies, and records missing items as a partial receipt".
  - Exports and outputs: `restock.test.ts`: "builds every export from one document, with the site’s own buyer details, for people who may read the order"; "gives quick-order lines, an email draft and product links"; `pure.test.ts`: "quotes commas, quotes and line breaks, and defuses cells a spreadsheet would run"; "runs onto more pages on Letter, numbering each one, with every line in the text".
  - Each works alone: `pure.test.ts`: "depends on no other package from this set; Kitting is an optional peer, reached only by a guarded dynamic import"; `restock.test.ts`: "drafts from the host’s own needs, at least the minimum, one draft per supplier".
  - The try-out app's database guard: `tryout.test.ts`: both tests.
- **Gaps added.**
  - **The transaction fix had no test** (3 tests, `test/transactions.test.ts`). A made-up Payload records what `find` is asked. The first two tests drive the two paths `bec7a21` changed: the orders `beforeChange` hook on create (`nextNumber`) and `purchaseOrderDocument` (the settings read). Each asserts the find made with a `req` passes `pagination: false` and still asks for `limit: 1`. The third drives the other seven finds made with a `req` (the settings clash check, three in drafting, two in `tracking.ts`, the cart list), which already skipped the count through `list` or by hand, so a later edit can't bring the race back unnoticed. Each check also counts the finds, so it can't pass by making none.
  - **Fail first.** With `src/collections.ts` and `src/document.ts` restored from `bec7a21^`, `npx vitest run test/transactions.test.ts` gave 2 failed and 1 passed: "find on purchase-orders: expected undefined to be false" and "find on restock-settings: expected undefined to be false". With the fix back: 3 passed.
  - **The arrival email's other refusals** (4 tests, `test/notify.test.ts`). The existing test covered truthy answers. Added: `true` (plain and async) and no `canSend` send once, and a repeated event sends nothing more; `false`, `0`, `''`, `null` and `undefined` send nothing; a `canSend` that throws or rejects sends nothing, the delivery is still recorded and the error is logged; blank recipients send nothing; a delivery inside a caller's transaction sends nothing, because that transaction could still roll back.
  - **Mutation checks** on `src/tracking.ts`, each a Python string replace restored with `git checkout` (SHA-256 checked). All 4 fail `notify.test.ts`: `!== true` made `=== false`; the `.catch` on the email removed; the caller's-transaction condition removed; the no-recipients return removed.
- **Gaps skipped (and why).**
  - **The race itself.** `NoSuchTransaction` came up about 1 time in 7 in another plugin and isn't reproduced here. A test that only fails sometimes proves little; the tests pin the argument that removes the race.
  - **Payload honoring `pagination: false`** (no count query sent): framework internals.
  - **The two finds in the admin view** (`RestockView`): they take no `req`, run outside any transaction and already pass `pagination: false`. Their access decision is covered in `view.test.ts`.
  - **`mayManageSite`, the draft endpoint's site check, with answers other than `true` or a query:** not covered here. A test belongs with a change to that function, so it has gone to the lead.
  - **Email wording and HTML escaping:** the subject and recipients are asserted; the body is presentation.
  - **Never stores vendor credentials, tags, license and release files:** as in the 2026-11-10 entries, review questions with nothing to run.

## 2026-11-09, day one (step 1: data model)

4 tests, against an in-memory MongoDB replica set.

| Promise | Test |
|---|---|
| Orders are numbered per site, prices are copied, the total says whether it's complete, and every change is in the history | purchase orders: numbers orders per site… |
| **Life cycle**: draft → approved → ordered by hand, nothing else by hand. Lines are frozen after the draft. Only drafts can be deleted; cancelling keeps the history | purchase orders: moves draft → approved → ordered… |
| **Access**: staff draft, only buyers approve or mark as ordered, viewers only read, nobody reads without signing in | moves draft → approved…; keeps each site's suppliers… |
| **Site isolation**: suppliers, items and orders stay in their site. Nothing links across sites, and an order can't use another supplier's items | refuses lines from another supplier or site…; keeps each site's suppliers… |
| Whole packs only | refuses lines… |

Gaps, planned with the steps that build them: drafting and rounding (step 2), outputs (step 3), receiving into Kitting (step 4), and the Console API's access (step 5). Shared suppliers with Kitting get a test with step 4.

## 2026-11-09, step 2 (drafting)

10 tests. Added:
- **Rounding to packs:** whole packs, minimums, and no floating-point dust. Tested as pure functions with known values.
- **Choosing the item:** preferred first, then the cheapest per unit; items no longer sold are skipped. Pure.
- **With Kitting** (0.1.0 from npm):
  - Restock shares Kitting's supplier list.
  - It drafts one order per supplier from what's below level, in whole packs and minimums.
  - Supplies without a supplier item are listed.
  - Another site's needs never show up.
  - Drafting twice adds nothing.
  - What's already on an approved order counts as on order.
- **Without Kitting:** drafting from the host's own needs, at least the minimum. A site is required.
- **Access:** `POST /api/restock/draft` refuses people who are signed out, viewers, and another site's staff.

Not covered yet: Kitting's `restockNeeds` (ready-stock targets). It arrives in Kitting 0.2.x, and the test moves to it when that's on npm.

## 2026-11-09, step 3 (outputs)

11 tests. Added "ways to place an order":
- quick-order lines with a comma and with a space, and the line-limit warning;
- CSV quoting, plus a defused formula cell (security: a CSV opened in a spreadsheet can't run what a supplier item says);
- the email draft's text, recipient and mailto;
- product links, with a `javascript:` link refused.

The order page's panel hasn't been opened in a browser yet. That's planned with receiving (step 4).

## 2026-11-09, step 4 (receiving)

13 tests. Added:
- **Receiving into Kitting** (0.1.0 from npm):
  - stock arrives through Kitting's movements, with the lot and use-by date;
  - packs are converted to the supply's unit, and the reference carries the order numbers;
  - more than ordered is refused and writes nothing;
  - the order goes partly received, then received, with history;
  - an order that isn't ordered can't be received.
- **Receiving without Kitting:** `POST /api/restock/receive` refuses people who are signed out, viewers, and another site's staff. It refuses part packs, and records who received it and a note.

Kitting's `restockNeeds` is tested in Kitting itself (its PR #2). Restock's tests still use Kitting 0.1.0's below-level fallback until 0.2.0 is on npm.

## 2026-11-09, browser check of the order page

In a local dev server of the platform with Restock installed temporarily and made-up data. **Found and fixed:** the receive form was a `<form>` inside Payload's own edit form. That's invalid HTML: it caused a hydration error, and pressing Enter could have submitted Payload's form instead of recording the receipt. It's now a group with its own button and Enter handling. After the fix: no hydration error, and receiving 2 packs with a lot from the keyboard recorded the stock and lot in Kitting. Also: order lines show read-only once past the draft, and Copy falls back to the older copy command where the clipboard API is blocked. Rendering the panel isn't covered by unit tests (it needs the full admin), as for Kitting's pages.

## 2026-11-09, step 5 (cart API for the Console)

14 tests. Added "the Console's cart API":
- signed out, manage-only staff and another site's staff are refused;
- only approved orders are listed;
- a failed cart needs a reason, an unknown status is refused, and a draft can't go to a cart;
- the cart status records with a history entry, and the lines and status stay untouched;
- an ordinary save can't change the cart status.

## 2026-11-09, exports (CSV, JSON, PDF; owner's request)

17 tests. Added:
- **Exports:** one document feeds the JSON, CSV and PDF.
  - The site's own buyer details are used, and the settings are one per site.
  - The JSON matches its documented format.
  - The CSV has a byte-order mark and the right columns.
  - The PDF is tagged (structure tree, marked content, language, title, table header cells) and A4 when set.
  - Its extracted text holds the organization, number, supplier, address, lines, total, "to be confirmed", the approver and the terms.
  - Access: signed out and another site refused, a viewer allowed, an unknown format refused.
- **The PDF on Letter:** a 60-line order runs onto more pages, each numbered "page n of N", and every line's text is present.
- **CSV cells:** quoting and defused formula cells (pure).

Checked by eye: a sample PDF, which looked right (layout, table and totals). Not checked: a screen reader on the PDF, or printing on paper. The fonts aren't embedded (Helvetica is a standard PDF font), so it isn't strict PDF/UA.

## 2026-11-09, shipments and "Arrived, please confirm" (owner's request)

20 tests. Added:
- **A delivered event never changes stock.** Stock, lines and the total stay the same, and the order stays ordered.
- **Idempotent:** the same event twice is `already`.
- **Another site's tracker is refused** (`wrong-site`), and an unknown one is `not-found`.
- **One email per parcel.** Shipments can't be added before the order is placed, and a tracker id can't be typed in.
- **"Received in full"** adds exactly what's still to come, once.
- **Lots:** a lot number, and a use-by unless the supply has a shelf life, are required where lots are tracked. Missing items go to a partial receipt with a note.
- **Access:** marking delivered by hand, the arrivals list and one-click receipt refuse viewers and another site's staff. The receipt records who confirmed it.

Not rendered in tests: the confirm panel, the Restock overview and Kitting's Today line, which need the full admin. They were checked in a browser on a throwaway platform copy with made-up data, with no console or server errors:
- the overview's Arrived list and Kitting's Today line;
- "Yes, I received this package" from the keyboard, which added exactly 2 cases of 500 swabs;
- on a lot-tracked order, a prefilled form with no one-click button, where Record stayed disabled until a lot number was given and then recorded the lot. Its use-by came from the supply's shelf life.

## 2026-11-10, after the MIT prep and the try-out app

22 tests. Since the last audit: the license and release files, Kitting as an optional peer from 0.1.0, and the local try-out app (`npm run dev`).

### Gap added (2 tests, 1 fix)

- **The try-out app's database guard.** The app signs anyone in, so it must refuse any database except the throwaway one `npm run dev` starts. The old check only looked at how the URL began, so `mongodb://127.0.0.1:x@example.com/` passed: that's a user name and password for another host. A second host after a comma passed too. It's now `isThrowawayDatabase` (`dev/local-only.ts`), a strict match: one MongoDB on 127.0.0.1, a port, a name and plain options. Tested against the URL the app really gets and ten that must be refused. It never shipped in the npm package (`files` is `dist` only), and it was only ever run against its own throwaway database.

### Checked by hand

`npm run dev` after the fix: the made-up data loaded, `/admin/restock` answered 200, and Ctrl+C deleted the database.

### Skipped, and why

- **Drafting with Kitting 0.2's `restockNeeds`.** CI tests against Kitting 0.1.0 from npm, which covers the fallback. The 0.2 path is tested on Kitting's side (`restockNeeds`), and Restock's call to it should get a test here once 0.2.0 is on npm. On the lead's list.
- **The license and release files:** nothing to test; the Release workflow checks the tag and the description itself.

## 2026-11-10, Kitting 0.2.0 on npm

Kitting 0.2.0 is on npm, so the gap left open above is closed.

### Gap added (1 test, 1 assertion, 1 setup fix)

- **Drafting with Kitting 0.2's `restockNeeds`.** The dev copy of Kitting is now 0.2.0. The drafting test asserts `restockNeeds` is there, so it can't quietly fall back.
- **The 0.1 fallback stays covered.** `test/kitting-0.1.test.ts` hides `restockNeeds` from the installed Kitting and checks that drafting from the stock report still gives whole packs, for one site only, with unmatched needs listed.
- **Setup fix, found by this test:** the test site didn't scope Kitting 0.2's new `kitting-settings` collection, and drafting failed with "the following path cannot be queried: tenant". Kitting's upgrade note already says to scope it. A site that skips the note gets the same unclear error, so a plainer check belongs in Kitting (on its list).

23 tests pass. Nothing skipped.

## 2026-11-10, fortnightly pass

No code has changed since the last audit: only the README's npm line and the standing rules in `docs/decisions.md`. This pass maps the decisions to the tests.

### Covered

| Promise | Tests |
|---|---|
| It never buys anything; the Console's cart API changes only its own status, with history, and refuses signed-out people and other sites | the Console's cart API (step 5) |
| Each works alone: Restock drafts from the host's own needs without Kitting, and from Kitting 0.1's stock report without `restockNeeds` | without Kitting (step 2); `test/kitting-0.1.test.ts` |
| One supplier list shared with Kitting | with Kitting (step 2) |
| Status by hand only draft ↔ approved → ordered; approving and ordering need `approve`; receiving and the cart status only through Restock | life cycle (step 1); step 4; step 5 |

### Gap added (1 test)

- **Works without Kitting, at the package level** ("each works alone"). The tests above run with Kitting installed, so a static import of it would pass them and still crash a host without it. Now a test checks that `package.json` depends on no other plugin from this set, that Kitting is an optional peer, and that the only reference to it in `src` is the guarded `await import(...).catch(() => null)` in `draft.ts`.

24 tests.

### For the lead

- **The build-it-right wording in `docs/decisions.md`:** "This repo imports no other plugin from this set" isn't quite true. It imports Kitting as an optional adapter, which that rule allows. The new test pins what's true; the line could say "imports no other plugin from this set except Kitting, optionally".

### Skipped, and why

- **"Never stores vendor credentials":** no collection has a field for one, and a test matching field names would prove little. A review question for any new supplier field, not a test.
- **No plugin-family tags:** one keyword list in `package.json`, read at review. A test would be overkill.
- **The README's npm line and the other decisions:** process, not behavior.

## 2026-11-11, only an exact `true` or a query that is applied

Suite: 24 tests before, 26 after (`npx vitest run`). From an access sweep.

- **The change.** `src/access.ts`: `isWhere` (a well-formed, non-empty query of `and`/`or` lists and known operators), `trueOrWhere` (exactly `true`, such a query, or no; a throw is no) and `mayUse`. `allows` (every endpoint, approving in the collection hook, the place-this-order panel and the arrivals list) took any truthy answer as a query, and Payload matched `1` against the order, so a `manage` answering `1` let someone receive; a throw was a 500, and a query on a missing field a 500 too. Now only `true` or a well-formed query counts, the query must match the order, and anything else, an unrunnable query included, is a 403. The `/admin/restock` page read `read` and `manage` as truthy; it now uses `mayUse` (its reads don't override access, so a query is applied by Payload).
- **Tests.** In `restock.test.ts`, "refuses a truthy non-true answer…": `allows` refuses `1`, `'yes'`, `{}`, `{ tenant: false }`, an unknown field, a throw and a rejection; a query for another site is no, one for the order's site and `true` are yes; the export endpoint answers 403 for each refusal and 200 for `true`. In `view.test.ts` (Payload's admin shell stubbed, a made-up Payload that reads nothing): the page reads orders only for `true` or a query from `read`, suppliers only for `true` or a query from `manage`, and nothing when signed out.
- **Mutation checks.** 8 mutations, each a Python string replace restored byte for byte (SHA-256 checked). All 8 fail the suite: `isWhere` taking any object; `trueOrWhere` rethrowing and passing truthy answers; the old truthy `allows`; the query not applied to the order; the unrunnable-query catch removed; the old truthy `read` and `manage` in the view.
- **Also found.** `allows` wasn't in the sweep's findings (only the view was), but it's the gate every endpoint uses and had the same flaw, so it's fixed here: before the fix, `manage` answering `1` let a person receive an order.
- **Skipped.** The view is checked through which reads it makes, not rendered in a real admin.

## 2026-11-11, `arrived` returns each order's site

Suite: 26 tests before, 26 after (`npx vitest run`), 1 extended. For Kitting's arrivals line (crossing `kitting-restock`).

- **The change.** `config.custom.restock.arrived` now returns `scope` with each order: the site's ID from `scopeField`, or `null` without one. `awaitingConfirmation` already worked it out; `arrived` dropped it. The other fields are as before.
- **Tests.** In `kitting.test.ts`, "tracks shipments…": the shared `arrived` returns the delivered order with its id, number, supplier, delivery time and its site's ID (not the populated site document).
- **Mutation checks.** 2 mutations, each a Python string replace restored byte for byte (SHA-256 checked). Both fail the suite: `scope` left out of `arrived`, and the populated site document returned instead of its ID.
- **Skipped.** `scope: null` without a `scopeField`: every database suite here runs with a site field, and the `null` branch is the same line `awaitingConfirmation` has used since 0.1. Kitting's side, the filtering, is tested in Kitting.
