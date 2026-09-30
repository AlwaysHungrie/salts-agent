/**
 * The slice of node:crypto test/clerk.ts signs with. Present at runtime under
 * nodejs_compat; the project carries no Node types, so this declares only what is used.
 */
declare module "node:crypto" {
  export function sign(
    algorithm: string,
    data: Uint8Array,
    key: { key: JsonWebKey; format: "jwk"; dsaEncoding: "ieee-p1363" }
  ): Uint8Array;
}
