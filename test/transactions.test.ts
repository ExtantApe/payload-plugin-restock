import { describe, expect, it, vi } from 'vitest'

// A paginated find makes Payload's Mongo adapter send the find and its count together on the request's session. As
// the first query in a transaction, the two race to start it and one can fail with NoSuchTransaction. So every find
// Restock makes with a `req` passes `pagination: false`. This file drives each of those code paths with a made-up
// Payload that reads nothing and remembers what `find` was asked. The race itself isn't reproduced here.

// Kitting is replaced by a stand-in with nothing to buy, so the drafting path with Kitting runs without the package.
vi.mock('@extantape/payload-plugin-kitting', () => ({ restockNeeds: async () => [] }))

const { ordersCollection, settingsCollection } = await import('../src/collections.js')
const { ordersForCart } = await import('../src/console.js')
const { purchaseOrderDocument } = await import('../src/document.js')
const { draftOrders } = await import('../src/draft.js')
const { awaitingConfirmation, markDelivered } = await import('../src/tracking.js')

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const ORDERS = 'purchase-orders'
const SUPPLIERS = 'suppliers'
const ITEMS = 'supplier-items'
const SETTINGS = 'restock-settings'

/** Made-up rows per collection. `find` answers with all of a collection's rows, whatever the query. */
const fakePayload = (rows: Record<string, Doc[]> = {}, restock: Doc = {}) => {
  const finds: Doc[] = []
  const o = {
    orders: ORDERS,
    suppliers: SUPPLIERS,
    items: ITEMS,
    settings: SETTINGS,
    userSlug: 'users',
    scopeField: 'tenant',
    currency: 'USD',
    kitting: false,
    read: () => true,
    manage: () => true,
    approve: () => true,
    ...restock,
  }
  const payload = {
    config: { custom: { restock: o, kitting: { scopeField: 'tenant' } }, routes: { admin: '/admin', api: '/api' } },
    find: async (args: Doc) => (finds.push(args), { docs: rows[args.collection] ?? [] }),
    findByID: async ({ collection, id }: Doc) => (rows[collection] ?? []).find((d) => String(d.id) === String(id)) ?? null,
    count: async () => ({ totalDocs: 0 }),
    create: async ({ data }: Doc) => ({ id: 'new-order', number: 'PO-0001', ...data }),
    update: async ({ id, data }: Doc) => ({ id, ...data }),
    db: { beginTransaction: async () => 'own-transaction', commitTransaction: async () => undefined, rollbackTransaction: async () => undefined },
    logger: { error: () => undefined },
  }
  return { payload: payload as never, o: o as never, finds }
}

/** A request that is already inside a transaction, as a hook's or an endpoint's is. */
const inTransaction = (payload: unknown) => ({ payload, transactionID: 'request-transaction', context: {}, user: null }) as never

/** Every find made with a `req` must skip the count. `howMany` keeps the check from passing with no finds at all. */
const expectNoPaginatedFinds = (finds: Doc[], howMany: number) => {
  const withReq = finds.filter((f) => f.req)
  expect(withReq.map((f) => f.collection)).toHaveLength(howMany)
  for (const f of withReq) expect(f.pagination, `find on ${f.collection}`).toBe(false)
}

const supplier = { id: 'sup-1', tenant: 'site-a', name: 'Example Packaging Co' }
const item = { id: 'item-1', tenant: 'site-a', supplier: 'sup-1', sku: 'S-0001', name: 'Poly mailer, made up', packSize: 100, minimumPacks: 1, price: 12.5 }

describe('finds that can run inside a transaction never paginate', () => {
  it('numbering a new order reads the highest number so far without a count, and still asks for one row', async () => {
    const { payload, o, finds } = fakePayload({ [SUPPLIERS]: [supplier], [ORDERS]: [{ id: 'o-7', number: 'PO-0007' }] })
    const beforeChange = ordersCollection(o).hooks!.beforeChange![0]!
    const data = (await beforeChange({ data: { tenant: 'site-a', supplier: 'sup-1', lines: [] }, operation: 'create', req: inTransaction(payload) } as never)) as Doc
    expect(data.number).toBe('PO-0008')
    expectNoPaginatedFinds(finds, 1)
    expect(finds[0]).toMatchObject({ collection: ORDERS, sort: '-number', limit: 1, where: { tenant: { equals: 'site-a' } } })
  })

  it('building the purchase-order document reads the site’s settings without a count, and still asks for one row', async () => {
    const order = { id: 'o-1', tenant: 'site-a', supplier: 'sup-1', number: 'PO-0001', status: 'approved', lines: [{ item: 'item-1', packs: 2, unitPrice: 12.5 }] }
    const { payload, finds } = fakePayload({ [ORDERS]: [order], [SUPPLIERS]: [supplier], [ITEMS]: [item], [SETTINGS]: [{ id: 'set-1', tenant: 'site-a', organizationName: 'Example Lab' }] })
    const d = await purchaseOrderDocument(payload, 'o-1', { req: inTransaction(payload) })
    expect(d.buyer.organization).toBe('Example Lab')
    expectNoPaginatedFinds(finds, 1)
    expect(finds[0]).toMatchObject({ collection: SETTINGS, limit: 1, where: { tenant: { equals: 'site-a' } } })
  })

  it('the other finds made with a req don’t paginate either: settings, drafting, deliveries, arrivals and the cart list', async () => {
    // One settings document per site.
    const settings = fakePayload()
    await settingsCollection(settings.o).hooks!.beforeChange![0]!({ data: { tenant: 'site-a', organizationName: 'Example Lab' }, req: inTransaction(settings.payload) } as never)
    expectNoPaginatedFinds(settings.finds, 1)

    // Drafting from the host's own needs: what's already on order, then the supplier's open draft.
    const needs = async () => [{ supplierItem: 'item-1', packs: 3 }]
    const own = fakePayload({ [ITEMS]: [item] }, { needs })
    const drafted = await draftOrders(own.payload, { scope: 'site-a', req: inTransaction(own.payload) })
    expect(drafted.created).toHaveLength(1)
    expectNoPaginatedFinds(own.finds, 2)

    // Drafting with Kitting: what's already on order, then the supplier items linked to supplies.
    const kitting = fakePayload({}, { kitting: true })
    await draftOrders(kitting.payload, { scope: 'site-a', req: inTransaction(kitting.payload) })
    expectNoPaginatedFinds(kitting.finds, 2)
    expect(kitting.finds.map((f) => f.collection)).toEqual([ORDERS, ITEMS])

    // A delivered event, inside the caller's transaction and inside Restock's own.
    const shipped = { id: 'o-2', tenant: 'site-a', number: 'PO-0002', status: 'ordered', shipments: [{ trackerId: 'trk-1', trackingNumber: 'EX123', status: 'in-transit' }] }
    const theirs = fakePayload({ [ORDERS]: [shipped] })
    expect(await markDelivered(theirs.payload, { trackerId: 'trk-1', scope: 'site-a', req: inTransaction(theirs.payload) })).toMatchObject({ status: 'delivered' })
    expectNoPaginatedFinds(theirs.finds, 1)
    const ours = fakePayload({ [ORDERS]: [{ ...shipped, shipments: [{ ...shipped.shipments[0], status: 'delivered' }] }] })
    expect(await markDelivered(ours.payload, { trackerId: 'trk-1', scope: 'site-a' })).toMatchObject({ status: 'already' })
    expect(ours.finds[0]!.req).toMatchObject({ transactionID: 'own-transaction' })
    expectNoPaginatedFinds(ours.finds, 1)

    // The arrivals list and the cart list.
    const arrivals = fakePayload()
    await awaitingConfirmation(arrivals.payload, { req: inTransaction(arrivals.payload) })
    expectNoPaginatedFinds(arrivals.finds, 1)
    const cart = fakePayload()
    await ordersForCart(cart.payload, { scope: 'site-a', req: inTransaction(cart.payload) })
    expectNoPaginatedFinds(cart.finds, 1)
  })
})
