#!/usr/bin/env node
// Parse dotenv with Node, never execute it as a shell script. Values are not logged.
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const argumentsList = process.argv.slice(2);
const files = argumentsList.filter((value) => !value.startsWith('--'));
if (files.length > 1 || argumentsList.some((value) => value.startsWith('--') && value !== '--ci'))
  throw new Error('Usage: bootstrap-admin.mjs [private-env-file] [--ci]');
const envFile = resolve(files[0] ?? '.env');
process.loadEnvFile(envFile);
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)
  throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in the private environment file');
const args = ['compose', '--env-file', envFile, '-f', 'infra/docker-compose.yml'];
if (process.argv.includes('--ci')) args.push('-f', 'infra/docker-compose.ci.yml');
args.push(
  'exec',
  '-T',
  '-e',
  'ADMIN_EMAIL',
  '-e',
  'ADMIN_PASSWORD',
  'api',
  'node',
  'apps/api/dist/cli/create-admin.js',
);
const result = spawnSync('docker', args, { stdio: 'inherit', env: process.env });
if (result.error)
  console.error(
    'Could not start Docker. Check that Docker Compose is installed and the stack is running.',
  );
process.exitCode = result.status ?? 1;
