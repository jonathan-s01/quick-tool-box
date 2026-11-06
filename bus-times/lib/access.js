// Who may use Bus times. Uses the same ALLOWED_NETWORKS setting as Quick Tool Box (set it in .env).
// Without it, private home network ranges and Tailscale are allowed, and nothing from the internet.
import net from 'node:net';

const DEFAULT = '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10,100.64.0.0/10';
const blocks = new net.BlockList();
for (const raw of (process.env.ALLOWED_NETWORKS || DEFAULT).split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = raw.split('/');
  if (!net.isIP(addr)) { console.warn(`ALLOWED_NETWORKS: ignoring ${raw}`); continue; }
  const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
  if (bits == null) blocks.addAddress(addr, type);
  else blocks.addSubnet(addr, Number(bits), type);
}

export function addressAllowed(remote) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(remote || '');
  const a = m ? m[1] : remote || '';
  if (!net.isIP(a)) return false;
  return blocks.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
}
