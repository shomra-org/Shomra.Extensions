import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';

const SOURCE = 'Shomra';

/**
 * AI-artifact path patterns the gate understands — a mirror of the CLI's
 * ARTIFACT_MATCHERS. ONLY these files are checked; every other file is ignored,
 * so the extension never gates a random source file.
 */
const ARTIFACT_RES: RegExp[] = [
  /(^|\/)\.?mcp\.json$/i,
  /(^|\/)SKILL\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)GEMINI\.md$/i,
  /(^|\/)\.cursorrules$/i,
  /(^|\/)\.windsurfrules$/i,
  /(^|\/)\.clinerules$/i,
  /(^|\/)copilot-instructions\.md$/i,
  /(^|\/)\.claude\/(commands|agents)\/[^/]+\.md$/i,
  /(^|\/)\.claude\/settings(\.local)?\.json$/i,
  /(^|\/)\.cursor\/rules\/[^/]+\.mdc?$/i,
  /(^|\/)\.well-known\/agent\.json$/i,
];

function isArtifact(fileName: string): boolean {
  const p = fileName.replace(/\\/g, '/');
  return ARTIFACT_RES.some((re) => re.test(p));
}

/**
 * Source files that can *load an AI model* — Python, notebooks, and JS/TS.
 * These aren't gated as artifacts; instead `shomra models` scans them for model
 * references (from_pretrained / SentenceTransformer / hf_hub_download / …) and
 * looks each up in the Model Security Index. Narrower than the CLI's full scan
 * set (which also reads yaml/toml/txt) to keep on-save latency low in the editor.
 */
const MODEL_RES = /\.(py|ipynb|[mc]?[jt]sx?)$/i;
function isModelScannable(fileName: string): boolean {
  return MODEL_RES.test(fileName.replace(/\\/g, '/'));
}

/** Raised when the `shomra` binary can't be found on PATH / at the configured path. */
class ShomraNotFound extends Error {}

let diagnostics: vscode.DiagnosticCollection;
// Model-index findings live in their own collection so they don't clobber (or
// get clobbered by) the artifact gate — a file is one or the other, never both.
let modelDiags: vscode.DiagnosticCollection;

type Kwarg = { name: string; value: string; reason: string };
// Per-file, per-(0-based)line remediation plan from the last `shomra models` run,
// so the "Harden this model load" quick-fix knows which kwargs to offer.
const modelFixByUri = new Map<string, Map<number, { id: string; kwargs: Kwarg[] }>>();
// Document version last scanned per file uri, so opening/focusing an already-
// scanned tab doesn't respawn the CLI. A save always forces a fresh scan.
const lastScanned = new Map<string, number>();
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let warnedMissing = false;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('shomra');
  modelDiags = vscode.languages.createDiagnosticCollection('shomra-models');
  output = vscode.window.createOutputChannel('Shomra');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'shomra.checkWorkspace';
  setStatus(0, 0, 0);
  context.subscriptions.push(diagnostics, modelDiags, output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('shomra.checkWorkspace', () => checkWorkspace()),
    vscode.commands.registerCommand('shomra.checkFile', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkFile(doc, true);
    }),
    vscode.commands.registerCommand('shomra.checkModelsFile', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkModelRefs(doc, true);
    }),
    vscode.commands.registerCommand('shomra.hardenModelLoad', (uri?: vscode.Uri, line?: number) => hardenModelLoad(uri, line)),
    vscode.commands.registerCommand('shomra.fixFile', (uri?: vscode.Uri) => fixFile(uri)),
    vscode.commands.registerCommand('shomra.explainFile', (uri?: vscode.Uri) => explainFile(uri)),
    vscode.commands.registerCommand('shomra.installHook', () => {
      const term = vscode.window.createTerminal('Shomra');
      term.show();
      term.sendText('shomra install-hook');
    }),
  );

  // Ambient checking — save is the primary loop; open catches problems earlier.
  // Two independent detectors run on the same triggers: the artifact gate
  // (checkFile) and the model-index lookup (checkModelRefs), each scoped to the
  // file types it understands.
  context.subscriptions.push(
    // Save is the primary loop — content just changed, so always re-scan.
    vscode.workspace.onDidSaveTextDocument((doc) => ambientCheck(doc, { force: true, gate: 'checkOnSave' })),
    // Opening a file scans it right away…
    vscode.workspace.onDidOpenTextDocument((doc) => ambientCheck(doc)),
    // …and so does switching to it. onDidOpen does NOT fire for a tab that's
    // already open (or restored from a previous session), so without this the
    // check would appear to run "only on save." Version-guarded, so flipping
    // between unchanged tabs is a no-op.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document) ambientCheck(editor.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // Keep diagnostics for saved files; only drop untitled scratch buffers.
      if (doc.isUntitled) {
        diagnostics.delete(doc.uri);
        modelDiags.delete(doc.uri);
      }
      lastScanned.delete(doc.uri.toString());
    }),
  );

  // One-click fix on any flagged artifact.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ShomraFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // Check whatever files are already open (incl. the focused one), plus an
  // optional full sweep.
  for (const doc of vscode.workspace.textDocuments) ambientCheck(doc);
  if (vscode.window.activeTextEditor?.document) ambientCheck(vscode.window.activeTextEditor.document);
  if (cfg<boolean>('checkWorkspaceOnStartup', false)) checkWorkspace();
}

export function deactivate() {
  diagnostics?.clear();
  modelDiags?.clear();
}

// ── config + process ──────────────────────────────────────────────

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('shomra').get<T>(key, def);
}

/**
 * Run the ambient checks (artifact gate + model-index lookup) for a document.
 * Runs at most once per (uri, document version) unless `force`, so opening or
 * focusing an unchanged tab doesn't respawn the CLI. `gate` selects which on/off
 * setting applies — `checkOnOpen` for open/focus, `checkOnSave` for saves.
 */
function ambientCheck(doc: vscode.TextDocument, opts: { force?: boolean; gate?: 'checkOnOpen' | 'checkOnSave' } = {}) {
  if (doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (!opts.force && lastScanned.get(key) === doc.version) return;
  lastScanned.set(key, doc.version);
  if (cfg<boolean>(opts.gate ?? 'checkOnOpen', true)) checkFile(doc);
  if (cfg<boolean>('checkModels', true)) checkModelRefs(doc);
}

/** Resolve `shomra.executable` into a spawnable command + leading args. */
function invocation(): { cmd: string; base: string[]; asNode: boolean } {
  const exe = cfg<string>('executable', 'shomra').trim();
  // A script path (…/shomra.mjs) is run with THIS process's runtime. In the VS
  // Code extension host `process.execPath` is the Electron binary, which only
  // behaves as plain Node when ELECTRON_RUN_AS_NODE=1 (set in runShomra).
  if (/\.(mjs|js|cjs)$/i.test(exe)) return { cmd: process.execPath, base: [exe], asNode: true };
  const parts = exe.split(/\s+/);
  if (parts.length > 1) return { cmd: parts[0], base: parts.slice(1), asNode: false };
  return { cmd: exe || 'shomra', base: [], asNode: false };
}

/**
 * Run the CLI and return its output. A non-zero exit (1 = blocked, 2 = flagged)
 * is NORMAL — we resolve with the code and parse stdout regardless; only a
 * missing binary rejects.
 */
function runShomra(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { cmd, base, asNode } = invocation();
  const argv = [...base, ...args];
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  // Make the Electron host binary run our .mjs as a plain Node script.
  if (asNode) env.ELECTRON_RUN_AS_NODE = '1';
  output.appendLine(`$ ${asNode ? '[node] ' : cmd + ' '}${argv.join(' ')}   (cwd: ${cwd})`);
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      argv,
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
      (err: any, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || err.errno === -4058 || err.errno === 'ENOENT')) {
          reject(new ShomraNotFound());
          return;
        }
        const code = typeof err?.code === 'number' ? err.code : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function parse(stdout: string): any | null {
  const s = stdout.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function folderFor(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
}

function handleRunError(e: unknown) {
  if (e instanceof ShomraNotFound) {
    if (warnedMissing) return;
    warnedMissing = true;
    const exe = cfg<string>('executable', 'shomra');
    vscode.window
      .showWarningMessage(
        `Shomra CLI not found (tried "${exe}"). Set "shomra.executable" to the full path of shomra.mjs, or install \`npm i -g @shomra/agent\`. Then reload the window.`,
        'Open Settings',
      )
      .then((pick) => {
        if (pick === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'shomra.executable');
      });
    return;
  }
  output.appendLine(`error: ${(e as Error)?.message ?? e}`);
}

// ── checking ──────────────────────────────────────────────────────

async function checkFile(doc: vscode.TextDocument, notifyClean = false) {
  if (doc.uri.scheme !== 'file' || !isArtifact(doc.fileName)) {
    diagnostics.delete(doc.uri);
    return;
  }
  let out;
  try {
    out = await runShomra(['gate', doc.fileName, '--json'], folderFor(doc.uri));
  } catch (e) {
    handleRunError(e);
    return;
  }
  const result = parse(out.stdout);
  if (!result) {
    output.appendLine(`checkFile: no JSON for ${doc.fileName} — ${out.stderr.trim() || '(no stderr)'}`);
    return;
  }
  const diags = buildDiagnostics(doc.getText(), result.findings ?? []);
  diagnostics.set(doc.uri, diags);
  if (notifyClean && diags.length === 0) {
    vscode.window.showInformationMessage(`Shomra: ${path.basename(doc.fileName)} is clean.`);
  }
}

// ── model-index lookup ────────────────────────────────────────────

/**
 * Scan a source file for AI-model references (from_pretrained / hf_hub_download /
 * SentenceTransformer / …) and surface any that are known-vulnerable in the
 * Shomra Model Index as diagnostics anchored on the model-load line. The CLI
 * (`shomra models <file> --json`) does the detection and the lookup; this only
 * renders the result. Silent on clean or not-yet-indexed models.
 */
async function checkModelRefs(doc: vscode.TextDocument, notifyClean = false) {
  if (doc.uri.scheme !== 'file' || !isModelScannable(doc.fileName)) {
    modelDiags.delete(doc.uri);
    return;
  }
  let out;
  try {
    out = await runShomra(['models', doc.fileName, '--json'], folderFor(doc.uri));
  } catch (e) {
    handleRunError(e);
    return;
  }
  const result = parse(out.stdout);
  if (!result || !Array.isArray(result.models)) {
    modelDiags.delete(doc.uri);
    return;
  }
  const text = doc.getText();
  const base = typeof result.url === 'string' ? result.url.replace(/\/+$/, '') : '';
  const diags: vscode.Diagnostic[] = [];
  const fixes = new Map<number, { id: string; kwargs: Kwarg[] }>();
  for (const m of result.models ?? []) {
    // Only known-vulnerable models raise a squiggle. `notIndexed` (not scanned
    // yet), local runtimes and OK verdicts stay silent — no noise on clean code.
    if (!m.found || m.alert === 'OK') continue;
    const sev = m.alert === 'BLOCK' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const titles = (m.findings ?? []).slice(0, 3).map((f: any) => f.title).join('; ');
    const more = (m.findingCount ?? 0) > 3 ? ` (+${m.findingCount - 3} more)` : '';
    const message = `Known-vulnerable AI model: ${m.id} — ${m.verdict} (risk ${m.riskScore}). ${m.findingCount} finding(s): ${titles}${more}. Source: Shomra Model Index.`;
    const slug = String(m.id).replace(/\//g, '__');
    const kwargs: Kwarg[] = Array.isArray(m.fix?.kwargs) ? m.fix.kwargs : [];
    for (const loc of m.locations ?? []) {
      const line0 = Math.max(0, (loc.line ?? 1) - 1);
      const d = new vscode.Diagnostic(rangeFor(text, { line: loc.line, title: m.id }), message, sev);
      d.source = SOURCE;
      d.code = base ? { value: `model:${m.verdict}`, target: vscode.Uri.parse(`${base}/models/${slug}`) } : `model:${m.verdict}`;
      diags.push(d);
      if (kwargs.length) fixes.set(line0, { id: m.id, kwargs });
    }
  }
  modelDiags.set(doc.uri, diags);
  modelFixByUri.set(doc.uri.toString(), fixes);
  if (notifyClean && diags.length === 0) {
    const n = result.detected ?? 0;
    vscode.window.showInformationMessage(
      n ? `Shomra: ${n} model reference(s) — no known vulnerabilities.` : `Shomra: no AI model references in ${path.basename(doc.fileName)}.`,
    );
  }
}

/**
 * "Harden this model load" quick-fix. Offers the safe-loading kwargs Shomra
 * recommended for the flagged model in a multi-select picker — the developer
 * CHOOSES which to apply — then rewrites the `from_pretrained(...)` call in place
 * (clean undo). Deterministic; no AI, no network beyond the model lookup.
 */
async function hardenModelLoad(uri?: vscode.Uri, line?: number) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = vscode.window.activeTextEditor;
  // Resolve the line: explicit arg (from the code-action) or the cursor.
  const line0 = typeof line === 'number' ? line : editor?.selection.active.line ?? -1;
  const plan = modelFixByUri.get(target.toString())?.get(line0);
  if (!plan || !plan.kwargs.length) {
    vscode.window.showInformationMessage('Shomra: no model-hardening suggestions for this line. Save the file to re-scan.');
    return;
  }

  const picks = await vscode.window.showQuickPick(
    plan.kwargs.map((k) => ({ label: `${k.name}=${k.value}`, detail: k.reason, picked: true, kwarg: k })),
    {
      canPickMany: true,
      title: `Harden load of ${plan.id}`,
      placeHolder: 'Choose the safe-loading arguments to add to from_pretrained(…)',
    },
  );
  if (!picks || !picks.length) return;

  const lineText = doc.lineAt(line0).text;
  const newLine = injectKwargs(lineText, picks.map((p) => p.kwarg));
  if (newLine === null) {
    vscode.window.showWarningMessage("Shomra: couldn't rewrite this call automatically (it may span multiple lines). Add the kwargs by hand.");
    return;
  }
  if (newLine === lineText) {
    vscode.window.showInformationMessage('Shomra: those arguments are already present.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(target, doc.lineAt(line0).range, newLine);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  vscode.window.showInformationMessage(`Shomra: hardened the load of ${plan.id} (${picks.length} argument${picks.length === 1 ? '' : 's'}).`);
  await checkModelRefs(doc);
}

/**
 * Insert `name=value` kwargs into the model-loading call on a single line,
 * balance-matching the loader's parentheses (so trailing `.to(device)` etc.
 * doesn't confuse it). Skips any kwarg already present. Returns null if the call
 * spans multiple lines (we don't rewrite those) or no loader call is found.
 */
function injectKwargs(line: string, kwargs: Kwarg[]): string | null {
  const m = line.match(/\.?(from_pretrained|hf_hub_download|snapshot_download|SentenceTransformer|CrossEncoder|InferenceClient|pipeline)\s*\(/);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1; // index of the '('
  let depth = 0;
  let close = -1;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null; // unbalanced on this line → multi-line call
  const inner = line.slice(open + 1, close);
  // Skip any kwarg already passed (a repeated keyword arg is a Python SyntaxError).
  // The kwarg names are distinctive, so no word-boundary anchor is needed.
  const toAdd = kwargs.filter((k) => !new RegExp(`${k.name}\\s*=`).test(inner));
  if (!toAdd.length) return line;
  const args = toAdd.map((k) => `${k.name}=${k.value}`).join(', ');
  const needsComma = inner.trim().length > 0;
  return line.slice(0, close) + (needsComma ? ', ' : '') + args + line.slice(close);
}

async function checkWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showInformationMessage('Shomra: open a folder to check.');
    return;
  }
  status.text = '$(loading~spin) Shomra';
  diagnostics.clear();
  let blocked = 0;
  let flagged = 0;
  let total = 0;
  for (const folder of folders) {
    let out;
    try {
      out = await runShomra(['check', folder.uri.fsPath, '--json'], folder.uri.fsPath);
    } catch (e) {
      handleRunError(e);
      setStatus(blocked, flagged, total);
      return;
    }
    const data = parse(out.stdout);
    if (!data) {
      output.appendLine(`checkWorkspace: no JSON for ${folder.uri.fsPath} — ${out.stderr.trim() || '(no stderr)'}`);
      continue;
    }
    blocked += data.blocked ?? 0;
    flagged += data.flagged ?? 0;
    total += data.scanned ?? 0;
    for (const r of data.results ?? []) {
      const full: string = r.full || path.join(folder.uri.fsPath, r.path);
      const uri = vscode.Uri.file(full);
      let text = '';
      try {
        text = (await vscode.workspace.openTextDocument(uri)).getText();
      } catch {
        text = '';
      }
      diagnostics.set(uri, buildDiagnostics(text, r.findings ?? []));
    }
  }
  setStatus(blocked, flagged, total);
  vscode.window.showInformationMessage(
    total ? `Shomra: ${total} artifact(s) — ${blocked} blocked, ${flagged} flagged.` : 'Shomra: no AI artifacts found.',
  );
}

// ── fixing ────────────────────────────────────────────────────────

async function fixFile(uri?: vscode.Uri) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    vscode.window.showWarningMessage('Shomra: open an AI-artifact file to fix.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  if (!isArtifact(doc.fileName)) {
    vscode.window.showWarningMessage('Shomra: this is not an AI artifact the gate understands.');
    return;
  }
  if (doc.isDirty) await doc.save();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shomra: generating fix for ${path.basename(doc.fileName)}…` },
    async () => {
      let out;
      try {
        out = await runShomra(['fix', doc.fileName, '--json'], folderFor(target));
      } catch (e) {
        handleRunError(e);
        return;
      }
      const res = parse(out.stdout);
      if (!res) {
        // No JSON usually means a hard stop (e.g. not enrolled) — surface the reason.
        const reason = (out.stderr.trim().split('\n').find((l) => l.trim()) ?? 'fix failed').replace(/\[[0-9;]*m/g, '');
        vscode.window.showErrorMessage(`Shomra: ${reason}`);
        output.appendLine(out.stderr || out.stdout);
        return;
      }
      if (!res.canFix) {
        const msg = `Shomra: ${res.message ?? 'no fix available.'}`;
        if (res.reason === 'ai-disabled' || res.reason === 'ai-error') vscode.window.showWarningMessage(msg);
        else vscode.window.showInformationMessage(msg);
        return;
      }
      // Apply the returned fixed bytes through a full-document edit, so the
      // change joins VS Code's undo stack and the open editor updates in place.
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(target, fullRange, String(res.fixedContent ?? ''));
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      const n = res.findingCount ?? (res.findings?.length ?? 0);
      vscode.window.showInformationMessage(`Shomra: applied fix — ${res.explanation || `${n} finding(s) addressed`}`);
      await checkFile(doc);
    },
  );
}

// ── explaining ────────────────────────────────────────────────────

async function explainFile(uri?: vscode.Uri) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    vscode.window.showWarningMessage('Shomra: open an AI-artifact file to explain.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  if (!isArtifact(doc.fileName)) {
    vscode.window.showWarningMessage('Shomra: this is not an AI artifact the gate understands.');
    return;
  }
  if (doc.isDirty) await doc.save();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shomra: explaining ${path.basename(doc.fileName)}…` },
    async () => {
      let out;
      try {
        out = await runShomra(['why', doc.fileName, '--json'], folderFor(target));
      } catch (e) {
        handleRunError(e);
        return;
      }
      const res = parse(out.stdout);
      if (!res || !Array.isArray(res.findings)) {
        const reason = (out.stderr.trim().split('\n').find((l) => l.trim()) ?? 'explain failed').replace(/\[[0-9;]*m/g, '');
        vscode.window.showErrorMessage(`Shomra: ${reason}`);
        return;
      }
      if (!res.findings.length) {
        vscode.window.showInformationMessage(`Shomra: ${path.basename(doc.fileName)} is clean — nothing to explain.`);
        return;
      }
      output.clear();
      output.appendLine(`Shomra — why  ${doc.fileName}`);
      if (res.summary) output.appendLine(`\n${res.summary}`);
      for (const f of res.findings) {
        const at = f.line ? ` (line ${f.line})` : '';
        const fp = f.likelyFalsePositive ? '  — likely false positive' : '';
        output.appendLine(`\n● [${f.severity}] ${f.title}${at}${fp}`);
        if (f.why) output.appendLine(`  why: ${f.why}`);
        if (f.exploit) output.appendLine(`  exploit: ${f.exploit}`);
        if (f.assessment) output.appendLine(`  ${f.assessment}`);
        if (f.remediationText) output.appendLine(`  fix: ${f.remediationText}`);
      }
      output.show(true);
      vscode.window.showInformationMessage(`Shomra: ${res.summary || `${res.findings.length} finding(s) explained`} — see Output → Shomra.`);
    },
  );
}

// ── diagnostics ───────────────────────────────────────────────────

function severityOf(sev: string): vscode.DiagnosticSeverity {
  switch (String(sev).toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return vscode.DiagnosticSeverity.Error;
    case 'MEDIUM':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function buildDiagnostics(text: string, findings: any[]): vscode.Diagnostic[] {
  return (findings ?? []).map((f) => {
    const d = new vscode.Diagnostic(
      rangeFor(text, f),
      f.remediationText ? `${f.title} — ${f.remediationText}` : String(f.title ?? 'Finding'),
      severityOf(f.severity),
    );
    d.source = SOURCE;
    if (f.class) d.code = String(f.class);
    return d;
  });
}

/**
 * The gate now resolves a 1-based `line` for most findings (analyzer
 * `evidence.line`), so anchor the squiggle on exactly that line. Fall back to
 * the snippet heuristic only when no line came through.
 */
function rangeFor(text: string, finding: any): vscode.Range {
  const lines = text.split(/\r?\n/);
  if (typeof finding.line === 'number' && finding.line >= 1 && finding.line <= lines.length) {
    const i = finding.line - 1;
    const lineText = lines[i] ?? '';
    const start = lineText.length - lineText.trimStart().length;
    const end = lineText.trimEnd().length;
    return new vscode.Range(i, Math.max(0, start), i, Math.max(start + 1, end || lineText.length));
  }
  return locate(text, finding);
}

/**
 * Best-effort line resolution: the gate findings don't carry line numbers, so
 * we look for a representative snippet — a quoted phrase in the finding text,
 * or a class-typical token (an injection phrase, a secret prefix, a shell
 * installer) — and anchor the squiggle there. Falls back to the first
 * non-empty line so a finding is never lost, just less precisely placed.
 */
function locate(text: string, finding: any): vscode.Range {
  const candidates: string[] = [];
  for (const s of [finding.title, finding.detail, finding.remediationText]) {
    if (typeof s !== 'string') continue;
    const m = s.match(/["'“]([^"'”]{6,120})["'”]/);
    if (m) candidates.push(m[1]);
  }
  const cls = String(finding.class ?? '').toUpperCase();
  const title = String(finding.title ?? '').toLowerCase();
  if (cls.includes('INJECT') || title.includes('inject')) candidates.push('ignore all previous', 'ignore previous', 'disregard', 'system prompt');
  if (cls.includes('SECRET') || title.includes('credential') || title.includes('secret')) candidates.push('AKIA', 'sk-', 'api_key', 'apikey', 'password', 'secret');
  if (cls.includes('PERMISSION') || title.includes('command') || title.includes('shell')) candidates.push('curl', 'wget', '| sh', '| bash', 'bash -c', 'rm -rf', 'reverse shell');

  const low = text.toLowerCase();
  for (const c of candidates) {
    const idx = low.indexOf(c.toLowerCase());
    if (idx >= 0) {
      const start = offsetToPos(text, idx);
      return new vscode.Range(start.line, start.character, start.line, start.character + c.length);
    }
  }
  const lines = text.split(/\r?\n/);
  const first = Math.max(0, lines.findIndex((l) => l.trim().length));
  return new vscode.Range(first, 0, first, (lines[first] ?? '').length);
}

function offsetToPos(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

// ── UI bits ───────────────────────────────────────────────────────

function setStatus(blocked: number, flagged: number, total: number) {
  if (blocked) {
    status.text = `$(error) Shomra: ${blocked}`;
    status.tooltip = `${blocked} blocked · ${flagged} flagged of ${total} — click to re-check`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (flagged) {
    status.text = `$(warning) Shomra: ${flagged}`;
    status.tooltip = `${flagged} flagged of ${total} — click to re-check`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    status.text = '$(shield) Shomra';
    status.tooltip = total ? `${total} artifact(s) clean — click to re-check` : 'AI-security gate — click to check the workspace';
    status.backgroundColor = undefined;
  }
  status.show();
}

class ShomraFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] | undefined {
    const mine = context.diagnostics.filter((d) => d.source === SOURCE);
    if (!mine.length) return;

    // Artifact gate → AI Fix / Explain.
    if (isArtifact(document.fileName)) {
      const fix = new vscode.CodeAction('Shomra: Fix this file (AI)', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'shomra.fixFile', title: 'Shomra: Fix this file', arguments: [document.uri] };
      fix.diagnostics = mine;
      fix.isPreferred = true;
      const explain = new vscode.CodeAction('Shomra: Explain findings (AI)', vscode.CodeActionKind.QuickFix);
      explain.command = { command: 'shomra.explainFile', title: 'Shomra: Explain findings', arguments: [document.uri] };
      explain.diagnostics = mine;
      return [fix, explain];
    }

    // Model-index findings → harden the load, open the model's page, re-check.
    if (isModelScannable(document.fileName)) {
      const actions: vscode.CodeAction[] = [];
      const fixes = modelFixByUri.get(document.uri.toString());
      for (const d of mine) {
        const line0 = d.range.start.line;
        // Primary, preferred action: apply the safe-loading kwargs (user chooses which).
        if (fixes?.get(line0)?.kwargs.length) {
          const harden = new vscode.CodeAction('Shomra: Harden this model load…', vscode.CodeActionKind.QuickFix);
          harden.command = { command: 'shomra.hardenModelLoad', title: 'Harden model load', arguments: [document.uri, line0] };
          harden.diagnostics = [d];
          harden.isPreferred = true;
          actions.push(harden);
        }
        const target = d.code && typeof d.code === 'object' && 'target' in d.code ? (d.code as { target: vscode.Uri }).target : undefined;
        if (target) {
          const open = new vscode.CodeAction('Shomra: View model in the Model Index', vscode.CodeActionKind.QuickFix);
          open.command = { command: 'vscode.open', title: 'Open model', arguments: [target] };
          open.diagnostics = [d];
          actions.push(open);
        }
      }
      const recheck = new vscode.CodeAction('Shomra: Re-check models in this file', vscode.CodeActionKind.QuickFix);
      recheck.command = { command: 'shomra.checkModelsFile', title: 'Re-check models' };
      actions.push(recheck);
      return actions;
    }
    return;
  }
}
