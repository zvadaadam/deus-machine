export const VALID_OBJECT = { type: 'text', text: 'Hello world' };
export const NESTED_OBJECT = { message: { content: [{ type: 'text', text: 'test' }] } };
export const CONTROL_CHAR_STRING = 'Hello\x00World\x01Test';
export const CLEAN_STRING = 'Hello, this is a normal string.';
export const VALID_JSON_STRING = '{"key": "value"}';
export const INVALID_JSON_STRING = '{key: value}';
export const EMPTY_STRING = '';
