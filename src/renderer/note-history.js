'use strict';

(() => {
  const limit = 60;
  const mergeDelay = 750;
  const maxHistoryText = 6_000_000;
  const mergeable = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);

  function snapshot(note, selection) {
    const { title, body, document, documentSignature } = note;
    return { title, body, document, documentSignature, selection };
  }

  function record(note, before, after, kind) {
    if (before.title === after.title && before.body === after.body && before.documentSignature === after.documentSignature) return;
    const history = note.history ||= { undo: [], redo: [] };
    const previous = history.undo.at(-1);
    const time = performance.now();
    const merge = !history.redo.length && previous && mergeable.has(kind) && previous.kind === kind &&
      time - previous.time < mergeDelay && before.selection && after.selection &&
      before.selection.field === after.selection.field && JSON.stringify(previous.after.selection) === JSON.stringify(before.selection);
    history.redo.length = 0;
    if (merge) Object.assign(previous, { after, time });
    else history.undo.push({ before, after, kind, time });
    let size = 0;
    for (let i = history.undo.length - 1; i >= 0; i--) {
      size += history.undo[i].before.documentSignature.length + history.undo[i].before.title.length;
      if (i < history.undo.length - 1 && (size > maxHistoryText || history.undo.length - i > limit)) {
        history.undo.splice(0, i + 1);
        break;
      }
    }
  }

  function step(note, action) {
    const history = note.history;
    if (!history) return null;
    const entry = history[action].pop();
    if (!entry) return null;
    entry.time = 0;
    history[action === 'undo' ? 'redo' : 'undo'].push(entry);
    return action === 'undo' ? entry.before : entry.after;
  }

  window.InMomentNoteHistory = Object.freeze({ snapshot, record, step });
})();
