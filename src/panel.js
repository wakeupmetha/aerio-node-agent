// Heartbeat client — the agent's side of the pairing.
//
// Every HEARTBEAT_MS (and right after a speedtest or geocheck run) the agent
// POSTs its identity and latest results to the panel with its per-node
// TOKEN. The reply names the node the panel resolved the token to and carries
// any commands queued there ("speedtest", "geocheck"). Geocheck snapshots
// in the durable outbox remain until the core explicitly acknowledges them.
//
// Logging is on TRANSITIONS, so a dead panel is one WARN and one INFO on
// recovery — not a line every 30 s — while a rejected token, the one failure
// the operator has to act on, repeats every 10 minutes at ERROR.

import { USER_AGENT } from './client.js';

const REJECTED_REPEAT_MS = 10 * 60_000;

export function createPanelClient({
  url,
  token,
  log,
  state,
  onCommand,
  onDeliveryAck = async () => {},
  pendingDeliveries = () => 0,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  heartbeatMs: heartbeatMsHint = 30_000,
  retryBaseMs = 5_000,
  now = Date.now,
}) {
  const endpoint = new URL('/api/agent/heartbeat', url).toString();

  let paired = false;
  let node = null;
  let lastOkAt = null;
  let lastError = null;
  let lastErrorKind = null;
  let lastErrorLoggedAt = 0;
  let failingSince = null;
  let mismatchWarnedFor = null;
  let inflight = false;
  let pendingBeat = false;
  let retryTimer = null;
  let retryMs = 0;
  let stopped = false;
  let unacknowledgedWarned = false;

  function schedule(ms) {
    if (stopped) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; void beat(); }, ms);
    retryTimer.unref?.();
  }

  async function beat() {
    if (stopped) return;
    // A result arriving during an in-flight heartbeat needs its own beat.
    if (inflight) { pendingBeat = true; return; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    inflight = true;
    let ok = false;
    let acknowledged = false;
    const t0 = now();
    try {
      const body = state();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      let text;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
        });
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      let reply = null;
      try { reply = JSON.parse(text); } catch { /* non-JSON reply */ }

      if (res.status === 401) {
        fail('rejected', 'token rejected by panel — regenerate it on /nodes and restart the agent', {
          status: 401, hint: reply?.hint,
        });
        return;
      }
      if (!res.ok || !reply?.ok) {
        fail('http', `panel answered ${res.status}`, { status: res.status, body: text.slice(0, 120) });
        return;
      }

      const rtt = now() - t0;
      lastOkAt = new Date(now()).toISOString();
      lastError = null;
      if (!paired || node !== reply.node) {
        log.info(`paired as "${reply.node}"`, {
          url,
          rtt,
          ...(failingSince ? { after: `${Math.round((now() - failingSince) / 1000)}s` } : {}),
        });
      }
      paired = true;
      node = reply.node;
      failingSince = null;
      lastErrorKind = null;

      const reportedIp = body.node?.ip ?? null;
      if (reply.expectedIp && reportedIp && reply.expectedIp !== reportedIp && mismatchWarnedFor !== reply.expectedIp) {
        log.warn('node address mismatch — is this token for this node?', {
          reported: reportedIp, panelExpects: reply.expectedIp,
        });
        mismatchWarnedFor = reply.expectedIp;
      }

      for (const cmd of reply.commands ?? []) {
        log.info('command received', { cmd });
        Promise.resolve().then(() => onCommand(cmd)).catch((e) => log.warn('command failed', { cmd, err: e }));
      }
      if (body.delivery?.id && reply.deliveryAck === body.delivery.id) {
        await onDeliveryAck(body.delivery.id);
        acknowledged = true;
        unacknowledgedWarned = false;
      } else if (body.delivery?.id && !unacknowledgedWarned) {
        log.warn('gateway did not acknowledge geocheck delivery; keeping the queue', { pending: pendingDeliveries() });
        unacknowledgedWarned = true;
      }
      ok = true;
      retryMs = 0;
    } catch (e) {
      // undici wraps the socket error: "fetch failed" with cause.code
      // ECONNREFUSED / ENOTFOUND / CERT_HAS_EXPIRED — the part worth reading.
      const msg = e?.name === 'AbortError'
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : [e?.message || String(e), e?.cause?.code].filter(Boolean).join(': ');
      fail('unreachable', 'unreachable', { err: msg, next: `${Math.round(heartbeatMsHint / 1000)}s` });
    } finally {
      inflight = false;
      if (!ok) {
        const cap = Math.max(5_000, heartbeatMsHint);
        retryMs = Math.min(cap, retryMs ? retryMs * 2 : retryBaseMs);
        pendingBeat = false;
        schedule(Math.min(cap, Math.round(retryMs * (0.8 + Math.random() * 0.4))));
      } else if (pendingBeat || (acknowledged && pendingDeliveries() > 0)) {
        pendingBeat = false;
        schedule(0);
      }
    }
  }

  function fail(kind, msg, fields) {
    const first = lastErrorKind !== kind;
    if (first) failingSince = now();
    lastError = fields?.err ? `${msg}: ${fields.err}` : msg;
    paired = false;
    const level = kind === 'rejected' ? 'error' : 'warn';
    const repeat = kind === 'rejected' && now() - lastErrorLoggedAt >= REJECTED_REPEAT_MS;
    if (first || repeat) {
      log[level](msg, fields);
      lastErrorLoggedAt = now();
    } else {
      log.debug(msg, fields);
    }
    lastErrorKind = kind;
  }

  return {
    beat,
    stop: () => { stopped = true; if (retryTimer) clearTimeout(retryTimer); retryTimer = null; },
    status: () => ({ url, paired, node, lastOkAt, lastError, pendingDeliveries: pendingDeliveries() }),
  };
}
