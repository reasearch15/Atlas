import { resolvePublicApiUrl } from "./resolve-public-api-url";

export { resolvePublicApiUrl } from "./resolve-public-api-url";

/** Browser API origin baked into the client bundle at build time. */
export const publicApiUrl = resolvePublicApiUrl();
