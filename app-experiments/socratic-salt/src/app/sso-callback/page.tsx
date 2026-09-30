import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/**
 * Where Google drops the browser back off.
 *
 * Clerk finishes the handshake here and then navigates on; the page itself only
 * needs to exist and hold still while that happens.
 */
export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <p className="text-muted text-sm leading-[1.43]">Signing you in…</p>
      <AuthenticateWithRedirectCallback />
    </div>
  );
}
