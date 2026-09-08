import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RETRY_TAG = 'v0.4.0';
const VERSION = '0.4.0';
const PACKAGE = 'bailinghub-mcp-server';
const REPOSITORY = 'bailinghub/bailinghub-mcp-server';
const SERVER = 'io.github.bailinghub/bailinghub-governance';

export function validateRegistryRetry({ tag, tagCommit, metadataCommit, packageJson, taggedPackage, serverJson, taggedServer, npmMetadata }) {
  assert.equal(tag, RETRY_TAG, 'this retry is restricted to v0.4.0');
  assert.match(tagCommit, /^[a-f0-9]{40}$/, 'release commit must be exact');
  assert.match(metadataCommit, /^[a-f0-9]{40}$/, 'metadata commit must be exact');
  for (const pkg of [packageJson, taggedPackage, npmMetadata]) {
    assert.equal(pkg.name, PACKAGE, 'package identity changed');
    assert.equal(pkg.version, VERSION, 'package version changed');
    assert.equal(pkg.mcpName, SERVER, 'MCP package identity changed');
  }
  assert.equal(serverJson.name, SERVER, 'Registry server identity changed');
  assert.equal(serverJson.version, VERSION, 'Registry version changed');
  assert.equal(typeof serverJson.description, 'string', 'description must be text');
  assert(serverJson.description.trim().length > 0, 'description must not be blank');
  assert(Array.from(serverJson.description).length <= 100, 'description must not exceed 100 characters');
  const { description: currentDescription, ...currentIdentity } = serverJson;
  const { description: originalDescription, ...taggedIdentity } = taggedServer;
  assert.deepEqual(currentIdentity, taggedIdentity, 'only description may differ from the published Tag');
  assert.equal(npmMetadata.gitHead, tagCommit, 'npm source must match the published Tag');
  assert.match(npmMetadata.dist?.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'npm integrity must use sha512');
  assert.equal(Buffer.from(npmMetadata.dist.integrity.slice(7), 'base64').length, 64, 'npm sha512 digest must be complete');
  assert.equal(npmMetadata.dist.tarball, `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${VERSION}.tgz`, 'npm artifact URL changed');
  return {
    schema: 'bailing.registry-metadata-check.v1', status: 'PASS',
    tag, package: PACKAGE, version: VERSION, server: SERVER,
    npm_source_commit: tagCommit, metadata_commit: metadataCommit,
    allowed_change: 'description', description: currentDescription,
    original_description: originalDescription,
    descriptor_sha256: createHash('sha256').update(JSON.stringify(serverJson)).digest('hex'),
    npm_integrity: npmMetadata.dist.integrity,
  };
}

export function validateDispatchEnvironment(environment, metadataCommit) {
  assert.equal(environment.GITHUB_EVENT_NAME, 'workflow_dispatch', 'manual Registry dispatch required');
  assert.equal(environment.GITHUB_REF, 'refs/heads/main', 'Registry dispatch must use main');
  assert.equal(environment.GITHUB_REPOSITORY, REPOSITORY, 'Registry dispatch repository changed');
  assert.equal(environment.GITHUB_SHA, metadataCommit, 'checkout must match the exact dispatch SHA');
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const metadataCommit = git('rev-parse', 'HEAD');
  validateDispatchEnvironment(process.env, metadataCommit);
  const tagCommit = git('rev-parse', `${RETRY_TAG}^{commit}`);
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const serverJson = JSON.parse(await readFile(resolve(root, 'server.json'), 'utf8'));
  const taggedPackage = JSON.parse(git('show', `${tagCommit}:package.json`));
  const taggedServer = JSON.parse(git('show', `${tagCommit}:server.json`));
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/${VERSION}`, { signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `published npm metadata unavailable (${response.status})`);
  const npmMetadata = await response.json();
  console.log(JSON.stringify(validateRegistryRetry({ tag: RETRY_TAG, tagCommit, metadataCommit, packageJson, taggedPackage, serverJson, taggedServer, npmMetadata }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
