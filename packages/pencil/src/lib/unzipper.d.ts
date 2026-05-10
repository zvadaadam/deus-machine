// Minimal ambient type for the `unzipper` package — we only need Extract().
declare module "unzipper" {
  export function Extract(opts: { path: string }): NodeJS.WritableStream;
}
