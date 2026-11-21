import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
  return css
    .replace(/<\/style/gi, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/url\s*\(\s*["']?\s*(?:javascript|vbscript):/gi, 'url(invalid:');
}

function readSafeFile(appDir, relPath) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('..') || relPath.startsWith('/')) {
    return null;
  }
  const full = resolve(appDir, relPath);
  if (!existsSync(full)) return null;
  const realApp = realpathSync(appDir);
  const realFull = realpathSync(full);
  if (!contained(realApp, realFull)) return null;
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

function normalizeApiPath(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('/api/')) return trimmed;
  if (trimmed.startsWith('api/')) return '/' + trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.startsWith('/api/')) {
      return parsed.pathname + parsed.search;
    }
  } catch {
    return null;
  }
  return null;
}

function invokeSandboxBackend(rootDir, dataDir, runtimeDir, manifest, rawUrl, options) {
  const apiPathWithQuery = normalizeApiPath(rawUrl);
  if (!apiPathWithQuery) {
    return { ok: false, status: 403, body: { error: 'External requests are blocked in the marketplace sandbox.' } };
  }
  const [pathPart, queryPart] = apiPathWithQuery.split('?', 2);
  const query = {};
  if (queryPart) {
    const sp = new URLSearchParams(queryPart);
    for (const [k, v] of sp.entries()) query[k] = v;
  }
  const method = String(options?.method || 'GET').toUpperCase();
  let body = options?.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = { raw: body }; }
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
        headers: options?.headers && typeof options.headers === 'object' ? options.headers : {},
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
  function parseNodes(stopTags = new Set()) {
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
          const consequent = parseNodes(new Set(['__BLOCK_END__']));
          let alternate = [];
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === ':else') {
            idx++;
            alternate = parseNodes(new Set(['__BLOCK_END__']));
          }
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === '/if') {
            idx++;
          }
          nodes.push({ type: 'if', cond, consequent, alternate });
          continue;
        }
        if (raw.startsWith('#each ')) {
          idx++;
          const m = /^#each\s+(.+?)\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?$/.exec(raw);
          const body = parseNodes(new Set(['__BLOCK_END__']));
          if (idx < tokens.length && tokens[idx].type === 'block' && tokens[idx].raw === '/each') {
            idx++;
          }
          if (m) {
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
        const children = tok.selfClose ? [] : parseNodes(new Set([tok.tag]));
        nodes.push({ type: 'element', tag: tok.tag, attrs: tok.attrs, children });
        continue;
      }
      idx++;
    }
    return nodes;
  }
  return parseNodes();
}

function evalExpr(context, expr, locals = {}) {
  try {
    const keys = Object.keys(locals);
    if (keys.length === 0) {
      return vm.runInContext(`(${expr})`, context, { timeout: 300 });
    }
    const fn = vm.runInContext(`(function(${keys.join(',')}){ return (${expr}); })`, context, { timeout: 300 });
    return fn(...keys.map(k => locals[k]));
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

    const gapMap = { xs: '0.25rem', sm: '0.5rem', md: '0.85rem', lg: '1.25rem', xl: '1.75rem' };
    const padMap = { none: '0', xs: '0.35rem', sm: '0.75rem', md: '1.15rem', lg: '1.65rem', xl: '2.25rem' };
    const sizeMap = { sm: '560px', md: '780px', lg: '1040px', xl: '1240px', full: '100%' };

    switch (tag) {
      case 'App':
        return `<div class="fl-app">${childrenHtml}</div>`;
      case 'Container': {
        const maxW = sizeMap[String(props.size || 'md')] || '780px';
        return `<div class="fl-container" style="max-width:${maxW}">${childrenHtml}</div>`;
      }
      case 'Stack': {
        const dir = props.direction === 'horizontal' ? 'row' : 'column';
        const gap = gapMap[String(props.gap || 'md')] || '0.85rem';
        const pad = props.padding ? (padMap[String(props.padding)] || '1rem') : '0';
        const align = props.align ? `align-items:${escapeAttr(String(props.align))};` : '';
        const justify = props.justify ? `justify-content:${escapeAttr(String(props.justify))};` : '';
        return `<div class="fl-stack" style="flex-direction:${dir};gap:${gap};padding:${pad};${align}${justify}">${childrenHtml}</div>`;
      }
      case 'Row': {
        const gap = gapMap[String(props.gap || 'md')] || '0.85rem';
        return `<div class="fl-row" style="gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Column': {
        const gap = gapMap[String(props.gap || 'md')] || '0.85rem';
        return `<div class="fl-col" style="gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Grid': {
        const cols = Math.max(1, Math.min(6, Number(props.columns || props.cols || 2) || 2));
        const gap = gapMap[String(props.gap || 'md')] || '1rem';
        return `<div class="fl-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));gap:${gap}">${childrenHtml}</div>`;
      }
      case 'Card': {
        const title = props.title ? `<div class="fl-card-title">${escapeHtml(props.title)}</div>` : '';
        return `<section class="fl-card"${extraEventStr}>${title}${childrenHtml}</section>`;
      }
      case 'Heading': {
        const level = Math.max(1, Math.min(6, Number(props.level || 2) || 2));
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
        const rows = Math.max(2, Math.min(12, Number(props.rows || 3) || 3));
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
        const href = typeof props.href === 'string' && /^(?:https?:\/\/|#)/.test(props.href) ? props.href : '#';
        return `<a class="fl-link" href="${escapeAttr(href)}" rel="noopener noreferrer"${extraEventStr}>${childrenHtml}</a>`;
      }
      case 'Image': {
        const src = typeof props.src === 'string' && /^(?:data:image\/|assets\/)/.test(props.src) ? props.src : '';
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
          if (lk === 'href' && typeof v === 'string' && !/^(?:https?:\/\/|#)/.test(v)) continue;
          if (lk === 'src' && typeof v === 'string' && !/^(?:data:image\/|assets\/)/.test(v)) continue;
          if (['class', 'id', 'type', 'name', 'value', 'placeholder', 'title', 'role', 'aria-label', 'href', 'src', 'alt', 'rows', 'cols', 'disabled', 'checked', 'selected'].includes(lk)) {
            if (typeof v === 'boolean') {
              if (v) safeAttrs.push(lk);
            } else if (v !== undefined && v !== null) {
              safeAttrs.push(`${lk}="${escapeAttr(String(v))}"`);
            }
          }
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

  const manifestRaw = readSafeFile(appDir, 'manifest.json');
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
      if (typeof rel === 'string' && !/^(?:server|backend|private)\//i.test(rel)) {
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
    if (typeof rel === 'string' && !/^(?:server|backend|private)\//i.test(rel)) {
      const src = readSafeFile(appDir, rel);
      if (src !== null) extraCss.push(src);
    }
  }

  const combinedLogic = rewriteTopLevelDecls([...extraLogic, ...logicBlocks].join('\n;\n'));
  const varNames = collectTopLevelVars(combinedLogic);

  let backendCalls = 0;
  const doBackendFetch = (url, opts, cb) => {
    if (backendCalls >= MAX_BACKEND_CALLS) {
      const lim = { ok: false, status: 429, body: { error: 'Too many sandbox backend calls in one turn' }, data: null };
      if (typeof cb === 'function') cb(lim);
      return Promise.resolve({ ...lim, json: async () => lim.body, text: async () => JSON.stringify(lim.body) });
    }
    backendCalls++;
    const res = invokeSandboxBackend(rootDir, dataDir, runtimeDir, manifest, url, opts || {});
    const wrapped = {
      ok: res.ok,
      status: res.status,
      body: res.body,
      data: res.body,
      json: async () => res.body,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    };
    if (typeof cb === 'function') {
      try { cb(wrapped); } catch {}
    }
    return Promise.resolve(wrapped);
  };

  const sandbox = {
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    console: { log() {}, warn() {}, error() {}, info() {} },
    softn: {
      net: { fetch: doBackendFetch },
      api: { fetch: doBackendFetch },
      time: { now: () => new Date().toISOString() },
    },
    api: { fetch: doBackendFetch },
    fetch: (url, opts) => doBackendFetch(url, opts),
  };

  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  if (combinedLogic.trim() !== '') {
    vm.runInContext(combinedLogic, context, { timeout: 1200 });
  }

  // Restore visitor's persisted session state variables
  const hasSavedState = prevState && typeof prevState === 'object' && Object.keys(prevState).length > 0;
  if (hasSavedState) {
    for (const [k, v] of Object.entries(prevState)) {
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) && !['softn', 'api', 'fetch', 'console'].includes(k)) {
        context[k] = v;
      }
    }
  }

  const ast = buildAst(tokenizeUi(markup));

  // First pass builds the valid server-side action/input registries for the current view
  const preActions = new Map();
  const preInputs = new Map();
  renderAst(ast, context, preActions, preInputs);

  // Sync any browser form field inputs mapped exclusively through opaque server-issued input IDs
  if (event && event.inputs && typeof event.inputs === 'object') {
    for (const [inputId, val] of Object.entries(event.inputs)) {
      const varName = preInputs.get(inputId);
      if (varName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) {
        context[varName] = val;
      }
    }
  }

  // Dispatch lifecycle or user interaction strictly via server-registered action ID
  if (!hasSavedState && (!event || event.type === 'init')) {
    for (const initFn of ['onMount', 'init', 'loadItems', 'load']) {
      if (typeof context[initFn] === 'function') {
        try {
          const r = context[initFn]();
          if (r && typeof r.then === 'function') await r;
        } catch {}
        break;
      }
    }
  } else if (event && typeof event.actionId === 'string') {
    const entry = preActions.get(event.actionId);
    if (entry) {
      const expr = entry.expr.trim();
      const locals = entry.locals || {};
      const keys = Object.keys(locals);
      const valList = keys.map(k => locals[k]);
      try {
        let res;
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(expr) && typeof context[expr] === 'function') {
          res = context[expr]({ target: { value: event.value ?? '' }, value: event.value ?? '' });
        } else {
          const invoker = vm.runInContext(
            `(function(${[...keys, '$event'].join(',')}){ return (${expr}); })`,
            context,
            { timeout: 1000 }
          );
          const evObj = { target: { value: event.value ?? '' }, value: event.value ?? '', preventDefault() {} };
          res = invoker(...valList, evObj);
          if (typeof res === 'function') {
            res = res(evObj);
          }
        }
        if (res && typeof res.then === 'function') {
          await res;
        }
      } catch {}
    }
  }

  // Render updated DOM after event mutation
  const postActions = new Map();
  const postInputs = new Map();
  const html = renderAst(ast, context, postActions, postInputs);

  // Snapshot serializable top-level state variables for the visitor's session
  const nextState = {};
  const stateKeys = new Set([...varNames, ...Object.keys(prevState || {})]);
  for (const k of stateKeys) {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)) continue;
    const val = context[k];
    if (typeof val === 'function' || typeof val === 'symbol' || val === undefined) continue;
    try {
      nextState[k] = JSON.parse(JSON.stringify(val));
    } catch {}
  }

  const css = DEFAULT_CSS + '\n' + safeCss([...extraCss, ...styleBlocks].join('\n'));
  process.stdout.write(JSON.stringify({
    title: typeof manifest.name === 'string' ? manifest.name : 'Marketplace Sandbox',
    html,
    css,
    state: nextState,
    backendCalls,
  }));
}

main().catch(err => {
  process.stderr.write(String(err?.message || err || 'render_error') + '\n');
  process.exit(1);
});
