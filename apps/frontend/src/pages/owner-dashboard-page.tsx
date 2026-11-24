import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Booking, MeetingType } from 'api-client'
import { AsyncSection } from '@/components/async-section'
import { Button } from '@/components/ui/button'
import {
  createMeetingType,
  deleteBooking,
  listMeetingTypes,
  listUpcomingBookings,
  networkError,
  type ApiError,
  type ApiResult,
} from '@/lib/api'
import { fieldErrorId, inputClassName, splitValidationFieldErrors } from '@/lib/form'
import type { LoadStatus } from '@/lib/load-status'
import { MEETING_TYPE_LIMITS } from '@/lib/meeting-type-limits'
import { formatOwnerDateTime } from '@/lib/owner-days'

interface CreateFormState {
  name: string
  description: string
  durationMin: string
}

const emptyForm: CreateFormState = {
  name: '',
  description: '',
  durationMin: '',
}

const FORM_FIELDS = ['name', 'description', 'durationMin'] as const
const FIELD_ERROR_PREFIX = 'meeting-type'

function OwnerDashboardPage() {
  const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>([])
  const [listStatus, setListStatus] = useState<LoadStatus>('loading')
  const [listError, setListError] = useState<ApiError | null>(null)

  const [bookings, setBookings] = useState<Booking[]>([])
  const [bookingsStatus, setBookingsStatus] = useState<LoadStatus>('loading')
  const [bookingsError, setBookingsError] = useState<ApiError | null>(null)

  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<number>>(
    () => new Set(),
  )
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [failedDeleteId, setFailedDeleteId] = useState<number | null>(null)

  const [form, setForm] = useState<CreateFormState>(emptyForm)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleResult = useCallback((result: ApiResult<MeetingType[]>) => {
    if (result.error) {
      setListError(result.error)
      setListStatus('error')
      return
    }

    setMeetingTypes(result.data)
    setListStatus('ready')
  }, [])

  useEffect(() => {
    void listMeetingTypes().then(handleResult)
  }, [handleResult])

  const handleBookingsResult = useCallback((result: ApiResult<Booking[]>) => {
    if (result.error) {
      setBookingsError(result.error)
      setBookingsStatus('error')
      return
    }

    setBookings(result.data)
    setBookingsStatus('ready')
  }, [])

  useEffect(() => {
    void listUpcomingBookings().then(handleBookingsResult)
  }, [handleBookingsResult])

  function retryMeetingTypes() {
    setListStatus('loading')
    setListError(null)
    void listMeetingTypes().then(handleResult)
  }

  function retryBookings() {
    setBookingsStatus('loading')
    setBookingsError(null)
    void listUpcomingBookings().then(handleBookingsResult)
  }

  async function handleDelete(id: number) {
    setDeletingIds((current) => new Set(current).add(id))
    setDeleteError(null)

    try {
      const error = await deleteBooking(id).catch(() => networkError())

      if (error && error.code !== 'not_found') {
        setDeleteError(error.message)
        setFailedDeleteId(id)
        return
      }

      setBookings((current) => current.filter((booking) => booking.id !== id))
      setFailedDeleteId(null)
    } finally {
      // Whatever the outcome, this card must leave the pending state so the
      // owner can retry. Remove only this id: another row may still be
      // deleting and must keep its own pending state.
      setDeletingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setConfirmingId((current) => (current === id ? null : current))
    }
  }

  function retryDelete() {
    if (failedDeleteId !== null) {
      void handleDelete(failedDeleteId)
    }
  }

  function updateField(field: keyof CreateFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setFieldErrors({})
    setSubmitError(null)

    const durationIsBlank = form.durationMin.trim() === ''

    const result = await createMeetingType({
      name: form.name,
      ...(form.description.trim() === ''
        ? {}
        : { description: form.description }),
      durationMin: durationIsBlank ? Number.NaN : Number(form.durationMin),
    })

    if (result.error) {
      setIsSubmitting(false)

      if (result.error.code === 'validation_failed') {
        const { fields } = splitValidationFieldErrors(result.error, FORM_FIELDS)
        setFieldErrors(fields)
        return
      }

      setSubmitError(result.error.message)
      return
    }

    setMeetingTypes((current) => [...current, result.data])
    setForm(emptyForm)
    setIsSubmitting(false)
  }

  return (
    <section className="flex flex-col gap-10 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Owner dashboard
        </h1>
        <p className="text-muted-foreground">
          Create the meeting types guests can book.
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-2">
        <section
          aria-labelledby="create-meeting-type-heading"
          className="flex flex-col gap-4 rounded-lg border p-6"
        >
          <h2
            id="create-meeting-type-heading"
            className="text-xl font-semibold"
          >
            Create a meeting type
          </h2>

          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="meeting-type-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="meeting-type-name"
                name="name"
                value={form.name}
                maxLength={MEETING_TYPE_LIMITS.nameMaxLength}
                onChange={(event) => updateField('name', event.target.value)}
                aria-invalid={fieldErrors.name ? 'true' : undefined}
                aria-describedby={
                  fieldErrors.name
                    ? fieldErrorId(FIELD_ERROR_PREFIX, 'name')
                    : undefined
                }
                className={inputClassName}
              />
              {fieldErrors.name && (
                <p
                  id={fieldErrorId(FIELD_ERROR_PREFIX, 'name')}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {fieldErrors.name}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="meeting-type-description"
                className="text-sm font-medium"
              >
                Description (optional)
              </label>
              <textarea
                id="meeting-type-description"
                name="description"
                value={form.description}
                maxLength={MEETING_TYPE_LIMITS.descriptionMaxLength}
                onChange={(event) =>
                  updateField('description', event.target.value)
                }
                rows={3}
                aria-invalid={fieldErrors.description ? 'true' : undefined}
                aria-describedby={
                  fieldErrors.description
                    ? fieldErrorId(FIELD_ERROR_PREFIX, 'description')
                    : undefined
                }
                className={`${inputClassName} h-auto py-2`}
              />
              {fieldErrors.description && (
                <p
                  id={fieldErrorId(FIELD_ERROR_PREFIX, 'description')}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {fieldErrors.description}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="meeting-type-duration"
                className="text-sm font-medium"
              >
                Duration (minutes)
              </label>
              <input
                id="meeting-type-duration"
                name="durationMin"
                type="number"
                min={MEETING_TYPE_LIMITS.durationMin.min}
                max={MEETING_TYPE_LIMITS.durationMin.max}
                value={form.durationMin}
                onChange={(event) =>
                  updateField('durationMin', event.target.value)
                }
                aria-invalid={fieldErrors.durationMin ? 'true' : undefined}
                aria-describedby={
                  fieldErrors.durationMin
                    ? fieldErrorId(FIELD_ERROR_PREFIX, 'durationMin')
                    : undefined
                }
                className={inputClassName}
              />
              {fieldErrors.durationMin && (
                <p
                  id={fieldErrorId(FIELD_ERROR_PREFIX, 'durationMin')}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {fieldErrors.durationMin}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create meeting type'}
              </Button>
              {submitError && (
                <p role="alert" className="text-sm text-destructive">
                  {submitError}
                </p>
              )}
            </div>
          </form>
        </section>

        <section
          aria-labelledby="meeting-types-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="meeting-types-heading" className="text-xl font-semibold">
            Meeting types
          </h2>

          <AsyncSection
            status={listStatus}
            loadingMessage="Loading meeting types..."
            errorMessage={`Couldn't load meeting types. ${listError?.message ?? ''}`}
            onRetry={retryMeetingTypes}
            isEmpty={meetingTypes.length === 0}
            emptyTitle="No meeting types yet"
            emptyMessage="Create your first meeting type to start accepting bookings."
          >
            <ul className="flex flex-col gap-3">
              {meetingTypes.map((meetingType) => (
                <li key={meetingType.id}>
                  <article className="flex flex-col gap-1 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-medium">{meetingType.name}</h3>
                      <span className="text-sm text-muted-foreground whitespace-nowrap">
                        {meetingType.durationMin} minutes
                      </span>
                    </div>
                    {meetingType.description && (
                      <p className="text-sm text-muted-foreground">
                        {meetingType.description}
                      </p>
                    )}
                  </article>
                </li>
              ))}
            </ul>
          </AsyncSection>
        </section>
      </div>

      <section
        aria-labelledby="upcoming-bookings-heading"
        className="flex flex-col gap-4"
      >
        <h2 id="upcoming-bookings-heading" className="text-xl font-semibold">
          Upcoming bookings
        </h2>

        <AsyncSection
          status={bookingsStatus}
          loadingMessage="Loading bookings..."
          errorMessage={`Couldn't load bookings. ${bookingsError?.message ?? ''}`}
          onRetry={retryBookings}
          isEmpty={bookings.length === 0}
          emptyTitle="No upcoming bookings yet"
          emptyMessage="Bookings made by guests will show up here."
        >
          <ul aria-label="Upcoming bookings" className="flex flex-col gap-3">
            {bookings.map((booking) => (
              <li key={booking.id}>
                <article className="flex flex-col gap-1 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="font-medium">{booking.meetingType.name}</h3>
                    <time
                      dateTime={booking.startAt}
                      className="text-sm text-muted-foreground whitespace-nowrap"
                    >
                      {formatOwnerDateTime(booking.startAt)}
                    </time>
                  </div>
                  <p className="text-sm">{booking.guestName}</p>
                  <a
                    href={`mailto:${booking.guestEmail}`}
                    className="text-sm text-muted-foreground"
                  >
                    {booking.guestEmail}
                  </a>
                  {confirmingId === booking.id ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-sm">Delete this booking?</p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={deletingIds.has(booking.id)}
                          onClick={() => void handleDelete(booking.id)}
                        >
                          {deletingIds.has(booking.id) ? 'Deleting...' : 'Confirm'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={deletingIds.has(booking.id)}
                          onClick={() => setConfirmingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : deletingIds.has(booking.id) ? (
                    <div className="mt-2">
                      <Button type="button" variant="outline" disabled>
                        Deleting...
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setDeleteError(null)
                          setFailedDeleteId(null)
                          setConfirmingId(booking.id)
                        }}
                      >
                        Delete booking
                      </Button>
                    </div>
                  )}
                </article>
              </li>
            ))}
          </ul>
        </AsyncSection>

        {deleteError && (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          >
            <p>Couldn't delete booking. {deleteError}</p>
            {failedDeleteId !== null && (
              <Button type="button" variant="outline" onClick={retryDelete}>
                Retry
              </Button>
            )}
          </div>
        )}
      </section>
    </section>
  )
}

export default OwnerDashboardPage
