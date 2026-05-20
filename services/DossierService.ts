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
    updatedDocumentBuffer?: Buffer; // Se non fornito, inoltra il documento originale
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
     *
     * KEY COMMITMENT: prima del key wrapping viene calcolato SHA-256(DEK) e registrato
     * on-chain come dekCommitment. Il ricevente potrà verificare l'integrità della busta
     * confrontando SHA-256(DEK_decifrata) con il valore notarizzato.
     */
    async createAndSubmitDossier(params: CreateDossierParams): Promise<void> {
        console.log(`\n[DossierService] Creazione e sottomissione Dossier: ${params.dossierId}`);

        // Genera DEK monouso e cifra il documento
        const dek = CryptoEngine.generateDEK();
        const encryptedPayload = CryptoEngine.encryptDocument(params.documentBuffer, dek);

        // KEY COMMITMENT: notarizza SHA-256(DEK) prima del wrapping
        const dekCommitment = CryptoEngine.computeDEKCommitment(dek);
        console.log(`[DossierService] DEK Commitment (SHA-256): ${dekCommitment}`);

        // Carica su IPFS
        const ipfsCid = await this.storageService.uploadDocument(Buffer.from(encryptedPayload.cipherText));

        // Risolvi il DID del destinatario per ottenere la sua chiave pubblica
        const recipientDoc = await this.didService.resolveDID(params.recipientDid);

        // Busta Digitale: cifra la DEK con la chiave pubblica del destinatario
        const digitalEnvelope = CryptoEngine.wrapKey(dek, recipientDoc.publicKey);

        // Trasmetti on-chain (con dekCommitment)
        console.log(`[DossierService] Registrazione on-chain in corso...`);
        const tx = await this.docRegistry.connect(params.submitter).submitDossier(
            ethers.id(params.dossierId),
            ethers.id(params.bankCredId),
            params.recipientAddress,
            ethers.toUtf8Bytes(ipfsCid),
            ethers.toUtf8Bytes(digitalEnvelope),
            dekCommitment  // bytes32: SHA-256(DEK) notarizzato on-chain
        );
        await tx.wait();

        console.log(`[DossierService] Dossier sottomesso con successo.`);
    }

    /**
     * Un'autorità legge il Dossier, apre la busta digitale, verifica il Key Commitment,
     * processa il documento e lo inoltra (re-wrapping) alla prossima autorità.
     *
     * Se SHA-256(DEK_decifrata) != dekCommitment on-chain, lancia un errore:
     * l'handler deve chiamare logDispute() per registrare la prova crittografica.
     */
    async reviewAndForwardDossier(params: ForwardDossierParams): Promise<void> {
        console.log(`\n[DossierService] Review e inoltro Dossier: ${params.dossierId}`);

        // 1. Recupera i metadati on-chain
        const dossierIdBytes = ethers.id(params.dossierId);
        const dossierData = await this.docRegistry.dossiers(dossierIdBytes);

        // 2. Apre la busta digitale
        const decryptedDEK = CryptoEngine.unwrapKey(
            ethers.toUtf8String(dossierData.encryptedDEK),
            params.handlerPrivateKey
        );
        console.log(`[DossierService] Busta digitale aperta con successo.`);

        // 3. VERIFICA KEY COMMITMENT: confronta SHA-256(DEK_decifrata) con il valore on-chain
        const onChainCommitment: string = dossierData.dekCommitment;
        const isValid = CryptoEngine.verifyDEKCommitment(decryptedDEK, onChainCommitment);
        if (!isValid) {
            // La DEK decifrata non corrisponde al commitment notarizzato on-chain.
            // Questo è la prova crittografica che la busta è stata manomessa.
            // L'handler deve chiamare logDispute() sul DelegationManager per registrare l'evidenza.
            throw new Error(
                `[DossierService] KEY COMMITMENT MISMATCH sul dossier ${params.dossierId}. ` +
                `La DEK decifrata non corrisponde al commitment on-chain (${onChainCommitment}). ` +
                `Chiamare logDispute() per registrare la prova crittografica.`
            );
        }
        console.log(`[DossierService] Key Commitment verificato con successo.`);

        // --- QUI AVVERREBBE IL DOWNLOAD DA IPFS E LA DECIFRATURA COMPLETA ---
        if (!params.updatedDocumentBuffer) {
            throw new Error("Il documento aggiornato è richiesto per proseguire (Mock IPFS behavior)");
        }

        // 4. Ri-cifra il documento con la stessa DEK (o una nuova — qui riusiamo la stessa)
        const nuovoEncryptedPayload = CryptoEngine.encryptDocument(params.updatedDocumentBuffer, decryptedDEK);

        // 5. Carica nuovo documento su IPFS
        const updatedCid = await this.storageService.uploadDocument(Buffer.from(nuovoEncryptedPayload.cipherText));

        // 6. Ottieni chiave pubblica del prossimo destinatario
        const nextRecipientDoc = await this.didService.resolveDID(params.nextRecipientDid);

        // 7. Crea la nuova busta digitale (Re-Wrapping JIT)
        const newDigitalEnvelope = CryptoEngine.wrapKey(decryptedDEK, nextRecipientDoc.publicKey);

        // 8. Calcola il nuovo Key Commitment per la transizione
        const newDekCommitment = CryptoEngine.computeDEKCommitment(decryptedDEK);
        console.log(`[DossierService] Nuovo DEK Commitment: ${newDekCommitment}`);

        // 9. Salva il passaggio di stato su blockchain (con nuovo dekCommitment)
        console.log(`[DossierService] Registrazione della transizione di stato in corso...`);
        const tx = await this.docRegistry.connect(params.handler).transitionDossier(
            dossierIdBytes,
            params.nextState,
            params.nextRecipientAddress,
            ethers.toUtf8Bytes(updatedCid),
            ethers.toUtf8Bytes(newDigitalEnvelope),
            newDekCommitment  // bytes32: SHA-256(DEK) notarizzato on-chain
        );
        await tx.wait();

        console.log(`[DossierService] Transizione completata.`);
    }
}
