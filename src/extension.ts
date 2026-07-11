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

/** Raised when the `shomra` binary can't be found on PATH / at the configured path. */
class ShomraNotFound extends Error {}

let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let warnedMissing = false;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('shomra');
  output = vscode.window.createOutputChannel('Shomra');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'shomra.checkWorkspace';
  setStatus(0, 0, 0);
  context.subscriptions.push(diagnostics, output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('shomra.checkWorkspace', () => checkWorkspace()),
    vscode.commands.registerCommand('shomra.checkFile', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkFile(doc, true);
    }),
    vscode.commands.registerCommand('shomra.fixFile', (uri?: vscode.Uri) => fixFile(uri)),
    vscode.commands.registerCommand('shomra.explainFile', (uri?: vscode.Uri) => explainFile(uri)),
    vscode.commands.registerCommand('shomra.installHook', () => {
      const term = vscode.window.createTerminal('Shomra');
      term.show();
      term.sendText('shomra install-hook');
    }),
  );

  // Ambient checking — save is the primary loop; open catches problems earlier.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (cfg<boolean>('checkOnSave', true)) checkFile(doc);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (cfg<boolean>('checkOnOpen', true)) checkFile(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // Keep diagnostics for saved files; only drop untitled scratch buffers.
      if (doc.isUntitled) diagnostics.delete(doc.uri);
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

  // Check whatever artifact files are already open, plus an optional full sweep.
  for (const doc of vscode.workspace.textDocuments) checkFile(doc);
  if (cfg<boolean>('checkWorkspaceOnStartup', false)) checkWorkspace();
}

export function deactivate() {
  diagnostics?.clear();
}

// ── config + process ──────────────────────────────────────────────

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('shomra').get<T>(key, def);
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
    if (!mine.length || !isArtifact(document.fileName)) return;
    const fix = new vscode.CodeAction('Shomra: Fix this file (AI)', vscode.CodeActionKind.QuickFix);
    fix.command = { command: 'shomra.fixFile', title: 'Shomra: Fix this file', arguments: [document.uri] };
    fix.diagnostics = mine;
    fix.isPreferred = true;
    const explain = new vscode.CodeAction('Shomra: Explain findings (AI)', vscode.CodeActionKind.QuickFix);
    explain.command = { command: 'shomra.explainFile', title: 'Shomra: Explain findings', arguments: [document.uri] };
    explain.diagnostics = mine;
    return [fix, explain];
  }
}
