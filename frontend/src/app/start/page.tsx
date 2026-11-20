/**
 * The home page under a second address. The landing page's "Get my agent" buttons
 * link here instead of `/`, so Cloudflare Web Analytics, which records paths but not
 * query strings, can count those clicks apart from "Sign in". See scripts/visitors.sh.
 */
export { default } from "../page";
