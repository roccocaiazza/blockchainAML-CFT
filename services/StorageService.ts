import { addFile, stopNode } from "../utils/helia-node";

export class StorageService {

    // Carica un documento cifrato su IPFS e restituisce il CID nel formato "ipfs://[CID]".
    async uploadDocument(buffer: Buffer): Promise<string> {
        console.log("[StorageService] Caricamento su IPFS locale in corso...");
        const rawCid = await addFile(new Uint8Array(buffer));
        const ipfsUri = `ipfs://${rawCid}`;
        console.log(`[StorageService] Caricamento completato. CID: ${ipfsUri}`);
        return ipfsUri;
    }

    // Ferma il nodo IPFS in modo pulito.
    async shutdown(): Promise<void> {
        await stopNode();
    }
}
