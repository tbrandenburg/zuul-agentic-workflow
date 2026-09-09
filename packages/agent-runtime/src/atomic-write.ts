import { openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";

/** Writes `content` to `outputPath` atomically: write to .tmp, fsync, rename. */
export function atomicWriteFile(outputPath: string, content: string): void {
  const tmpPath = `${outputPath}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, outputPath);
}
