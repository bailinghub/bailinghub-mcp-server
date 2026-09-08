import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDispatchEnvironment, validateRegistryRetry } from '../scripts/check-registry-retry.mjs';

const sha = 'a'.repeat(40);
const metadataSha = 'b'.repeat(40);
function fixture() {
  const pkg = { name: 'bailinghub-mcp-server', version: '0.4.0', mcpName: 'io.github.bailinghub/bailinghub-governance' };
  const descriptor = { name: pkg.mcpName, version: pkg.version, description: 'A concise description.', packages: [{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' }, environmentVariables: [{ name: 'BAILINGHUB_CLIENT_TOKEN', isRequired: true, isSecret: true }] }] };
  return { tag: 'v0.4.0', tagCommit: sha, metadataCommit: metadataSha, packageJson: structuredClone(pkg), taggedPackage: structuredClone(pkg), serverJson: structuredClone(descriptor), taggedServer: { ...structuredClone(descriptor), description: 'Previous long description. '.repeat(8) }, npmMetadata: { ...pkg, gitHead: sha, dist: { integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), tarball: 'https://registry.npmjs.org/bailinghub-mcp-server/-/bailinghub-mcp-server-0.4.0.tgz' } } };
}

test('Registry retry preserves original npm source while allowing only a shorter description', () => {
  const result = validateRegistryRetry(fixture());
  assert.equal(result.status, 'PASS');
  assert.equal(result.npm_source_commit, sha);
  assert.equal(result.metadata_commit, metadataSha);
});

test('Registry retry rejects version, package, server and environment changes', () => {
  const mutations = [
    (f) => { f.tag = 'v0.4.1'; },
    (f) => { f.packageJson.version = '0.4.1'; },
    (f) => { f.serverJson.version = '0.4.1'; },
    (f) => { f.serverJson.packages[0].identifier = 'another-package'; },
    (f) => { f.serverJson.packages[0].version = '0.4.1'; },
    (f) => { f.serverJson.packages[0].environmentVariables[0].isRequired = false; },
    (f) => { f.serverJson.packages[0].environmentVariables.push({ name: 'UNEXPECTED' }); },
    (f) => { f.serverJson.title = 'Another title'; },
    (f) => { f.serverJson.remotes = [{ url: 'https://example.com' }]; },
    (f) => { f.npmMetadata.gitHead = metadataSha; },
    (f) => { delete f.npmMetadata.gitHead; },
    (f) => { f.npmMetadata.dist.integrity = 'sha512-AA=='; },
    (f) => { f.npmMetadata.dist.tarball = 'https://example.com/package.tgz'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateRegistryRetry(f));
  }
});

test('Registry retry rejects blank and overlength descriptions', () => {
  for (const description of ['', '  ', 'a'.repeat(101), null]) {
    const f = fixture(); f.serverJson.description = description;
    assert.throws(() => validateRegistryRetry(f));
  }
});

test('Registry dispatch requires main and an exact checkout of the dispatch commit', () => {
  const environment = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'bailinghub/bailinghub-mcp-server', GITHUB_SHA: metadataSha };
  validateDispatchEnvironment(environment, metadataSha);
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_REPOSITORY: 'example/fork' }, { GITHUB_SHA: sha }]) {
    assert.throws(() => validateDispatchEnvironment({ ...environment, ...patch }, metadataSha));
  }
});
