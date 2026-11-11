import { expect, vi } from 'vitest';
import type { FeedbackFetch } from './feedback-providers';

export const revision = 'a'.repeat(40),
  merged = 'b'.repeat(40);

export type FakeHooks = {
  create?: (bug: string) => Response;
  draft?: boolean;
  merged?: boolean;
  changedHead?: boolean;
  liveSha?: string;
  release?: boolean;
  wrongSession?: boolean;
  unsafeScope?: boolean;
  unprotectedMain?: boolean;
  openEgress?: boolean;
  noPr?: boolean;
  compare?: boolean;
  badBody?: boolean;
  missingAsset?: boolean;
};
export function fakeProvider(hooks: FakeHooks = {}) {
  const starts: string[] = [];
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'POST') {
      expect(url).toBe('https://api.devin.ai/v3/organizations/org-test/sessions');
      const payload = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      expect(payload).toMatchObject({
        repos: ['swyxio/papra'],
        max_acu_limit: 3,
        bypass_approval: false,
        security_profile: { profile_id: 'profile-limited' },
        secret_ids: [],
        session_secrets: [],
        resumable: false,
        memory_enabled: false,
      });
      starts.push(payload.tags[0]);
      return hooks.create
        ? hooks.create(payload.tags[0])
        : Response.json({ session_id: payload.tags[0] });
    }
    if (url.endsWith('/rules/branches/main'))
      return Response.json(
        hooks.unprotectedMain
          ? []
          : [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
      );
    if (url.endsWith('/branches/main')) return Response.json({ protected: false });
    if (url.includes('/repositories?'))
      return Response.json({
        has_next_page: !!hooks.unsafeScope,
        items: [{ repo_full_name: 'swyxio/papra', git_connection_host: 'github.com' }],
      });
    if (url.includes('/security-profiles/'))
      return Response.json({
        profile_id: 'profile-limited',
        org_id: 'org-test',
        enforcement_level: 'mandatory',
        devin_mcp_read_only: true,
        git_access_level: 'read_write',
        mcp_config: { servers: [] },
        net_policy: hooks.openEgress ? null : { allow: [{ hostname: 'github.com' }] },
      });
    if (url.startsWith('https://api.devin.ai/')) {
      const pathId = url.split('/').at(-1)!;
      if (!pathId.startsWith('devin-')) throw new Error('Expected a prefixed Devin path ID');
      const id = pathId.slice(6);
      return Response.json({
        session_id: id,
        tags: hooks.wrongSession ? [] : [id],
        security_profile: { profile_id: 'profile-limited' },
        status: 'running',
        pull_requests: hooks.noPr ? [] : [{ pr_url: 'https://github.com/swyxio/papra/pull/17' }],
      });
    }
    const repo = url.includes('/smolhuman/') ? 'swyxio/smolhuman' : 'swyxio/papra';
    if (url.endsWith('/pulls/17'))
      return Response.json({
        number: 17,
        state: hooks.merged ? 'closed' : 'open',
        draft: hooks.draft ?? !hooks.merged,
        body: hooks.badBody
          ? 'TBD'
          : '## Before\nRange failed.\n## After\n32 bytes recovered.\n## Tests\nFixture passed.\n## Remaining uncertainty\nBrowser coverage.',
        merged: hooks.merged ?? false,
        merge_commit_sha: merged,
        head: { sha: hooks.changedHead ? merged : revision },
        base: { ref: 'main', repo: { full_name: repo } },
      });
    if (url === 'https://drive.swyx.io/api/health') {
      const sourceSha = hooks.liveSha ?? merged;
      return Response.json({ status: 'ok', sourceSha, version: 'git-' + sourceSha.slice(0, 12) });
    }
    if (url.includes('/compare/'))
      return Response.json({
        status: hooks.compare ? 'ahead' : 'behind',
        merge_base_commit: { sha: merged },
      });
    if (url.endsWith('/releases/tags/v1.2.3'))
      return Response.json({
        draft: !hooks.release,
        published_at: '2026-01-01',
        tag_name: 'v1.2.3',
        assets: hooks.missingAsset
          ? []
          : [{ name: 'smolhuman-1.2.3.dmg', size: 500, state: 'uploaded' }],
      });
    if (url.endsWith('/git/ref/tags/v1.2.3'))
      return Response.json({ object: { type: 'tag', sha: revision } });
    if (url.endsWith('/git/tags/' + revision))
      return Response.json({ object: { type: 'commit', sha: merged } });
    throw new Error('Unexpected fake request');
  });
  return { http: http as FeedbackFetch, starts };
}
