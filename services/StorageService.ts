import { addFile, stopNode } from "../utils/helia-node";

export class StorageService {
    /**
     * Carica un documento su IPFS tramite Helia e restituisce il CID formattato.
     * @param buffer Il contenuto crittografato (o in chiaro) da caricare
     * @returns Una stringa nel formato "ipfs://[CID]"
     */
    async uploadDocument(buffer: Buffer): Promise<string> {
        console.log("[StorageService] Caricamento su IPFS locale in corso...");
        const rawCid = await addFile(new Uint8Array(buffer));
        const ipfsUri = `ipfs://${rawCid}`;
        console.log(`[StorageService] Caricamento completato. CID: ${ipfsUri}`);
        return ipfsUri;
    }

    /**
     * Ferma il nodo IPFS (utile per concludere in modo pulito gli script Node)
     */
    async shutdown(): Promise<void> {
        await stopNode();
    }
}
