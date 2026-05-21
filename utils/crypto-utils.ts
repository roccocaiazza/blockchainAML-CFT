import * as crypto from "node:crypto";

// Crittografia ibrida AES-256-GCM + RSA-OAEP per il pattern "Busta Digitale"

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

    // Genera una coppia di chiavi RSA-2048 in formato PEM. Usata per popolare il DIDRegistry.
    static generateRSAKeyPair(): KeyPair {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        return { publicKey, privateKey };
    }

    // Genera una DEK monouso da 256 bit per AES-256.
    static generateDEK(): Buffer {
        return crypto.randomBytes(32);
    }

    // Cifra un documento con AES-256-GCM. Restituisce cipherText, IV e authTag.
    static encryptDocument(fileBuffer: Buffer, dek: Buffer): EncryptedPayload {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
        const cipherText = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return { cipherText, iv, authTag };
    }

    // Decifra un documento AES-256-GCM verificando l'authTag.
    static decryptDocument(encryptedPayload: EncryptedPayload, dek: Buffer): Buffer {
        const decipher = crypto.createDecipheriv("aes-256-gcm", dek, encryptedPayload.iv);
        decipher.setAuthTag(encryptedPayload.authTag);
        return Buffer.concat([decipher.update(encryptedPayload.cipherText), decipher.final()]);
    }

    // Cifra la DEK con la chiave pubblica RSA del destinatario (RSA-OAEP). Restituisce la Busta Digitale in Base64.
    static wrapKey(dek: Buffer, recipientPublicKey: string): string {
        const encryptedDEK = crypto.publicEncrypt(
            { key: recipientPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            dek
        );
        return encryptedDEK.toString("base64");
    }

    // Decifra la Busta Digitale con la chiave privata RSA del destinatario, recuperando la DEK.
    static unwrapKey(encryptedDEKBase64: string, recipientPrivateKey: string): Buffer {
        const encryptedDEK = Buffer.from(encryptedDEKBase64, "base64");
        return crypto.privateDecrypt(
            { key: recipientPrivateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            encryptedDEK
        );
    }

    // Calcola SHA-256(DEK) da notarizzare on-chain prima del key wrapping (Key Commitment).
    // Il ricevente confronta questo valore con SHA-256(DEK_decifrata) per rilevare manomissioni.
    static computeDEKCommitment(dek: Buffer): string {
        const hash = crypto.createHash("sha256").update(dek).digest();
        return "0x" + hash.toString("hex");
    }

    // Restituisce true se la DEK decifrata corrisponde al commitment notarizzato on-chain.
    static verifyDEKCommitment(dek: Buffer, onChainCommitment: string): boolean {
        const computed = CryptoEngine.computeDEKCommitment(dek);
        return computed.toLowerCase() === onChainCommitment.toLowerCase();
    }
}
