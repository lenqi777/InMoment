'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { MODEL_MANIFEST, EXTRA_FILES, validModelDirectory } = require('../src/main/semantic-installer.cjs');

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function readPackage(directory) { return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); }
function validPackageName(name) { return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) && !name.split('/').some(part => part === '.' || part === '..'); }
function supportsPlatform(values, selected) {
  if (!values) return true;
  const entries = Array.isArray(values) ? values : [values];
  return !entries.includes('!' + selected) && (!entries.some(value => !value.startsWith('!')) || entries.includes(selected) || entries.includes('any'));
}
function resolvePackage(name, requester, moduleRoot) {
  if (!validPackageName(name) || name === 'electron') throw new Error('Not an allowed production dependency: ' + name);
  const localRequire = createRequire(path.join(requester, 'package.json'));
  for (const directory of localRequire.resolve.paths(name) || []) {
    if (!within(moduleRoot, directory)) continue;
    const candidate = path.join(directory, ...name.split('/'));
    if (!fs.existsSync(path.join(candidate, 'package.json'))) continue;
    const source = fs.realpathSync(candidate);
    if (!within(moduleRoot, source)) throw new Error('Production dependency resolves outside the project node_modules: ' + name);
    const metadata = readPackage(source);
    if (metadata.name !== name || typeof metadata.version !== 'string') throw new Error('Production package metadata does not match: ' + name);
    return { source, metadata };
  }
  return null;
}
function copyRuntimePackage(source, target, metadata, { platform, arch }) {
  const excluded = new Set(['node_modules', '.git', '.github', '.cache', '.npmrc', '.yarnrc', '.yarnrc.yml', 'test', 'tests', '__tests__', 'fixtures', 'example', 'examples', 'coverage']);
  function copy(from, to, parents = new Set()) {
    const relative = path.relative(source, from); const parts = relative.split(path.sep);
    if (relative && (parts.some(part => excluded.has(part) || part === '.env' || part.startsWith('.env.')) || /\.(?:log|key|p12|pfx)$/iu.test(relative))) return;
    // This archive contains several operating systems' native binaries. The
    // portable app only needs the target Windows x64 runtime.
    if (metadata.name === 'onnxruntime-node' && parts[0] === 'bin' && parts[1] === 'napi-v3' && ((parts[2] && parts[2] !== platform) || (parts[3] && parts[3] !== arch))) return;
    const actual = fs.realpathSync(from);
    if (!within(source, actual)) throw new Error('A runtime package link escapes its package: ' + metadata.name);
    const stat = fs.statSync(actual);
    if (stat.isDirectory()) {
      if (parents.has(actual)) throw new Error('Circular runtime package link: ' + metadata.name);
      const nextParents = new Set(parents).add(actual); fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(actual)) copy(path.join(from, name), path.join(to, name), nextParents);
    } else if (stat.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(actual, to); }
    else throw new Error('Unsupported runtime package entry: ' + metadata.name);
  }
  copy(source, target);
}

// Read metadata without importing packages or running install scripts. pnpm's
// links are resolved to an explicit production closure copied as ordinary files.
function copyProductionDependencies(root, appDir, { platform = 'win32', arch = 'x64' } = {}) {
  const metadata = readPackage(root); const packageRoot = path.join(root, 'node_modules');
  const required = { ...metadata.dependencies }; const optional = { ...metadata.optionalDependencies };
  if (!Object.keys({ ...required, ...optional }).length) return [];
  const moduleRoot = fs.realpathSync(packageRoot);
  const scope = { target: appDir, source: root, children: new Map(), parent: null };
  const queue = []; const records = [];
  function attach(name, requester, isOptional) {
    let resolved;
    try { resolved = resolvePackage(name, requester.source, moduleRoot); }
    catch (error) { if (isOptional && error.code === 'ENOENT') return; throw error; }
    if (!resolved) { if (isOptional) return; throw new Error('Missing production dependency: ' + name); }
    if (!supportsPlatform(resolved.metadata.os, platform) || !supportsPlatform(resolved.metadata.cpu, arch)) {
      if (isOptional) return; throw new Error('Production dependency does not support this build: ' + name);
    }
    for (let ancestor = requester; ancestor; ancestor = ancestor.parent) {
      const existing = ancestor.children.get(name); if (existing?.source === resolved.source) return existing;
    }
    const destinationScope = !scope.children.has(name) ? scope : requester;
    const existing = destinationScope.children.get(name);
    if (existing) { if (existing.source !== resolved.source) throw new Error('Conflicting production dependency at one location: ' + name); return existing; }
    const target = path.join(destinationScope.target, 'node_modules', ...name.split('/'));
    const node = { source: resolved.source, target, metadata: resolved.metadata, children: new Map(), parent: destinationScope };
    destinationScope.children.set(name, node); queue.push(node); return node;
  }
  for (const name of Object.keys({ ...required, ...optional }).sort()) attach(name, scope, Object.hasOwn(optional, name));
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]; copyRuntimePackage(node.source, node.target, node.metadata, { platform, arch });
    records.push({ name: node.metadata.name, version: node.metadata.version, license: node.metadata.license || 'See package notices', directory: path.relative(appDir, node.target).split(path.sep).join('/') });
    const optionalDependencies = node.metadata.optionalDependencies || {};
    const dependencies = { ...node.metadata.dependencies, ...node.metadata.peerDependencies, ...optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) attach(name, node, Object.hasOwn(optionalDependencies, name) || node.metadata.peerDependenciesMeta?.[name]?.optional === true);
  }
  fs.writeFileSync(path.join(appDir, 'RUNTIME-DEPENDENCIES.json'), JSON.stringify({ platform, arch, packages: records }, null, 2));
  return records;
}
function verifyFileDigest(filename, file) {
  const stat = fs.statSync(filename); if (!stat.isFile() || stat.size !== file.size) throw new Error('Bundled model file size mismatch: ' + file.path);
  const hash = crypto.createHash(file.sha256 ? 'sha256' : 'sha1'); if (!file.sha256) hash.update(`blob ${file.size}\0`);
  const descriptor = fs.openSync(filename, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(descriptor); }
  if (hash.digest('hex') !== (file.sha256 || file.gitSha1)) throw new Error('Bundled model file integrity mismatch: ' + file.path);
}
function copySemanticModel(source, destination, { manifest = MODEL_MANIFEST } = {}) {
  if (!validModelDirectory(source, manifest)) throw new Error('Install and verify the optional local semantic model before packaging with --with-semantic.');
  if (fs.existsSync(destination)) throw new Error('Semantic bundle destination already exists.');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of [...manifest.files.map(file => file.path), ...EXTRA_FILES]) {
    const output = path.join(destination, ...name.split('/')); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(source, ...name.split('/')), output);
  }
  for (const file of manifest.files) verifyFileDigest(path.join(destination, ...file.path.split('/')), file);
  if (!validModelDirectory(destination, manifest)) throw new Error('Semantic model bundle is incomplete.');
}
function verifyRuntimeImport(executable, appDir, { temporaryRoot = os.tmpdir(), spawnImpl = spawnSync } = {}) {
  const temporaryParent = fs.realpathSync(temporaryRoot); const prefix = 'inmoment-runtime-import-';
  if (within(fs.realpathSync(path.resolve(__dirname, '..')), temporaryParent)) throw new Error('Runtime import validation requires a temporary directory outside the checkout.');
  const directory = fs.mkdtempSync(path.join(temporaryParent, prefix));
  try {
    // Copy exactly the portable runtime closure, never a model, app source,
    // settings, databases or media. Normal files also eliminate pnpm fallback.
    fs.copyFileSync(path.join(appDir, 'package.json'), path.join(directory, 'package.json'));
    fs.cpSync(path.join(appDir, 'node_modules'), path.join(directory, 'node_modules'), { recursive: true, filter: filename => {
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Portable runtime import validation rejects dependency links.'); return true;
    } });
    const probe = `
      import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import https from 'node:https';
      import { fileURLToPath } from 'node:url'; import { registerHooks, syncBuiltinESMExports } from 'node:module';
      const root = fs.realpathSync(path.join(process.cwd(), 'node_modules'));
      function contained(filename) { const relative = path.relative(root, fs.realpathSync(filename)); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
      registerHooks({ resolve(specifier, context, nextResolve) { const result = nextResolve(specifier, context); if (result.url.startsWith('file:') && !contained(fileURLToPath(result.url))) throw new Error('Dependency resolved outside isolated portable runtime'); if (!result.url.startsWith('file:') && !result.url.startsWith('node:')) throw new Error('Unsupported runtime import protocol'); return result; } });
      const denied = () => { throw new Error('Network is disabled during import validation'); };
      globalThis.fetch = denied; http.request = http.get = https.request = https.get = denied; syncBuiltinESMExports();
      const entry = fileURLToPath(import.meta.resolve('@huggingface/transformers')); if (!contained(entry)) throw new Error('Runtime entry is outside temporary node_modules');
      const runtime = await import('@huggingface/transformers'); if (typeof runtime.pipeline !== 'function') throw new Error('Missing runtime export');
      console.log('Isolated runtime import verified; no model was loaded or executed.');
    `;
    const result = spawnImpl(path.resolve(executable), ['--input-type=module', '-e', probe], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 45000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1', INMOMENT_DISABLE_NETWORK: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    if (result.error || result.status !== 0) throw new Error('Portable production runtime import failed: ' + (result.error?.message || result.stderr || result.stdout));
    console.log(result.stdout.trim());
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith(prefix) || path.basename(resolved) === prefix || fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved) throw new Error('Refusing to clean an unexpected runtime validation directory.');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
module.exports = { copyProductionDependencies, copySemanticModel, verifyRuntimeImport };
