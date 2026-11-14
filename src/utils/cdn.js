/**
 * Cloudflare R2 CDN integration for philippine-weather-app
 * Resolves static & dynamic weather assets.
 * 
 * Note: If a verified Custom Domain is set (e.g. https://assets.yourdomain.com),
 * it uses it directly. If using Cloudflare's development 'r2.dev' domain, we route
 * via same-origin relative URLs ('/assets/...', '/images/...') which Vercel proxies
 * directly to Cloudflare R2 on the backend via vercel.json.
 * This completely avoids ISP DNS failures (net::ERR_NAME_NOT_RESOLVED) with *.r2.dev.
 */

const envUrl = import.meta.env.VITE_R2_PUBLIC_URL || "";
export const R2_PUBLIC_URL = (envUrl && !envUrl.includes(".r2.dev")) ? envUrl : "";

/**
 * Normalizes an asset or image path
 * @param {string} path - e.g. "assets/fnv3_...png" or "/images/wind/...png"
 * @returns {string} - Relative proxy path or custom CDN URL
 */
export const getAssetUrl = (path) => {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;

  const cleanPath = path.startsWith("/") ? path.slice(1) : path;

  // If a custom production CDN domain is configured, load directly
  if (R2_PUBLIC_URL && (cleanPath.startsWith("assets/") || cleanPath.startsWith("images/"))) {
    return `${R2_PUBLIC_URL.replace(/\/$/, "")}/${cleanPath}`;
  }

  // Otherwise, use same-origin relative path (proxied to R2 by Vercel)
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${cleanPath}`;
};

export default getAssetUrl;
