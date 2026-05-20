// In-memory Helia node
import type { Helia } from "helia";
import type { UnixFS } from "@helia/unixfs";

let _helia: Helia | null = null;
let _fs: UnixFS | null = null;

/** Lazily create (or reuse) a single Helia node for this process. */
export async function getNode(): Promise<{ helia: Helia; fs: UnixFS }> {
  if (_helia && _fs) return { helia: _helia, fs: _fs };

  // Trick essenziale: TypeScript converte gli 'import()' dinamici in 'require()' se il tsconfig 
  // ha "module": "commonjs", causando l'errore "MODULE_NOT_FOUND" perché Node vieta require su ESM.
  // Usando `new Function` forziamo Node.js ad eseguire il vero `import()` nativo!
  const loadESM = new Function('modulePath', 'return import(modulePath)');

  const { createHelia } = await loadESM("helia");
  const { unixfs } = await loadESM("@helia/unixfs");
  const { FsBlockstore } = await loadESM("blockstore-fs");
  const { FsDatastore } = await loadESM("datastore-fs");

  const blockstore = new FsBlockstore("./.ipfs/blocks");
  const datastore = new FsDatastore("./.ipfs/data");

  // start: false (we don't need libp2p networking for a local lab)
  _helia = await createHelia({ blockstore, datastore, start: false });
  _fs = unixfs(_helia);

  return { helia: _helia!, fs: _fs! };
}

/** Stop the Helia node. Call this in test `after()` so the runner exits cleanly. */
export async function stopNode(): Promise<void> {
  if (_helia) {
    await _helia.stop();
    _helia = null;
    _fs = null;
  }
}

/**
 * Add bytes (string | Uint8Array) to IPFS and return the CID as a string.
 * For small inputs you'll get a CIDv1 raw codec, base32-encoded (e.g. "bafk...").
 */
export async function addFile(content: string | Uint8Array): Promise<string> {
  const { fs } = await getNode();
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const cid = await fs.addBytes(bytes);
  return cid.toString();
}