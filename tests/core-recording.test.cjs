'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecordingSession, STATES } = require('../src/core/recording-session.cjs');

function begin(session) {
  session.rightDown();
  const result = session.holdThresholdReached({ windowTitle: 'Original research' });
  return result.actions.find(action => action.type === 'prepareRecording').token;
}

test('short right click creates no capture, session, or draft', () => {
  const session = new RecordingSession();
  assert.equal(session.rightDown().sessionId, null);
  assert.equal(session.rightUp().state, STATES.IDLE);
  assert.equal(session.holdThresholdReached().actions.length, 0);
});

test('initial hold starts then releases; manual continuation ignores right mouse release', () => {
  const session = new RecordingSession();
  const firstToken = begin(session);
  assert.equal(session.microphoneReady(firstToken).state, STATES.RECORDING_HOLD);
  assert.equal(session.rightUp().state, STATES.PAUSED);
  const sameId = session.sessionId;
  const manual = session.continueRecording();
  assert.equal(manual.state, STATES.ARMING_MANUAL);
  assert.equal(session.rightHeld, false);
  assert.equal(session.microphoneReady(manual.actions[0].token).state, STATES.RECORDING_MANUAL);
  assert.equal(session.rightUp().state, STATES.RECORDING_MANUAL);
  assert.equal(session.pause().state, STATES.PAUSED);
  assert.equal(session.sessionId, sameId);
  assert.deepEqual(session.source, { windowTitle: 'Original research' });
  assert.equal(session.segmentCount, 2);
});

test('late microphone after initial release must be disposed instead of starting', () => {
  const session = new RecordingSession();
  const token = begin(session);
  session.rightUp();
  const late = session.microphoneReady(token);
  assert.equal(late.state, STATES.PAUSED);
  assert.equal(late.actions[0].type, 'releaseLateMicrophone');
});

test('pause while manual microphone is arming revokes only the start permission', () => {
  const session = new RecordingSession();
  begin(session);
  session.rightUp();
  const screenshotToken = session.token();
  const { actions } = session.continueRecording();
  session.pause();
  assert.equal(session.microphoneReady(actions[0].token).actions[0].type, 'releaseLateMicrophone');
  assert.equal(session.accepts(screenshotToken), true);
});

test('discard invalidates screenshot, segment and microphone tokens before cleanup', () => {
  const session = new RecordingSession();
  const start = begin(session);
  const write = session.token();
  const result = session.discard();
  assert.equal(result.state, STATES.DISCARDED);
  assert.equal(session.accepts(write), false);
  assert.equal(session.accepts(start), false);
  assert.equal(result.actions[0].type, 'stopAllCapture');
  assert.equal(result.source, null);
});

test('completion only accepts pause and is idempotent while committing/saved', () => {
  const session = new RecordingSession();
  const token = begin(session);
  session.microphoneReady(token);
  assert.throws(() => session.finish(), /Pause/);
  session.rightUp();
  assert.equal(session.finish().state, STATES.COMMITTING);
  assert.equal(session.finish().actions.length, 0);
  assert.equal(session.markSaved().state, STATES.SAVED);
  assert.equal(session.finish().actions.length, 0);
  assert.equal(session.accepts(token), false);
});
