import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
if ((process.env.WORKERS_CI_BRANCH ?? git('branch', '--show-current')) !== 'main') {
  throw new Error('Production deployment requires main');
}
const healthUrl = 'https://drive.swyx.io/api/health';
const health = await fetch(healthUrl, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
if (!health.ok) throw new Error(`Pre-deploy health check failed: ${health.status}`);
const live = await health.json();
if (!/^[a-f0-9]{7,40}$/.test(live.sourceSha ?? ''))
  throw new Error('Live source revision is unknown');
if (git('rev-parse', '--is-shallow-repository') === 'true') git('fetch', '--unshallow', 'origin');
const liveSha = git('rev-parse', '--verify', `${live.sourceSha}^{commit}`);
const nativeChanged =
  git(
    'diff',
    '--name-only',
    liveSha,
    sha,
    '--',
    'apps/papra-worker/native',
    'apps/papra-worker/wrangler.jsonc',
  ) !== '';
console.log(
  `Deploying ${sha}; native container ${nativeChanged ? 'will be rebuilt' : 'unchanged'}`,
);
execFileSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--keep-vars',
    `--containers-rollout=${nativeChanged ? 'immediate' : 'none'}`,
    '--var',
    `SOURCE_SHA:${sha}`,
    '--var',
    `VERSION:git-${sha.slice(0, 12)}`,
  ],
  {
    cwd: `${root}/apps/papra-worker`,
    stdio: 'inherit',
  },
);
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch(`${healthUrl}?release=${sha}`, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    const result = await response.json();
    if (response.ok && result.status === 'ok' && result.sourceSha === sha) {
      console.log(`Verified production release ${sha} at https://drive.swyx.io`);
      process.exit(0);
    }
  } catch (error) {
    console.warn(`Health verification attempt ${attempt + 1}: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
throw new Error(`Deployment completed but production did not report ${sha}`);
