import * as fs from 'node:fs';
import * as path from 'node:path';


export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!name) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(name)) return name;
  // Relative to wherever the spawn happens to start - that is the workspace.
  if (/[\\/]/.test(name)) return null;
  // CreateProcess starts only .com and .exe - exactly what libuv would have tried.
  const names = platform === 'win32' ? (p.extname(name) ? [name] : [`${name}.com`, `${name}.exe`]) : [name];
  for (const raw of String(env.PATH ?? env.Path ?? '').split(p.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    for (const n of names) {
      const candidate = p.join(dir, n);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not in this directory */
      }
    }
  }
  return null;
}


export function shadowingCommand(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exts =
    platform === 'win32'
      ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC').split(';').filter(Boolean), '.ps1']
      : [''];
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const ext of exts) {
    const candidate = p.join(dir, `shomra${ext.toLowerCase()}`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return null;
}
