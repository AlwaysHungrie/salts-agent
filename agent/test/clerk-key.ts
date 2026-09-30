/**
 * The suite's stand-in for Clerk: an issuer the outbound mock serves keys for, and the
 * key that signs its tokens. Test-only, generated for this suite, trusted nowhere else.
 */
export const TEST_CLERK_ISSUER = "https://clerk.test";
export const TEST_CLERK_KID = "test-key";

export const TEST_CLERK_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "IvaWbID71Lo0Ofv5DsF32klIqXMPaStT93ch_koUsyM",
  y: "fldgcEa08SNCD-v77osY-xUVPtukoTzR07iHseVClUs",
  d: "209OSv-KvxcXionu3ck1vO4g4z8VT9bCXL3KjWyNYQA",
};

/** What the mock publishes at `${TEST_CLERK_ISSUER}/.well-known/jwks.json`. */
export const TEST_CLERK_JWKS = {
  keys: [
    {
      kty: "EC",
      crv: "P-256",
      x: TEST_CLERK_PRIVATE_JWK.x,
      y: TEST_CLERK_PRIVATE_JWK.y,
      kid: TEST_CLERK_KID,
      alg: "ES256",
      use: "sig",
    },
  ],
};
