import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';

// Mirrors the real mutex's scope-to-port mapping. This only chooses synthetic
// fixture paths; it does not replace the production mutex or shorten its wait.
export function operationLockPort(scope) {
  return 10000 + createHash('sha256').update(scope).digest().readUInt32BE(0) % 30000;
}

async function portsAvailable(ports) {
  const listeners = [];
  try {
    for (const port of ports) {
      const server = createServer(socket => socket.destroy());
      listeners.push(server);
      const available = await new Promise((resolve, reject) => {
        server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
      });
      if (!available) return false;
    }
    return true;
  } finally {
    await Promise.all(listeners.filter(server => server.listening)
      .map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}

/** Avoid known occupied loopback ports before a synthetic fixture starts.
 * Callers supply only public registry/file lock scopes, never credential data.
 * This is a probe, not a reservation: the real mutex still fails closed if an
 * unrelated listener appears later. Concurrency inside a fixture is unchanged.
 */
export async function createLockFixtureDirectory(prefix, scopesForDirectory) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const directory = await mkdtemp(prefix);
    let accepted = false;
    try {
      const scopes = [...new Set(scopesForDirectory(directory))];
      if (!scopes.length || scopes.some(scope => typeof scope !== 'string' || !scope)) {
        throw new TypeError('Fixture lock scopes must be nonempty strings');
      }
      const ports = scopes.map(operationLockPort);
      // Distinct nested scopes must not collide with one another either.
      accepted = new Set(ports).size === scopes.length && await portsAvailable(ports);
      if (accepted) return directory;
    } finally {
      if (!accepted) await rm(directory, { recursive: true, force: true });
    }
  }
  throw new Error('Could not allocate an unoccupied synthetic fixture lock scope');
}
