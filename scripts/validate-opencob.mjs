#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const opencobDir = path.join(repoRoot, '.opencob');

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  } catch (error) {
    fail(`Cannot read ${path.relative(repoRoot, filePath)}: ${error.message}`);
    return '';
  }
}

function listMarkdownFilesRecursive(rootDir) {
  const output = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      output.push(...listMarkdownFilesRecursive(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(absolutePath);
    }
  }

  return output;
}

function parseJson(filePath) {
  const content = readText(filePath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`Invalid JSON in ${path.relative(repoRoot, filePath)}: ${error.message}`);
    return null;
  }
}

function assertFileExists(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
  }
}

function validateCustomModes() {
  const filePath = path.join(opencobDir, 'custom_modes.json');
  const parsed = parseJson(filePath);
  if (!parsed) {
    return;
  }

  const allowedModes = new Set(['ask', 'plan', 'code', 'advanced', 'orchestrator']);
  const allowedTools = new Set(['read', 'search', 'edit', 'analysis', 'command', 'meta', 'mcp']);

  if (!Array.isArray(parsed.customModes)) {
    fail('.opencob/custom_modes.json must define customModes as an array');
    return;
  }

  if (parsed.customModes.length === 0) {
    warn('.opencob/custom_modes.json has no custom modes defined');
    return;
  }

  const seenSlugs = new Set();

  parsed.customModes.forEach((mode, index) => {
    const prefix = `.opencob/custom_modes.json customModes[${index}]`;

    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) {
      fail(`${prefix} must be an object`);
      return;
    }

    const requiredStringFields = ['slug', 'name', 'description', 'roleDefinition'];
    for (const field of requiredStringFields) {
      if (typeof mode[field] !== 'string' || mode[field].trim().length === 0) {
        fail(`${prefix}.${field} must be a non-empty string`);
      }
    }

    if (typeof mode.slug === 'string') {
      if (seenSlugs.has(mode.slug)) {
        fail(`${prefix}.slug "${mode.slug}" is duplicated`);
      }
      seenSlugs.add(mode.slug);
    }

    if (!Array.isArray(mode.tools) || mode.tools.length === 0) {
      fail(`${prefix}.tools must be a non-empty array`);
    } else {
      mode.tools.forEach((toolName) => {
        if (typeof toolName !== 'string') {
          fail(`${prefix}.tools contains a non-string value`);
          return;
        }

        if (!allowedTools.has(toolName)) {
          warn(`${prefix}.tools includes unrecognized tool "${toolName}"`);
        }
      });
    }

    if (!Array.isArray(mode.allowedModes) || mode.allowedModes.length === 0) {
      fail(`${prefix}.allowedModes must be a non-empty array`);
    } else {
      mode.allowedModes.forEach((allowedMode) => {
        if (typeof allowedMode !== 'string') {
          fail(`${prefix}.allowedModes contains a non-string value`);
          return;
        }

        if (!allowedModes.has(allowedMode)) {
          warn(`${prefix}.allowedModes includes unrecognized mode "${allowedMode}"`);
        }
      });
    }
  });
}

function validateMcpServers() {
  const filePath = path.join(opencobDir, 'mcp-servers.json');
  const parsed = parseJson(filePath);
  if (!parsed) {
    return;
  }

  if (
    !parsed.mcpServers ||
    typeof parsed.mcpServers !== 'object' ||
    Array.isArray(parsed.mcpServers)
  ) {
    fail('.opencob/mcp-servers.json must define mcpServers as an object map');
    return;
  }

  for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
    const prefix = `.opencob/mcp-servers.json mcpServers.${serverName}`;

    if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
      fail(`${prefix} must be an object`);
      continue;
    }

    if (typeof serverConfig.command !== 'string' || serverConfig.command.trim().length === 0) {
      fail(`${prefix}.command must be a non-empty string`);
    }

    if (serverConfig.args !== undefined && !Array.isArray(serverConfig.args)) {
      fail(`${prefix}.args must be an array when provided`);
    }

    if (
      serverConfig.env !== undefined &&
      (typeof serverConfig.env !== 'object' || Array.isArray(serverConfig.env))
    ) {
      fail(`${prefix}.env must be an object when provided`);
    }
  }
}

function parseFrontmatter(markdownText) {
  const normalized = markdownText.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) {
    return null;
  }

  const secondDivider = normalized.indexOf('\n---\n', 4);
  if (secondDivider === -1) {
    return null;
  }

  const frontmatterRaw = normalized.slice(4, secondDivider);
  const lines = frontmatterRaw.split('\n');
  const data = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    data[key] = value;
  }

  return data;
}

function validateMarkdownFrontmatter(relativeDir, requiredFields) {
  const absoluteDir = path.join(opencobDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    fail(`Missing directory: .opencob/${relativeDir}`);
    return;
  }

  const files = listMarkdownFilesRecursive(absoluteDir);

  if (files.length === 0) {
    warn(`No markdown files found in .opencob/${relativeDir}`);
  }

  files.forEach((absolutePath) => {
    const relativePath = path.relative(repoRoot, absolutePath);
    const content = readText(absolutePath);
    if (!content) {
      return;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      fail(`${relativePath} is missing valid frontmatter block`);
      return;
    }

    requiredFields.forEach((field) => {
      if (typeof frontmatter[field] !== 'string' || frontmatter[field].trim().length === 0) {
        fail(`${relativePath} frontmatter must define non-empty ${field}`);
      }
    });

    if (frontmatter.applyTo && !frontmatter.applyTo.includes('*')) {
      warn(`${relativePath} applyTo does not include a glob pattern`);
    }
  });
}

function validateGitignore() {
  const gitignorePath = path.join(opencobDir, '.gitignore');
  const content = readText(gitignorePath);
  if (!content) {
    return;
  }

  if (!content.includes('conversations.json')) {
    fail('.opencob/.gitignore must ignore conversations.json');
  }
}

function main() {
  assertFileExists('.opencob/README.md');
  assertFileExists('.opencob/.gitignore');
  assertFileExists('.opencob/opencob-instructions.md');
  assertFileExists('.opencob/custom_modes.json');
  assertFileExists('.opencob/mcp-servers.json');

  validateCustomModes();
  validateMcpServers();
  validateMarkdownFrontmatter('instructions', ['applyTo', 'description']);
  validateMarkdownFrontmatter('hooks', ['event', 'applyTo', 'description']);
  validateGitignore();

  if (warnings.length > 0) {
    console.warn('opencob config warnings:');
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  if (errors.length > 0) {
    console.error('opencob config errors:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('opencob config validation passed');
}

main();
