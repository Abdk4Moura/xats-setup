import { isIP } from 'node:net';

export const XATS_MDNS_TYPE = 'xats-peer';
export const XATS_PEER_PROTOCOL_VERSION = '1';
const DEVICE_ID_RE = /^[a-f0-9]{32}$/;

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function candidateEndpoints(service, ownDeviceId, now) {
  if (!service || service.type !== XATS_MDNS_TYPE || service.protocol && service.protocol !== 'tcp') return [];
  if (!validPort(service.port)) return [];
  const txt = service.txt && typeof service.txt === 'object' ? service.txt : {};
  const deviceId = txt.xats_id;
  if (txt.xats_v !== XATS_PEER_PROTOCOL_VERSION || !DEVICE_ID_RE.test(deviceId) || deviceId === ownDeviceId) return [];
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  const seen = new Set();
  const result = [];
  for (const host of addresses) {
    if (typeof host !== 'string' || !isIP(host) || host === '127.0.0.1' || host === '::1' || seen.has(host)) continue;
    seen.add(host);
    result.push({
      deviceId,
      endpoint: { host, port: service.port },
      serviceName: typeof service.name === 'string' ? service.name : '',
      protocolVersion: XATS_PEER_PROTOCOL_VERSION,
      discoveredAt: now,
    });
  }
  return result;
}

// Registers candidate-only mDNS discovery. Advertisements expose only a public
// instance id/version and the peer service port; neither credentials nor rosters
// are included. This function does not connect to, trust, or pair any candidate.
export function attachXatsMdns({ bonjour, deviceId, port, onCandidate, onLost = () => {}, onError = () => {}, now = () => Date.now() }) {
  if (!bonjour || typeof bonjour.publish !== 'function' || typeof bonjour.find !== 'function') throw new TypeError('bonjour_instance_required');
  if (!DEVICE_ID_RE.test(deviceId)) throw new TypeError('invalid_device_id');
  if (!validPort(port)) throw new TypeError('invalid_peer_port');
  if (typeof onCandidate !== 'function') throw new TypeError('onCandidate_required');

  const found = new Map();
  const browser = bonjour.find({ type: XATS_MDNS_TYPE });
  const handleUp = (service) => {
    for (const candidate of candidateEndpoints(service, deviceId, now())) {
      const key = `${candidate.deviceId}|${candidate.endpoint.host}|${candidate.endpoint.port}`;
      found.set(key, candidate);
      onCandidate({ ...candidate, endpoint: { ...candidate.endpoint } });
    }
  };
  const handleDown = (service) => {
    const txt = service?.txt && typeof service.txt === 'object' ? service.txt : {};
    const device = txt.xats_id;
    if (!DEVICE_ID_RE.test(device) || device === deviceId) return;
    for (const [key, candidate] of found) {
      if (candidate.deviceId === device && (!service.name || candidate.serviceName === service.name)) {
        found.delete(key);
        onLost({ ...candidate, endpoint: { ...candidate.endpoint } });
      }
    }
  };
  browser.on('up', handleUp);
  browser.on('down', handleDown);
  browser.on('error', onError);

  const service = bonjour.publish({
    name: `xats-${deviceId}`,
    type: XATS_MDNS_TYPE,
    protocol: 'tcp',
    port,
    txt: { xats_v: XATS_PEER_PROTOCOL_VERSION, xats_id: deviceId },
  });
  service.on?.('error', onError);

  let closed = false;
  return {
    candidates: () => [...found.values()].map((candidate) => ({ ...candidate, endpoint: { ...candidate.endpoint } })),
    close: async () => {
      if (closed) return;
      closed = true;
      browser.removeListener?.('up', handleUp);
      browser.removeListener?.('down', handleDown);
      browser.removeListener?.('error', onError);
      browser.stop?.();
      await new Promise((resolve) => {
        if (typeof service.stop !== 'function') return resolve();
        try { service.stop(resolve); } catch { resolve(); }
      });
      await new Promise((resolve) => {
        if (typeof bonjour.destroy !== 'function') return resolve();
        try { bonjour.destroy(resolve); } catch { resolve(); }
      });
    },
  };
}

export async function startXatsMdns(options) {
  const imported = await import('bonjour-service');
  const Bonjour = imported.default ?? imported.Bonjour;
  if (typeof Bonjour !== 'function') throw new Error('bonjour_service_unavailable');
  const bonjour = new Bonjour({}, (error) => options.onError?.(error));
  try {
    return attachXatsMdns({ ...options, bonjour });
  } catch (error) {
    bonjour.destroy?.();
    throw error;
  }
}
