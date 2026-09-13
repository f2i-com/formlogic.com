// Run after uploading assets and before publishing a new draft release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyUploadedAsset(release, name, bytes) {
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const matches = (release.assets ?? []).filter(asset => asset.name === name);
  if (matches.length !== 1 || matches[0].digest !== digest || matches[0].size !== bytes.length) {
    throw new Error('GitHub has not confirmed the uploaded ZIP digest and size. Check the release asset before publishing.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  if (!repo || !tag) throw new Error('GitHub repository and release tag are required.');
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], { encoding: 'utf8' }));
  const files = readdirSync('dist-package').filter(name => name.endsWith('.zip'));
  if (files.length !== 1) throw new Error('Expected exactly one release ZIP.');
  for (const name of files) {
    verifyUploadedAsset(release, name, readFileSync(`dist-package/${name}`));
    console.log(`${name}: GitHub SHA-256 and size verified.`);
  }
}
