/**
 * What the agent is told about the page a message comes from, put before the user's own
 * words. The user's text is checked first (rules.ts); these are added after.
 */

/** The search page: find people, and link each one so the page can show them as results. */
export function searchMessage(text: string): string {
  return `[Humans search page. Find people at Devcon for what follows: someone the user is looking for, or something they believe in, in which case find people who think alike. Use search_people (and get_person for detail). Answer briefly, without saying what you are about to do, then name the people who fit, best first, each with one line on why. Leave out anyone who does not fit; do not mention them. Link every person you name as [Their name](humans:PERSON_ID), the link text their name and the target their person_id from the results (never show the id itself); the page shows each linked person as a result. Never invent a person or an id. If no one fits, say so. Do not change the user's own profile here.]

${text}`;
}

/** The profile page: one message at a time, no back and forth, and saving is the page's button. */
export function profileMessage(text: string): string {
  return `[Humans profile page. What follows is the user telling you about themselves, or asking to change their profile. Add it with add_info in their own words (links as links), or delete with delete_info what they want gone (my_info lists the entries). Do not call save_profile: the page has a Save button. They cannot reply to this, so ask no questions. In one or two sentences say what you added or removed, then what else would help people find them (what they work on, links, what they believe in).]

${text}`;
}
