import { bookingsDelete } from 'api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteBooking } from './api'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('deleteBooking', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats a bodyless 204 from the generated SDK as success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteBooking(42)).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = fetchMock.mock.calls[0][0] as Request
    expect(request.method).toBe('DELETE')
    expect(request.url).toBe('http://localhost:3000/bookings/42')
  })

  it('accepts the generated SDK result for a bodyless 204 as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 })),
    )

    const result = await bookingsDelete({ path: { id: 42 } })

    expect(result.error).toBeUndefined()
    expect(result.data).toBeNull()
  })

  it('returns the normalized not_found error for a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(404, {
          statusCode: 404,
          code: 'not_found',
          message: 'Booking not found',
        }),
      ),
    )

    await expect(deleteBooking(42)).resolves.toEqual({
      status: 404,
      code: 'not_found',
      message: 'Booking not found',
      details: undefined,
    })
  })

  it('returns the normalized error for any other failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(500, {
          statusCode: 500,
          code: 'internal_error',
          message: 'Internal server error',
        }),
      ),
    )

    await expect(deleteBooking(42)).resolves.toEqual({
      status: 500,
      code: 'internal_error',
      message: 'Internal server error',
      details: undefined,
    })
  })

  it('returns a network error when the request rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('Failed to fetch')),
    )

    await expect(deleteBooking(42)).resolves.toEqual({
      status: 0,
      code: 'network_error',
      message: 'Failed to fetch',
      details: undefined,
    })
  })
})
