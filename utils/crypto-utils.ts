import * as crypto from "node:crypto";

// MODULO DI CRITTOGRAFIA IBRIDA (AES-256-GCM + RSA-OAEP)
// Implementazione del pattern "Busta Digitale" per il framework AML
export interface KeyPair {
    publicKey: string;
    privateKey: string;
}

export interface EncryptedPayload {
    cipherText: Buffer;
    iv: Buffer;
    authTag: Buffer;
}

export class CryptoEngine {

    // 1. GENERAZIONE CHIAVI ASIMMETRICHE (Identità del Nodo)
    // Utilizzate per popolare il campo 'publicKey' nel DIDRegistry
    static generateRSAKeyPair(): KeyPair {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: "spki",
                format: "pem",
            },
            privateKeyEncoding: {
                type: "pkcs8",
                format: "pem",
            },
        });

        return { publicKey, privateKey };
    }

    // 2. GENERAZIONE CHIAVE SIMMETRICA (Data Encryption Key - DEK)
    // Chiave usa e getta per cifrare il singolo dossier investigativo
    static generateDEK(): Buffer {
        return crypto.randomBytes(32); // 256 bit per AES-256
    }

    // 3. CIFRATURA DEL DOCUMENTO (Off-Chain / IPFS)
    // Cifra il file (es. PDF o JSON) utilizzando AES-256-GCM
    static encryptDocument(fileBuffer: Buffer, dek: Buffer): EncryptedPayload {
        const iv = crypto.randomBytes(12); // Initialization Vector consigliato per GCM
        const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);

        const cipherText = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
        const authTag = cipher.getAuthTag();

        return { cipherText, iv, authTag };
    }

    // 4. DECIFRATURA DEL DOCUMENTO
    static decryptDocument(encryptedPayload: EncryptedPayload, dek: Buffer): Buffer {
        const decipher = crypto.createDecipheriv("aes-256-gcm", dek, encryptedPayload.iv);
        decipher.setAuthTag(encryptedPayload.authTag);

        return Buffer.concat([decipher.update(encryptedPayload.cipherText), decipher.final()]);
    }

    // 5. KEY WRAPPING (La Busta Digitale)
    // Cifra la DEK (chiave simmetrica) utilizzando la chiave pubblica RSA del destinatario
    static wrapKey(dek: Buffer, recipientPublicKey: string): string {
        const encryptedDEK = crypto.publicEncrypt(
            {
                key: recipientPublicKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: "sha256",
            },
            dek
        );
        // Ritorna la busta digitale in formato Base64 per facilitare il salvataggio su Blockchain
        return encryptedDEK.toString("base64");
    }

    // 6. KEY UNWRAPPING (Apertura della Busta)
    // Il destinatario usa la propria chiave privata RSA per recuperare la DEK
    static unwrapKey(encryptedDEKBase64: string, recipientPrivateKey: string): Buffer {
        const encryptedDEK = Buffer.from(encryptedDEKBase64, "base64");

        const dek = crypto.privateDecrypt(
            {
                key: recipientPrivateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: "sha256",
            },
            encryptedDEK
        );
        return dek;
    }
}