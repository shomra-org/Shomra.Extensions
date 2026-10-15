import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveOnPath, shadowingCommand } from './cli-path';

const SOURCE = 'NoFly';
const LEGACY = 'shomra';

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

const MODEL_RES = /\.(py|ipynb|[mc]?[jt]sx?)$/i;
function isModelScannable(fileName: string): boolean {
  return MODEL_RES.test(fileName.replace(/\\/g, '/'));
}

class NoFlyNotFound extends Error {}

let diagnostics: vscode.DiagnosticCollection;
let modelDiags: vscode.DiagnosticCollection;

type Kwarg = { name: string; value: string; reason: string };
const modelFixByUri = new Map<string, Map<number, { id: string; kwargs: Kwarg[] }>>();
const lastScanned = new Map<string, number>();
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let warnedMissing = false;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('nofly');
  modelDiags = vscode.languages.createDiagnosticCollection('nofly-models');
  output = vscode.window.createOutputChannel('NoFly');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'nofly.checkWorkspace';
  setStatus(0, 0, 0);
  context.subscriptions.push(diagnostics, modelDiags, output, status);

  const commands: Record<string, (...args: any[]) => unknown> = {
    checkWorkspace: () => checkWorkspace(),
    checkFile: () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkFile(doc, true);
    },
    checkModelsFile: () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkModelRefs(doc, true);
    },
    hardenModelLoad: (uri?: vscode.Uri, line?: number) => hardenModelLoad(uri, line),
    fixFile: (uri?: vscode.Uri) => fixFile(uri),
    explainFile: (uri?: vscode.Uri) => explainFile(uri),
    installHook: () => {
      const cli = resolveOnPath('nofly') || !resolveOnPath(LEGACY) ? 'nofly' : LEGACY;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const shadow = folder ? shadowingCommand(folder, process.env, process.platform, cli) : null;
      if (shadow) {
        vscode.window.showErrorMessage(
          `NoFly: install-hook was not run - "${path.basename(shadow)}" in this workspace would run instead of the NoFly CLI. Remove it, or run \`${cli} install-hook\` from a terminal outside this folder.`,
        );
        return;
      }
      const term = vscode.window.createTerminal('NoFly');
      term.show();
      term.sendText(`${cli} install-hook`);
    },
  };
  for (const [name, run] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`nofly.${name}`, run),
      vscode.commands.registerCommand(`${LEGACY}.${name}`, run),
    );
  }


  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => ambientCheck(doc, { force: true, gate: 'checkOnSave' })),
    vscode.workspace.onDidOpenTextDocument((doc) => ambientCheck(doc)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document) ambientCheck(editor.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.isUntitled) {
        diagnostics.delete(doc.uri);
        modelDiags.delete(doc.uri);
      }
      lastScanned.delete(doc.uri.toString());
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new NoFlyFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  for (const doc of vscode.workspace.textDocuments) ambientCheck(doc);
  if (vscode.window.activeTextEditor?.document) ambientCheck(vscode.window.activeTextEditor.document);
  if (cfg<boolean>('checkWorkspaceOnStartup', false)) checkWorkspace();
}

export function deactivate() {
  diagnostics?.clear();
  modelDiags?.clear();
}

function cfg<T>(key: string, def: T): T {
  const own = vscode.workspace.getConfiguration('nofly');
  const set = own.inspect<T>(key);
  if ([set?.globalValue, set?.workspaceValue, set?.workspaceFolderValue].some((v) => v !== undefined)) return own.get<T>(key, def);
  const legacy = vscode.workspace.getConfiguration(LEGACY).inspect<T>(key);
  const old = key === 'executable' ? legacy?.globalValue : legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
  return old !== undefined ? old : own.get<T>(key, def);
}

function ambientCheck(doc: vscode.TextDocument, opts: { force?: boolean; gate?: 'checkOnOpen' | 'checkOnSave' } = {}) {
  if (doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  if (!opts.force && lastScanned.get(key) === doc.version) return;
  lastScanned.set(key, doc.version);
  if (cfg<boolean>(opts.gate ?? 'checkOnOpen', true)) checkFile(doc);
  if (cfg<boolean>('checkModels', true)) checkModelRefs(doc);
}


function bundledCli(): string | null {
  for (const entry of ['nofly.mjs', `${LEGACY}.mjs`]) {
    const p = path.join(__dirname, '..', 'cli', entry);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
    }
  }
  return null;
}


function invocation(): { cmd: string; base: string[]; asNode: boolean } | null {
  const exe = cfg<string>('executable', 'nofly').trim();
  if (/\.(mjs|js|cjs)$/i.test(exe)) return path.isAbsolute(exe) ? { cmd: process.execPath, base: [exe], asNode: true } : null;
  const [head, ...rest] = exe.split(/\s+/).filter(Boolean);
  const cmd = resolveOnPath(head ?? 'nofly') ?? (head === 'nofly' ? resolveOnPath(LEGACY) : null);
  return cmd ? { cmd, base: rest, asNode: false } : null;
}


function runNoFly(
  args: string[],
  cwd: string,
  viaBundled = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bundled = bundledCli();
  const resolved = viaBundled ? { cmd: process.execPath, base: [bundled as string], asNode: true } : invocation();
  if (!resolved) {
    return !viaBundled && bundled ? runNoFly(args, cwd, true) : Promise.reject(new NoFlyNotFound());
  }
  const { cmd, base, asNode } = resolved;
  const argv = [...base, ...args];
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (asNode) env.ELECTRON_RUN_AS_NODE = '1';
  output.appendLine(
    `$ ${asNode ? '[node] ' : cmd + ' '}${argv.join(' ')}   (cwd: ${cwd}${viaBundled ? ', bundled' : ''})`,
  );
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      argv,
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
      (err: any, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || err.errno === -4058 || err.errno === 'ENOENT')) {
          if (!viaBundled && bundled) {
            runNoFly(args, cwd, true).then(resolve, reject);
            return;
          }
          reject(new NoFlyNotFound());
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
  if (e instanceof NoFlyNotFound) {
    if (warnedMissing) return;
    warnedMissing = true;
    const exe = cfg<string>('executable', 'nofly');
    vscode.window
      .showWarningMessage(
        `NoFly couldn't run its CLI (tried "${exe}"). The extension bundles it, so this is unexpected - reload the window, or set "nofly.executable" to a nofly.mjs path if you meant to use your own.`,
        'Open Settings',
      )
      .then((pick) => {
        if (pick === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'nofly.executable');
      });
    return;
  }
  output.appendLine(`error: ${(e as Error)?.message ?? e}`);
}

async function checkFile(doc: vscode.TextDocument, notifyClean = false) {
  if (doc.uri.scheme !== 'file' || !isArtifact(doc.fileName)) {
    diagnostics.delete(doc.uri);
    return;
  }
  let out;
  try {
    out = await runNoFly(['gate', doc.fileName, '--json'], folderFor(doc.uri));
  } catch (e) {
    handleRunError(e);
    return;
  }
  const result = parse(out.stdout);
  if (!result) {
    output.appendLine(`checkFile: no JSON for ${doc.fileName} - ${out.stderr.trim() || '(no stderr)'}`);
    return;
  }
  const diags = buildDiagnostics(doc.getText(), result.findings ?? []);
  diagnostics.set(doc.uri, diags);
  if (notifyClean && diags.length === 0) {
    vscode.window.showInformationMessage(`NoFly: ${path.basename(doc.fileName)} is clean.`);
  }
}

// ── model-index lookup ────────────────────────────────────────────

async function checkModelRefs(doc: vscode.TextDocument, notifyClean = false) {
  if (doc.uri.scheme !== 'file' || !isModelScannable(doc.fileName)) {
    modelDiags.delete(doc.uri);
    return;
  }
  let out;
  try {
    out = await runNoFly(['models', doc.fileName, '--json'], folderFor(doc.uri));
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
    if (!m.found || m.alert === 'OK') continue;
    const sev = m.alert === 'BLOCK' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const titles = (m.findings ?? []).slice(0, 3).map((f: any) => f.title).join('; ');
    const more = (m.findingCount ?? 0) > 3 ? ` (+${m.findingCount - 3} more)` : '';
    const message = `Known-vulnerable AI model: ${m.id} - ${m.verdict} (risk ${m.riskScore}). ${m.findingCount} finding(s): ${titles}${more}. Source: NoFly Model Index.`;
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
      n ? `NoFly: ${n} model reference(s) - no known vulnerabilities.` : `NoFly: no AI model references in ${path.basename(doc.fileName)}.`,
    );
  }
}

async function hardenModelLoad(uri?: vscode.Uri, line?: number) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = vscode.window.activeTextEditor;
  const line0 = typeof line === 'number' ? line : editor?.selection.active.line ?? -1;
  const plan = modelFixByUri.get(target.toString())?.get(line0);
  if (!plan || !plan.kwargs.length) {
    vscode.window.showInformationMessage('NoFly: no model-hardening suggestions for this line. Save the file to re-scan.');
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
    vscode.window.showWarningMessage("NoFly: couldn't rewrite this call automatically (it may span multiple lines). Add the kwargs by hand.");
    return;
  }
  if (newLine === lineText) {
    vscode.window.showInformationMessage('NoFly: those arguments are already present.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(target, doc.lineAt(line0).range, newLine);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  vscode.window.showInformationMessage(`NoFly: hardened the load of ${plan.id} (${picks.length} argument${picks.length === 1 ? '' : 's'}).`);
  await checkModelRefs(doc);
}

function injectKwargs(line: string, kwargs: Kwarg[]): string | null {
  const m = line.match(/\.?(from_pretrained|hf_hub_download|snapshot_download|SentenceTransformer|CrossEncoder|InferenceClient|pipeline)\s*\(/);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1;
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
  if (close < 0) return null; 
  const inner = line.slice(open + 1, close);
  const toAdd = kwargs.filter((k) => !new RegExp(`${k.name}\\s*=`).test(inner));
  if (!toAdd.length) return line;
  const args = toAdd.map((k) => `${k.name}=${k.value}`).join(', ');
  const needsComma = inner.trim().length > 0;
  return line.slice(0, close) + (needsComma ? ', ' : '') + args + line.slice(close);
}

async function checkWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showInformationMessage('NoFly: open a folder to check.');
    return;
  }
  status.text = '$(loading~spin) NoFly';
  diagnostics.clear();
  let blocked = 0;
  let flagged = 0;
  let total = 0;
  for (const folder of folders) {
    let out;
    try {
      out = await runNoFly(['check', folder.uri.fsPath, '--json'], folder.uri.fsPath);
    } catch (e) {
      handleRunError(e);
      setStatus(blocked, flagged, total);
      return;
    }
    const data = parse(out.stdout);
    if (!data) {
      output.appendLine(`checkWorkspace: no JSON for ${folder.uri.fsPath} - ${out.stderr.trim() || '(no stderr)'}`);
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
    total ? `NoFly: ${total} artifact(s) - ${blocked} blocked, ${flagged} flagged.` : 'NoFly: no AI artifacts found.',
  );
}

async function fixFile(uri?: vscode.Uri) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    vscode.window.showWarningMessage('NoFly: open an AI-artifact file to fix.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  if (!isArtifact(doc.fileName)) {
    vscode.window.showWarningMessage('NoFly: this is not an AI artifact the gate understands.');
    return;
  }
  if (doc.isDirty) await doc.save();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `NoFly: generating fix for ${path.basename(doc.fileName)}…` },
    async () => {
      let out;
      try {
        out = await runNoFly(['fix', doc.fileName, '--json'], folderFor(target));
      } catch (e) {
        handleRunError(e);
        return;
      }
      const res = parse(out.stdout);
      if (!res) {
        const reason = (out.stderr.trim().split('\n').find((l) => l.trim()) ?? 'fix failed').replace(/\[[0-9;]*m/g, '');
        vscode.window.showErrorMessage(`NoFly: ${reason}`);
        output.appendLine(out.stderr || out.stdout);
        return;
      }
      if (!res.canFix) {
        const msg = `NoFly: ${res.message ?? 'no fix available.'}`;
        if (res.reason === 'ai-disabled' || res.reason === 'ai-error') vscode.window.showWarningMessage(msg);
        else vscode.window.showInformationMessage(msg);
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(target, fullRange, String(res.fixedContent ?? ''));
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      const n = res.findingCount ?? (res.findings?.length ?? 0);
      vscode.window.showInformationMessage(`NoFly: applied fix - ${res.explanation || `${n} finding(s) addressed`}`);
      await checkFile(doc);
    },
  );
}

async function explainFile(uri?: vscode.Uri) {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    vscode.window.showWarningMessage('NoFly: open an AI-artifact file to explain.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  if (!isArtifact(doc.fileName)) {
    vscode.window.showWarningMessage('NoFly: this is not an AI artifact the gate understands.');
    return;
  }
  if (doc.isDirty) await doc.save();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `NoFly: explaining ${path.basename(doc.fileName)}…` },
    async () => {
      let out;
      try {
        out = await runNoFly(['why', doc.fileName, '--json'], folderFor(target));
      } catch (e) {
        handleRunError(e);
        return;
      }
      const res = parse(out.stdout);
      if (!res || !Array.isArray(res.findings)) {
        const reason = (out.stderr.trim().split('\n').find((l) => l.trim()) ?? 'explain failed').replace(/\[[0-9;]*m/g, '');
        vscode.window.showErrorMessage(`NoFly: ${reason}`);
        return;
      }
      if (!res.findings.length) {
        vscode.window.showInformationMessage(`NoFly: ${path.basename(doc.fileName)} is clean - nothing to explain.`);
        return;
      }
      output.clear();
      output.appendLine(`NoFly - why  ${doc.fileName}`);
      if (res.summary) output.appendLine(`\n${res.summary}`);
      for (const f of res.findings) {
        const at = f.line ? ` (line ${f.line})` : '';
        const fp = f.likelyFalsePositive ? '  - likely false positive' : '';
        output.appendLine(`\n● [${f.severity}] ${f.title}${at}${fp}`);
        if (f.why) output.appendLine(`  why: ${f.why}`);
        if (f.exploit) output.appendLine(`  exploit: ${f.exploit}`);
        if (f.assessment) output.appendLine(`  ${f.assessment}`);
        if (f.remediationText) output.appendLine(`  fix: ${f.remediationText}`);
      }
      output.show(true);
      vscode.window.showInformationMessage(`NoFly: ${res.summary || `${res.findings.length} finding(s) explained`} - see Output → NoFly.`);
    },
  );
}

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
      f.remediationText ? `${f.title} - ${f.remediationText}` : String(f.title ?? 'Finding'),
      severityOf(f.severity),
    );
    d.source = SOURCE;
    if (f.class) d.code = String(f.class);
    return d;
  });
}

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

function setStatus(blocked: number, flagged: number, total: number) {
  if (blocked) {
    status.text = `$(error) NoFly: ${blocked}`;
    status.tooltip = `${blocked} blocked · ${flagged} flagged of ${total} - click to re-check`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (flagged) {
    status.text = `$(warning) NoFly: ${flagged}`;
    status.tooltip = `${flagged} flagged of ${total} - click to re-check`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    status.text = '$(shield) NoFly';
    status.tooltip = total ? `${total} artifact(s) clean - click to re-check` : 'AI-security gate - click to check the workspace';
    status.backgroundColor = undefined;
  }
  status.show();
}

class NoFlyFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] | undefined {
    const mine = context.diagnostics.filter((d) => d.source === SOURCE);
    if (!mine.length) return;

    if (isArtifact(document.fileName)) {
      const fix = new vscode.CodeAction('NoFly: Fix this file (AI)', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'nofly.fixFile', title: 'NoFly: Fix this file', arguments: [document.uri] };
      fix.diagnostics = mine;
      fix.isPreferred = true;
      const explain = new vscode.CodeAction('NoFly: Explain findings (AI)', vscode.CodeActionKind.QuickFix);
      explain.command = { command: 'nofly.explainFile', title: 'NoFly: Explain findings', arguments: [document.uri] };
      explain.diagnostics = mine;
      return [fix, explain];
    }

    if (isModelScannable(document.fileName)) {
      const actions: vscode.CodeAction[] = [];
      const fixes = modelFixByUri.get(document.uri.toString());
      for (const d of mine) {
        const line0 = d.range.start.line;
        if (fixes?.get(line0)?.kwargs.length) {
          const harden = new vscode.CodeAction('NoFly: Harden this model load…', vscode.CodeActionKind.QuickFix);
          harden.command = { command: 'nofly.hardenModelLoad', title: 'Harden model load', arguments: [document.uri, line0] };
          harden.diagnostics = [d];
          harden.isPreferred = true;
          actions.push(harden);
        }
        const target = d.code && typeof d.code === 'object' && 'target' in d.code ? (d.code as { target: vscode.Uri }).target : undefined;
        if (target) {
          const open = new vscode.CodeAction('NoFly: View model in the Model Index', vscode.CodeActionKind.QuickFix);
          open.command = { command: 'vscode.open', title: 'Open model', arguments: [target] };
          open.diagnostics = [d];
          actions.push(open);
        }
      }
      const recheck = new vscode.CodeAction('NoFly: Re-check models in this file', vscode.CodeActionKind.QuickFix);
      recheck.command = { command: 'nofly.checkModelsFile', title: 'Re-check models' };
      actions.push(recheck);
      return actions;
    }
    return;
  }
}
