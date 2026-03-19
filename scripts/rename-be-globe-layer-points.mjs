import fs from 'node:fs/promises';

const inputPath = process.argv[2] ?? 'demo/public/be-globe-layer-points.json';
const outputPath = process.argv[3] ?? inputPath;

let renamedCount = 0;

const renameObjectKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(renameObjectKeys);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const renamedKey = key === 'headingRadians' ? 'rotationRadians' : key;
    if (renamedKey !== key) {
      renamedCount += 1;
    }
    output[renamedKey] = renameObjectKeys(nestedValue);
  }

  return output;
};

const inputJson = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const outputJson = renameObjectKeys(inputJson);

await fs.writeFile(outputPath, `${JSON.stringify(outputJson, null, 2)}\n`, 'utf8');

console.log(
  `[rename-be-globe-layer-points] renamed ${renamedCount} headingRadians keys in ${inputPath}`
    + (outputPath === inputPath ? '' : ` to ${outputPath}`),
);