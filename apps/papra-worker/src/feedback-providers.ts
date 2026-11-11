import { error } from './db';
import type { Env } from './types';

export type FeedbackEnv = Env;
export type FeedbackFetch = typeof fetch;

export type FeedbackBug = {
  id: string;
  operation: string;
  status: string;
  generation: number;
  trusted_stage: string | null;
  trusted_status: number | null;
  trusted_signature: string | null;
  server_build: string | null;
};

export const webRepo = 'swyxio/papra';
export const desktopRepo = 'swyxio/smolhuman';
export const repository = (bug: FeedbackBug) =>
  bug.operation === 'desktop-help' ? desktopRepo : webRepo;
export const sessionTag = (bug: FeedbackBug) => `feedback-${bug.id}-g${bug.generation}`;

const sha = /^[a-f0-9]{40}$/;
const sessionId = /^[\w-]{1,120}$/;

export function hasDevinConfig(env: FeedbackEnv) {
  return !!(
    env.DEVIN_API_KEY?.startsWith('cog_') &&
    /^org-[\w-]+$/.test(env.DEVIN_ORG_ID ?? '') &&
    /^[\w-]{1,128}$/.test(env.DEVIN_SECURITY_PROFILE_ID ?? '')
  );
}

// A repo hint on a create request selects a checkout; the organization grant
// is the access boundary. Validate the actual grant and the session profile
// before reserving any paid work. Dependencies are installed in the blueprint.
export async function isolatedDevinScope(env: FeedbackEnv, http: FeedbackFetch) {
  const get = async <T>(path: string) => {
    const response = await http('https://api.devin.ai/' + path, {
      headers: { authorization: `Bearer ${env.DEVIN_API_KEY}` },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw error(503, 'Could not verify Devin access scope');
    return response.json<T>();
  };
  const [repos, profile, protectedMain] = await Promise.all([
    // Both the selected checkout and the receiving branch must enforce their grants.
    get<{
      items: { repo_full_name: string; git_connection_host: string }[];
      has_next_page: boolean;
    }>(`v3/organizations/${env.DEVIN_ORG_ID}/repositories?first=2&load_indexing_status=false`),
    get<{
      profile_id: string;
      org_id: string;
      enforcement_level: string;
      devin_mcp_read_only: boolean;
      git_access_level: string;
      mcp_config: { servers: string[] } | null;
      net_policy: { allow: { hostname?: string }[] } | null;
    }>(
      `v3beta1/organizations/${env.DEVIN_ORG_ID}/security-profiles/${env.DEVIN_SECURITY_PROFILE_ID}`,
    ),
    requiresPullRequestReview(env, http),
  ]);
  const allowedHosts = [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
  ];
  return (
    protectedMain &&
    repos.has_next_page === false &&
    repos.items?.length === 1 &&
    repos.items[0].git_connection_host === 'github.com' &&
    repos.items[0].repo_full_name === webRepo &&
    profile.profile_id === env.DEVIN_SECURITY_PROFILE_ID &&
    profile.org_id === env.DEVIN_ORG_ID &&
    profile.enforcement_level === 'mandatory' &&
    profile.devin_mcp_read_only === true &&
    profile.git_access_level === 'read_write' &&
    Array.isArray(profile.mcp_config?.servers) &&
    profile.mcp_config.servers.length === 0 &&
    Array.isArray(profile.net_policy?.allow) &&
    profile.net_policy.allow.every((dest) => allowedHosts.includes(dest.hostname ?? ''))
  );
}

// Each recipe uses a fixed, synthetic input. Free text, file names, logs, client
// measurements and uploads are deliberately absent from the provider contract.
export function evidencePrompt(bug: FeedbackBug) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(bug.id) ||
    !Number.isSafeInteger(bug.generation) ||
    bug.operation !== 'shared-download' ||
    bug.trusted_stage !== 'transfer' ||
    !sha.test(bug.server_build ?? '')
  )
    return null;
  let example: string;
  if (bug.trusted_signature === 'download-filename-encoding' && bug.trusted_status === 500) {
    example =
      'Use a small generated WAV and test the download display label formatter with synthetic Unicode file names. Check the attachment label and resulting bytes.';
  } else if (bug.trusted_signature === 'valid-range-rejected' && bug.trusted_status === 416) {
    example =
      'Use a 1 KiB generated WAV. Request a valid range (bytes 32–63) locally from a synthetic shared download and compare the returned bytes to the fixture.';
  } else return null;
  return [
    `Investigate ${sessionTag(bug)} in an isolated checkout of ${webRepo}.`,
    `The server observed ${bug.operation} / ${bug.trusted_stage}: ${bug.trusted_signature}, HTTP ${bug.trusted_status}, build ${bug.server_build}.`,
    example,
    'Use local fixtures and mocks. Stop and request human review if evidence suggests a security, privacy or credential issue, or if the symptom cannot be reproduced.',
    'If confirmed, open a draft PR targeting main. Include nonempty Markdown sections titled Before, After, Tests and Remaining uncertainty. Describe the synthetic observation before and after and list the focused tests and results. Leave merge and release to the reviewer.',
  ].join('\n');
}

async function devinRequest(
  env: FeedbackEnv,
  http: FeedbackFetch,
  path: string,
  init?: RequestInit,
) {
  return http(`https://api.devin.ai/v3/organizations/${env.DEVIN_ORG_ID}/sessions${path}`, {
    ...init,
    headers: { 'authorization': `Bearer ${env.DEVIN_API_KEY}`, 'content-type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
}

type Session = {
  session_id: string;
  tags: string[];
  status: string;
  status_detail?: string;
  pull_requests?: { pr_url: string }[];
  security_profile?: { profile_id: string };
};

export const validSessionId = (value: unknown): value is string =>
  typeof value === 'string' && sessionId.test(value);

export async function createDevinSession(
  env: FeedbackEnv,
  http: FeedbackFetch,
  bug: FeedbackBug,
  prompt: string,
) {
  const response = await devinRequest(env, http, '', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      title: sessionTag(bug),
      tags: [sessionTag(bug)],
      repos: [webRepo],
      security_profile: { profile_id: env.DEVIN_SECURITY_PROFILE_ID },
      bypass_approval: false,
      resumable: false,
      max_acu_limit: 3,
      secret_ids: [],
      session_secrets: [],
      knowledge_ids: [],
      memory_enabled: false,
    }),
  });
  if (!response.ok) return { status: response.status, id: null };
  const data = await response.json<Session>();
  return { status: response.status, id: validSessionId(data.session_id) ? data.session_id : null };
}

export async function readDevinSession(
  env: FeedbackEnv,
  http: FeedbackFetch,
  id: string,
  bug: FeedbackBug,
) {
  if (!hasDevinConfig(env) || !validSessionId(id))
    throw error(409, 'Session lookup is unavailable');
  const canonicalId = id.startsWith('devin-') ? id : 'devin-' + id;
  const response = await devinRequest(env, http, '/' + canonicalId);
  if (!response.ok) throw error(503, 'Devin could not confirm this session');
  const session = await response.json<Session>();
  if (
    !validSessionId(session.session_id) ||
    session.session_id.replace(/^devin-/, '') !== canonicalId.slice(6) ||
    !Array.isArray(session.tags) ||
    !session.tags.includes(sessionTag(bug)) ||
    session.security_profile?.profile_id !== env.DEVIN_SECURITY_PROFILE_ID
  )
    throw error(409, 'Session does not match this investigation and profile');
  return session;
}

type PullRequest = {
  number: number;
  draft: boolean;
  state: string;
  body: string | null;
  merged: boolean;
  base: { ref: string; repo: { full_name: string } };
  head: { sha: string };
  merge_commit_sha: string | null;
};

async function github<T>(env: FeedbackEnv, http: FeedbackFetch, repo: string, path: string) {
  const response = await http(`https://api.github.com/repos/${repo}/${path}`, {
    headers: {
      'accept': 'application/vnd.github+json',
      'user-agent': 'SwyxDrive-Feedback',
      ...(env.FEEDBACK_GITHUB_TOKEN
        ? { authorization: `Bearer ${env.FEEDBACK_GITHUB_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw error(503, 'GitHub could not confirm the requested evidence');
  return response.json<T>();
}

type ReviewRule = { required_approving_review_count?: number };
async function requiresPullRequestReview(env: FeedbackEnv, http: FeedbackFetch) {
  // GitHub supports both active rulesets and classic branch protection.
  const rules = await github<{ type: string; parameters?: ReviewRule }[]>(
    env,
    http,
    webRepo,
    'rules/branches/main',
  );
  if (
    rules.some(
      (rule) =>
        rule.type === 'pull_request' &&
        (rule.parameters?.required_approving_review_count ?? 0) >= 1,
    )
  )
    return true;
  const branch = await github<{ protected: boolean }>(env, http, webRepo, 'branches/main');
  if (!branch.protected) return false;
  const review = await github<ReviewRule>(
    env,
    http,
    webRepo,
    'branches/main/protection/required_pull_request_reviews',
  );
  return (review.required_approving_review_count ?? 0) >= 1;
}

export async function readPr(
  env: FeedbackEnv,
  http: FeedbackFetch,
  bug: FeedbackBug,
  number: number,
) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw error(400, 'Enter a valid pull request number');
  const repo = repository(bug);
  const pr = await github<PullRequest>(env, http, repo, `pulls/${number}`);
  if (
    pr.number !== number ||
    pr.base?.repo?.full_name !== repo ||
    pr.base.ref !== 'main' ||
    !sha.test(pr.head?.sha ?? '')
  )
    throw error(409, 'Pull request must target the product repository on main');
  return pr;
}

export function verifyDraft(pr: PullRequest) {
  const sections = (pr.body ?? '').split(/^#{1,6}\s+/m).slice(1);
  if (
    !pr.draft ||
    pr.state !== 'open' ||
    !['Before', 'After', 'Tests', 'Remaining uncertainty'].every((label) =>
      sections.some((section) => {
        const [heading, ...content] = section.trim().split(/\r?\n/);
        return (
          heading.trim().toLowerCase() === label.toLowerCase() &&
          content.join('\n').trim().length > 0
        );
      }),
    )
  )
    throw error(
      409,
      'Link an open draft with Before, After, Tests and Remaining uncertainty sections',
    );
}

export function sessionPr(session: Session, bug: FeedbackBug) {
  const prefix = `https://github.com/${repository(bug)}/pull/`;
  const numbers = session.pull_requests
    ?.map(({ pr_url }) =>
      typeof pr_url === 'string' && pr_url.startsWith(prefix) ? pr_url.slice(prefix.length) : '',
    )
    .filter((number) => /^[1-9]\d{0,9}$/.test(number));
  return numbers?.length === 1 ? Number(numbers[0]) : null;
}

type Release = {
  draft: boolean;
  published_at: string | null;
  tag_name: string;
  assets: { name: string; state: string; size: number }[];
};

async function desktopRelease(env: FeedbackEnv, http: FeedbackFetch, requestedTag?: string) {
  const validTag = (tag: string) => /^[\w][\w.-]{0,100}$/.test(tag);
  if (requestedTag !== undefined && !validTag(requestedTag))
    throw error(400, 'Enter a release tag');
  const release = await github<Release>(
    env,
    http,
    desktopRepo,
    requestedTag ? `releases/tags/${requestedTag}` : 'releases/latest',
  );
  if (
    release.draft ||
    !release.published_at ||
    !validTag(release.tag_name) ||
    (requestedTag && release.tag_name !== requestedTag) ||
    !release.assets.some(
      (asset) =>
        asset.state === 'uploaded' &&
        asset.size > 0 &&
        /^smolhuman[\w.-]*\.(dmg|pkg|app\.tar\.gz|app\.zip)$/i.test(asset.name),
    )
  )
    throw error(409, 'Desktop release needs a published smolhuman Mac installer');
  let { object } = await github<{ object: { type: string; sha: string } }>(
    env,
    http,
    desktopRepo,
    `git/ref/tags/${release.tag_name}`,
  );
  if (object.type === 'tag' && sha.test(object.sha)) {
    ({ object } = await github<{ object: { type: string; sha: string } }>(
      env,
      http,
      desktopRepo,
      `git/tags/${object.sha}`,
    ));
  }
  if (object.type !== 'commit' || !sha.test(object.sha))
    throw error(409, 'Could not verify the desktop release tag');
  return { version: release.tag_name, commit: object.sha };
}

async function deployedWeb(http: FeedbackFetch) {
  const response = await http('https://drive.swyx.io/api/health', {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw error(503, 'Live SwyxDrive health check failed');
  const data = await response.json<{ status: string; sourceSha: string; version: string }>();
  if (
    data.status !== 'ok' ||
    !sha.test(data.sourceSha) ||
    data.version !== `git-${data.sourceSha.slice(0, 12)}`
  )
    throw error(409, 'Live SwyxDrive deployment did not identify its build');
  return { version: data.version, commit: data.sourceSha };
}

export async function verifyDeployment(
  env: FeedbackEnv,
  http: FeedbackFetch,
  bug: FeedbackBug,
  pr: PullRequest,
  approvedHead: string,
  tag?: string,
) {
  if (!pr.merged || pr.head.sha !== approvedHead || !sha.test(pr.merge_commit_sha ?? ''))
    throw error(409, 'The reviewed revision must be merged into main');
  const repo = repository(bug);
  const deployed =
    repo === webRepo ? await deployedWeb(http) : await desktopRelease(env, http, tag);
  if (deployed.commit !== pr.merge_commit_sha) {
    const compare = await github<{ status: string; merge_base_commit: { sha: string } }>(
      env,
      http,
      repo,
      `compare/${pr.merge_commit_sha}...${deployed.commit}`,
    );
    if (compare.status !== 'ahead' || compare.merge_base_commit?.sha !== pr.merge_commit_sha)
      throw error(409, 'The released build does not yet contain the reviewed merge');
  }
  return deployed.version;
}
