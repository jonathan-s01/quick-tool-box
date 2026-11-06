// Who may use this server. On a Mac it only listens on this computer.
// On a home server (Docker), it also accepts your home network and Tailscale.
// Settings come from environment variables, so nothing here needs editing:
//   HOST              address to listen on (default 127.0.0.1; Docker uses 0.0.0.0)
//   ALLOWED_NETWORKS  comma separated address ranges that may connect
//   ALLOWED_HOSTNAMES comma separated names you type in the browser, for example tools.example.com
import net from 'node:net';

export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT) || 3210;
export const LOCAL_ONLY = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const DEFAULT_NETWORKS = LOCAL_ONLY
  ? '127.0.0.0/8,::1/128'
  // Private home network ranges and Tailscale. Set ALLOWED_NETWORKS in .env to narrow this down.
  : '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10,100.64.0.0/10';

const blocks = new net.BlockList();
for (const raw of (process.env.ALLOWED_NETWORKS || DEFAULT_NETWORKS).split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = raw.split('/');
  const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
  if (!net.isIP(addr)) { console.warn(`ALLOWED_NETWORKS: ignoring ${raw}`); continue; }
  if (bits == null) blocks.addAddress(addr, type);
  else blocks.addSubnet(addr, Number(bits), type);
}

const names = new Set(['localhost', '127.0.0.1', '[::1]',
  ...(process.env.ALLOWED_HOSTNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);

function plainAddress(a) {
  if (!a) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1] : a;
}

/** Is the computer making this request allowed to use the server? */
export function addressAllowed(remote) {
  const a = plainAddress(remote);
  if (!net.isIP(a)) return false;
  return blocks.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
}

/**
 * Is the name in the address bar one we expect? This blocks "DNS rebinding",
 * where another website tricks your browser into talking to this server.
 */
export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (v6) host = v6[1];
  else host = host.replace(/:\d+$/, '');
  if (names.has(host) || names.has(`[${host}]`)) return true;
  if (host.endsWith('.ts.net')) return true; // Tailscale MagicDNS names
  if (!LOCAL_ONLY && !host.includes('.') && /^[a-z0-9-]+$/.test(host)) return true; // short Tailscale machine names
  if (net.isIP(host)) return addressAllowed(host);
  return false;
}

/** For form posts: the page that sent it must be one of ours. */
export function originAllowed(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return hostAllowed(u.host);
  } catch {
    return false;
  }
}
