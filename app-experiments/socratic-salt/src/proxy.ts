import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * `proxy` is the Next 16 name for what used to be `middleware`; both the named and
 * the default export are kept so Clerk finds its handler either way.
 *
 * It establishes the Clerk session and stops there. It does **not** protect routes,
 * and that is a deliberate change: this app has a second way to be somebody — the
 * `API_SECRET` back door, chosen in the browser's localStorage — and middleware runs
 * too early and in the wrong place to see it. A page navigation carries no headers of
 * ours, so `auth.protect()` here would bounce every impersonated visitor to a sign-in
 * screen they have no intention of using, for pages that would have worked.
 *
 * Nothing is given away by that. The pages are shells; every byte of agent data on
 * them arrives from a route handler, each route handler forwards to the Worker, and
 * the Worker answers nobody it cannot identify and shows no agent to an address that
 * is not on its list. Reaching an agent page you were not given renders an empty
 * frame and a 404 from the API, which is what it rendered before. The gate was never
 * here; it was always on the other side of `AGENT_URL`.
 *
 * What replaces it for the user's sake, not the data's, is `useIdentity()`: each page
 * draws the front door when nobody is signed in, so the experience is unchanged.
 */
export const proxy = clerkMiddleware();

export default proxy;

export const config = {
  matcher: [
    // Everything except Next's own build output and static files, which no
    // session check has anything to say about.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
