import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

const packageJson = await readJson('package.json');
const packageLock = await readJson('package-lock.json');
const serverJson = await readJson('server.json');
const compatibility = await readJson('compatibility/client-api.json');
const sourceVersion = await readFile(resolve(root, 'src/version.ts'), 'utf8');
const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const stableVersion = /^\d+\.\d+\.\d+$/;
const candidateVersion = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
const privateCandidate = packageJson.private === true && candidateVersion.test(packageJson.version);
check(
  stableVersion.test(packageJson.version) || privateCandidate,
  'package version must be stable semantic or an explicitly private prerelease candidate',
);
check(
  privateCandidate || packageJson.private === false,
  'stable packages must set private to false',
);
check(
  packageJson.publishConfig?.access === 'public' &&
    packageJson.publishConfig?.provenance === true,
  'public npm access and provenance must remain enabled',
);
check(
  sourceVersion.includes(`PACKAGE_VERSION = '${packageJson.version}'`),
  'src/version.ts must match package.json',
);
check(
  packageLock.version === packageJson.version &&
    packageLock.packages?.['']?.version === packageJson.version,
  'package-lock.json root versions must match package.json',
);
check(
  changelog.includes(`## ${packageJson.version} `),
  'CHANGELOG.md must contain the package version',
);
check(
  privateCandidate ? stableVersion.test(serverJson.version) : serverJson.version === packageJson.version,
  privateCandidate
    ? 'private candidates must retain a stable public server.json version'
    : 'server.json version must match package.json',
);
check(
  privateCandidate
    ? compatibility.adapter_version === serverJson.version
    : compatibility.adapter_version === packageJson.version,
  privateCandidate
    ? 'private candidates must retain the published Client API compatibility version'
    : 'compatibility adapter_version must match package.json',
);
check(serverJson.name === packageJson.mcpName, 'server.json name must match package mcpName');
check(
  serverJson.name.startsWith('io.github.bailinghub/'),
  'server name must use the BailingHub GitHub namespace',
);
check(serverJson.packages?.length === 1, 'server.json must contain one package');

const registryPackage = serverJson.packages?.[0] ?? {};
check(registryPackage.registryType === 'npm', 'registry package must use npm');
check(registryPackage.identifier === packageJson.name, 'registry identifier must match package name');
check(
  registryPackage.version === (privateCandidate ? serverJson.version : packageJson.version),
  'registry package version must match the public server descriptor',
);
check(registryPackage.transport?.type === 'stdio', 'registry transport must be stdio');

const environmentVariables = registryPackage.environmentVariables ?? [];
const environmentNames = environmentVariables.map((item) => item.name).sort();
check(
  JSON.stringify(environmentNames) ===
    JSON.stringify(
      [
        'BAILINGHUB_ALLOW_INSECURE_HTTP',
        'BAILINGHUB_BASE_URL',
        'BAILINGHUB_CLIENT_TOKEN',
        'BAILINGHUB_ROUTE',
      ].sort(),
    ),
  'server.json environment variable set changed unexpectedly',
);
check(
  environmentVariables.find((item) => item.name === 'BAILINGHUB_CLIENT_TOKEN')?.isSecret ===
    true,
  'Client Token must be marked secret',
);
check(
  packageJson.repository?.url ===
    'git+https://github.com/bailinghub/bailinghub-mcp-server.git',
  'package repository URL is incorrect',
);
check(
  serverJson.repository?.url === 'https://github.com/bailinghub/bailinghub-mcp-server',
  'server repository URL is incorrect',
);

for (const path of [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'SECURITY.md',
  'PRIVACY.md',
  'CHANGELOG.md',
  'docs/AGENT_CLIENT_SDK.md',
  'docs/AGENT_CLIENT_SDK.zh-CN.md',
  'docs/COMPATIBILITY.md',
  'docs/PROJECT_BOUNDARIES.md',
  'docs/THREAT_MODEL.md',
  'compatibility/client-api.json',
  'server.json',
]) {
  try {
    await access(resolve(root, path));
  } catch {
    failures.push(`required file is missing: ${path}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Project checks failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `PASS: ${packageJson.name} ${packageJson.version} metadata and project boundaries are aligned.`,
);
