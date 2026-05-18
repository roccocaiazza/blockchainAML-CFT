import { ethers } from "ethers";

export class CredentialService {
    private credRegistry: any;
    private policyManager: any;

    constructor(credRegistryContract: any, policyManagerContract: any) {
        this.credRegistry = credRegistryContract;
        this.policyManager = policyManagerContract;
    }

    /**
     * Propone una banca per l'onboarding e approva tramite voti.
     * In un ambiente reale questo metodo sarebbe diviso tra le varie Autorità.
     */
    async onboardBank(uif: ethers.Signer, ade: ethers.Signer, bankAddress: string): Promise<void> {
        console.log(`[CredentialService] Proposta onboarding per la banca: ${bankAddress}`);
        
        // La UIF propone
        let tx = await this.policyManager.connect(uif).proposeBankOnboarding(bankAddress);
        await tx.wait();

        // L'AdE vota a favore (raggiungendo il quorum)
        tx = await this.policyManager.connect(ade).vote(0);
        await tx.wait();

        console.log(`[CredentialService] Quorum raggiunto. La banca è stata autorizzata.`);
    }

    /**
     * Emette una Verifiable Credential su Blockchain.
     */
    async issueCredential(issuer: ethers.Signer, credId: string, subjectAddress: string, contentHash: string): Promise<void> {
        console.log(`[CredentialService] Emissione Verifiable Credential per ${subjectAddress}`);
        const tx = await this.credRegistry.connect(issuer).issueCredential(
            ethers.id(credId), 
            subjectAddress, 
            ethers.id(contentHash)
        );
        await tx.wait();
        console.log(`[CredentialService] Credenziale ${credId} emessa con successo.`);
    }
}
