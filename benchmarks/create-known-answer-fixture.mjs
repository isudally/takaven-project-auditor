#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const files = {
  'package.json': '{"name":"known-answer-fixture","private":true}\n',
  'docs/workflow-requirements.md': `# Workflow requirements

- A submission may be retried after a timeout or lost acknowledgement.
- Retrying the same logical submission must not create a duplicate external effect.
- Completion responses should reflect durable state rather than only an attempted call.
`,
  'src/flows/account-setup.mjs': `export async function createAccount(input, db) {
  const account = await db.accounts.insert(input);
  try {
    await db.checklists.assignDefaults(account.id);
  } catch (error) {
    console.warn('defaults unavailable', error.message);
  }
  return { ok: true, id: account.id };
}
`,
  'src/flows/policy-publish.mjs': `export async function publishPolicy(policy, db) {
  const record = await db.policies.replace(policy.id, policy.content);
  await db.policies.markPublished(policy.id);
  return { ok: true, version: record.version };
}

export async function acknowledgePolicy(id, version, db) {
  return db.policies.acknowledge(id, version);
}
`,
  'src/security/diagnostics.mjs': `export function recordLogin(logger, user, result) {
  logger.info({ email: user.email, result, event: 'login' });
}
`,
  'src/security/admin.mjs': `export async function removeAdministrator(id, db) {
  const administrators = await db.users.count({ role: 'administrator', active: true });
  if (administrators <= 1) return db.users.delete(id);
  return db.users.delete(id);
}
`,
  'src/inquiries/contact.mjs': `export async function completeSetup(state, db) {
  await db.setup.update({ completed: true });
  return { ok: true };
}

export async function sendInquiry(input, email) {
  await email.send({ to: input.destination, subject: input.subject, text: input.message });
  return { ok: true };
}
`,
  'src/notifications/publish.mjs': `export async function publishFromDefaultRoute(input, db) {
  await db.publications.create(input);
  return { ok: true };
}

export async function publishFromManagedRoute(input, db, notify) {
  await db.publications.create(input);
  await notify(input);
  return { ok: true };
}
`,
  'src/controls/healthy.mjs': `export function validateRecord(record) {
  return Boolean(record && record.id && record.updatedAt);
}
`,
  'src/heldout/retry.mjs': `export async function submitOnce(input, transport, db) {
  const result = await transport.send(input);
  await db.submissions.markSent(input.id);
  return { ok: true, receipt: result.receipt };
}

export async function retrySubmission(input, transport, db) {
  return submitOnce(input, transport, db);
}
`,
};

export function createKnownAnswerFixture(root) {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return root;
}

if (process.argv[1]) {
  const destination = resolve(process.argv[2] ?? 'known-answer-fixture');
  createKnownAnswerFixture(destination);
  console.log(destination);
}
