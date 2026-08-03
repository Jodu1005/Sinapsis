export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
  })[character]!)
}
