import { ApiError } from '../common/api-error.js';
import { BookingsRepository } from './bookings.repository.js';
import { BookingsService } from './bookings.service.js';
import { MeetingTypesService } from '../meeting-types/meeting-types.service.js';

function createService(deleteById: (id: number) => boolean) {
  const repository = {
    deleteById,
  } as unknown as BookingsRepository;

  return new BookingsService({} as MeetingTypesService, repository);
}

describe('BookingsService.delete', () => {
  it('deletes an existing booking by id', () => {
    const deleteById = vi.fn().mockReturnValue(true);
    const service = createService(deleteById);

    expect(() => service.delete('42')).not.toThrow();
    expect(deleteById).toHaveBeenCalledWith(42);
  });

  it('throws not_found when the booking does not exist', () => {
    const service = createService(() => false);

    try {
      service.delete('999');
      expect.unreachable('Expected delete to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.code).toBe('not_found');
    }
  });

  it('throws not_found for a non-integer id without touching the repository', () => {
    const deleteById = vi.fn();
    const service = createService(deleteById);

    try {
      service.delete('abc');
      expect.unreachable('Expected delete to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.code).toBe('not_found');
    }

    expect(deleteById).not.toHaveBeenCalled();
  });
});
