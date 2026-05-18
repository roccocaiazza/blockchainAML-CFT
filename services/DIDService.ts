import { ethers } from "ethers";

export class DIDService {
    private registry: any;

    constructor(didRegistryContract: any) {
        this.registry = didRegistryContract;
    }

    /**
     * Registra un nuovo DID per un ente.
     * @param signer L'account/signer Ethers che esegue la transazione
     * @param did Identificativo univoco (es. "did:aml:uif")
     * @param publicKey La chiave pubblica RSA dell'ente
     * @param endpoint Un URL opzionale per i servizi dell'ente
     */
    async registerDID(signer: ethers.Signer, did: string, publicKey: string, endpoint: string = ""): Promise<void> {
        console.log(`[DIDService] Registrazione DID: ${did} per l'indirizzo: ${await signer.getAddress()}`);
        const tx = await this.registry.connect(signer).registerDID(did, publicKey, endpoint);
        await tx.wait();
        console.log(`[DIDService] DID ${did} registrato con successo.`);
    }

    /**
     * Risolve un DID interrogando lo Smart Contract.
     * @param did Il DID da risolvere
     * @returns L'oggetto documento del DID (contiene controller, publicKey, ecc)
     */
    async resolveDID(did: string): Promise<any> {
        console.log(`[DIDService] Risoluzione DID: ${did}`);
        return await this.registry.resolveDID(did);
    }
}
