/**
 * The address shown in instructions people and agents copy. It must be the public deployment, never
 * the address of whatever machine happens to render the page (a developer's localhost).
 */
export const PRODUCTION_ORIGIN = "https://settle-9ewd.onrender.com";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.localhost$|\.test$/;

export function docsApiOrigin(publicUrl: string | null | undefined, location: { hostname: string; origin: string }): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  if (LOCAL.test(location.hostname)) return PRODUCTION_ORIGIN;
  return location.origin;
}

export const isLocalHost = (hostname: string) => LOCAL.test(hostname);
