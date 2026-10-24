import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const release = YAML.parse(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
const verify = YAML.parse(fs.readFileSync('.github/workflows/verify.yml', 'utf8'));

test('fork and PR verification has no release secrets or write authority', () => {
  assert.equal(verify.permissions.contents, 'read');
  assert.ok('pull_request' in verify.on);
  assert.ok('workflow_call' in verify.on);
  assert.equal(release.on.pull_request, undefined);
  assert.equal(release.jobs.version.if, undefined);
  assert.equal(release.permissions.contents, 'read');
  for (const [name, job] of Object.entries(release.jobs)) {
    if (name === 'publish') continue;
    assert.ok(!JSON.stringify(job).includes('secrets.'));
    assert.ok(!JSON.stringify(job.permissions ?? {}).includes('write'));
    assert.ok(!JSON.stringify(job).includes('--publish'));
  }
  assert.ok(!JSON.stringify(verify).includes('secrets.'));
  assert.ok(!JSON.stringify(verify).includes('--publish'));
});

test('only trusted tags with every gate and exact approval reach the protected publisher', () => {
  const job = release.jobs.publish;
  for (const condition of ["always()", "!cancelled()", "github.event_name == 'push'", "startsWith(github.ref, 'refs/tags/')", "github.repository == 'zpershuai/reach'", "needs.version.outputs.test_only == 'false'", "needs.version.result == 'success'", "needs.verify.result == 'success'", "needs.candidate.result == 'success'"]) {
    assert.ok(job.if.includes(condition), condition);
  }
  assert.equal(job.environment, 'public-release');
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.equal(release.jobs.verify.uses, './.github/workflows/verify.yml');
  const publisher = job.steps.at(-1);
  assert.ok(publisher.run.indexOf('release-plan.py approve') < publisher.run.indexOf('--publish'));
  assert.equal(publisher.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.ok(!JSON.stringify(release).includes('secrets.'));
  for (const oldSetting of ['REACH_SOURCE_REPOSITORY', 'REACH_ENGINE_RELEASE_REPOSITORY', 'REACH_GATEWAY_RELEASE_REPOSITORY', 'REACH_PUBLIC_RELEASE_TOKEN', 'REACH_GHCR_PUBLISH_TOKEN']) assert.ok(!JSON.stringify(release).includes(oldSetting));
  const metadata = release.jobs.candidate.steps.find(step => step.env?.SOURCE_REPOSITORY);
  assert.equal(metadata.env.SOURCE_REPOSITORY, '${{ github.repository }}');
  const candidate = JSON.stringify(release.jobs.candidate);
  for (const gate of ['manifest', 'verify-release-assets.py complete', 'install-publication-tools.py', 'prepare-public-source.py', 'release-plan.py prepare']) assert.ok(candidate.includes(gate));
});

test('explicit CI tags use the real component pipeline and cannot enter publishing', () => {
  assert.deepEqual(release.on.push.tags, ['engine-v*', 'gateway-v*']);
  assert.equal(release.jobs.version.outputs.test_only, '${{ steps.tag.outputs.test_only }}');
  const steps = release.jobs.version.steps;
  assert.ok(steps.find(step => step.run?.includes('release-metadata.py workflow-tag')));
  const ancestry = steps.find(step => step.env?.TEST_ONLY);
  assert.ok(ancestry.run.includes('if [[ "$TEST_ONLY" == true ]]'));
  assert.ok(ancestry.run.includes('git merge-base --is-ancestor "origin/$DEFAULT_BRANCH" HEAD'));
  assert.ok(ancestry.run.includes('git merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH"'));
  for (const name of ['verify', 'engine', 'gateway', 'candidate']) assert.ok(release.jobs[name]);
  assert.ok(release.jobs.publish.if.includes("needs.version.outputs.test_only == 'false'"));
});

test('tag ancestry accepts merged CI retries but still rejects unmerged stable and diverged commits', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-release-ancestry-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.com');
  const tree = execFileSync('git', ['mktree'], { cwd, input: '', encoding: 'utf8' }).trim();
  const commit = (message, ...parents) => git('commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message);
  const base = commit('base');
  const candidate = commit('candidate', base);
  const advanced = commit('main after candidate merge', candidate);
  const diverged = commit('diverged main', base);
  const unrelated = commit('unrelated history');
  const ancestry = release.jobs.version.steps.find(step => step.env?.TEST_ONLY);
  for (const [name, head, main, testOnly, expected] of [
    ['current CI candidate', base, base, true, 0],
    ['CI candidate ahead of main', candidate, base, true, 0],
    ['merged CI candidate after main advances', candidate, advanced, true, 0],
    ['current stable release', base, base, false, 0],
    ['merged stable release', candidate, advanced, false, 0],
    ['unmerged stable release', candidate, base, false, 1],
    ['diverged CI candidate', candidate, diverged, true, 1],
    ['diverged stable release', candidate, diverged, false, 1],
    ['unrelated CI candidate', candidate, unrelated, true, 1],
    ['unrelated stable release', candidate, unrelated, false, 1],
  ]) {
    git('update-ref', 'refs/remotes/origin/main', main);
    git('update-ref', 'HEAD', head);
    const result = spawnSync('bash', ['-e', '-c', ancestry.run], {
      cwd, encoding: 'utf8', env: { ...process.env, TEST_ONLY: String(testOnly), DEFAULT_BRANCH: 'main' },
    });
    assert.equal(result.status, expected, `${name}: ${result.stderr}`);
  }
});

test('artifact uploads are explicit allowlists and private reports cannot be uploaded', () => {
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
      assert.ok(!step.with.path.includes('*'));
      assert.ok(!step.with.path.includes('publication/'));
      assert.ok(!step.with.path.includes('report'));
      assert.equal(step.with['if-no-files-found'], 'error');
      assert.equal(step.with['include-hidden-files'], true);
    }
  }
  const candidateUploads = release.jobs.candidate.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'));
  const enginePaths = candidateUploads[0].with.path;
  for (const asset of ['engine-linux-x64-musl', 'engine-darwin-arm64', 'engine-darwin-x64']) {
    for (const suffix of ['', '.NOTICES.txt', '.licenses.tgz']) assert.ok(enginePaths.split('\n').includes('.reach/release/' + asset + suffix));
  }
  for (const paths of candidateUploads.map(step => step.with.path)) {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'third-party-licenses.tgz', 'release-manifest.json', 'SHA256SUMS']) assert.ok(paths.split('\n').includes('.reach/release/' + name));
  }
});

test('every external Action is pinned to an immutable commit', () => {
  for (const workflow of [release, verify]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const item of [job, ...(job.steps ?? [])]) {
        if (!item.uses || item.uses.startsWith('./')) continue;
        assert.match(item.uses, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+@[a-f0-9]{40}$/);
      }
    }
  }
});
