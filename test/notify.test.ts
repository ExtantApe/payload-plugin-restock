import { describe, expect, it } from 'vitest'

import { markDelivered } from '../src/tracking.js'

// The "Arrived, please confirm" email must fail closed: it goes out only when the host's `canSend` answers exactly
// `true` (or there is no `canSend`), and a `canSend` that breaks never stops the delivery being recorded.
// `test/kitting.test.ts` covers truthy answers against a real database. This covers the rest with a made-up Payload:
// falsy answers, a throw, a rejection, no recipients, and a caller's transaction that could still roll back.

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** One made-up ordered purchase order with a parcel on its way. Updates are kept, so a second read sees them. */
const fake = (notify: Doc) => {
  const order: Doc = { id: 'o-1', tenant: 'site-a', number: 'PO-0001', status: 'ordered', supplier: { id: 'sup-1', name: 'Example Packaging Co' }, shipments: [{ trackerId: 'trk-1', trackingNumber: 'EX123', status: 'in-transit' }] }
  const sent: Doc[] = []
  const errors: Doc[] = []
  const payload = {
    config: {
      custom: { restock: { orders: 'purchase-orders', userSlug: 'users', scopeField: 'tenant', notify: { recipients: ['receiving@example.com'], sendEmail: async (m: Doc) => void sent.push(m), ...notify } } },
      routes: { admin: '/admin' },
      serverURL: '',
    },
    find: async () => ({ docs: [order] }),
    findByID: async () => order,
    update: async ({ data }: Doc) => Object.assign(order, data),
    db: { beginTransaction: async () => 'own-transaction', commitTransaction: async () => undefined, rollbackTransaction: async () => undefined },
    logger: { error: (e: Doc) => void errors.push(e) },
  }
  return { payload: payload as never, order, sent, errors }
}
const delivered = { trackerId: 'trk-1', scope: 'site-a' }

describe('the arrival email fails closed', () => {
  it('sends once when canSend answers true, and when there is no canSend', async () => {
    for (const notify of [{ canSend: () => true }, { canSend: async () => true }, {}]) {
      const { payload, order, sent } = fake(notify)
      expect(await markDelivered(payload, delivered)).toMatchObject({ status: 'delivered' })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ to: ['receiving@example.com'], subject: 'Arrived, please confirm: PO-0001' })
      expect(order.shipments[0].notifiedAt).toEqual(expect.any(String))
      // The same event again changes nothing and sends nothing.
      expect(await markDelivered(payload, delivered)).toMatchObject({ status: 'already' })
      expect(sent).toHaveLength(1)
    }
  })

  it('sends nothing for a falsy answer, and still records the delivery', async () => {
    for (const answer of [false, 0, '', null, undefined]) {
      const { payload, order, sent, errors } = fake({ canSend: () => answer })
      expect(await markDelivered(payload, delivered), String(answer)).toMatchObject({ status: 'delivered' })
      expect(order.shipments[0].status).toBe('delivered')
      expect(sent, String(answer)).toHaveLength(0)
      expect(errors).toHaveLength(0)
    }
  })

  it('sends nothing when canSend throws or rejects; the delivery is recorded and the error is logged', async () => {
    const broken = [
      () => {
        throw new Error('settings store down')
      },
      async () => {
        throw new Error('settings store down')
      },
    ]
    for (const canSend of broken) {
      const { payload, order, sent, errors } = fake({ canSend })
      expect(await markDelivered(payload, delivered)).toMatchObject({ status: 'delivered' })
      expect(order.shipments[0].status).toBe('delivered')
      expect(sent).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ msg: 'restock: arrival email not sent' })
    }
  })

  it('sends nothing without recipients, or inside a caller’s transaction that could still roll back', async () => {
    const nobody = fake({ recipients: [' ', ''] })
    expect(await markDelivered(nobody.payload, delivered)).toMatchObject({ status: 'delivered' })
    expect(nobody.sent).toHaveLength(0)

    const theirs = fake({ canSend: () => true })
    expect(await markDelivered(theirs.payload, { ...delivered, req: { transactionID: 'request-transaction', context: {} } as never })).toMatchObject({ status: 'delivered' })
    expect(theirs.sent).toHaveLength(0)
  })
})
