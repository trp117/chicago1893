// Reviewer-side check for the automated cold reviews (Gemini, OpenAI). The admin page keeps
// the same text for its copy-paste REVIEW_PROMPTS, because that script cannot import a server
// module; tests/unverified-tag.test.mjs fails if the two copies drift.
export const REVIEWER_LOAD_BEARING_CHECK = `LOAD-BEARING SPECIFICS — check every rank, title, unit, date, weapon/equipment model, casualty figure, place-name, and hard number:
(1) Is it correct AS OF the scenario's date, not the person's later or best-known status? A figure famous by a certain title may have held a lower rank at the time — a man remembered as "Colonel" who was a Major at the event. Flag any you cannot confirm as of that date.
(2) Does each citation's named source actually support the claim, and is it cited at the work level? Flag any citation that credits a real work with something it may not say, or that carries a page/paragraph/"Day" locator you cannot verify.
List each unconfirmed item as a VERIFY note (name it, say what to check). A human resolves these before the scenario is published.`;
