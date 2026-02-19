import { describe, it, expect } from 'vitest';
import { AppError, NotFoundError, ValidationError, ConflictError } from '../../../src/lib/errors';

describe('AppError', () => {
  it('sets statusCode, message, and details', () => {
    const err = new AppError(500, 'Server error', { field: 'x' });
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('Server error');
    expect(err.details).toEqual({ field: 'x' });
  });

  it('has name set to AppError', () => {
    const err = new AppError(400, 'bad');
    expect(err.name).toBe('AppError');
  });

  it('leaves details undefined when not provided', () => {
    const err = new AppError(422, 'unprocessable');
    expect(err.details).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new AppError(500, 'boom');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('NotFoundError', () => {
  it('defaults to 404 status and "Not found" message', () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('NotFoundError');
  });

  it('accepts a custom message', () => {
    const err = new NotFoundError('User not found');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('User not found');
  });

  it('is an instance of both Error and AppError', () => {
    const err = new NotFoundError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('ValidationError', () => {
  it('sets 400 status and includes details when provided', () => {
    const details = { fields: ['name', 'email'] };
    const err = new ValidationError('Invalid input', details);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Invalid input');
    expect(err.details).toEqual(details);
    expect(err.name).toBe('ValidationError');
  });

  it('is an instance of both Error and AppError', () => {
    const err = new ValidationError('bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('ConflictError', () => {
  it('sets 409 status and includes details when provided', () => {
    const details = { existing: 'record-123' };
    const err = new ConflictError('Already exists', details);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Already exists');
    expect(err.details).toEqual(details);
    expect(err.name).toBe('ConflictError');
  });

  it('is an instance of both Error and AppError', () => {
    const err = new ConflictError('duplicate');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});
