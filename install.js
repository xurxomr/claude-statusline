#!/usr/bin/env node
'use strict';
// Installs the status line: copies the files next to this script into
// <claude config dir>/statusline and adds the "statusLine" entry to
// <claude config dir>/settings.json.
//
//   node install.js             install (or update)
//   node install.js --dry-run   show what would happen, change nothing
//   node install.js --force     replace a different statusLine already configured
//
// Anything it overwrites is first copied to <file>.bak-<timestamp>. If
// settings.json is not valid JSON it stops before touching anything.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node install.js [--dry-run] [--force]');
  process.exit(0);
}
const DRY = args.has('--dry-run');
const FORCE = args.has('--force');

const FILES = ['statusline.js', 'README.md', 'sample.json'];  // sample.json is optional
const defaultDir = path.join(os.homedir(), '.claude');
const configDir = process.env.CLAUDE_CONFIG_DIR || defaultDir;
const destDir = path.join(configDir, 'statusline');
const settingsPath = path.join(configDir, 'settings.json');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// With the default config dir, keep the portable "~" form; otherwise spell the
// path out (forward slashes work in every shell Claude Code runs commands in).
const script = path.join(destDir, 'statusline.js');
const command = configDir === defaultDir
  ? 'node ~/.claude/statusline/statusline.js'
  : `node "${script.replace(/\\/g, '/')}"`;
const wanted = { type: 'command', command };

const say = (m) => console.log(DRY ? `[dry-run] ${m}` : m);
const fail = (m) => { console.error(`Error: ${m}`); process.exit(1); };

// --- 1. Read settings.json first, so a broken file aborts before any change ---
let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
  try {
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    fail(`${settingsPath} is not valid JSON (${e.message}). Fix it and run again; nothing was changed.`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    fail(`${settingsPath} does not contain a JSON object; nothing was changed.`);
  }
}

// --- 2. Copy the files ---
say(`Destination: ${destDir}`);
if (!DRY) fs.mkdirSync(destDir, { recursive: true });
for (const name of FILES) {
  const src = path.join(__dirname, name);
  if (!fs.existsSync(src)) {
    if (name === 'statusline.js') fail(`${src} not found; run install.js from the repository folder.`);
    continue;
  }
  const dst = path.join(destDir, name);
  if (fs.existsSync(dst)) {
    if (fs.readFileSync(src).equals(fs.readFileSync(dst))) { say(`  = ${name} (unchanged)`); continue; }
    say(`  ~ ${name} (backup: ${name}.bak-${stamp})`);
    if (!DRY) fs.copyFileSync(dst, `${dst}.bak-${stamp}`);
  } else {
    say(`  + ${name}`);
  }
  if (!DRY) fs.copyFileSync(src, dst);
}

// --- 3. settings.json ---
const current = settings.statusLine;
const same = current && current.type === wanted.type && current.command === wanted.command;
if (same) {
  say('settings.json: statusLine already configured');
} else if (current && !FORCE) {
  console.warn(`settings.json: a different statusLine is already configured, left as is:\n  ${JSON.stringify(current)}`);
  console.warn('Run again with --force to replace it. Files were copied.');
  process.exit(2);
} else {
  say(`settings.json: ${current ? 'replacing' : 'adding'} statusLine -> ${command}`);
  if (!DRY) {
    fs.mkdirSync(configDir, { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak-${stamp}`);
    settings.statusLine = wanted;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}

if (!DRY) console.log('\nDone. Restart Claude Code to see the status line.');
