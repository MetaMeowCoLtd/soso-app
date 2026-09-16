/**
 * Every `SosoGateway` upload method (`uploadAvatar`, `uploadMessageMedia`)
 * takes a `Blob` — that's the one payload type used throughout
 * `packages/core/src/data/gateway.ts`, unchanged from the web port. RN's
 * `fetch` can read a local `file://` URI into a real `Blob` the same way it
 * reads a network response; this is the one line every media pipeline
 * function in this directory ends on before handing bytes to the gateway.
 */
export async function uriToBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  return response.blob();
}
