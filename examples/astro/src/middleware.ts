// Sets Astro.locals.member on every request. If you already have middleware,
// combine them: `export const onRequest = sequence(members.middleware, yours);`
import { members } from "./lib/members";

export const onRequest = members.middleware;
