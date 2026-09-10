import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Descriptive data supplied by the authorizing business, never an identity or instruction. */
export type AgentSubjectDisplay = { name: string };
export type AgentSubjectDisplayStatus = 'provided' | 'missing' | 'unsupported' | 'unavailable';
export type AgentSubjectDisplayView = {
  subjectDisplay: AgentSubjectDisplay | null;
  subjectDisplayStatus: AgentSubjectDisplayStatus;
};
export type AgentSubjectDisplayBinding = {
  connectionKey: string; baseUrl: string; clientAppId: string; workspace: string; sessionId: string;
};

/** An optional display field cannot turn successful authorization into a failed login. */
export function parseAgentSubjectDisplay(record: Record<string, unknown>): AgentSubjectDisplayView {
  const value = record.subject_display;
  const status = record.subject_display_status;
  if (value === undefined && status === undefined) {
    return { subjectDisplay: null, subjectDisplayStatus: 'unsupported' };
  }
  if (status === 'missing' && value === null) return { subjectDisplay: null, subjectDisplayStatus: 'missing' };
  if (status === 'provided' && value && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>).name;
    if (Object.keys(value).length === 1 && typeof name === 'string' && name.trim() && name.trim().length <= 120 &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name) && !/[\uD800-\uDFFF]/u.test(name)) {
      return { subjectDisplay: { name: name.trim() }, subjectDisplayStatus: 'provided' };
    }
  }
  return { subjectDisplay: null, subjectDisplayStatus: 'unavailable' };
}

type CachedDisplay = AgentSubjectDisplayView & { subjectDisplayCachedAt: string };

/** Public display data is separate from both credentials and the backwards-compatible registry. */
export class AgentSubjectDisplayCache {
  readonly directory: string;
  constructor(registryPath: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.directory = `${registryPath}.subject-display`;
  }

  private path(binding: AgentSubjectDisplayBinding): string {
    const digest = createHash('sha256').update(JSON.stringify([
      binding.connectionKey, binding.baseUrl, binding.clientAppId, binding.workspace, binding.sessionId,
    ])).digest('hex');
    return join(this.directory, `${digest}.json`);
  }

  async load(binding: AgentSubjectDisplayBinding): Promise<CachedDisplay | undefined> {
    const path = this.path(binding);
    let metadata;
    try { metadata = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not read authorization display cache.');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096 ||
        (this.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) ||
        (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error('Authorization display cache is not secure.');
    }
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!record || record.schema_version !== 1 ||
        JSON.stringify(record.binding) !== JSON.stringify(binding) ||
        typeof record.cached_at !== 'string' || !Number.isFinite(Date.parse(record.cached_at))) {
      throw new Error('Authorization display cache has an invalid binding.');
    }
    const parsed = record.subject_display_status === 'unsupported' && record.subject_display === null
      ? { subjectDisplay: null, subjectDisplayStatus: 'unsupported' as const }
      : parseAgentSubjectDisplay(record);
    if (parsed.subjectDisplayStatus === 'unavailable') throw new Error('Authorization display cache is invalid.');
    return { ...parsed, subjectDisplayCachedAt: record.cached_at };
  }

  async save(binding: AgentSubjectDisplayBinding, display: AgentSubjectDisplayView, now: number): Promise<void> {
    if (display.subjectDisplayStatus === 'unavailable') return;
    const record = {
      schema_version: 1, binding: {
        connectionKey: binding.connectionKey, baseUrl: binding.baseUrl, clientAppId: binding.clientAppId,
        workspace: binding.workspace, sessionId: binding.sessionId,
      },
      subject_display: display.subjectDisplay ? { name: display.subjectDisplay.name } : null,
      subject_display_status: display.subjectDisplayStatus,
      cached_at: new Date(now).toISOString(),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error('Authorization display cache directory is not secure.');
    }
    if (this.platform !== 'win32') await chmod(this.directory, 0o700);
    const temporaryPath = join(this.directory, `.display-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, this.path(binding));
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
