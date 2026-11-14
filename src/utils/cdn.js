/**
 * Cloudflare R2 CDN integration for philippine-weather-app
 * Resolves static & dynamic weather assets directly from Cloudflare R2 edge CDN
 */

export const R2_PUBLIC_URL = import.meta.env.VITE_R2_PUBLIC_URL || "https://pub-040c32d81da842f1a99cc2a091e9d513.r2.dev";

/**
 * Normalizes an asset or image path to point to Cloudflare R2 CDN
 * @param {string} path - e.g. "assets/fnv3_...png" or "/images/wind/...png"
 * @returns {string} - Full CDN URL or local fallback
 */
export const getAssetUrl = (path) => {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;

  const cleanPath = path.startsWith("/") ? path.slice(1) : path;

  // Images and assets route through Cloudflare R2 CDN
  if (cleanPath.startsWith("assets/") || cleanPath.startsWith("images/")) {
    const cdnBase = R2_PUBLIC_URL.replace(/\/$/, "");
    return `${cdnBase}/${cleanPath}`;
  }

  // Other local files (e.g. data/) fall back to Vite base URL
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${cleanPath}`;
};

export default getAssetUrl;
