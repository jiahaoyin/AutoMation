#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fail() {
  process.exitCode = 1;
}

function copyDescriptor(sourceFd, targetFd) {
  const buffer = Buffer.allocUnsafe(16 * 1024);
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EINTR") continue;
      throw error;
    }
    if (bytesRead === 0) return;
    let offset = 0;
    while (offset < bytesRead) {
      try {
        offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
      } catch (error) {
        if (error?.code === "EINTR") continue;
        throw error;
      }
    }
  }
}

function main() {
  const [mode, fifoPath] = process.argv.slice(2);
  if (
    !["read", "write"].includes(mode) ||
    !fifoPath ||
    !path.isAbsolute(fifoPath) ||
    /[\0\r\n]/.test(fifoPath) ||
    (fs.constants.O_NOFOLLOW ?? 0) === 0
  ) {
    fail();
    return;
  }

  let descriptor = null;
  try {
    const access = mode === "read" ? fs.constants.O_RDONLY : fs.constants.O_WRONLY;
    descriptor = fs.openSync(fifoPath, access | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFIFO() || (stats.mode & 0o777) !== 0o600) {
      throw new Error("invalid FIFO");
    }
    if (mode === "read") copyDescriptor(descriptor, process.stdout.fd);
    else copyDescriptor(process.stdin.fd, descriptor);
  } catch {
    fail();
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        fail();
      }
    }
  }
}

main();
