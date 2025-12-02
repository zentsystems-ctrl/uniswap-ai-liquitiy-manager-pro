// scripts/generate-abis.js
const fs = require('fs');
const path = require('path');

const artifactsDir = path.join(__dirname, '..', 'artifacts', 'contracts');
const targetDir = path.join(__dirname, '..', 'src', 'abis');

function copyRec(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) copyRec(full);
    else if (f.endsWith('.json')) {
      const dest = path.join(targetDir, f);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(full, dest);
      console.log('copied', full, '->', dest);
    }
  }
}

copyRec(artifactsDir);
console.log('ABIs generation (copy) complete.');
