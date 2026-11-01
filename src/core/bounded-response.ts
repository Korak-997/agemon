export async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of body) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
