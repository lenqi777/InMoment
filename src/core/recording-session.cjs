'use strict';

const { randomUUID } = require('node:crypto');

const STATES = Object.freeze({ IDLE: 'IDLE', ARMING_HOLD: 'ARMING_HOLD', RECORDING_HOLD: 'RECORDING_HOLD', PAUSED: 'PAUSED', ARMING_MANUAL: 'ARMING_MANUAL', RECORDING_MANUAL: 'RECORDING_MANUAL', COMMITTING: 'COMMITTING', SAVED: 'SAVED', DISCARDED: 'DISCARDED' });

/** Pure interaction state. Audio/window APIs execute the returned actions outside this class. */
class RecordingSession {
  constructor({ idFactory = randomUUID, now = () => Date.now() } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.state = STATES.IDLE;
    this.sessionId = null;
    this.epoch = 0;
    this.generation = 0;
    this.segmentCount = 0;
    this.segmentId = null;
    this.rightHeld = false;
    this.source = null;
    this.createdAt = null;
  }

  snapshot() {
    return { state: this.state, sessionId: this.sessionId, epoch: this.epoch, generation: this.generation, segmentId: this.segmentId, segmentCount: this.segmentCount, rightHeld: this.rightHeld, source: structuredClone(this.source), createdAt: this.createdAt };
  }

  token(kind = 'write') {
    return Object.freeze({ sessionId: this.sessionId, epoch: this.epoch, kind, segmentId: this.segmentId, generation: this.generation });
  }

  accepts(token) {
    if (!token || !this.sessionId || token.sessionId !== this.sessionId || token.epoch !== this.epoch || [STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.state)) return false;
    if (token.kind === 'start') {
      return token.generation === this.generation && token.segmentId === this.segmentId && (this.state === STATES.ARMING_MANUAL || (this.state === STATES.ARMING_HOLD && this.rightHeld));
    }
    return true;
  }

  result(actions = []) { return { ...this.snapshot(), actions }; }

  rightDown() {
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.state)) return this.result();
    this.sessionId = null;
    this.segmentId = null;
    this.source = null;
    this.createdAt = null;
    this.segmentCount = 0;
    this.rightHeld = true;
    this.state = STATES.ARMING_HOLD;
    return this.result([{ type: 'armHoldThreshold' }]);
  }

  holdThresholdReached(source = null) {
    if (this.state !== STATES.ARMING_HOLD || !this.rightHeld || this.sessionId) return this.result();
    this.sessionId = this.idFactory();
    this.epoch += 1;
    this.source = structuredClone(source);
    this.createdAt = this.now();
    this.newSegment();
    return this.result([
      { type: 'createDraft', sessionId: this.sessionId, source: structuredClone(this.source), createdAt: this.createdAt },
      { type: 'captureSource', token: this.token() },
      { type: 'prepareRecording', token: this.token('start'), mode: 'hold' },
    ]);
  }

  newSegment() {
    this.segmentCount += 1;
    this.segmentId = `${this.sessionId}-${this.segmentCount}`;
    this.generation += 1;
  }

  microphoneReady(token) {
    if (!this.accepts(token) || token.kind !== 'start') return this.result([{ type: 'releaseLateMicrophone', token }]);
    this.state = this.state === STATES.ARMING_HOLD ? STATES.RECORDING_HOLD : STATES.RECORDING_MANUAL;
    return this.result([{ type: 'startRecording', token: this.token(), mode: this.state === STATES.RECORDING_HOLD ? 'hold' : 'manual' }]);
  }

  rightUp() {
    this.rightHeld = false;
    if (this.state === STATES.ARMING_HOLD && !this.sessionId) {
      this.state = STATES.IDLE;
      return this.result([{ type: 'cancelHoldThreshold' }]);
    }
    if ([STATES.ARMING_HOLD, STATES.RECORDING_HOLD].includes(this.state)) return this.pause();
    return this.result();
  }

  continueRecording() {
    if (this.state !== STATES.PAUSED) throw new Error('Only a paused draft can continue recording.');
    this.newSegment();
    this.state = STATES.ARMING_MANUAL;
    return this.result([{ type: 'prepareRecording', token: this.token('start'), mode: 'manual' }]);
  }

  pause() {
    if (![STATES.ARMING_HOLD, STATES.RECORDING_HOLD, STATES.ARMING_MANUAL, STATES.RECORDING_MANUAL].includes(this.state) || !this.sessionId) return this.result();
    const token = this.token();
    const wasRecording = [STATES.RECORDING_HOLD, STATES.RECORDING_MANUAL].includes(this.state);
    this.generation += 1; // Revoke pending microphone starts before asking native code to stop.
    this.state = STATES.PAUSED;
    return this.result([{ type: wasRecording ? 'stopRecording' : 'cancelRecordingStart', token }, { type: 'showPauseChoices' }]);
  }

  discard() {
    if ([STATES.IDLE, STATES.DISCARDED, STATES.SAVED, STATES.COMMITTING].includes(this.state) || !this.sessionId) return this.result();
    const sessionId = this.sessionId;
    this.epoch += 1; // Always invalidate callbacks before emitting cleanup actions.
    this.generation += 1;
    this.state = STATES.DISCARDED;
    this.rightHeld = false;
    this.source = null;
    return this.result([{ type: 'stopAllCapture', sessionId }, { type: 'discardDraft', sessionId }]);
  }

  finish() {
    if ([STATES.COMMITTING, STATES.SAVED].includes(this.state)) return this.result();
    if (this.state !== STATES.PAUSED) throw new Error('Pause recording before completing it.');
    this.generation += 1;
    this.state = STATES.COMMITTING;
    return this.result([{ type: 'commitDraft', sessionId: this.sessionId, token: this.token() }]);
  }

  markSaved() {
    if (this.state !== STATES.COMMITTING) throw new Error('No completion is in progress.');
    this.state = STATES.SAVED;
    this.epoch += 1;
    return this.result([{ type: 'saved', sessionId: this.sessionId }]);
  }

  commitFailed() {
    if (this.state === STATES.COMMITTING) this.state = STATES.PAUSED;
    return this.result();
  }
}

module.exports = { RecordingSession, STATES };
