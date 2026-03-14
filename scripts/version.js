const fs = await import('fs/promises');

const target = process.argv[2] ?? 'patch';

const versionFile = new URL('../package.json', import.meta.url);
const content = JSON.parse(await fs.readFile(versionFile, 'utf8'));

const [major, minor, patch] = String(content.version)
  .split('.')
  .map((part) => Number.parseInt(part, 10));

if ([major, minor, patch].some(Number.isNaN)) {
  throw new Error('Invalid semantic version in package.json');
}

if (target === 'major') {
  content.version = `${major + 1}.0.0`;
} else if (target === 'minor') {
  content.version = `${major}.${minor + 1}.0`;
} else {
  content.version = `${major}.${minor}.${patch + 1}`;
}

await fs.writeFile(versionFile, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
console.log(`[version] bumped to ${content.version}`);
