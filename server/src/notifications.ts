import { connect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listHosts } from "./repo.ts";
import { getSettings } from "./db.ts";
import { CERT_DIR } from "./certs.ts";

/** A plain-language heads-up shown in the app's notification banner. */
export interface AppNotification {
  id: string; // stable per condition, so the UI can de-dupe / remember dismissals
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  dismissible: boolean;
}

const IS_PROD = process.env.NODE_ENV === "production";

/** Quick TCP liveness probe for a local port (is something listening?). */
function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

const list = (names: string[]) => names.join(", ");

/**
 * Compute the current actionable notifications. `isManager` (admin/editor) unlocks
 * the operational/security notices that only they can act on; everyone sees
 * service-reachability problems.
 */
export async function buildNotifications(opts: { isManager: boolean }): Promise<AppNotification[]> {
  const out: AppNotification[] = [];
  const enabled = listHosts().filter((h) => h.enabled);

  // 1. Is the data plane actually listening? (prod only - dev has no bundled nginx)
  if (IS_PROD) {
    const [http, https] = await Promise.all([portOpen(80), portOpen(443)]);
    if (!http || !https) {
      const ports = !http && !https ? "80 or 443" : !http ? "80" : "443";
      out.push({
        id: "dataplane-down",
        severity: "critical",
        title: "The proxy isn't accepting connections",
        message:
          `Nothing is listening on port ${ports} on this machine, so your services aren't being served. ` +
          `Check the container logs - if you've forwarded these ports on your router, the forwarding is fine; ` +
          `the proxy itself needs to come back up.`,
        dismissible: false,
      });
    } else if (enabled.length) {
      // Up locally, but we can't see the internet from in here - remind about forwarding.
      out.push({
        id: "port-forward-reminder",
        severity: "info",
        title: "Reachable from the internet?",
        message:
          "The proxy is serving on ports 80 and 443 here. For your services to be reachable from outside your " +
          "network, your router/gateway must forward external ports 80 and 443 to NginUX's HTTP/HTTPS ports on " +
          "this machine. (Keep the control plane on :4600 on your LAN - never forward it.)",
        dismissible: true,
      });
    }
  }

  // 2. Services NginUX can't reach (offline, or wrong forward address/port).
  const down = enabled.filter((h) => h.health === "down");
  if (down.length) {
    out.push({
      id: "services-down:" + down.map((h) => h.id).sort().join(","),
      severity: "warning",
      title: down.length === 1 ? `Can't reach ${down[0].name}` : `Can't reach ${down.length} services`,
      message:
        `${list(down.map((h) => h.name))} ${down.length === 1 ? "isn't" : "aren't"} responding. ` +
        "The app may be offline, or the forward address/port may be wrong.",
      dismissible: true,
    });
  }

  if (!opts.isManager) return out;

  // 3. Temporary self-signed cert in use → visitors get a browser warning.
  const selfSigned = enabled.filter(
    (h) => h.ssl && (h.protocol === "http" || h.protocol === "grpc") && !existsSync(join(CERT_DIR, h.domain, "fullchain.pem")),
  );
  if (selfSigned.length) {
    out.push({
      id: "bootstrap-cert:" + selfSigned.map((h) => h.id).sort().join(","),
      severity: "warning",
      title: `${selfSigned.length} service${selfSigned.length > 1 ? "s" : ""} on a temporary certificate`,
      message:
        `${list(selfSigned.map((h) => h.name))} ${selfSigned.length === 1 ? "is" : "are"} served with a self-signed ` +
        "certificate, so visitors see a browser security warning. Issue a free Let's Encrypt certificate from the Certificates page.",
      dismissible: true,
    });
  }

  // 4a. Login-gated hosts but no sign-in URL → visitors get a bare 401, no way in.
  if (!getSettings().ssoLoginUrl && enabled.some((h) => h.requireLogin)) {
    out.push({
      id: "sso-login-url-missing",
      severity: "warning",
      title: "Login-gated services can't sign anyone in",
      message:
        "Some services require NginUX login, but no sign-in URL is configured - so visitors get a blank 401 with " +
        "no way to log in. Set it in Settings → Login gate (expose NginUX on a subdomain of your base domain).",
      dismissible: true,
    });
  }

  // 4b. Login-gated hosts without a forward secret set (auto-seeded on boot, but
  //     an admin can clear it - warn if they have, since the gate is then weaker).
  if (!getSettings().ssoForwardSecret && enabled.some((h) => h.requireLogin)) {
    out.push({
      id: "forward-secret-missing",
      severity: "warning",
      title: "Login gate isn't fully secured",
      message:
        "Some services require login, but no forward-auth secret is set. Add one under Settings → Login gate " +
        "(click Generate) so the login check can't be called directly and bypassed.",
      dismissible: true,
    });
  }

  // 5. Expiring / expired certificates.
  const now = Date.now();
  const expiring = enabled.filter(
    (h) => h.certExpiresAt && Date.parse(h.certExpiresAt) - now < 14 * 86400_000,
  );
  if (expiring.length) {
    const expired = expiring.filter((h) => Date.parse(h.certExpiresAt!) < now);
    out.push({
      id: "cert-expiring:" + expiring.map((h) => h.id).sort().join(","),
      severity: expired.length ? "critical" : "warning",
      title: expired.length
        ? `${expired.length} certificate${expired.length > 1 ? "s" : ""} expired`
        : `${expiring.length} certificate${expiring.length > 1 ? "s" : ""} expiring soon`,
      message:
        `${list(expiring.map((h) => h.name))} - renew from the Certificates page. ` +
        "(Let's Encrypt certificates auto-renew; self-signed ones don't.)",
      dismissible: true,
    });
  }

  return out;
}
