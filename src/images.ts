// Bilder som ikke kan bygges rett inn i en PDF (WebP, GIF, BMP, eller mobilbilder
// som er lagret på siden) tegnes om i nettleseren til JPEG eller PNG.
import type { ImageInfo } from "./edit";

export async function normalizeImage(bytes: Uint8Array, info: ImageInfo): Promise<Uint8Array> {
  // EXIF-retningen brukes, så bildet står slik det ble tatt.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Foto forblir JPEG; grafikk (PNG, GIF, BMP) blir tapsfri PNG.
  const blob = await canvas.convertToBlob(info.kind === "jpeg" ? { type: "image/jpeg", quality: 0.92 } : { type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
