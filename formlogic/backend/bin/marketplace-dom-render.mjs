import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_RUNNER = join(__dirname, 'shared-native-runner.mjs');
const MAX_BACKEND_CALLS = 6;
const MAX_RENDER_NODES = 1200;

function contained(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function safeCss(css) {
  if (typeof css !== 'string') return '';
  let out = css;
  for (let i = 0; i < 8; i++) {
    const prev = out;
    out = out
      .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
      .replace(/<\/?\s*style/gi, ' ')
      .replace(/@import\b[^;]*;?/gi, ' ')
      .replace(/expression\s*\(/gi, 'invalid(')
      .replace(/url\s*\(\s*["']?\s*(?:javascript|vbscript):/gi, 'url(invalid:');
    if (out === prev) break;
  }
  return out;
}

const MAX_AST_DEPTH = 64;
const SAFE_IMG_SRC_RE = /^(?:data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+|assets\/[^\s"'<>]+)$/i;
const SAFE_HREF_RE = /^(?:https?:\/\/|#)/i;

function readSafeFile(appDir, relPath, allowManifest = false) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0') || relPath.includes('..') || relPath.startsWith('/') || relPath.startsWith('\\')) {
    return null;
  }
  const full = resolve(appDir, relPath);
  if (!existsSync(full)) return null;
  const realApp = realpathSync(appDir);
  const realFull = realpathSync(full);
  if (!contained(realApp, realFull)) return null;
  const normRel = relative(realApp, realFull).replaceAll('\\', '/');
  if (!allowManifest && /^(?:server|backend|private)(?:\/|$)/i.test(normRel)) {
    return null;
  }
  try {
    if (!statSync(realFull).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(realFull, 'utf8');
}

function extractTagBlocks(source, tagName) {
  const blocks = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const stripped = source.replace(re, (_, inner) => {
    blocks.push(inner);
    return '';
  });
  return { blocks, stripped };
}

function collectTopLevelVars(code) {
  const names = new Set();
  const re = /(?:^|[;\n])\s*(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

function rewriteTopLevelDecls(code) {
  // Rewrite top-level `let`/`const` to `var` so all state bindings live cleanly on the VM context
  // and can be snapshotted/restored across stateless HTTP demo event turns.
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1] || '';
    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += '/';
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === '\\' && next) { out += next; i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '\\' && next) { out += next; i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      out += ch;
      if (ch === '\\' && next) { out += next; i++; continue; }
      if (ch === '`') inTemplate = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; out += '//'; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; out += '/*'; i++; continue; }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === '`') { inTemplate = true; out += ch; continue; }
    if (ch === '{') { depth++; out += ch; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); out += ch; continue; }

    if (depth === 0) {
      const slice = code.slice(i);
      const match = /^(?:let|const)(?=\s+[a-zA-Z_$])/.exec(slice);
      if (match) {
        const prev = i > 0 ? code[i - 1] : '';
        if (!/[a-zA-Z0-9_$.]/.test(prev)) {
          out += 'var';
          i += match[0].length - 1;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

const ALLOWED_SANDBOX_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_SANDBOX_HEADERS = new Set([
  'host', 'cookie', 'authorization', 'origin', 'referer', 'forwarded',
  'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-method-override',
]);

function normalizeApiPath(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  let candidate = null;
  if (trimmed.startsWith('/api/')) candidate = trimmed;
  else if (trimmed.startsWith('api/')) candidate = '/' + trimmed;
  else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.pathname.startsWith('/api/')) {
        candidate = parsed.pathname + parsed.search;
      }
    } catch {
      return null;
    }
  }
  if (!candidate) return null;
  const hashIdx = candidate.indexOf('#');
  if (hashIdx !== -1) candidate = candidate.slice(0, hashIdx);
  const qIdx = candidate.indexOf('?');
  const rawPath = qIdx === -1 ? candidate : candidate.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : candidate.slice(qIdx + 1);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    rawPath.length > 2048 ||
    decodedPath.length > 2048 ||
    !rawPath.startsWith('/api/') ||
    !decodedPath.startsWith('/api/') ||
    rawPath.includes('\\') ||
    decodedPath.includes('\\') ||
    rawPath.includes('//') ||
    decodedPath.includes('//') ||
    rawPath.includes(';') ||
    decodedPath.includes(';') ||
    /%(?:2e|2f|5c|00|25|3f|23|3b)/i.test(rawPath) ||
    /%[0-9a-f]{2}/i.test(decodedPath) ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(rawPath) ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(decodedPath) ||
    /[\x00-\x1f\x7f]/.test(rawPath) ||
    /[\x00-\x1f\x7f]/.test(decodedPath)
  ) {
    return null;
  }
  if (decodedPath.toLowerCase().startsWith('/api/site/') || decodedPath.toLowerCase() === '/api/site') {
    return null;
  }
  return { pathPart: decodedPath, queryPart: rawQuery };
}

function invokeSandboxBackend(rootDir, dataDir, runtimeDir, manifest, rawUrl, options) {
  const normalized = normalizeApiPath(rawUrl);
  if (!normalized) {
    return { ok: false, status: 403, body: { error: 'External or restricted requests are blocked in the marketplace sandbox.' } };
  }
  const { pathPart, queryPart } = normalized;
  const query = Object.create(null);
  if (queryPart) {
    const sp = new URLSearchParams(queryPart);
    let qCount = 0;
    for (const [k, v] of sp.entries()) {
      if (qCount >= 64) break;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      query[k] = v;
      qCount++;
    }
  }
  const method = String(options?.method || 'GET').toUpperCase();
  if (!ALLOWED_SANDBOX_METHODS.has(method)) {
    return { ok: false, status: 405, body: { error: 'HTTP method not allowed in marketplace sandbox.' } };
  }
  let body = options?.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = { raw: body }; }
  }
  const safeHeaders = Object.create(null);
  if (options?.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    let hCount = 0;
    for (const [k, v] of Object.entries(options.headers)) {
      if (hCount >= 32) break;
      const lk = String(k).trim().toLowerCase();
      if (
        !lk ||
        lk.length > 64 ||
        !/^[a-z0-9-]+$/.test(lk) ||
        BLOCKED_SANDBOX_HEADERS.has(lk) ||
        lk.startsWith('x-formlogic-') ||
        lk.startsWith('x-forwarded-') ||
        lk.startsWith('proxy-')
      ) {
        continue;
      }
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        safeHeaders[lk] = String(v).replace(/[\r\n\0]+/g, '').slice(0, 2048);
        hCount++;
      }
    }
  }
  const isContainer = manifest && typeof manifest.backend === 'object' && manifest.backend !== null && !Array.isArray(manifest.backend);
  const payload = isContainer
    ? {
        method,
        path: pathPart,
        query: queryPart ? '?' + queryPart : '',
        headers: [['content-type', 'application/json']],
        bodyBase64: Buffer.from(typeof options?.body === 'string' ? options.body : JSON.stringify(body ?? {})).toString('base64'),
      }
    : {
        method,
        path: pathPart,
        query,
        body: body && typeof body === 'object' ? body : {},
        headers: safeHeaders,
        client_ip: '127.0.0.1',
        photos: false,
      };

  const env = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    NODE_NO_WARNINGS: '1',
    SOFTN_RUNNER_DEADLINE_MS: '7000',
    SOFTN_BACKEND_ROOT: rootDir,
    SOFTN_DATA_ROOT: dataDir,
    SOFTN_RUNTIME_DIR: runtimeDir,
    SOFTN_HOST_CONTEXT: JSON.stringify({
      demo: true,
      sandbox: true,
      authenticated: true,
      userId: 'marketplace-sandbox-visitor',
      roleId: 'member',
      formlogic: {
        appId: manifest?.id || 'marketplace-demo',
        userId: 'marketplace-sandbox-visitor',
        roleId: 'member',
      },
    }),
    SOFTN_RECORD_EVENTS: '[]',
  };

  try {
    const out = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--disable-proto=throw', '--no-wasm-tier-up', '--no-wasm-dynamic-tiering', SHARED_RUNNER],
      {
        input: JSON.stringify(payload),
        env,
        cwd: rootDir,
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse(out);
    if (isContainer && typeof parsed.bodyBase64 === 'string') {
      const rawText = Buffer.from(parsed.bodyBase64, 'base64').toString('utf8');
      let decoded = rawText;
      try { decoded = JSON.parse(rawText); } catch {}
      return {
        ok: parsed.status >= 200 && parsed.status < 300,
        status: parsed.status,
        body: decoded,
        data: decoded,
      };
    }
    return {
      ok: Number(parsed.status) >= 200 && Number(parsed.status) < 300,
      status: Number(parsed.status) || 500,
      body: parsed.body,
      data: parsed.body,
    };
  } catch {
    return { ok: false, status: 500, body: { error: 'Sandbox backend request failed' }, data: null };
  }
}

// ── Minimal Recursive-Descent Parser for SoftN .ui Markup ────────────────────
const VOID_TAGS = new Set(['Input', 'Divider', 'Image', 'Spacer', 'input', 'hr', 'br', 'img', 'Checkbox', 'Switch']);

function parseAttributes(raw) {
  const attrs = [];
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /\s/.test(raw[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i);
    if (!name) { i++; continue; }
    while (i < len && /\s/.test(raw[i])) i++;
    if (raw[i] !== '=') {
      attrs.push({ name, kind: 'bool', value: true });
      continue;
    }
    i++; // '='
    while (i < len && /\s/.test(raw[i])) i++;
    if (raw[i] === '"' || raw[i] === "'") {
      const q = raw[i++];
      const vStart = i;
      while (i < len && raw[i] !== q) i++;
      const val = raw.slice(vStart, i);
      if (i < len) i++;
      attrs.push({ name, kind: 'string', value: val });
    } else if (raw[i] === '{') {
      let depth = 0;
      const vStart = i + 1;
      while (i < len) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const expr = raw.slice(vStart, i).trim();
      if (i < len) i++;
      attrs.push({ name, kind: 'expr', value: expr });
    } else {
      const vStart = i;
      while (i < len && !/[\s>]/.test(raw[i])) i++;
      attrs.push({ name, kind: 'string', value: raw.slice(vStart, i) });
    }
  }
  return attrs;
}

function tokenizeUi(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    // Comments <!-- ... -->
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // Control blocks {#if ...}, {:else}, {/if}, {#each ...}, {/each} or #if (...) { ... }
    if (src[i] === '{' && (src[i + 1] === '#' || src[i + 1] === ':' || src[i + 1] === '/')) {
      let depth = 0;
      const start = i;
      while (i < len) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      tokens.push({ type: 'block', raw: src.slice(start + 1, i - 1).trim() });
      continue;
    }
    if (src[i] === '<' && (/[A-Za-z/]/.test(src[i + 1] || ''))) {
      const isClose = src[i + 1] === '/';
      let j = i + (isClose ? 2 : 1);
      const nameStart = j;
      while (j < len && /[A-Za-z0-9_.-]/.test(src[j])) j++;
      const tag = src.slice(nameStart, j);
      if (isClose) {
        while (j < len && src[j] !== '>') j++;
        i = j < len ? j + 1 : len;
        tokens.push({ type: 'close', tag });
        continue;
      }
      // Scan until unquoted/unbraced '>'
      let inQ = null;
      let brace = 0;
      const attrStart = j;
      while (j < len) {
        const ch = src[j];
        if (inQ) {
          if (ch === inQ) inQ = null;
        } else if (ch === '"' || ch === "'") {
          inQ = ch;
        } else if (ch === '{') {
          brace++;
        } else if (ch === '}') {
          brace = Math.max(0, brace - 1);
        } else if (ch === '>' && brace === 0) {
          break;
        }
        j++;
      }
      let attrRaw = src.slice(attrStart, j);
      const selfClose = attrRaw.trimEnd().endsWith('/');
      if (selfClose) attrRaw = attrRaw.trimEnd().slice(0, -1);
      i = j < len ? j + 1 : len;
      tokens.push({ type: 'open', tag, attrs: parseAttributes(attrRaw), selfClose: selfClose || VOID_TAGS.has(tag) });
      continue;
    }
    // Text chunk
    let j = i;
    while (j < len) {
      if (src.startsWith('<!--', j)) break;
      if (src[j] === '<' && /[A-Za-z/]/.test(src[j + 1] || '')) break;
      if (src[j] === '{' && (src[j + 1] === '#' || src[j + 1] === ':' || src[j + 1] === '/')) break;
      j++;
    }
    const text = src.slice(i, j);
    if (text) tokens.push({ type: 'text', text });
    i = j > i ? j : i + 1;
  }
  return tokens;
}

function buildAst(tokens) {
  let idx = 0;
  function parseNodes(stopTags = new Set(), depth = 0) {
    const nodes = [];
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok.type === 'close') {
        if (stopTags.has(tok.tag)) { idx++; break; }
        idx++;
        continue;
      }
      if (tok.type === 'block') {
        const raw = tok.raw;
        if (raw.startsWith('#if ')) {
          idx++;
          const cond = raw.slice(4).trim();
          const consequent = depth < MAX_AST_DEPTH ? parseNodes(new Set(['__BLOCK_END__']), depth + 1) : [];
          let alternate = [];
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === ':else') {
            idx++;
            alternate = depth < MAX_AST_DEPTH ? parseNodes(new Set(['__BLOCK_END__']), depth + 1) : [];
          }
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === '/if') {
            idx++;
          }
          if (depth < MAX_AST_DEPTH) {
            nodes.push({ type: 'if', cond, consequent, alternate });
          }
          continue;
        }
        if (raw.startsWith('#each ')) {
          idx++;
          const m = /^#each\s+(.+?)\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?$/.exec(raw);
          const body = depth < MAX_AST_DEPTH ? parseNodes(new Set(['__BLOCK_END__']), depth + 1) : [];
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === '/each') {
            idx++;
          }
          if (m && depth < MAX_AST_DEPTH) {
            nodes.push({ type: 'each', listExpr: m[1].trim(), itemVar: m[2], indexVar: m[3] || null, body });
          }
          continue;
        }
        if (raw === ':else' || raw === '/if' || raw === '/each') {
          if (stopTags.has('__BLOCK_END__')) break;
          idx++;
          continue;
        }
        idx++;
        continue;
      }
      if (tok.type === 'text') {
        idx++;
        nodes.push(tok);
        continue;
      }
      if (tok.type === 'open') {
        idx++;
        const children = tok.selfClose || depth >= MAX_AST_DEPTH ? [] : parseNodes(new Set([tok.tag]), depth + 1);
        nodes.push({ type: 'element', tag: tok.tag, attrs: tok.attrs, children });
        continue;
      }
      idx++;
    }
    return nodes;
  }
  return parseNodes();
}

const VALID_IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const SAFE_ALIGN_VALUES = new Set(['flex-start', 'start', 'center', 'flex-end', 'end', 'stretch', 'baseline']);
const SAFE_JUSTIFY_VALUES = new Set(['flex-start', 'start', 'center', 'flex-end', 'end', 'space-between', 'space-around', 'space-evenly']);

function evalExpr(engine, expr, locals = {}) {
  try {
    const cleanExpr = String(expr ?? '').trim();
    if (cleanExpr === '' || cleanExpr.length > 8192) return '';
    const keys = [];
    const vals = [];
    for (const [k, v] of Object.entries(locals || {})) {
      if (VALID_IDENT_RE.test(k)) {
        keys.push(k);
        vals.push(v);
      }
    }
    return engine.callFunction('__flEvalExpr', [cleanExpr, keys, vals]);
  } catch {
    return '';
  }
}

function interpolateText(context, text, locals) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      const start = i + 1;
      let j = i;
      while (j < text.length) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth === 0) {
        const expr = text.slice(start, j).trim();
        const val = evalExpr(context, expr, locals);
        out += escapeHtml(val === undefined || val === null ? '' : val);
        i = j + 1;
        continue;
      }
    }
    out += escapeHtml(text[i]);
    i++;
  }
  return out;
}

const SAFE_HTML_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'form', 'label', 'input', 'textarea', 'select', 'option',
  'button', 'strong', 'em', 'small', 'code', 'pre', 'hr', 'br', 'a', 'img', 'blockquote', 'dl', 'dt', 'dd', 'figure', 'figcaption',
]);

function renderAst(ast, context, actionRegistry, inputRegistry) {
  let nodeCount = 0;
  let actionSeq = 0;
  let inputSeq = 0;

  function registerAction(handlerExpr, locals) {
    const id = 'a' + (actionSeq++);
    actionRegistry.set(id, { expr: handlerExpr, locals: { ...locals } });
    return id;
  }

  function registerInput(varName) {
    const id = 'f' + (inputSeq++);
    inputRegistry.set(id, varName);
    return id;
  }

  function renderNodes(nodes, locals) {
    let html = '';
    for (const node of nodes) {
      if (nodeCount++ > MAX_RENDER_NODES) break;
      if (node.type === 'text') {
        html += interpolateText(context, node.text, locals);
        continue;
      }
      if (node.type === 'if') {
        const cond = Boolean(evalExpr(context, node.cond, locals));
        html += renderNodes(cond ? node.consequent : node.alternate, locals);
        continue;
      }
      if (node.type === 'each') {
        const list = evalExpr(context, node.listExpr, locals);
        if (Array.isArray(list)) {
          for (let i = 0; i < Math.min(list.length, 200); i++) {
            const nextLocals = { ...locals, [node.itemVar]: list[i] };
            if (node.indexVar) nextLocals[node.indexVar] = i;
            html += renderNodes(node.body, nextLocals);
          }
        }
        continue;
      }
      if (node.type === 'element') {
        html += renderElement(node, locals);
      }
    }
    return html;
  }

  function attrValue(attr, locals) {
    if (attr.kind === 'bool') return true;
    if (attr.kind === 'string') return attr.value;
    return evalExpr(context, attr.value, locals);
  }

  function renderElement(node, locals) {
    const tag = node.tag;
    const props = {};
    const events = {};
    let bindVar = null;

    for (const a of node.attrs) {
      if (a.name.startsWith('@')) {
        events[a.name.slice(1).toLowerCase()] = a.value;
      } else if (a.name === ':bind' || a.name === 'bind:value' || a.name === 'v-model') {
        bindVar = typeof a.value === 'string' ? a.value.trim() : null;
      } else if (a.name.startsWith(':')) {
        props[a.name.slice(1)] = attrValue(a, locals);
      } else {
        props[a.name] = attrValue(a, locals);
      }
    }

    const evAttrs = [];
    if (events.click) evAttrs.push(`data-fl-click="${registerAction(events.click, locals)}"`);
    if (events.submit) evAttrs.push(`data-fl-submit="${registerAction(events.submit, locals)}"`);
    if (events.change) evAttrs.push(`data-fl-change="${registerAction(events.change, locals)}"`);
    if (events.input) evAttrs.push(`data-fl-input="${registerAction(events.input, locals)}"`);

    const bindAttr = bindVar ? ` data-fl-bind="${registerInput(bindVar)}"` : '';
    const extraEventStr = evAttrs.length ? ' ' + evAttrs.join(' ') : '';
    const childrenHtml = renderNodes(node.children || [], locals);

    const gapMap = Object.assign(Object.create(null), { xs: '0.25rem', sm: '0.5rem', md: '0.85rem', lg: '1.25rem', xl: '1.75rem' });
    const padMap = Object.assign(Object.create(null), { none: '0', xs: '0.35rem', sm: '0.75rem', md: '1.15rem', lg: '1.65rem', xl: '2.25rem' });
    const sizeMap = Object.assign(Object.create(null), { sm: '560px', md: '780px', lg: '1040px', xl: '1240px', full: '100%' });
    const lookup = (map, val, fallback) => {
      const k = typeof val === 'string' ? val : '';
      return Object.hasOwn(map, k) ? map[k] : fallback;
    };

    switch (tag) {
      case 'App':
        return `<div class="fl-app">${childrenHtml}</div>`;
      case 'Container': {
        const maxW = lookup(sizeMap, props.size || 'md', '780px');
        return `<div class="fl-container" style="max-width:${maxW}">${childrenHtml}</div>`;
      }
      case 'Stack': {
        const dir = props.direction === 'horizontal' ? 'row' : 'column';
        const gap = lookup(gapMap, props.gap || 'md', '0.85rem');
        const pad = props.padding ? lookup(padMap, props.padding, '1rem') : '0';
        const rawAlign = typeof props.align === 'string' ? props.align.trim().toLowerCase() : '';
        const rawJustify = typeof props.justify === 'string' ? props.justify.trim().toLowerCase() : '';
        const align = SAFE_ALIGN_VALUES.has(rawAlign) ? `align-items:${rawAlign};` : '';
        const justify = SAFE_JUSTIFY_VALUES.has(rawJustify) ? `justify-content:${rawJustify};` : '';
        return `<div class="fl-stack" style="flex-direction:${dir};gap:${gap};padding:${pad};${align}${justify}">${childrenHtml}</div>`;
      }
      case 'Row': {
        const gap = lookup(gapMap, props.gap || 'md', '0.85rem');
        return `<div class="fl-row" style="gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Column': {
        const gap = lookup(gapMap, props.gap || 'md', '0.85rem');
        return `<div class="fl-col" style="gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Grid': {
        const cols = Math.max(1, Math.min(6, Math.trunc(Number(props.columns || props.cols || 2)) || 2));
        const gap = lookup(gapMap, props.gap || 'md', '1rem');
        return `<div class="fl-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Card': {
        const title = props.title ? `<div class="fl-card-title">${escapeHtml(props.title)}</div>` : '';
        return `<section class="fl-card"${extraEventStr}>${title}${childrenHtml}</section>`;
      }
      case 'Heading': {
        const level = Math.max(1, Math.min(6, Math.trunc(Number(props.level || 2)) || 2));
        return `<h${level} class="fl-heading fl-h${level}">${childrenHtml}</h${level}>`;
      }
      case 'Text': {
        const variant = String(props.variant || 'body');
        return `<p class="fl-text fl-text-${escapeAttr(variant)}">${childrenHtml}</p>`;
      }
      case 'Badge':
      case 'Tag': {
        const variant = String(props.variant || 'default');
        return `<span class="fl-badge fl-badge-${escapeAttr(variant)}">${childrenHtml}</span>`;
      }
      case 'Alert': {
        const variant = String(props.variant || 'info');
        return `<div class="fl-alert fl-alert-${escapeAttr(variant)}" role="status">${childrenHtml}</div>`;
      }
      case 'Divider':
        return '<hr class="fl-divider" />';
      case 'Button': {
        const variant = String(props.variant || 'secondary');
        const type = props.type === 'submit' ? 'submit' : 'button';
        const disabled = props.disabled ? ' disabled' : '';
        return `<button type="${type}" class="fl-btn fl-btn-${escapeAttr(variant)}"${disabled}${extraEventStr}>${childrenHtml}</button>`;
      }
      case 'Input': {
        const type = ['text', 'email', 'number', 'password', 'date', 'url', 'search', 'tel'].includes(String(props.type || 'text'))
          ? String(props.type || 'text')
          : 'text';
        const val = bindVar !== null ? evalExpr(context, bindVar, locals) : (props.value ?? '');
        const label = props.label ? `<label class="fl-label">${escapeHtml(props.label)}</label>` : '';
        const ph = props.placeholder ? ` placeholder="${escapeAttr(String(props.placeholder))}"` : '';
        const name = props.name ? ` name="${escapeAttr(String(props.name))}"` : '';
        return `<div class="fl-field">${label}<input class="fl-input" type="${type}" value="${escapeAttr(String(val ?? ''))}"${ph}${name}${bindAttr}${extraEventStr} /></div>`;
      }
      case 'TextArea':
      case 'Textarea': {
        const val = bindVar !== null ? evalExpr(context, bindVar, locals) : (props.value ?? '');
        const label = props.label ? `<label class="fl-label">${escapeHtml(props.label)}</label>` : '';
        const ph = props.placeholder ? ` placeholder="${escapeAttr(String(props.placeholder))}"` : '';
        const rows = Math.max(2, Math.min(12, Math.trunc(Number(props.rows || 3)) || 3));
        return `<div class="fl-field">${label}<textarea class="fl-textarea" rows="${rows}"${ph}${bindAttr}${extraEventStr}>${escapeHtml(String(val ?? ''))}</textarea></div>`;
      }
      case 'Checkbox':
      case 'Switch': {
        const checked = Boolean(bindVar !== null ? evalExpr(context, bindVar, locals) : props.checked);
        const label = props.label ? escapeHtml(String(props.label)) : childrenHtml;
        return `<label class="fl-check"><input type="checkbox"${checked ? ' checked' : ''}${bindAttr}${extraEventStr} /><span>${label}</span></label>`;
      }
      case 'Select': {
        const label = props.label ? `<label class="fl-label">${escapeHtml(props.label)}</label>` : '';
        return `<div class="fl-field">${label}<select class="fl-select"${bindAttr}${extraEventStr}>${childrenHtml}</select></div>`;
      }
      case 'Option':
        return `<option value="${escapeAttr(String(props.value ?? ''))}">${childrenHtml}</option>`;
      case 'Form':
        return `<form class="fl-form"${extraEventStr}>${childrenHtml}</form>`;
      case 'List':
        return `<ul class="fl-list">${childrenHtml}</ul>`;
      case 'ListItem':
        return `<li class="fl-list-item"${extraEventStr}>${childrenHtml}</li>`;
      case 'Table':
        return `<div class="fl-table-wrap"><table class="fl-table">${childrenHtml}</table></div>`;
      case 'Link': {
        const href = typeof props.href === 'string' && SAFE_HREF_RE.test(props.href) ? props.href : '#';
        return `<a class="fl-link" href="${escapeAttr(href)}" rel="noopener noreferrer"${extraEventStr}>${childrenHtml}</a>`;
      }
      case 'Image': {
        const src = typeof props.src === 'string' && SAFE_IMG_SRC_RE.test(props.src) ? props.src : '';
        if (!src) return '';
        return `<img class="fl-img" src="${escapeAttr(src)}" alt="${escapeAttr(String(props.alt || ''))}" />`;
      }
      default: {
        const lower = tag.toLowerCase();
        if (!SAFE_HTML_TAGS.has(lower)) {
          return `<div class="fl-node"${extraEventStr}>${childrenHtml}</div>`;
        }
        const safeAttrs = [];
        for (const [k, v] of Object.entries(props)) {
          const lk = k.toLowerCase();
          if (lk.startsWith('on') || lk === 'srcdoc' || lk === 'style') continue;
          if (lk === 'href') {
            if (typeof v !== 'string' || !SAFE_HREF_RE.test(v)) continue;
          }
          if (lk === 'src') {
            if (typeof v !== 'string' || !SAFE_IMG_SRC_RE.test(v)) continue;
          }
          if (['class', 'id', 'type', 'name', 'value', 'placeholder', 'title', 'role', 'aria-label', 'href', 'src', 'alt', 'rows', 'cols', 'disabled', 'checked', 'selected'].includes(lk)) {
            if (typeof v === 'boolean') {
              if (v) safeAttrs.push(lk);
            } else if (typeof v === 'string' || typeof v === 'number') {
              safeAttrs.push(`${lk}="${escapeAttr(String(v))}"`);
            }
          }
        }
        if (lower === 'a') {
          safeAttrs.push('rel="noopener noreferrer"');
        }
        const attrStr = safeAttrs.length ? ' ' + safeAttrs.join(' ') : '';
        if (['input', 'hr', 'br', 'img'].includes(lower)) {
          return `<${lower}${attrStr}${bindAttr}${extraEventStr} />`;
        }
        return `<${lower}${attrStr}${bindAttr}${extraEventStr}>${childrenHtml}</${lower}>`;
      }
    }
  }

  const html = renderNodes(ast, {});
  return html;
}

const DEFAULT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; background: #f8fafc; color: #0f172a; line-height: 1.5; }
.fl-app { min-height: 100vh; padding: 1.25rem; }
.fl-container { margin: 0 auto; width: 100%; }
.fl-stack, .fl-col { display: flex; flex-direction: column; }
.fl-row { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; }
.fl-grid { display: grid; }
.fl-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(15,23,42,0.05); }
.fl-card-title { font-weight: 700; font-size: 1.05rem; margin-bottom: 0.75rem; color: #0f172a; }
.fl-heading { margin: 0 0 0.4rem; font-weight: 700; color: #0f172a; letter-spacing: -0.015em; }
.fl-h1 { font-size: 1.65rem; } .fl-h2 { font-size: 1.35rem; } .fl-h3 { font-size: 1.1rem; }
.fl-text { margin: 0; font-size: 0.95rem; color: #1e293b; }
.fl-text-muted { color: #64748b; font-size: 0.875rem; }
.fl-text-bold { font-weight: 600; }
.fl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; font: inherit; font-weight: 600; font-size: 0.9rem; padding: 0.6rem 1.05rem; border-radius: 10px; border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a; cursor: pointer; transition: all 0.15s ease; }
.fl-btn:hover:not(:disabled) { background: #f1f5f9; border-color: #94a3b8; }
.fl-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.fl-btn-primary { background: #2563eb; border-color: #2563eb; color: #ffffff; }
.fl-btn-primary:hover:not(:disabled) { background: #1d4ed8; border-color: #1d4ed8; }
.fl-btn-danger { background: #dc2626; border-color: #dc2626; color: #ffffff; }
.fl-btn-danger:hover:not(:disabled) { background: #b91c1c; border-color: #b91c1c; }
.fl-field { display: flex; flex-direction: column; gap: 0.3rem; }
.fl-label { font-size: 0.82rem; font-weight: 600; color: #334155; }
.fl-input, .fl-textarea, .fl-select { width: 100%; font: inherit; font-size: 0.92rem; padding: 0.55rem 0.75rem; border-radius: 9px; border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a; }
.fl-input:focus, .fl-textarea:focus, .fl-select:focus { outline: 2px solid rgba(37,99,235,0.22); border-color: #2563eb; }
.fl-check { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; color: #1e293b; cursor: pointer; }
.fl-badge { display: inline-flex; align-items: center; padding: 0.18rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: #e2e8f0; color: #334155; }
.fl-badge-primary { background: #dbeafe; color: #1d4ed8; }
.fl-badge-success { background: #dcfce7; color: #15803d; }
.fl-badge-warning { background: #fef3c7; color: #b45309; }
.fl-alert { padding: 0.75rem 1rem; border-radius: 10px; font-size: 0.88rem; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; }
.fl-divider { border: 0; border-top: 1px solid #e2e8f0; margin: 0.75rem 0; }
.fl-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.fl-list-item { padding: 0.65rem 0.85rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; }
.fl-table-wrap { overflow-x: auto; }
.fl-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.fl-table th, .fl-table td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid #e2e8f0; }
.fl-table th { font-weight: 600; color: #475569; background: #f8fafc; }
.fl-link { color: #2563eb; text-decoration: none; font-weight: 500; }
.fl-link:hover { text-decoration: underline; }
`;

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { rootDir, appDir, dataDir, runtimeDir, state: prevState, event } = input;

  const manifestRaw = readSafeFile(appDir, 'manifest.json', true);
  if (!manifestRaw) throw new Error('manifest.json missing');
  const manifest = JSON.parse(manifestRaw);
  const mainFile = typeof manifest.main === 'string' ? manifest.main : 'ui/main.ui';
  const uiSource = readSafeFile(appDir, mainFile);
  if (uiSource === null) throw new Error('Main UI file missing');

  const { blocks: logicBlocks, stripped: afterLogic } = extractTagBlocks(uiSource, 'logic');
  const { blocks: styleBlocks, stripped: markup } = extractTagBlocks(afterLogic, 'style');

  const extraLogic = [];
  if (Array.isArray(manifest.files?.logic)) {
    for (const rel of manifest.files.logic) {
      if (typeof rel === 'string') {
        const src = readSafeFile(appDir, rel);
        if (src !== null) extraLogic.push(src);
      }
    }
  }
  const extraCss = [];
  for (const rel of [
    ...(Array.isArray(manifest.files?.css) ? manifest.files.css : []),
    ...(Array.isArray(manifest.files?.styles) ? manifest.files.styles : []),
  ]) {
    if (typeof rel === 'string') {
      const src = readSafeFile(appDir, rel);
      if (src !== null) extraCss.push(src);
    }
  }

  const combinedLogic = rewriteTopLevelDecls([...extraLogic, ...logicBlocks].join('\n;\n'));
  const varNames = collectTopLevelVars(combinedLogic);

  let backendCalls = 0;

  // Execute all publisher `.ui`/`.logic` exclusively inside the bundled ZIPP WASM safe-sandbox
  // (never Node's `node:vm`, which is not a security boundary and exposes host-realm constructors).
  const wasmJsPath = join(runtimeDir, 'wasm', 'zipp_wasm.mjs');
  const wasmBinPath = join(runtimeDir, 'wasm', 'zipp_wasm_bg.wasm');
  if (!existsSync(wasmJsPath) || !existsSync(wasmBinPath)) {
    throw new Error('WASM sandbox runtime missing');
  }
  const { initSync, Engine, zippProfile } = await import(pathToFileURL(wasmJsPath).href);
  initSync({ module: readFileSync(wasmBinPath) });
  if (!JSON.parse(zippProfile()).features.includes('safe-sandbox')) {
    throw new Error('Sandbox profile missing');
  }

  const engine = new Engine();
  try {
    engine.setInstructionBudget(5_000_000);
    engine.setSyncHostCapabilities(['db.query']);
    engine.setDbBridge({
      query: (op, args) => {
        if (op === 'time.now') {
          return new Date().toISOString();
        }
        if (op === 'backend.fetch') {
          const url = Array.isArray(args) ? String(args[0] ?? '') : '';
          const opts = Array.isArray(args) && args[1] && typeof args[1] === 'object' ? args[1] : {};
          if (backendCalls >= MAX_BACKEND_CALLS) {
            return { ok: false, status: 429, body: { error: 'Too many sandbox backend calls in one turn' }, data: null };
          }
          backendCalls++;
          const res = invokeSandboxBackend(rootDir, dataDir, runtimeDir, manifest, url, opts);
          return { ok: res.ok, status: res.status, body: res.body, data: res.body };
        }
        return { ok: false, status: 403, body: { error: 'Host operation denied' }, data: null };
      },
    });

    const reservedGlobals = new Set([
      'softn', 'api', 'fetch', 'console', 'db',
      '__flWrapFetch', '__flDoFetch', '__flEvalExpr', '__flSetGlobal',
      '__flRestoreState', '__flRunInit', '__flRunAction', '__flSnapshotState',
    ]);
    const guestShim = `
var console = { log: function(){}, warn: function(){}, error: function(){}, info: function(){} };
function __flWrapFetch(res) {
  var body = res && typeof res === 'object' ? res.body : null;
  return {
    ok: !!(res && res.ok),
    status: Number((res && res.status) || 500),
    body: body,
    data: body,
    json: function() { return Promise.resolve(body); },
    text: function() { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); }
  };
}
function __flDoFetch(url, opts, cb) {
  var res = db.query('backend.fetch', [String(url || ''), opts && typeof opts === 'object' ? opts : {}]);
  var wrapped = __flWrapFetch(res || { ok: false, status: 500, body: null });
  if (typeof cb === 'function') {
    try { cb(wrapped); } catch (_) {}
  }
  return Promise.resolve(wrapped);
}
var softn = {
  net: { fetch: __flDoFetch },
  api: { fetch: __flDoFetch },
  time: { now: function() { return db.query('time.now', []); } }
};
var api = { fetch: __flDoFetch };
function fetch(url, opts) { return __flDoFetch(url, opts); }
function __flEvalExpr(expr, keys, vals) {
  var kList = Array.isArray(keys) ? keys : [];
  var vList = Array.isArray(vals) ? vals : [];
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(expr)) {
    var idx = kList.indexOf(expr);
    if (idx !== -1) return vList[idx];
    return globalThis[expr];
  }
  var fn = Function.apply(null, kList.concat(['return (' + expr + ');']));
  return fn.apply(null, vList);
}
function __flSetGlobal(name, val) {
  globalThis[name] = val;
}
function __flRestoreState(entries) {
  if (!Array.isArray(entries)) return;
  for (var i = 0; i < entries.length; i++) {
    var pair = entries[i];
    if (Array.isArray(pair) && typeof pair[0] === 'string') {
      globalThis[pair[0]] = pair[1];
    }
  }
}
function __flRunInit() {
  var names = ['onMount', 'init', 'loadItems', 'load'];
  for (var i = 0; i < names.length; i++) {
    var fn = globalThis[names[i]];
    if (typeof fn === 'function') {
      try { return fn(); } catch (_) { return null; }
    }
  }
  return null;
}
function __flRunAction(expr, keys, vals, evValue) {
  var evObj = { target: { value: evValue }, value: evValue, preventDefault: function(){} };
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(expr) && typeof globalThis[expr] === 'function') {
    try { return globalThis[expr](evObj); } catch (_) { return null; }
  }
  var kList = Array.isArray(keys) ? keys : [];
  var vList = Array.isArray(vals) ? vals : [];
  try {
    var fn = Function.apply(null, kList.concat(['$event', 'return (' + expr + ');']));
    var res = fn.apply(null, vList.concat([evObj]));
    if (typeof res === 'function') {
      return res(evObj);
    }
    return res;
  } catch (_) {
    return null;
  }
}
function __flSnapshotState(keys) {
  var out = {};
  if (!Array.isArray(keys)) return out;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = globalThis[k];
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
    try { out[k] = JSON.parse(JSON.stringify(v)); } catch (_) {}
  }
  return out;
}
`;
    engine.initScript(guestShim + '\n' + combinedLogic);

    // Restore visitor's persisted session state variables
    const hasSavedState = prevState && typeof prevState === 'object' && Object.keys(prevState).length > 0;
    if (hasSavedState) {
      const restoreEntries = [];
      for (const [k, v] of Object.entries(prevState)) {
        if (VALID_IDENT_RE.test(k) && !reservedGlobals.has(k)) {
          restoreEntries.push([k, v]);
        }
      }
      if (restoreEntries.length > 0) {
        engine.callFunction('__flRestoreState', [restoreEntries]);
      }
    }

    const ast = buildAst(tokenizeUi(markup));

    // First pass builds the valid server-side action/input registries for the current view
    const preActions = new Map();
    const preInputs = new Map();
    renderAst(ast, engine, preActions, preInputs);

    // Sync any browser form field inputs mapped exclusively through opaque server-issued input IDs
    if (event && event.inputs && typeof event.inputs === 'object' && !Array.isArray(event.inputs)) {
      let appliedInputs = 0;
      for (const [inputId, rawVal] of Object.entries(event.inputs)) {
        if (appliedInputs >= 64) break;
        if (inputId === '__proto__' || inputId === 'constructor' || inputId === 'prototype') continue;
        const varName = preInputs.get(inputId);
        if (!varName || !VALID_IDENT_RE.test(varName) || reservedGlobals.has(varName)) continue;
        if (typeof rawVal === 'string') {
          engine.callFunction('__flSetGlobal', [varName, rawVal.slice(0, 4096)]);
          appliedInputs++;
        } else if (typeof rawVal === 'boolean' || (typeof rawVal === 'number' && Number.isFinite(rawVal))) {
          engine.callFunction('__flSetGlobal', [varName, rawVal]);
          appliedInputs++;
        }
      }
    }

    // Dispatch lifecycle or user interaction strictly via server-registered action ID
    if (!hasSavedState && (!event || event.type === 'init')) {
      try {
        await engine.callFunction('__flRunInit', []);
      } catch {}
    } else if (event && typeof event.actionId === 'string') {
      const entry = preActions.get(event.actionId);
      if (entry) {
        const expr = entry.expr.trim();
        if (expr !== '' && expr.length <= 8192) {
          const locals = entry.locals || {};
          const keys = [];
          const valList = [];
          for (const [k, v] of Object.entries(locals)) {
            if (VALID_IDENT_RE.test(k)) {
              keys.push(k);
              valList.push(v);
            }
          }
          try {
            await engine.callFunction('__flRunAction', [expr, keys, valList, event.value ?? '']);
          } catch {}
        }
      }
    }

    // Render updated DOM after event mutation
    const postActions = new Map();
    const postInputs = new Map();
    const html = renderAst(ast, engine, postActions, postInputs);

    // Snapshot serializable top-level state variables for the visitor's session
    const stateKeys = [...new Set([...varNames, ...Object.keys(prevState || {})])]
      .filter(k => VALID_IDENT_RE.test(k) && !reservedGlobals.has(k));
    let nextState = {};
    try {
      const snap = engine.callFunction('__flSnapshotState', [stateKeys]);
      if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
        nextState = snap;
      }
    } catch {}

    const css = DEFAULT_CSS + '\n' + safeCss([...extraCss, ...styleBlocks].join('\n'));
    process.stdout.write(JSON.stringify({
      title: typeof manifest.name === 'string' ? manifest.name : 'Marketplace Sandbox',
      html,
      css,
      state: nextState,
      backendCalls,
    }));
  } finally {
    try { engine.dispose(); } finally { engine.free(); }
  }
}

main().catch(err => {
  process.stderr.write(String(err?.message || err || 'render_error') + '\n');
  process.exit(1);
});
