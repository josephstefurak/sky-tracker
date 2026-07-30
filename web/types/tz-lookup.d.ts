/**
 * Local types for tz-lookup (v6.1.x) — the package ships none, and pulling in
 * @types/tz-lookup would add an MIT-licensed dependency (with its attribution
 * term) for two lines of declaration.
 *
 * The package is plain CommonJS — `module.exports = tzlookup` — so `export =`
 * is the accurate shape. With `esModuleInterop` this makes
 * `(await import("tz-lookup")).default` a `(lat, lon) => string`. It throws
 * RangeError on out-of-range coordinates, and coerces with unary `+`, so
 * `null` silently becomes 0: only ever call it with validated finite numbers
 * (see lib/observer.ts).
 */
declare module "tz-lookup" {
  function tzlookup(lat: number, lon: number): string;
  export = tzlookup;
}
