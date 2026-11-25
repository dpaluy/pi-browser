export function webHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname;
  } catch {}
  return undefined;
}

export function allowedHosts(value) {
  return new Set(Array.isArray(value) ? value.filter(host => typeof host === 'string' && host).map(host => host.toLowerCase()) : []);
}

function exactOnly(host) {
  return host === 'localhost' || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

// Only pass hosts extracted from HTTP(S) URLs. A missing host is never covered, even by '*'.
export function coversHost(allowed, host) {
  if (!host) return false;
  host = host.toLowerCase();
  if (allowed.has('*') || allowed.has(host)) return true;
  if (exactOnly(host)) return false;
  for (const entry of allowed) {
    if (!exactOnly(entry) && host.endsWith(`.${entry}`)) return true;
  }
  return false;
}
