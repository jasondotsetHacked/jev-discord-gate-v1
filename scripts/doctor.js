import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const results = [];
const commandName = (name) => process.platform === 'win32' && ['npx'].includes(name) ? `${name}.cmd` : name;

function record(status, label, detail = '') {
  results.push({ status, label, detail });
  const icon = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${icon.padEnd(4)} ${label}${detail ? `: ${detail}` : ''}`);
}

function run(command, args) {
  return spawnSync(commandName(command), args, { encoding: 'utf8', windowsHide: true });
}

function placeholder(value) {
  return !value || /^(replace-me|your[_-])/i.test(value);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  record(major >= 22 ? 'pass' : 'fail', 'Node.js', `v${process.versions.node}; 22+ required`);
}

function checkDependencies() {
  record(fs.existsSync('node_modules') ? 'pass' : 'fail', 'npm dependencies',
    fs.existsSync('node_modules') ? 'installed' : 'run npm ci');
}

function checkAws() {
  const version = run('aws', ['--version']);
  if (version.error || version.status !== 0) {
    record('fail', 'AWS CLI', 'not available');
    return;
  }

  const identity = run('aws', ['sts', 'get-caller-identity', '--output', 'json']);
  if (identity.status !== 0) {
    record('fail', 'AWS credentials', (identity.stderr || 'not configured').trim().split('\n')[0]);
    return;
  }

  try {
    const account = JSON.parse(identity.stdout).Account;
    record('pass', 'AWS credentials', account ? `account ${account}` : 'available');
  } catch {
    record('pass', 'AWS credentials', 'available');
  }
}

function checkDocker() {
  const result = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (result.error || result.status !== 0) {
    record('fail', 'Docker daemon', 'not available or not running');
    return;
  }
  record('pass', 'Docker daemon', `server ${result.stdout.trim()}`);
}

function checkCdk() {
  const result = run('npx', ['--no-install', 'cdk', '--version']);
  record(result.status === 0 ? 'pass' : 'fail', 'AWS CDK',
    result.status === 0 ? result.stdout.trim() : 'run npm ci');
}

function checkCredentials() {
  if (!fs.existsSync('credentials.json')) {
    record('fail', 'credentials.json', 'copy credentials.example.json and fill it in');
    return;
  }

  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
  } catch (error) {
    record('fail', 'credentials.json', `invalid JSON (${error.message})`);
    return;
  }

  for (const key of ['DISCORD_TOKEN', 'TYPESAFE_API_KEY']) {
    record(placeholder(credentials[key]) ? 'fail' : 'pass', key,
      placeholder(credentials[key]) ? 'missing or placeholder' : 'configured');
  }
  record(placeholder(credentials.OPENAI_API_KEY) ? 'warn' : 'pass', 'OPENAI_API_KEY',
    placeholder(credentials.OPENAI_API_KEY) ? 'optional in shadow mode' : 'configured');
}

console.log('Jev Discord Gate deployment check\n');
checkNode();
checkDependencies();
checkAws();
checkDocker();
checkCdk();
checkCredentials();

const failures = results.filter((result) => result.status === 'fail').length;
console.log(failures ? `\n${failures} required check(s) failed.` : '\nReady to deploy.');
if (failures) process.exitCode = 1;
