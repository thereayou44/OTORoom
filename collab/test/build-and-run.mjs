import { execSync } from 'child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

console.log('типы...');
run('npx tsc --noEmit');

console.log('\nсборка провайдера для тестов...');
run(
  'npx esbuild src/provider.ts --bundle --format=esm --outfile=test/provider.mjs ' +
  '--platform=neutral --external:yjs --external:y-protocols/* --external:lib0/* --log-level=warning',
);

console.log('\nлогика синхронизации:');
run('node test/run.mjs');

console.log('\nсборка бандла...');
run('npx vite build');

console.log('\nсобранный бандл:');
run('node test/bundle.mjs');
