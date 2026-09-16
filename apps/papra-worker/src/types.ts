import type { Hono } from 'hono';
import type { ImageProcessorContainer } from '../native/container';
import type { MetadataBackupParams } from './backup-workflow';

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  BACKUPS: R2Bucket;
  JOBS: Queue;
  AI: Ai;
  INDEX: VectorizeIndex;
  PROCESSOR: DurableObjectNamespace<ImageProcessorContainer>;
  ASSETS: Fetcher;
  BACKUP_WORKFLOW: Workflow<MetadataBackupParams>;
  SHARE_PASSWORD_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_URL: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  VERSION: string;
  SOURCE_SHA: string;
};
export type Identity = {
  userId: string;
  email: string;
  name: string;
  image?: string;
  isOwner: boolean;
  organizations: { id: string; name: string; role: string }[];
  session: { id: string; expiresAt: Date };
  serviceScope?: { organizationId: string; folderId: string; permissions: string[] };
};
export type AppEnv = { Bindings: Env; Variables: { identity: Identity } };
export type App = Hono<AppEnv>;
