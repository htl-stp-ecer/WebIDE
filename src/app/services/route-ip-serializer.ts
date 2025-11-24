export function encodeRouteIp(ip: string): string {
  if (!ip) {
    return ip;
  }

  try {
    return encodeURIComponent(ip);
  } catch {
    return ip;
  }
}

export function decodeRouteIp(ip: string | null): string | null {
  if (ip === null || ip === undefined) {
    return ip;
  }

  let decoded = ip;
  for (let i = 0; i < 5; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}
