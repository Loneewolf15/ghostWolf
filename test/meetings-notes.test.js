// tests/meetings-notes.test.js
// Unit tests for the meeting persistence and notes parsing modules.
// These run with node --test and require no Electron context.

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ---- helpers ----
function tempFile() {
  return path.join(os.tmpdir(), `ghostwolf-test-meetings-${crypto.randomBytes(6).toString('hex')}.json`);
}

// ---- meetings module ----
const { createMeetingStore, loadMeetingsFile, saveMeetingsFile } = require('../src/meetings');

test('loadMeetingsFile returns [] for a missing file', () => {
  const result = loadMeetingsFile('/tmp/__nonexistent_file_cue__.json');
  assert.deepEqual(result, []);
});

test('loadMeetingsFile returns [] for corrupt JSON', () => {
  const f = tempFile();
  fs.writeFileSync(f, 'not-json{{{{');
  try {
    const result = loadMeetingsFile(f);
    assert.deepEqual(result, []);
  } finally {
    fs.unlinkSync(f);
  }
});

test('saveMeetingsFile writes and loadMeetingsFile reads back', () => {
  const f = tempFile();
  const meetings = [{ id: 'abc', title: 'Test', startedAt: 1000 }];
  try {
    const ok = saveMeetingsFile(f, meetings);
    assert.equal(ok, true);
    const loaded = loadMeetingsFile(f);
    assert.deepEqual(loaded, meetings);
  } finally {
    fs.unlinkSync(f);
  }
});

test('createMeetingStore.add() creates a meeting with required fields', () => {
  const store = createMeetingStore({ file: tempFile() });
  const m = store.add();
  assert.ok(m.id, 'should have an id');
  assert.ok(m.startedAt > 0, 'should have startedAt timestamp');
  assert.equal(m.title, 'Untitled meeting');
  assert.deepEqual(m.transcript, []);
  assert.equal(m.endedAt, null);
});

test('createMeetingStore.get() returns the meeting by id', () => {
  const store = createMeetingStore({});
  const m = store.add();
  const found = store.get(m.id);
  assert.equal(found.id, m.id);
});

test('createMeetingStore.get() returns null for unknown id', () => {
  const store = createMeetingStore({});
  assert.equal(store.get('not-real'), null);
});

test('createMeetingStore.update() patches fields', () => {
  const store = createMeetingStore({});
  const m = store.add();
  const patched = store.update(m.id, { title: 'Interview at Acme', summary: 'Went well.' });
  assert.equal(patched.title, 'Interview at Acme');
  assert.equal(patched.summary, 'Went well.');
});

test('createMeetingStore.update() returns null for unknown id', () => {
  const store = createMeetingStore({});
  const result = store.update('ghost-id', { title: 'x' });
  assert.equal(result, null);
});

test('createMeetingStore.addTurn() appends to transcript', () => {
  const store = createMeetingStore({});
  const m = store.add();
  store.addTurn(m.id, { channel: 'you', text: 'Hello', ts: 1000 });
  store.addTurn(m.id, { channel: 'them', text: 'Hi back', ts: 2000 });
  const fetched = store.get(m.id);
  assert.equal(fetched.transcript.length, 2);
  assert.equal(fetched.transcript[0].text, 'Hello');
});

test('createMeetingStore.remove() deletes a meeting', () => {
  const store = createMeetingStore({});
  const m = store.add();
  const removed = store.remove(m.id);
  assert.equal(removed, true);
  assert.equal(store.get(m.id), null);
});

test('createMeetingStore.remove() returns false for unknown id', () => {
  const store = createMeetingStore({});
  assert.equal(store.remove('ghost'), false);
});

test('createMeetingStore.search() finds meeting by transcript text', () => {
  const store = createMeetingStore({});
  const m = store.add();
  store.addTurn(m.id, { channel: 'them', text: 'Tell me about distributed systems', ts: 1000 });
  const results = store.search('distributed systems');
  assert.ok(results.length > 0, 'should find meeting by transcript text');
  assert.equal(results[0].id, m.id);
});

test('createMeetingStore.search() returns [] for empty query', () => {
  const store = createMeetingStore({});
  store.add();
  assert.deepEqual(store.search(''), []);
});

test('createMeetingStore.recentSummaries() only returns meetings with summaries', () => {
  const store = createMeetingStore({});
  const m1 = store.add();
  const m2 = store.add();
  store.update(m1.id, { summary: 'Had a great interview' });
  // m2 has no summary
  const summaries = store.recentSummaries(5);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, m1.id);
});

test('createMeetingStore.list() returns all meetings', () => {
  const store = createMeetingStore({});
  store.add();
  store.add();
  store.add();
  assert.equal(store.list().length, 3);
});

test('createMeetingStore persists to disk and reloads', () => {
  const f = tempFile();
  try {
    const store1 = createMeetingStore({ file: f });
    const m = store1.add();
    store1.update(m.id, { title: 'Persisted meeting' });
    store1.flush();
    // Reload
    const store2 = createMeetingStore({ file: f });
    const loaded = store2.get(m.id);
    assert.ok(loaded, 'meeting should survive reload');
    assert.equal(loaded.title, 'Persisted meeting');
  } finally {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// ---- notes module ----
const { buildNotesPrompt, parseNotes } = require('../src/notes');

test('buildNotesPrompt includes transcript lines', () => {
  const transcript = [
    { channel: 'them', text: 'Tell me about yourself', ts: 1000 },
    { channel: 'you', text: 'Sure, I am a software engineer', ts: 2000 }
  ];
  const prompt = buildNotesPrompt(transcript);
  assert.ok(prompt.includes('Them: Tell me about yourself'), 'should include them line');
  assert.ok(prompt.includes('You: Sure, I am a software engineer'), 'should include you line');
  assert.ok(prompt.includes('Meeting Summary:'), 'should include heading instructions');
});

test('buildNotesPrompt handles empty transcript', () => {
  const prompt = buildNotesPrompt([]);
  assert.ok(prompt.includes('(empty)'), 'should indicate empty transcript');
});

test('parseNotes extracts summary', () => {
  const raw = `Meeting Summary:\nThe candidate discussed their background at Acme Corp.\n\nKey Points:\n- Led a team of 5 engineers\n\nDecisions:\n- Proceed to next round\n\nAction Items:\n- Send portfolio link\n\nFollow-Up:\n- Schedule technical interview`;
  const notes = parseNotes(raw);
  assert.ok(notes.summary.includes('Acme Corp'), 'should extract summary');
  assert.ok(notes.keyPoints.length > 0, 'should extract key points');
  assert.ok(notes.decisions.length > 0, 'should extract decisions');
  assert.ok(notes.actionItems.length > 0, 'should extract action items');
  assert.ok(notes.followUp.length > 0, 'should extract follow-up');
});

test('parseNotes strips bullet prefixes from lists', () => {
  const raw = `Meeting Summary:\nBrief summary.\n\nAction Items:\n- First item\n* Second item\n• Third item\n1. Numbered item`;
  const notes = parseNotes(raw);
  assert.ok(notes.actionItems.every(item => !item.startsWith('-') && !item.startsWith('*') && !item.startsWith('•')));
  assert.ok(notes.actionItems.length === 4);
});

test('parseNotes falls back to summary when no headings found', () => {
  const raw = 'The meeting went well and covered distributed systems.';
  const notes = parseNotes(raw);
  assert.ok(notes.summary.includes('distributed systems'), 'should fall back to summary');
});

test('parseNotes returns empty structure for empty input', () => {
  const notes = parseNotes('');
  assert.equal(notes.summary, '');
  assert.deepEqual(notes.keyPoints, []);
  assert.deepEqual(notes.decisions, []);
  assert.deepEqual(notes.actionItems, []);
  assert.deepEqual(notes.followUp, []);
});

test('parseNotes handles null/undefined gracefully', () => {
  assert.doesNotThrow(() => parseNotes(null));
  assert.doesNotThrow(() => parseNotes(undefined));
});
