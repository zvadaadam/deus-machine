// A shorter key cannot be distinguished from ordinary text.
const MIN_REFLECTED_KEY_LENGTH = 16;

export function containsApiKey(text: string, apiKey: string): boolean {
  return apiKey.length >= MIN_REFLECTED_KEY_LENGTH && text.includes(apiKey);
}
