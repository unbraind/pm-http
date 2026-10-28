import { gitEnvironment } from './environment.ts';
/** Enforce the tracked identity baseline and reject newly added private home paths. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandRoot, isMainInvocation } from './main-invocation.ts';

/** Read policy entries while ignoring comments and blank lines. */
function policyEntries(root: string, name: string): string[] {
  return readFileSync(join(root, '.github', name), 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
}

/** Audit every post-baseline commit, including side branches, against tracked policy. */
export function auditIdentities(root: string): string[] {
  const baseline = policyEntries(root, 'identity-baseline.txt');
  if (baseline.length !== 1 || !/^[a-f0-9]{40}$/i.test(baseline[0])) throw new Error('Invalid identity baseline');
  const approved = new Set(policyEntries(root, 'approved-git-identities.txt'));
  if (approved.size === 0) throw new Error('Approved identity list is empty');
  const env = gitEnvironment(process.env);
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  const git = (args: readonly string[]): string => execFileSync('git', [...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['merge-base', '--is-ancestor', baseline[0], 'HEAD']);
  const commits = git(['rev-list', `${baseline[0]}..HEAD`]).split('\n').filter(Boolean);
  const violations: string[] = [];
  for (const commit of commits) {
    const [author, committer] = git(['show', '-s', '--format=%ae%n%ce', commit]).split('\n');
    if (!approved.has(author)) violations.push(`${commit}: unapproved author identity`);
    if (!approved.has(committer)) violations.push(`${commit}: unapproved committer identity`);
    const patch = git(['show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--unified=0', commit]);
    if (patch.split('\n').some(line => line.startsWith('+') && !line.startsWith('+++') && /(?<!\w)(?:[\\/](?:home|Users)[\\/]|[\\/]root(?:[\\/]|\b))/i.test(line))) {
      violations.push(`${commit}: added absolute home path`);
    }
  }
  return violations;
}

/** Report policy failures without exposing private paths or unapproved email addresses. */
export function runIdentityGate(root: string, output: (line: string) => void = console.log): number {
  try {
    const violations = auditIdentities(root);
    output(`identity-gate: ${violations.length} violation(s)${violations.length > 0 ? `\n${violations.join('\n')}` : ''}`);
    return violations.length > 0 ? 1 : 0;
  } catch {
    output('identity-gate: policy or Git history could not be verified');
    return 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const root = commandRoot(process.argv[2]);
  if (root !== undefined) process.exitCode = runIdentityGate(root);
}
