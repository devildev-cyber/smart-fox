/**
 * Shrinks big screenshots before they are uploaded. The vision API resizes
 * images itself (so this barely changes the token count); what it saves is
 * upload size and time, which matters for a raw 4K PNG over a live call.
 */

/** The size an image of `width` x `height` should have so its longest edge is at most `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge) || width <= 0 || height <= 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read the image."));
    img.src = src;
  });
}

/** Returns a JPEG data URL no larger than `maxEdge`, or the input unchanged if it is already small (or anything fails). */
export async function shrinkImage(
  dataUrl: string,
  maxEdge = 1800,
  quality = 0.85
): Promise<string> {
  if (typeof document === "undefined" || !dataUrl) return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    const target = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge);
    if (target.width === img.naturalWidth && target.height === img.naturalHeight) {
      return dataUrl;
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, target.width, target.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}
