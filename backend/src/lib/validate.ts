import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Parse and validate data against a Zod schema.
 * Throws ValidationError with descriptive messages on failure.
 */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    });
    throw new ValidationError(messages.join('; '));
  }
  return result.data;
}
