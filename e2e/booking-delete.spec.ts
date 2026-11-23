import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100'
const OWNER_TIMEZONE = 'Europe/Moscow'

interface MeetingTypeBody {
  id: number
  name: string
}

interface BookingBody {
  id: number
  startAt: string
}

interface SlotBody {
  startAt: string
}

function ownerDate(offsetDays: number): string {
  const now = new Date()
  now.setUTCDate(now.getUTCDate() + offsetDays)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: OWNER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function ownerTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: OWNER_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

test('owner deletes a booking and the freed slot is bookable again', async ({
  page,
  request,
}) => {
  const meetingTypeName = `Delete verification ${randomUUID().slice(0, 8)}`
  const createType = await request.post(`${API_URL}/meeting-types`, {
    data: {
      name: meetingTypeName,
      description: 'Browser verification for booking deletion',
      durationMin: 30,
    },
  })
  expect(createType.status()).toBe(201)
  const meetingType = (await createType.json()) as MeetingTypeBody

  const tomorrow = ownerDate(1)
  const availability = await request.get(`${API_URL}/availability`, {
    params: { meetingTypeId: meetingType.id, date: tomorrow },
  })
  expect(availability.status()).toBe(200)
  const slots = (await availability.json()) as SlotBody[]
  expect(slots.length).toBeGreaterThan(0)

  const targetSlot = slots[0]
  const targetTime = ownerTime(targetSlot.startAt)

  const guestName = 'Ada Lovelace'
  const guestEmail = 'ada.lovelace@example.com'

  const createBooking = await request.post(`${API_URL}/bookings`, {
    data: {
      meetingTypeId: meetingType.id,
      startAt: targetSlot.startAt,
      guestName,
      guestEmail,
      comment: 'Booked to verify deletion.',
    },
  })
  expect(createBooking.status()).toBe(201)
  const booking = (await createBooking.json()) as BookingBody

  const slotsAfterBooking = (await (
    await request.get(`${API_URL}/availability`, {
      params: { meetingTypeId: meetingType.id, date: tomorrow },
    })
  ).json()) as SlotBody[]
  expect(
    slotsAfterBooking.map((slot) => slot.startAt),
    'booked interval is hidden before deletion',
  ).not.toContain(targetSlot.startAt)

  await page.goto('/admin')
  const bookingList = page.getByRole('list', { name: 'Upcoming bookings' })
  const row = bookingList
    .getByRole('listitem')
    .filter({ hasText: guestName })
    .filter({ hasText: meetingTypeName })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(guestEmail)

  await row.getByRole('button', { name: 'Delete booking' }).click()
  await expect(page.getByText('Delete this booking?')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toBeVisible()
  await expect(page.getByText('Delete this booking?')).toHaveCount(0)

  await row.getByRole('button', { name: 'Delete booking' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(row).toHaveCount(0)

  const bookingsAfterDelete = (await (
    await request.get(`${API_URL}/bookings`, {
      params: { scope: 'upcoming' },
    })
  ).json()) as BookingBody[]
  expect(bookingsAfterDelete.map((item) => item.id)).not.toContain(booking.id)

  const slotsAfterDelete = (await (
    await request.get(`${API_URL}/availability`, {
      params: { meetingTypeId: meetingType.id, date: tomorrow },
    })
  ).json()) as SlotBody[]
  expect(
    slotsAfterDelete.map((slot) => slot.startAt),
    'freed interval is offered again',
  ).toContain(targetSlot.startAt)

  await page.goto('/book')
  await page.getByRole('button', { name: meetingTypeName }).click()
  const days = page.getByRole('list', { name: 'Available days' })
  await days.getByRole('button').nth(1).click()
  const slotButton = page
    .getByRole('list', { name: 'Available slots' })
    .getByRole('button', { name: targetTime, exact: true })
  await expect(slotButton).toBeVisible()
  await slotButton.click()

  await page.getByLabel('Name', { exact: true }).fill('Grace Hopper')
  await page.getByLabel('Email', { exact: true }).fill('grace.hopper@example.com')
  await page.getByRole('button', { name: 'Confirm booking' }).click()

  await expect(
    page.getByRole('heading', { name: 'Booking confirmed' }),
  ).toBeVisible()
  const confirmation = page.locator('article')
  await expect(
    confirmation.getByRole('heading', { name: meetingTypeName }),
  ).toBeVisible()
  await expect(confirmation).toContainText('Grace Hopper')
  await expect(confirmation).toContainText(targetTime)

  const bookingsAfterRebook = (await (
    await request.get(`${API_URL}/bookings`, {
      params: { scope: 'upcoming' },
    })
  ).json()) as BookingBody[]
  const rebooked = bookingsAfterRebook.find(
    (item) => item.startAt === targetSlot.startAt,
  )
  expect(rebooked, 'slot was rebooked at the same start').toBeDefined()
  expect(rebooked!.id).not.toBe(booking.id)

  const slotsAfterRebook = (await (
    await request.get(`${API_URL}/availability`, {
      params: { meetingTypeId: meetingType.id, date: tomorrow },
    })
  ).json()) as SlotBody[]
  expect(
    slotsAfterRebook.map((slot) => slot.startAt),
    'rebooked interval is hidden again',
  ).not.toContain(targetSlot.startAt)

  await test.info().attach('verification-summary', {
    contentType: 'text/plain',
    body: [
      `testedSha=${process.env.TESTED_SHA ?? 'unknown'}`,
      `meetingTypeId=${meetingType.id} name=${meetingTypeName}`,
      `date=${tomorrow} slot=${targetSlot.startAt} (${targetTime} Moscow)`,
      `deletedBookingId=${booking.id}`,
      `rebookedBookingId=${rebooked!.id}`,
    ].join('\n'),
  })
})
