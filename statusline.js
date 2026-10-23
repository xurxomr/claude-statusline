#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Claude Code status line.
//
// Wired up from ~/.claude/settings.json:
//
//   "statusLine": { "type": "command",
//                   "command": "node ~/.claude/statusline/statusline.js" }
//
// This is NOT a hook. Hooks are a different mechanism entirely: they live
// under the "hooks" key of settings.json, bind to lifecycle events
// (PreToolUse, Stop, SessionStart...) and are never auto-discovered from a
// directory. The status line is its own contract: one command, a JSON object
// on stdin, one line on stdout.
//
// Everything rendered here comes from that stdin JSON or from local git. No
// network requests, no reading of credentials, no undocumented HTTP endpoints.
//
// Layout: everything flush left, most important first.
//
//   📁 dir │ 🌿 branch │ Opus 5/high │ ctx [███░] 74% left 260k/1M │ 5h [█░░░] 11% 2h04m │ 7d 1% │ $0.92 │ task
//
// In both bars the FILLED blocks are what has been consumed. The context
// label reports what is still free ("left"), the limit labels report what has
// been used, so each number is explicit about which direction it runs in.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Set CC_STATUS_DEBUG=1 to see on stderr what is failing instead of having
// every problem swallowed silently.
const DEBUG = !!process.env.CC_STATUS_DEBUG;
const warn = (where, e) => { if (DEBUG) console.error(`[statusline] ${where}: ${e && e.message}`); };

// ---- Tunables (all overridable from the environment) ----------------------
const BAR_WIDTH   = int(process.env.CC_BAR_WIDTH, 10);
const BAR_FULL    = process.env.CC_BAR_FULL  || '█';  // █
const BAR_EMPTY   = process.env.CC_BAR_EMPTY || '░';  // ░
// Columns left free at the right edge. Claude Code cycles system notifications
// (MCP errors, auto-update, context-low warnings) through the right side of
// this row, and overshooting the width wraps the line onto a second row.
const MARGIN      = int(process.env.CC_STATUS_MARGIN, 2);
// Severity at which a bar starts screaming: adds 💀 and ANSI blink.
const PANIC_AT    = int(process.env.CC_PANIC_AT, 90);
const TASK_MAX    = int(process.env.CC_TASK_MAX, 40);
const SEP         = ' │ ';                            // │

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// ---- ANSI ----------------------------------------------------------------
//
// Secondary text uses explicit greys from the 256-color ramp (232 = black,
// 255 = white) instead of `dim` or `bright black`. Those two are a trap on a
// dark background: SGR 2 and SGR 90 each darken the text, combining them
// ("\x1b[2;90m") leaves it barely readable, and how dark they land is up to
// the terminal's palette rather than up to us. A number from the ramp renders
// the same everywhere. Raise CC_GREY_BOOST to lighten all three at once.
const GREY_BOOST = int(process.env.CC_GREY_BOOST, 0);
const grey = (n) => `\x1b[38;5;${Math.min(255, Math.max(232, n + GREY_BOOST))}m`;

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  blink:  '\x1b[5m',
  sep:    grey(243),   // the │ dividers: present but out of the way
  muted:  grey(246),   // supporting data: tokens, cost, effort, task
  label:  grey(249),   // the words that name a value: ctx, 5h, 7d
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red:    '\x1b[31m',
};

// ---------------------------------------------------------------------------
// Cell-width measurement.
//
// Padding the gap between the two zones requires the on-screen width, which is
// neither the byte length nor the code-point count: ANSI escapes occupy no
// cells, emoji occupy two, combining marks occupy none. Measuring by code
// points would drift by one cell per emoji and push the right zone off the
// edge.
// ---------------------------------------------------------------------------
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) ||
         (cp >= 0x2e80 && cp <= 0xa4cf) ||
         (cp >= 0xac00 && cp <= 0xd7a3) ||
         (cp >= 0xf900 && cp <= 0xfaff) ||
         (cp >= 0xfe30 && cp <= 0xfe6f) ||
         (cp >= 0xff00 && cp <= 0xff60) ||
         (cp >= 0xffe0 && cp <= 0xffe6) ||
         (cp >= 0x1f300 && cp <= 0x1f64f) ||
         (cp >= 0x1f680 && cp <= 0x1f6ff) ||
         (cp >= 0x1f900 && cp <= 0x1f9ff) ||
         (cp >= 0x20000 && cp <= 0x3fffd);
}

function isZeroWidth(cp) {
  return (cp >= 0x0300 && cp <= 0x036f) ||   // combining diacriticals
         cp === 0xfe0f || cp === 0xfe0e ||   // variation selectors
         cp === 0x200d;                      // zero-width joiner
}

function cellWidth(str) {
  let w = 0;
  for (const ch of str.replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0);
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Bars and formatting
// ---------------------------------------------------------------------------

// One severity scale for every bar, so a color means the same thing wherever
// it appears: green fine, yellow watch it, orange tight, red trouble.
function severityColor(sev) {
  if (sev < 50) return C.green;
  if (sev < 75) return C.yellow;
  if (sev < 90) return C.orange;
  return C.red;
}

// `severity` is always "how bad is it" (0 = perfect, 100 = exhausted), which
// for both context and rate limits is the percentage consumed.
function bar(severity) {
  const sev = clamp(Math.round(severity), 0, 100);

  // Round to the nearest cell, then nudge the ends so that a small-but-nonzero
  // usage still shows one block and a nearly-full bar still shows one gap.
  let filled = Math.round((sev * BAR_WIDTH) / 100);
  if (filled === 0 && sev > 0) filled = 1;
  if (filled >= BAR_WIDTH && sev < 100) filled = BAR_WIDTH - 1;

  const body = BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
  const color = severityColor(sev);
  const panic = sev >= PANIC_AT;

  // Note: some terminals ignore SGR 5 (blink) and will just show the skull.
  return `${panic ? C.blink : ''}${color}${panic ? '\u{1F480} ' : ''}[${body}]${C.reset}`;
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtCost(usd) {
  if (!Number.isFinite(usd)) return null;
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

// Accepts either an epoch (seconds or milliseconds) or an ISO string.
function fmtUntil(resetsAt) {
  if (resetsAt === undefined || resetsAt === null) return null;
  let ms;
  if (typeof resetsAt === 'number') ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  else ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;

  const mins = Math.floor((ms - Date.now()) / 60000);
  if (mins < 0) return null;
  const h = Math.floor(mins / 60);
  // Days once past 24h: the weekly window resets ~150 hours out, and "151h47m"
  // is a number you have to stop and divide.
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  return h > 0 ? `${h}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

// ---------------------------------------------------------------------------
// Local data sources (git, transcript)
// ---------------------------------------------------------------------------
function gitBranch(cwd) {
  const run = (args) => execFileSync('git', ['-C', cwd, '--no-optional-locks', ...args],
    { encoding: 'utf8', timeout: 400, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return run(['branch', '--show-current']) || run(['rev-parse', '--short', 'HEAD']) || null;
  } catch (e) {
    warn('git', e);               // not a repo, or git missing: both fine
    return null;
  }
}

// The in-progress to-do, if there is one.
//
// This is the one genuinely fragile segment: Claude Code exposes no to-do
// field on stdin, so it has to be read out of internal state. The legacy
// ~/.claude/todos/ directory that older status lines read no longer exists
// (checked on 2.1.268), so the transcript is the current source. Only its
// tail is read, newest line first, and anything unexpected degrades to no
// segment at all rather than to a wrong one.
function currentTask(data) {
  return taskFromTodosDir(data) || taskFromTranscript(data);
}

function taskFromTodosDir(data) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'todos');
    const sid = data.session_id;
    if (!sid || !fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(sid) && f.endsWith('.json'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files) {
      const todos = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const live = (Array.isArray(todos) ? todos : []).find((t) => t.status === 'in_progress');
      if (live) return live.activeForm || live.content || null;
    }
  } catch (e) { warn('todos', e); }
  return null;
}

const TAIL_BYTES = 128 * 1024;

function taskFromTranscript(data) {
  try {
    const p = data.transcript_path;
    if (!p || !fs.existsSync(p)) return null;

    const size = fs.statSync(p).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }

    const lines = buf.toString('utf8').split('\n');
    // Newest first, and stop at the first to-do list found: that is the
    // current one.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('TodoWrite')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }  // truncated first line
      const content = (obj.message && obj.message.content) || [];
      for (const block of Array.isArray(content) ? content : []) {
        const todos = block && block.name === 'TodoWrite' && block.input && block.input.todos;
        const live = (Array.isArray(todos) ? todos : []).find((t) => t.status === 'in_progress');
        if (live) return live.activeForm || live.content || null;
      }
    }
  } catch (e) { warn('transcript', e); }
  return null;
}

function truncate(s, max) {
  if (!s) return s;
  return cellWidth(s) <= max ? s : [...s].slice(0, Math.max(1, max - 1)).join('') + '…';
}

// ---------------------------------------------------------------------------
// Segment assembly
//
// Each segment carries a priority. When the terminal is too narrow for all of
// them, the lowest-priority segments are dropped one at a time until the line
// fits; anything at priority >= 90 is load-bearing and never dropped.
// ---------------------------------------------------------------------------
function buildSegments(data) {
  const segs = [];
  const add = (prio, text) => { if (text) segs.push({ prio, text }); };

  const cwd = (data.workspace && data.workspace.current_dir) || data.cwd || process.cwd();
  add(100, `${C.cyan}\u{1F4C1} ${path.basename(cwd) || cwd}${C.reset}`);

  const branch = gitBranch(cwd);
  add(60, branch && `${C.magenta}\u{1F33F} ${branch}${C.reset}`);

  // Model and effort read as one identity, so they are joined with a slash
  // rather than separated like independent segments.
  const model = (data.model && data.model.display_name) || 'Claude';
  const effort = data.effort && data.effort.level;
  add(100, `${C.bold}${model}${C.reset}${effort ? `${C.sep}/${C.reset}${C.muted}${effort}${C.reset}` : ''}`);

  const ctx = data.context_window || {};
  const usedPct = Number.isFinite(ctx.used_percentage)
    ? ctx.used_percentage
    : (Number.isFinite(ctx.remaining_percentage) ? 100 - ctx.remaining_percentage : null);
  if (usedPct !== null) {
    const leftPct = clamp(Math.round(100 - usedPct), 0, 100);
    const tokens = `${fmtTokens(ctx.total_input_tokens)}/${fmtTokens(ctx.context_window_size)}`;
    add(95, `${C.label}ctx${C.reset} ${bar(usedPct)} ${leftPct}% left ${C.muted}${tokens}${C.reset}`);
  } else {
    add(95, `${C.label}ctx [${BAR_EMPTY.repeat(BAR_WIDTH)}] ?${C.reset}`);
  }

  // Rate limits, straight from stdin. No API call, no token, no cache: Claude
  // Code already reports both windows here.
  const rl = data.rate_limits || {};
  if (rl.five_hour && Number.isFinite(rl.five_hour.used_percentage)) {
    const p = Math.round(rl.five_hour.used_percentage);
    const until = fmtUntil(rl.five_hour.resets_at);
    add(70, `${C.label}5h${C.reset} ${bar(p)} ${p}%${until ? ` ${C.muted}${until}${C.reset}` : ''}`);
  } else if (rl.seven_day) {
    // Rate limits are being reported, but this window is momentarily missing:
    // it comes back absent or null right after the 5-hour window resets. Keep
    // the slot rather than letting the line silently change shape, which reads
    // as a bug. (If `rate_limits` is absent altogether, as with an API key,
    // nothing is shown at all.)
    add(70, `${C.label}5h${C.reset} ${C.muted}?${C.reset}`);
  }
  if (rl.seven_day && Number.isFinite(rl.seven_day.used_percentage)) {
    const p = Math.round(rl.seven_day.used_percentage);
    const until = fmtUntil(rl.seven_day.resets_at);
    // No bar here: the weekly window moves slowly, so the number carries it and
    // the ten cells are better spent elsewhere.
    add(25, `${C.label}7d${C.reset} ${severityColor(p)}${p}%${C.reset}${until ? ` ${C.muted}${until}${C.reset}` : ''}`);
  }

  const cost = fmtCost(data.cost && data.cost.total_cost_usd);
  add(35, cost && `${C.muted}${cost}${C.reset}`);

  // Last because it is the longest and the least load-bearing.
  const task = truncate(currentTask(data), TASK_MAX);
  add(30, task && `${C.muted}${task}${C.reset}`);

  return segs;
}

// ---------------------------------------------------------------------------
// Composition: join everything flush left, dropping whatever does not fit.
//
// Terminal width comes from $COLUMNS, which Claude Code exports before running
// this script. It cannot come from the tty: Claude Code captures stdout rather
// than attaching it to the terminal, so there is nothing to query. It is used
// only to decide what to drop — nothing is padded or positioned, so a stale
// COLUMNS after a resize costs nothing.
// ---------------------------------------------------------------------------
function join(segs) {
  return segs.map((s) => s.text).join(C.sep + SEP + C.reset);
}

function compose(segs) {
  const cols = int(process.env.COLUMNS, 0);
  let active = segs.slice();

  if (cols > 0) {
    const budget = cols - MARGIN;
    while (cellWidth(join(active)) > budget) {
      const droppable = active.filter((s) => s.prio < 90).sort((a, b) => a.prio - b.prio);
      if (!droppable.length) break;   // only load-bearing segments left
      active = active.filter((s) => s !== droppable[0]);
    }
  }

  return join(active);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function render(data) {
  try {
    return compose(buildSegments(data));
  } catch (e) {
    warn('render', e);
    return `${C.muted}status unavailable${C.reset}`;
  }
}

function main(raw) {
  // CC_STATUS_DUMP=<path> writes the raw stdin JSON there on every render. The
  // only way to see what Claude Code actually sends, which is worth having:
  // fields come and go between versions.
  if (process.env.CC_STATUS_DUMP) {
    try { fs.writeFileSync(process.env.CC_STATUS_DUMP, raw); } catch (e) { warn('dump', e); }
  }
  let data = {};
  try { data = JSON.parse(raw); } catch (e) { warn('stdin', e); }
  process.stdout.write(render(data) + '\n');
}

if (process.stdin.isTTY) {
  main('{}');            // run by hand from a shell: render with defaults
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => main(input));
  process.stdin.on('error', (e) => { warn('stdin', e); main('{}'); });
}
