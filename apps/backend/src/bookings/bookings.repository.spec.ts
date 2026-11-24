import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import { BookingsRepository } from './bookings.repository.js';

describe('BookingsRepository.deleteById', () => {
  let directory: string;
  let database: DatabaseService;
  let repository: BookingsRepository;
  let meetingTypeId: number;
  let bookingId: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'call-calendar-booking-repo-'));
    process.env.DATABASE_URL = `file:${join(directory, 'unit.db')}`;
    database = new DatabaseService();
    repository = new BookingsRepository(database);

    const meetingType = database.db
      .prepare(
        `INSERT INTO "MeetingType" ("name", "description", "durationMin", "createdAt")
         VALUES (?, ?, ?, ?)`,
      )
      .run('Intro call', null, 30, new Date().toISOString());
    meetingTypeId = Number(meetingType.lastInsertRowid);

    const booking = database.db
      .prepare(
        `INSERT INTO "Booking"
           ("meetingTypeId", "startAt", "endAt", "guestName", "guestEmail", "comment", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingTypeId,
        '2026-11-10T06:00:00.000Z',
        '2026-11-10T06:30:00.000Z',
        'Ada Lovelace',
        'ada@example.com',
        null,
        new Date().toISOString(),
      );
    bookingId = Number(booking.lastInsertRowid);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('removes the row and reports that it affected a row', () => {
    expect(repository.deleteById(bookingId)).toBe(true);
    expect(
      database.db
        .prepare('SELECT COUNT(*) AS count FROM "Booking"')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('returns false for a missing id', () => {
    expect(repository.deleteById(bookingId + 1)).toBe(false);
    expect(
      database.db
        .prepare('SELECT COUNT(*) AS count FROM "Booking"')
        .get(),
    ).toEqual({ count: 1 });
  });
});
