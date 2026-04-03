import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { performance } from "perf_hooks";

async function writeRepoFilesSequential(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(rootDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }
}

async function writeRepoFilesConcurrent(rootDir, files) {
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const targetPath = join(rootDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }));
}

async function run() {
    const rootDir1 = await mkdtemp(join(tmpdir(), "benchmark-write-seq-"));
    const rootDir2 = await mkdtemp(join(tmpdir(), "benchmark-write-con-"));
    const files = {};
    for (let i = 0; i < 1000; i++) {
        files["dir" + (i % 20) + "/file" + i + ".txt"] = "content" + i;
    }

    const startSeq = performance.now();
    await writeRepoFilesSequential(rootDir1, files);
    const endSeq = performance.now();

    const startCon = performance.now();
    await writeRepoFilesConcurrent(rootDir2, files);
    const endCon = performance.now();

    console.log("Sequential writeRepoFiles took " + (endSeq - startSeq) + " ms");
    console.log("Concurrent writeRepoFiles took " + (endCon - startCon) + " ms");

    await rm(rootDir1, { recursive: true, force: true });
    await rm(rootDir2, { recursive: true, force: true });
}

run();
