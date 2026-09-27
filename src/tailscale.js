import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const TAILSCALE_CLI = '/usr/local/bin/tailscale';

/**
 * Inspect Tailscale daemon and serve configuration.
 */
export async function getTailscaleStatus() {
  const result = {
    available: false,
    running: false,
    dnsName: null,
    ips: [],
    peersCount: 0,
    serve: {
      active: false,
      url: null,
      funnel: false,
      target: null
    }
  };

  try {
    const { stdout: statusOut } = await execFileAsync(TAILSCALE_CLI, ['status', '--json'], { timeout: 3000 });
    const statusData = JSON.parse(statusOut || '{}');
    result.available = true;
    result.running = statusData.BackendState === 'Running';
    result.dnsName = (statusData.Self?.DNSName || '').replace(/\.$/, '') || null;
    result.ips = statusData.Self?.TailscaleIPs || [];
    result.peersCount = Object.keys(statusData.Peer || {}).length;

    if (result.running && result.dnsName) {
      try {
        const { stdout: serveOut } = await execFileAsync(TAILSCALE_CLI, ['serve', 'status', '--json'], { timeout: 3000 });
        const serveData = JSON.parse(serveOut || '{}');
        const webHandlers = serveData.Web || {};
        const hostKey = Object.keys(webHandlers).find((k) => k.startsWith(result.dnsName));
        if (hostKey) {
          const handler = webHandlers[hostKey]?.Handlers?.['/'] || {};
          const isFunnel = !!serveData.AllowFunnel?.[hostKey];
          result.serve = {
            active: true,
            url: `https://${result.dnsName}`,
            funnel: isFunnel,
            target: handler.Proxy || null
          };
        }
      } catch {
        // Serve not configured or errored
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      result.error = err.message;
    }
  }

  return result;
}

/**
 * Configure Tailscale Serve (private Tailnet) or Funnel (public HTTPS).
 */
export async function setTailscaleServe(targetPort = 8045, { funnel = false } = {}) {
  const cmd = funnel ? 'funnel' : 'serve';
  try {
    const { stdout } = await execFileAsync(TAILSCALE_CLI, [cmd, '--bg', String(targetPort)], { timeout: 8000 });
    return { ok: true, output: stdout.trim(), funnel };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Reset Tailscale Serve / Funnel mappings.
 */
export async function resetTailscaleServe() {
  try {
    const { stdout } = await execFileAsync(TAILSCALE_CLI, ['serve', 'reset'], { timeout: 5000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
