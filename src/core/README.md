# Core contracts

The project requires Node.js 24+ with `node:sqlite` available. These CommonJS core modules use Node built-ins. Network access is confined to explicitly approved calls to the saved AI provider: DeepSeek, OpenAI or Gemini. This document describes the current core contracts.

## RecordingSession

Methods return a serializable snapshot with `actions`. The caller executes native I/O; the class itself never enables a microphone or captures a screen.

- `rightDown()` starts only the long-press timer. A short `rightUp()` returns to idle without allocating a draft.
- `holdThresholdReached(source)` creates a session ID, freezes the original source and emits `createDraft`, `captureSource` and `prepareRecording` actions. It does nothing if released before the threshold.
- `microphoneReady(startToken)` starts only if the token still permits starting. Rejected callbacks emit `releaseLateMicrophone`: the caller must dispose of the returned native stream.
- `rightUp()` pauses the initial hold mode. It does not pause manual mode.
- `continueRecording()` from pause arms a new **manual** segment. No right mouse hold is required. `pause()` ends the segment.
- `discard()` invalidates the session epoch before cleanup actions. `finish()` accepts only pause and is idempotent during completion. Call `markSaved()` after storage commit, or `commitFailed()` on failure.

`token('start')` is a short-lived microphone-start permission: pause/release invalidates it. `token()` is a write permission: it survives pause so the final audio bytes or initial screenshot can arrive, but discard invalidates it. Always check `session.accepts(token)` before processing an asynchronous native callback. `sessionId`, `segmentId`, `epoch` and `generation` identify the expected session and operation.

## LocalStore

`new LocalStore(rootDir)` creates SQLite metadata plus `drafts/` and `records/`. Public record objects contain `id`, `status`, `source`, `title`, `task`, `notes`, `segments`, `screenshots`, `organization`, `transcript` and timestamps. Audio segments reference absolute local paths. Paths must never be accepted directly from an untrusted renderer.

```js
const draft = store.createDraft({ id: session.sessionId, source: session.source });
const writeToken = store.draftToken(draft.id);
store.addSegment(draft.id, { id: session.segmentId, order: 1, bytes, ext: 'wav' }, writeToken);
store.addScreenshot(draft.id, pngBytes, { capturedAt: Date.now() }, writeToken);
const saved = store.complete(draft.id);
```

Store tokens (`{id,generation}`) are distinct from state-machine tokens. `getToken(id)` aliases `draftToken(id)`; `store.accepts(token)` tests a local draft permission. Cancellation and completion revoke store tokens. Discarded IDs remain as minimal tombstones and cannot be reused. Passing a token into attachment writes is recommended. Synchronous writes without a token still reject unavailable drafts, but callers must also reject callbacks from an old capture session.

Wait for all native audio handles and expected final writes before `complete(id)`. Completion moves attachments and persists one saved record; repeated calls return that record. A persisted `committing` marker allows recovery after a crash between a move and the final SQLite transaction. Never invoke completion automatically for ordinary unresolved drafts.

`discard(id)` removes draft content; `deleteRecord(id)` removes saved content. Both persist cancellation before file deletion. Failed cleanup stays `delete_pending`, excluded from retrieval, and is retried on startup. `listPendingCleanup()` exposes failures. The store rejects path traversal and symbolic links below the storage root. It erases application metadata and controlled attachments, without making forensic disk-erasure guarantees.

`setTranscript(id,[{id:segmentId,text}])` accepts only known segments. `updateRecord(id,{title,task,notes})` updates user text. `saveOrganization(id,data)` and `setJob(id,kind,status,error)` accept only completed records. `listDrafts()` lists recoverable local work; `listRecords()`, `getRecord(id)` and `search(query)` only expose saved records. `getDraft(id)` and `get(id)` are also available.

`LocalStore.search()` is **local lexical search**, with exact text/word matching and Chinese character overlap fallback. An FTS5 trigram table is maintained where supported; the fallback scores saved local records directly. This describes the store method, not the application's full search capability: [semantic-service.cjs](../main/semantic-service.cjs) maintains the local E5 vector index, and [library-ai.cjs](../main/library-ai.cjs) combines semantic/lexical candidates with bounded cloud query interpretation and ranking. The inspiration cloud also uses local vector similarity and the graph functions in [semantic-graph.cjs](semantic-graph.cjs). These are retrieval and similarity features, not a library-wide RAG answer generator.

## AI clients and provider configuration

```js
const { createAIClient } = require('./ai-client.cjs');
const client = createAIClient({ provider, model, apiKey: localKey, fetchImpl });
// Only after the main process validates the applicable grant and request scope:
const organization = await client.organize(savedRecord, { approved: true, signal });
```

[`ai-providers.cjs`](ai-providers.cjs) exposes the shared catalog in [`../shared/ai-providers.js`](../shared/ai-providers.js), including defaults, model validation and image-support checks. The current defaults are `deepseek-flash`, `gpt-5.4-mini` and `gemini-3.8-flash`. Model names may be customized: 1–100 ASCII letters, digits, dots, underscores, colons or hyphens, beginning with a letter or digit. The selected model must support the provider's JSON response format.

[`createAIClient()`](ai-client.cjs) returns the existing `DeepSeekClient` for DeepSeek or a native provider adapter for OpenAI and Gemini. All adapters reuse the task prompts, evidence and grouping validators. They expose `provider`, `model` and the same task methods. The endpoints are fixed:

| Provider | Endpoint and response format |
| --- | --- |
| DeepSeek | `https://api.deepseek.com/chat/completions`, JSON Chat Completions |
| OpenAI | `https://api.openai.com/v1/responses`, `text.format.type = json_object`, `store: false` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{encodedModel}:generateContent`, `responseMimeType = application/json` |

Task-level `maxTokens` is an answer-planning budget of 1–4096 tokens. OpenAI passes it as `max_output_tokens`; the GPT-5.4 presets use `reasoning.effort = none`. Gemini 3 presets use `thinkingLevel = low` and `maxOutputTokens = Math.max(2048, maxTokens)`, so even small tasks such as automatic naming receive a total allowance of at least 2048 tokens for thinking and the answer. Gemini usage includes thought tokens in completion usage. A value such as the library coordinator's 1500-token budget is therefore not a uniform provider-level output cap. See [`ai-client.cjs`](ai-client.cjs) for the adapter-specific limits.

Cloud methods require `approved === true` before requesting the service. The main process enforces enabled capabilities, request scope and either per-request confirmation or the explicitly accepted persistent click-to-send grant. Development and test calls require the human user's explicit approval for that particular real call.

The main process snapshots the saved provider, model and its own decrypted key for each task. Saving another active provider, model or key cancels the old in-flight work and clears query caches. Search cache identity includes provider and model; the duplicate-pair cache also tracks that identity. Late responses must still pass the task's current-configuration and record-version checks before application.

[`Settings`](../main/settings.cjs) stores independent `aiProfiles` for `deepseek`, `openai` and `gemini`. `key(provider)` decrypts only the requested profile; public settings expose its model and `hasApiKey`, without encrypted or plaintext credentials. Legacy single-provider fields migrate into the DeepSeek profile in memory without rewriting the settings file. Reset preserves every protected key blob, restores provider/model defaults and revokes capabilities. Selecting another provider with enabled cloud scopes requires fresh approval before saving. [User setup](../../docs/AI_PROVIDER_SETUP.md) describes the form and account requirements.

`organize()` accepts a saved record with nonempty segment transcripts. It sends that record's task, notes, segment IDs/text, saved source application/window title/URL clues, locally selected available topic names and already assigned topic names. An explicitly authorized image may also be attached through the separate `image` option. Both the main process and adapter check `supportsImages(provider, model)` before using an image. Unsupported combinations fail with a visible message; the client does not silently discard an authorized image and continue as text-only. No original audio or video is sent. Single-record organization excludes other records' bodies. The app's image loader and permission checks live outside this module; passing an image is not permission to read an arbitrary local file.

The current organization result uses schema version 2: a title, summary, verbatim evidence, optional key points, uncertainties, topic suggestions and bounded context clues, with model/usage metadata. Refer to `organize()` and `validateOrganization()` in [deepseek.cjs](deepseek.cjs) for exact fields, limits and legacy compatibility. Every evidence segment must exist and every quote must be a literal substring of that segment's transcript. This proves the cited text exists, not that all generated interpretation is correct. Image-derived context is not a verified URL or evidence of the speaker's intent. Keep original transcripts and audio; summaries and grouping suggestions do not replace them.

For batch organization, `deferGrouping` requests per-record summaries without individual topic recommendations. `classifyBatch()` then compares only the approved batch's titles, summaries and selected existing group names, with record IDs and content versions. Its separate schema and validators check complete, unique membership and grouping limits; classification failure preserves the summaries and does not create groups. The batch coordinator in [batch-organizer.cjs](../main/batch-organizer.cjs) freezes the visible record scope, and the UI requires confirmation before applying classifications.

Other methods have narrower task-specific inputs: title generation sends bounded transcript text; query interpretation sends the description; candidate ranking and duplicate checks send bounded selected candidate fragments and context. See the corresponding methods for their protocols. The client does not automatically retry failed requests.

OpenAI and Gemini adapters validate their native response envelope, completion status and JSON object before passing results to the shared task validators. They normalize usage fields for the application and reject responses containing the submitted key. Provider error bodies are not echoed into the UI. Failed or cancelled calls are not automatically retried.

Inject `fetchImpl` for mock tests. Local tests use synthetic inputs and do not require a real key or call a real API. The current multi-provider change has been validated with mocked requests; no real AI API call was made during this development work.
