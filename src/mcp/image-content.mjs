import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_STEP_IMAGES = 4;
export const MAX_STEP_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_IMAGES = 4;
export const MAX_TASK_IMAGE_BYTES = 8 * 1024 * 1024;

const extensions = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"],
  ["image/gif", "gif"], ["image/webp", "webp"],
]);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function rasterMime(value) {
  const mime = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  return extensions.has(mime) ? mime : null;
}

function base64Size(data) {
  if (typeof data !== "string" || !data.length || data.length % 4) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const body = data.slice(0, data.length - padding);
  if (/[^A-Za-z0-9+/]/.test(body)) return null;
  // Require zero unused bits as well as the standard alphabet and terminal padding.
  const last = alphabet.indexOf(body.at(-1));
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) return null;
  return data.length / 4 * 3 - padding;
}

export function extractImages(result, budget = {}) {
  const images = [];
  const omitted = [];
  let bytes = 0;
  const maxImages = Math.min(MAX_STEP_IMAGES, budget.images ?? MAX_STEP_IMAGES);
  const maxBytes = Math.min(MAX_STEP_IMAGE_BYTES, budget.bytes ?? MAX_STEP_IMAGE_BYTES);
  for (const block of result?.content ?? []) {
    if (block?.type !== "image") continue;
    const mimeType = rasterMime(block.mimeType);
    if (!mimeType) { omitted.push("unsupported-mime"); continue; }
    const size = base64Size(block.data);
    if (size === null) { omitted.push("invalid-base64"); continue; }
    if (size > MAX_IMAGE_BYTES) { omitted.push("size"); continue; }
    if (images.length >= maxImages || bytes + size > maxBytes) { omitted.push("limit"); continue; }
    images.push({ type: "image", data: block.data, mimeType, bytes: size });
    bytes += size;
  }
  return { images, bytes, omitted };
}

export function imageBlocks(images) {
  return images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

function plainName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !value.endsWith(".");
}

async function imageDirectory(dir, taskId, create = false) {
  if (!plainName(taskId)) throw new Error("Invalid image task id");
  const root = path.join(dir, "images");
  const directory = path.join(root, taskId);
  for (const target of [root, directory]) {
    if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid image directory");
  }
  return directory;
}

export async function storeImages(dir, taskId, stepIndex, images) {
  const refs = [];
  let failed = 0;
  if (!images.length) return { refs, failed };
  let directory;
  try { directory = await imageDirectory(dir, taskId, true); }
  catch { return { refs, failed: images.length }; }
  for (const image of images) {
    let handle;
    let file;
    try {
      const mimeType = rasterMime(image.mimeType);
      if (!mimeType || !Number.isInteger(stepIndex) || stepIndex < 0 ||
          !Number.isInteger(image.bytes) || image.bytes <= 0 || image.bytes > MAX_IMAGE_BYTES ||
          base64Size(image.data) !== image.bytes) throw new Error("Invalid image");
      const attachment = "step-" + stepIndex + "-" + randomUUID() + "." + extensions.get(mimeType);
      file = path.join(directory, attachment);
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(Buffer.from(image.data, "base64"));
      await handle.close();
      handle = null;
      refs.push({ type: "image", attachment, mimeType, bytes: image.bytes });
    } catch {
      failed++;
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(file).catch(() => {});
      }
    }
  }
  return { refs, failed };
}

export async function loadImages(dir, taskId, refs) {
  const images = [];
  let unavailable = 0;
  let bytes = 0;
  if (!refs.length) return { images, unavailable };
  let directory;
  try { directory = await imageDirectory(dir, taskId); }
  catch { return { images, unavailable: refs.length }; }
  for (const ref of refs) {
    let handle;
    try {
      const mimeType = rasterMime(ref?.mimeType);
      if (!plainName(ref?.attachment) || !mimeType ||
          !Number.isInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > MAX_IMAGE_BYTES ||
          images.length >= MAX_TASK_IMAGES || bytes + ref.bytes > MAX_TASK_IMAGE_BYTES) {
        throw new Error("Invalid image ref");
      }
      const file = path.join(directory, ref.attachment);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== ref.bytes) throw new Error("Invalid image file");
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== ref.bytes || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error("Image file changed");
      }
      // Read at most the declared size plus one byte, even if the file grows after stat.
      const data = Buffer.alloc(ref.bytes + 1);
      let length = 0;
      while (length < data.length) {
        const read = await handle.read(data, length, data.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== ref.bytes) throw new Error("Image size changed");
      images.push({ type: "image", data: data.subarray(0, length).toString("base64"), mimeType });
      bytes += ref.bytes;
    } catch { unavailable++; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }
  return { images, unavailable };
}

export function storedImageRefs(result) {
  return (result?.content ?? []).filter(block => block?.type === "image" && "attachment" in block);
}

export async function removeImages(dir, taskId) {
  const directory = await imageDirectory(dir, taskId);
  await fs.rm(directory, { recursive: true, force: true });
}

export function summarizeImageOmissions(omitted) {
  const labels = {
    "unsupported-mime": "unsupported format", "invalid-base64": "invalid base64",
    size: "size", limit: "limit",
  };
  return omitted.length ? "images omitted: " + [...new Set(omitted.map(reason => labels[reason] || reason))].join(", ") : "";
}
