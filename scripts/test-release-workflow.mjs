import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

const release = YAML.parse(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
const verify = YAML.parse(fs.readFileSync('.github/workflows/verify.yml', 'utf8'));

test('fork and PR verification has no release secrets or write authority', () => {
  assert.equal(verify.permissions.contents, 'read');
  assert.ok('pull_request' in verify.on);
  assert.ok('workflow_call' in verify.on);
  assert.equal(release.on.pull_request, undefined);
  assert.equal(release.jobs.version.if, 'github.repository == vars.REACH_SOURCE_REPOSITORY');
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
  for (const condition of ["github.event_name == 'push'", "startsWith(github.ref, 'refs/tags/')", 'github.repository == vars.REACH_SOURCE_REPOSITORY', "needs.version.result == 'success'", "needs.verify.result == 'success'", "needs.candidate.result == 'success'"]) {
    assert.ok(job.if.includes(condition), condition);
  }
  assert.equal(job.environment, 'public-release');
  assert.equal(job.permissions.contents, 'read');
  assert.equal(release.jobs.verify.uses, './.github/workflows/verify.yml');
  const publisher = job.steps.at(-1);
  assert.ok(publisher.run.indexOf('release-plan.py approve') < publisher.run.indexOf('--publish'));
  assert.equal(publisher.env.GH_TOKEN, '${{ secrets.REACH_PUBLIC_RELEASE_TOKEN }}');
  assert.ok(publisher.env.REACH_ENGINE_RELEASE_REPOSITORY);
  assert.ok(publisher.env.REACH_GATEWAY_RELEASE_REPOSITORY);
  assert.ok(publisher.env.REACH_GATEWAY_IMAGE_REPOSITORY);
  const candidate = JSON.stringify(release.jobs.candidate);
  for (const gate of ['manifest', 'verify-release-assets.py complete', 'install-publication-tools.py', 'prepare-public-source.py', 'release-plan.py prepare']) assert.ok(candidate.includes(gate));
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
