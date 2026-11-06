import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData, syncedContent } from '../lib/merge.js';

const T = (n) => new Date(Date.UTC(2026, 10, 1, 12, 0, n)).toISOString(); // T(1) < T(2) < …
const NOW = new Date(Date.UTC(2026, 10, 2));

function db(over = {}) {
  return {
    version: 1,
    jobs: [],
    profile: { name: '', headline: '', resume: '', about: '', style: '' },
    settings: { engine: 'builtin', lmUrl: 'http://localhost:1234', weeklyGoal: 5, temperature: 0.7 },
    general: { chat: [], documents: [] },
    ...over,
  };
}
const job = (id, updatedAt, extra = {}) => ({ id, title: id, status: 'saved', createdAt: T(0), updatedAt, chat: [], documents: [], history: [], ...extra });
const merge = (a, b) => mergeData(a, b, { now: NOW });

// Both computers must end up with the same data whichever one merges, or they'd keep overwriting each other.
function assertSymmetric(a, b) {
  assert.equal(syncedContent(merge(a, b)), syncedContent(merge(b, a)));
}

test('jobs added on different computers are all kept', () => {
  const a = db({ jobs: [job('a', T(1))] });
  const b = db({ jobs: [job('b', T(2))] });
  assert.deepEqual(merge(a, b).jobs.map((j) => j.id).sort(), ['a', 'b']);
  assertSymmetric(a, b);
});

test('the newer edit of a job wins', () => {
  const a = db({ jobs: [job('x', T(1), { title: 'old' })] });
  const b = db({ jobs: [job('x', T(2), { title: 'new' })] });
  assert.equal(merge(a, b).jobs[0].title, 'new');
  assert.equal(merge(b, a).jobs[0].title, 'new');
});

test('a deletion wins over older edits, but a later edit brings the job back', () => {
  const edited = db({ jobs: [job('x', T(1))] });
  const deleted = db({ deleted: { x: T(2) } });
  assert.equal(merge(edited, deleted).jobs.length, 0);
  assert.equal(merge(deleted, edited).jobs.length, 0);
  const editedLater = db({ jobs: [job('x', T(3))] });
  assert.equal(merge(editedLater, deleted).jobs.length, 1);
});

test('documents inside a job merge by id, and deleted documents stay deleted', () => {
  const doc = (id, updatedAt, content) => ({ id, type: 'other', title: id, content, createdAt: T(0), updatedAt });
  const a = db({ jobs: [job('x', T(1), { documents: [doc('d1', T(1), 'v1'), doc('d2', T(1), 'keep')] })] });
  const b = db({ jobs: [job('x', T(1), { documents: [doc('d1', T(3), 'v2'), doc('d3', T(2), 'new')] })], deleted: { d2: T(2) } });
  const docs = merge(a, b).jobs[0].documents;
  assert.deepEqual(docs.map((d) => [d.id, d.content]).sort(), [['d1', 'v2'], ['d3', 'new']]);
  assertSymmetric(a, b);
});

test('chat messages from both computers are kept once, in order; clearing the chat removes older ones', () => {
  const m = (at, role, content) => ({ at, role, content });
  const shared = [m(T(1), 'user', 'hi'), m(T(1), 'assistant', 'hello')];
  const a = db({ general: { chat: [...shared, m(T(3), 'user', 'from A')], documents: [] } });
  const b = db({ general: { chat: [...shared, m(T(2), 'user', 'from B')], documents: [] } });
  assert.deepEqual(merge(a, b).general.chat.map((x) => x.content), ['hi', 'hello', 'from B', 'from A']);
  assertSymmetric(a, b);

  const cleared = db({ general: { chat: [m(T(4), 'user', 'after clear')], documents: [], chatClearedAt: T(3) } });
  assert.deepEqual(merge(a, cleared).general.chat.map((x) => x.content), ['after clear']);
});

test('profile fields merge one by one by their own change time', () => {
  const a = db({ profile: { name: 'Alex', headline: 'Old headline', resume: 'R1' }, stamps: { profile: { name: T(5), headline: T(1) } } });
  const b = db({ profile: { name: 'Al', headline: 'New headline', resume: 'R1' }, stamps: { profile: { name: T(2), headline: T(4) } } });
  const p = merge(a, b).profile;
  assert.equal(p.name, 'Alex');
  assert.equal(p.headline, 'New headline');
  assertSymmetric(a, b);
});

test('unstamped (pre-sync) profiles pick the same winner on both computers', () => {
  const a = db({ profile: { name: 'Alex Rivera', resume: 'long resume text' } });
  const b = db({ profile: { name: 'A', resume: '' } });
  assertSymmetric(a, b);
  assert.equal(merge(a, b).profile.name, merge(b, a).profile.name);
});

test("this computer's own settings are never taken from the other computer", () => {
  const a = db({ settings: { engine: 'builtin', lmUrl: 'http://a', weeklyGoal: 5, contextLength: 8192 }, stamps: { settings: { weeklyGoal: T(1) } } });
  const b = db({ settings: { engine: 'lmstudio', lmUrl: 'http://b', weeklyGoal: 9, contextLength: 32768 }, stamps: { settings: { weeklyGoal: T(2) } } });
  const s = merge(a, b).settings;
  assert.equal(s.engine, 'builtin');
  assert.equal(s.lmUrl, 'http://a');
  assert.equal(s.contextLength, 8192);
  assert.equal(s.weeklyGoal, 9);
});

test('merging again changes nothing', () => {
  const a = db({ jobs: [job('a', T(1))], profile: { name: 'A' }, stamps: { profile: { name: T(1) } }, deleted: { z: T(1) } });
  const b = db({ jobs: [job('b', T(2))], profile: { name: 'B' }, stamps: { profile: { name: T(2) } } });
  const once = merge(a, b);
  assert.equal(syncedContent(merge(once, b)), syncedContent(once));
  assert.equal(syncedContent(merge(once, once)), syncedContent(once));
});

test('very old deletion records are dropped', () => {
  const a = db({ deleted: { old: '2026-01-01T00:00:00.000Z', recent: T(1) } });
  assert.deepEqual(Object.keys(merge(a, db()).deleted), ['recent']);
});

test('no remote copy yet: the local data is used as it is', () => {
  const a = db({ jobs: [job('a', T(1))] });
  assert.equal(merge(a, null), a);
});
