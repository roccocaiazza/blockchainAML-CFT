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
    updatedDocumentBuffer?: Buffer;
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

    // Cifra il documento, calcola il dekCommitment, carica su IPFS e registra on-chain.
    async createAndSubmitDossier(params: CreateDossierParams): Promise<void> {
        console.log(`\n[DossierService] Creazione e sottomissione Dossier: ${params.dossierId}`);

        const dek = CryptoEngine.generateDEK();
        const encryptedPayload = CryptoEngine.encryptDocument(params.documentBuffer, dek);

        // SHA-256(DEK) notarizzato on-chain prima del key wrapping
        const dekCommitment = CryptoEngine.computeDEKCommitment(dek);
        console.log(`[DossierService] DEK Commitment (SHA-256): ${dekCommitment}`);

        const ipfsCid = await this.storageService.uploadDocument(Buffer.from(encryptedPayload.cipherText));

        const recipientDoc = await this.didService.resolveDID(params.recipientDid);
        const digitalEnvelope = CryptoEngine.wrapKey(dek, recipientDoc.publicKey);

        console.log(`[DossierService] Registrazione on-chain in corso...`);
        const tx = await this.docRegistry.connect(params.submitter).submitDossier(
            ethers.id(params.dossierId),
            ethers.id(params.bankCredId),
            params.recipientAddress,
            ethers.toUtf8Bytes(ipfsCid),
            ethers.toUtf8Bytes(digitalEnvelope),
            dekCommitment
        );
        await tx.wait();

        console.log(`[DossierService] Dossier sottomesso con successo.`);
    }

    // Apre la busta digitale, verifica il Key Commitment, ri-cifra e inoltra alla prossima autorità.
    // Se SHA-256(DEK_decifrata) != dekCommitment on-chain, lancia un errore: chiamare logDispute().
    async reviewAndForwardDossier(params: ForwardDossierParams): Promise<void> {
        console.log(`\n[DossierService] Review e inoltro Dossier: ${params.dossierId}`);

        const dossierIdBytes = ethers.id(params.dossierId);
        const dossierData = await this.docRegistry.dossiers(dossierIdBytes);

        const decryptedDEK = CryptoEngine.unwrapKey(
            ethers.toUtf8String(dossierData.encryptedDEK),
            params.handlerPrivateKey
        );
        console.log(`[DossierService] Busta digitale aperta con successo.`);

        const onChainCommitment: string = dossierData.dekCommitment;
        const isValid = CryptoEngine.verifyDEKCommitment(decryptedDEK, onChainCommitment);
        if (!isValid) {
            throw new Error(
                `[DossierService] KEY COMMITMENT MISMATCH sul dossier ${params.dossierId}. ` +
                `La DEK decifrata non corrisponde al commitment on-chain (${onChainCommitment}). ` +
                `Chiamare logDispute() per registrare la prova crittografica.`
            );
        }
        console.log(`[DossierService] Key Commitment verificato con successo.`);

        if (!params.updatedDocumentBuffer) {
            throw new Error("Il documento aggiornato è richiesto per proseguire (Mock IPFS behavior)");
        }

        const nuovoEncryptedPayload = CryptoEngine.encryptDocument(params.updatedDocumentBuffer, decryptedDEK);
        const updatedCid = await this.storageService.uploadDocument(Buffer.from(nuovoEncryptedPayload.cipherText));

        const nextRecipientDoc = await this.didService.resolveDID(params.nextRecipientDid);
        const newDigitalEnvelope = CryptoEngine.wrapKey(decryptedDEK, nextRecipientDoc.publicKey);

        const newDekCommitment = CryptoEngine.computeDEKCommitment(decryptedDEK);
        console.log(`[DossierService] Nuovo DEK Commitment: ${newDekCommitment}`);

        console.log(`[DossierService] Registrazione della transizione di stato in corso...`);
        const tx = await this.docRegistry.connect(params.handler).transitionDossier(
            dossierIdBytes,
            params.nextState,
            params.nextRecipientAddress,
            ethers.toUtf8Bytes(updatedCid),
            ethers.toUtf8Bytes(newDigitalEnvelope),
            newDekCommitment
        );
        await tx.wait();

        console.log(`[DossierService] Transizione completata.`);
    }
}
