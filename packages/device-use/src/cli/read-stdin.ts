/** Read all data from stdin until EOF, with optional timeout. */
export function readStdin(timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
    };

    const onData = (chunk: string) => {
      data += chunk;
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data.trim());
    };

    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Timed out waiting for stdin after ${Math.ceil(timeoutMs / 1000)}s`));
          }, timeoutMs)
        : undefined;

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
