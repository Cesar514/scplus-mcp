import { discoverHubs } from './build/core/hub.js';
import { resolve } from 'path';

async function main() {
    const root = resolve(process.cwd(), 'dummy-repo');

    // Warmup
    for (let i=0; i<2; i++) {
        await discoverHubs(root);
    }

    const times = [];
    for (let i=0; i<10; i++) {
        const start = performance.now();
        await discoverHubs(root);
        const end = performance.now();
        times.push(end - start);
    }
    const avg = times.reduce((a, b) => a + b) / times.length;
    console.log(`Average time: ${avg.toFixed(2)} ms`);
}

main();
