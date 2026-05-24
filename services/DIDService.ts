import { ethers } from "ethers";

export class DIDService {
    private registry: any;

    constructor(didRegistryContract: any) {
        this.registry = didRegistryContract;
    }

    // Registra un DID on-chain con la chiave pubblica RSA, il service endpoint e il dominio dell'ente.
    async registerDID(signer: ethers.Signer, did: string, publicKey: string, endpoint: string = "", domain: string = "GENERIC"): Promise<void> {
        console.log(`[DIDService] Registrazione DID: ${did} per l'indirizzo: ${await signer.getAddress()}`);
        const didBytes32 = ethers.encodeBytes32String(did);
        const pubKeyBytes = ethers.toUtf8Bytes(publicKey);
        const endpointBytes = ethers.toUtf8Bytes(endpoint);
        const domainBytes32 = ethers.encodeBytes32String(domain);

        const tx = await this.registry.connect(signer).registerDID(didBytes32, pubKeyBytes, endpointBytes, domainBytes32);
        await tx.wait();
        console.log(`[DIDService] DID ${did} registrato con successo.`);
    }

    // Risolve un DID e restituisce il documento con chiave pubblica e service endpoint.
    async resolveDID(did: string): Promise<any> {
        console.log(`[DIDService] Risoluzione DID: ${did}`);
        const didBytes32 = ethers.encodeBytes32String(did);
        const doc = await this.registry.resolveDID(didBytes32);
        return {
            owner: doc.owner,
            publicKey: ethers.toUtf8String(doc.publicKey),
            serviceEndpoint: ethers.toUtf8String(doc.serviceEndpoint),
            domain: ethers.decodeBytes32String(doc.domain),
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            active: doc.active
        };
    }
}
