// A shorter key cannot be distinguished from ordinary text, so match it only as a whole value.
const MIN_SUBSTRING_KEY_LENGTH = 16;

export function carriesApiKey(values: readonly string[], apiKey: string): boolean {
  return apiKey.length >= MIN_SUBSTRING_KEY_LENGTH
    ? values.some((value) => value.includes(apiKey))
    : values.includes(apiKey);
}
