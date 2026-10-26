import { clearLine, cursorTo } from "node:readline";

const FRAMES = ["|", "/", "-", "\\"];

export function spinnerEnabled({ stream = process.stderr, env = process.env, json = false } = {}) {
  return Boolean(stream?.isTTY && !env?.CI && !json);
}

export async function withSpinner(label, operation, {
  stream = process.stderr,
  env = process.env,
  json = false,
  intervalMs = 100,
} = {}) {
  let timer;
  let rendered = false;
  let frame = 0;
  const enabled = spinnerEnabled({ stream, env, json });
  const draw = () => {
    rendered = true;
    clearLine(stream, 0);
    cursorTo(stream, 0);
    stream.write(`${FRAMES[frame++ % FRAMES.length]} ${label}`);
  };

  try {
    if (enabled) {
      draw();
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
    }
    return await operation();
  } finally {
    if (timer) clearInterval(timer);
    if (rendered) {
      try {
        clearLine(stream, 0);
        cursorTo(stream, 0);
      } catch {}
    }
  }
}
