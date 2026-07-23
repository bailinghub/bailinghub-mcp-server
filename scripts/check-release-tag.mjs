import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const tag = String(process.env.GITHUB_REF_NAME ?? '').replace(/^v/, '');

if (!tag) {
  throw new Error('GITHUB_REF_NAME is required.');
}
if (tag !== packageJson.version) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
}

console.log(`Release tag ${tag} matches package.json.`);
