import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

// Only generated output is removed; source and project files stay untouched.
const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'src']) {
  await cp(new URL(`../${name}`, import.meta.url), new URL(name, output), { recursive: true });
}
await writeFile(new URL('.nojekyll', output), '');
console.log('Built static application in dist/ (relative URLs support GitHub project pages).');
