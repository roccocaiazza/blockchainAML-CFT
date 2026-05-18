import { ethers } from "ethers";
import { CryptoEngine } from "../utils/crypto-utils";
import { StorageService } from "./StorageService";
import { DIDService } from "./DIDService";

export interface CreateDossierParams {
    submitter: ethers.Signer;
    dossierId: string;
    bankCredId: string;
    recipientDid: string;
    recipientAddress: string;
    documentBuffer: Buffer;
}

export interface ForwardDossierParams {
    handler: ethers.Signer;
    handlerPrivateKey: string;
    dossierId: string;
    nextRecipientDid: string;
    nextRecipientAddress: string;
    nextState: number;
    updatedDocumentBuffer?: Buffer; // Se non fornito, inoltra il documento originale in chiaro testualmente
}

export class DossierService {
    private docRegistry: any;
    private didService: DIDService;
    private storageService: StorageService;

    constructor(docRegistryContract: any, didService: DIDService, storageService: StorageService) {
        this.docRegistry = docRegistryContract;
        this.didService = didService;
        this.storageService = storageService;
    }

    /**
     * Crea un nuovo Dossier, cifra i dati, li carica su IPFS e chiude la busta digitale
     * usando la chiave pubblica del destinatario.
     */
    async createAndSubmitDossier(params: CreateDossierParams): Promise<void> {
        console.log(`\n[DossierService] Creazione e sottomissione Dossier: ${params.dossierId}`);
        
        // 1. Genera DEK monouso e cifra il documento
        const dek = CryptoEngine.generateDEK();
        const encryptedPayload = CryptoEngine.encryptDocument(params.documentBuffer, dek);
        
        // 2. Carica su IPFS
        const ipfsCid = await this.storageService.uploadDocument(Buffer.from(encryptedPayload.cipherText));
        
        // 3. Risolvi il DID del destinatario per ottenere la sua chiave pubblica
        const recipientDoc = await this.didService.resolveDID(params.recipientDid);
        
        // 4. Busta Digitale: cifra la DEK
        const digitalEnvelope = CryptoEngine.wrapKey(dek, recipientDoc.publicKey);
        
        // 5. Trasmetti on-chain
        console.log(`[DossierService] Registrazione on-chain in corso...`);
        const tx = await this.docRegistry.connect(params.submitter).submitDossier(
            ethers.id(params.dossierId),
            ethers.id(params.bankCredId),
            params.recipientAddress,
            ipfsCid,
            digitalEnvelope
        );
        await tx.wait();
        
        console.log(`[DossierService] Dossier sottomesso con successo.`);
    }

    /**
     * Un'autorità legge il Dossier, apre la busta digitale, processa il documento 
     * e lo inoltra (re-wrapping) alla prossima autorità.
     */
    async reviewAndForwardDossier(params: ForwardDossierParams): Promise<void> {
        console.log(`\n[DossierService] Review e inoltro Dossier: ${params.dossierId}`);
        
        // 1. Recupera i metadati on-chain
        const dossierIdBytes = ethers.id(params.dossierId);
        const dossierData = await this.docRegistry.dossiers(dossierIdBytes);
        
        // 2. Apre la busta digitale
        const decyptedDEK = CryptoEngine.unwrapKey(dossierData.encryptedDEK, params.handlerPrivateKey);
        console.log(`[DossierService] Busta digitale aperta con successo.`);
        
        // --- QUI AVVERREBBE IL DOWNLOAD DA IPFS E LA DECIFRATURA COMPLETA ---
        // Al momento il buffer aggiornato viene passato esplicitamente
        // ------------------------------------------------------------------
        
        if(!params.updatedDocumentBuffer) {
            throw new Error("Il documento aggiornato è richiesto per proseguire (Mock IPFS behavior)");
        }
        
        // 3. Ri-cifra il documento (nuovo o lo stesso) con la STESSA DEK 
        // (O potresti generare una nuova DEK, ma usare la stessa è valido)
        const nuovoEncryptedPayload = CryptoEngine.encryptDocument(params.updatedDocumentBuffer, decyptedDEK);
        
        // 4. Carica nuovo documento su IPFS
        const updatedCid = await this.storageService.uploadDocument(Buffer.from(nuovoEncryptedPayload.cipherText));
        
        // 5. Ottieni chiave pubblica del prossimo destinatario
        const nextRecipientDoc = await this.didService.resolveDID(params.nextRecipientDid);
        
        // 6. Crea la nuova busta digitale (Re-Wrapping)
        const newDigitalEnvelope = CryptoEngine.wrapKey(decyptedDEK, nextRecipientDoc.publicKey);
        
        // 7. Salva il passaggio di stato su blockchain
        console.log(`[DossierService] Registrazione della transizione di stato in corso...`);
        const tx = await this.docRegistry.connect(params.handler).transitionDossier(
            dossierIdBytes,
            params.nextState,
            params.nextRecipientAddress,
            updatedCid,
            newDigitalEnvelope
        );
        await tx.wait();
        
        console.log(`[DossierService] Transizione completata.`);
    }
}
