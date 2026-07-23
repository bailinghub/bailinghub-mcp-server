import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const contractArg = process.argv.indexOf('--contract-dir');
if (contractArg < 0 || !process.argv[contractArg + 1]) {
  throw new Error('--contract-dir is required');
}
const contractDir = resolve(process.argv[contractArg + 1]);

function readJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function semanticVersion(value) {
  const parts = String(value).split('.');
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`invalid semantic version: ${value}`);
  }
  return parts.map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function schemaFields(schema, key) {
  const value = schema[key] ?? (key === 'required' ? [] : undefined);
  if (key === 'required') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('schema required must be an array of strings');
    }
    return new Set(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('schema properties must be an object');
  }
  return new Set(Object.keys(value));
}

function propertyMaxLength(schema, field) {
  const maximum = schema.properties?.[field]?.maxLength;
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error(`${field} must declare a positive maxLength`);
  }
  return maximum;
}

const declaration = readJson(resolve(root, 'compatibility/client-api.json'));
const manifest = readJson(resolve(contractDir, 'manifest.json'));
const packageJson = readJson(resolve(root, 'package.json'));
const vectors = readJson(resolve(contractDir, manifest.vectors ?? 'vectors.json'));

if (manifest.contract !== declaration.contract) {
  throw new Error('contract id does not match the adapter declaration');
}
if (manifest.major !== declaration.contract_major) {
  throw new Error('Client API major version is incompatible');
}
const currentVersion = semanticVersion(manifest.version);
const testedVersion = semanticVersion(declaration.tested_contract_version);
if (
  currentVersion[0] !== testedVersion[0] ||
  compareVersions(currentVersion, testedVersion) < 0
) {
  throw new Error('current Client API version predates the adapter compatibility floor');
}
if (declaration.adapter_version !== packageJson.version) {
  throw new Error('adapter_version must match package.json');
}

const endpoints = new Map();
for (const endpoint of manifest.endpoints ?? []) {
  if (!endpoint || typeof endpoint.id !== 'string') {
    throw new Error('every manifest endpoint must have an id');
  }
  endpoints.set(endpoint.id, endpoint);
}

for (const [endpointId, claim] of Object.entries(declaration.endpoint_contracts ?? {})) {
  const endpoint = endpoints.get(endpointId);
  if (!endpoint || !claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error(`missing required endpoint: ${endpointId}`);
  }
  for (const key of ['method', 'path', 'authentication']) {
    if (claim[key] !== endpoint[key]) {
      throw new Error(
        `${endpointId}: ${key} changed from ${JSON.stringify(claim[key])} ` +
          `to ${JSON.stringify(endpoint[key])}`,
      );
    }
  }
}

for (const [endpointId, claim] of Object.entries(declaration.requests ?? {})) {
  const endpoint = endpoints.get(endpointId);
  const schema = readJson(resolve(contractDir, endpoint.request_schema));
  const sent = new Set(claim.fields_sent ?? []);
  const required = schemaFields(schema, 'required');
  const properties = schemaFields(schema, 'properties');
  const missing = [...required].filter((field) => !sent.has(field));
  const unknown = [...sent].filter((field) => !properties.has(field));
  if (missing.length) throw new Error(`${endpointId}: adapter omits ${missing.join(', ')}`);
  if (unknown.length) throw new Error(`${endpointId}: adapter sends unknown ${unknown.join(', ')}`);
}

const runRequest = readJson(
  resolve(contractDir, endpoints.get('run.submit').request_schema),
);
for (const [limitName, field] of [
  ['request_id_max_length', 'request_id'],
  ['route_max_length', 'route'],
  ['input_max_length', 'input'],
]) {
  const adapterLimit = declaration.limits?.[limitName];
  const contractLimit = propertyMaxLength(runRequest, field);
  if (!Number.isInteger(adapterLimit) || adapterLimit < 1) {
    throw new Error(`${limitName} must be a positive integer`);
  }
  if (adapterLimit > contractLimit) {
    throw new Error(
      `${limitName} allows ${adapterLimit}, above contract maximum ${contractLimit}`,
    );
  }
}

for (const [endpointId, claim] of Object.entries(declaration.responses ?? {})) {
  const endpoint = endpoints.get(endpointId);
  const schema = readJson(resolve(contractDir, endpoint.response_schema));
  const guaranteed = schemaFields(schema, 'required');
  const missing = (claim.required_fields ?? []).filter((field) => !guaranteed.has(field));
  if (missing.length) {
    throw new Error(`${endpointId}: contract no longer guarantees ${missing.join(', ')}`);
  }
}

if (
  JSON.stringify(declaration.known_job_statuses) !==
  JSON.stringify(manifest.job_statuses?.known)
) {
  throw new Error('adapter known statuses differ from the Client API contract');
}
if (
  JSON.stringify(declaration.terminal_job_statuses) !==
  JSON.stringify(manifest.job_statuses?.terminal)
) {
  throw new Error('adapter terminal statuses differ from the Client API contract');
}

const handledErrors = new Set(declaration.handled_http_errors ?? []);
const missingErrors = Object.keys(manifest.http_errors ?? {})
  .map(Number)
  .filter((status) => !handledErrors.has(status));
if (missingErrors.length) {
  throw new Error(`adapter does not classify HTTP errors ${missingErrors.join(', ')}`);
}

if (!Array.isArray(vectors.cases) || vectors.cases.length === 0) {
  throw new Error('Client API vectors must contain cases');
}
for (const vector of vectors.cases) {
  if (typeof vector.schema !== 'string') throw new Error('vector schema must be a string');
  readFileSync(resolve(contractDir, vector.schema));
}

console.log(
  `PASS: ${declaration.consumer} ${declaration.adapter_version} ` +
    `accepts ${manifest.contract} ${manifest.version}`,
);
